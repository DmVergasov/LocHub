// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubEnvironment.h"

#include "Algo/StableSort.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Interfaces/IPluginManager.h"
#include "LocHubChildProcess.h"
#include "LocHubProcessSpawnLock.h"
#include "LocHubUserSettings.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "ModuleDescriptor.h"
#include "PluginDescriptor.h"

namespace LocHubEnvironmentPrivate
{
	constexpr int32 MinNodeMajor = 22;
	constexpr int32 MinNodeMinor = 11;
	// Every bounded process this file launches (CheckNode's own "node --version" and the Mac/Linux login-shell
	// lookup, both reached from StartNode on the game thread when a tool launch needs them) must not block on a
	// node that never exits, so each polls up to this deadline and terminates it instead of waiting forever.
	constexpr double NodeVersionTimeoutSeconds = 5.0;
	constexpr float NodeVersionPollIntervalSeconds = 0.05f;

	/** Module types whose strings can reach a player (client, server or both). */
	bool IsGameModuleType(const EHostType::Type InType)
	{
		switch (InType)
		{
		case EHostType::Runtime:
		case EHostType::RuntimeNoCommandlet:
		case EHostType::RuntimeAndProgram:
		case EHostType::CookedOnly:
		case EHostType::ServerOnly:
		case EHostType::ClientOnly:
		case EHostType::ClientOnlyNoCommandlet:
			return true;
		default:
			return false;
		}
	}

	FString ToProjectRelative(const FString& InPath, const FString& InProjectDir)
	{
		FString Path = FPaths::ConvertRelativePathToFull(InPath);
		FPaths::MakePathRelativeTo(Path, *InProjectDir);
		FPaths::NormalizeDirectoryName(Path);
		return Path;
	}

	TArray<TSharedRef<IPlugin>> GetProjectPlugins()
	{
		TArray<TSharedRef<IPlugin>> Plugins = IPluginManager::Get().GetEnabledPlugins();
		Plugins.RemoveAll([](const TSharedRef<IPlugin>& InPlugin)
		{
			return InPlugin->GetLoadedFrom() != EPluginLoadedFrom::Project;
		});
		Plugins.Sort([](const TSharedRef<IPlugin>& InA, const TSharedRef<IPlugin>& InB)
		{
			return InA->GetName() < InB->GetName();
		});
		return Plugins;
	}

	/** All PATH entries, trimmed and de-quoted, empties dropped -- used by FindExecutableOnPath's PATH search. */
	TArray<FString> GetPathDirs()
	{
		TArray<FString> PathDirs;
		FPlatformMisc::GetEnvironmentVariable(TEXT("PATH")).ParseIntoArray(PathDirs, FPlatformMisc::GetPathVarDelimiter(), true);
		for (FString& Dir : PathDirs)
		{
			Dir.TrimStartAndEndInline();
			Dir.TrimQuotesInline();
		}
		PathDirs.RemoveAll([](const FString& InDir) { return InDir.IsEmpty(); });
		return PathDirs;
	}

	/** Outcome of RunBoundedProcess, kept distinct from FLocHubNodeCheck::Status: a launch failure classifies as
	 *  Unreadable (ClassifyNode's bInRan=false path) while a timeout is its own status, so the two must not be
	 *  collapsed into one bool. */
	enum class EBoundedProcessResult : uint8
	{
		LaunchFailed,
		TimedOut,
		Exited,
	};

	/** Launches InExe InArgs and waits up to NodeVersionTimeoutSeconds for it to exit, terminating it instead of
	 *  blocking the caller when it does not. Shared by the node --version classifier and the Mac/Linux login-shell
	 *  node lookup, both of which must never hang on a process that never exits.
	 *  The child gets its own stdin pipe that this function never writes to and never closes early: node never
	 *  reads stdin, but an interactive-shell profile invoked with no terminal of its own can try to read one, and a
	 *  pipe that stays open with nothing written makes that read block until the deadline below terminates the
	 *  process, instead of falling through to whatever this process inherited as its own stdin (the editor's
	 *  console, on a terminal-launched editor).
	 *  InExe itself is never handed to CreateProc directly: LocHubEnvironment::BuildSpawnCommand decides what to
	 *  launch instead, so a Node.js candidate that exists but cannot run (no exec bit, wrong architecture) becomes
	 *  a clean LaunchFailed/Unreadable on every platform rather than crashing the editor (UE 5.6 Mac). */
	EBoundedProcessResult RunBoundedProcess(const FString& InExe, const TCHAR* InArgs, FString& OutOutput, int32& OutReturnCode)
	{
		OutOutput.Reset();
		OutReturnCode = -1;

		void* PipeRead = nullptr;
		void* PipeWrite = nullptr;
		if (!FPlatformProcess::CreatePipe(PipeRead, PipeWrite))
		{
			return EBoundedProcessResult::LaunchFailed;
		}

		void* StdinRead = nullptr;
		void* StdinWrite = nullptr;
		if (!FPlatformProcess::CreatePipe(StdinRead, StdinWrite, /*bWritePipeLocal=*/true))
		{
			FPlatformProcess::ClosePipe(PipeRead, PipeWrite);
			return EBoundedProcessResult::LaunchFailed;
		}

		const FLocHubSpawnCommand SpawnCommand = LocHubEnvironment::BuildSpawnCommand(InExe, InArgs, LocHubEnvironment::CurrentHostOS());
		if (SpawnCommand.bRejected)
		{
			FPlatformProcess::ClosePipe(PipeRead, PipeWrite);
			FPlatformProcess::ClosePipe(StdinRead, StdinWrite);
			return EBoundedProcessResult::LaunchFailed;
		}

		uint32 ProcessId = 0;
		FProcHandle Handle;
		{
			// Same lock FLocHubServiceProcess::StartNode holds around its own CreateProc while LOCHUB_API_KEY is set
			// on the editor's environment (LocHubProcessSpawnLock.h): without it, this call racing that window
			// could inherit the key (Windows) or race the SetEnvironmentVar calls around it (Mac/Linux).
			FScopeLock SpawnLock(&LocHubProcessSpawnLock::Get());
			Handle = FPlatformProcess::CreateProc(*SpawnCommand.Exe, *SpawnCommand.Args, false, true, true, &ProcessId, 0, nullptr, PipeWrite, StdinRead);
		}
		if (!Handle.IsValid())
		{
			FPlatformProcess::ClosePipe(PipeRead, PipeWrite);
			FPlatformProcess::ClosePipe(StdinRead, StdinWrite);
			return EBoundedProcessResult::LaunchFailed;
		}

		// Collected as bytes and decoded once at the end: FPlatformProcess::ReadPipe decodes Linux output as ANSI, which
		// would garble a path under a non-ASCII home directory, and a read can end inside a UTF-8 character.
		TArray<uint8> OutputBytes;
		const double Deadline = FPlatformTime::Seconds() + NodeVersionTimeoutSeconds;
		bool bExited = false;
		while (FPlatformTime::Seconds() < Deadline)
		{
			LocHubChildProcess::ReadAvailableBytes(PipeRead, OutputBytes);
			if (!FPlatformProcess::IsProcRunning(Handle))
			{
				bExited = true;
				break;
			}
			FPlatformProcess::Sleep(NodeVersionPollIntervalSeconds);
		}

		if (bExited)
		{
			LocHubChildProcess::ReadAvailableBytes(PipeRead, OutputBytes);
			FPlatformProcess::GetProcReturnCode(Handle, &OutReturnCode);
		}
		else
		{
			// Nothing is waiting for a clean exit of a process that already missed the deadline: SIGKILL (Mac/Linux)
			// right away, and wait for it, so the CloseProc below does not block on Linux until the child exits.
			LocHubChildProcess::Terminate(Handle, ProcessId, ELocHubStopMode::Immediate);
		}
		FPlatformProcess::CloseProc(Handle);
		FPlatformProcess::ClosePipe(PipeRead, PipeWrite);
		FPlatformProcess::ClosePipe(StdinRead, StdinWrite);
		OutOutput = LocHubChildProcess::ConsumeCompleteUtf8(OutputBytes);
		return bExited ? EBoundedProcessResult::Exited : EBoundedProcessResult::TimedOut;
	}

	/** Runs InNodePath through the bounded "node --version" poll and classifies the result; empty InNodePath is
	 *  NotFound, a launch failure is Unreadable, a timeout is TimedOut. */
	FLocHubNodeCheck RunNodeVersionCheck(const FString& InNodePath)
	{
		if (InNodePath.IsEmpty())
		{
			return LocHubEnvironment::ClassifyNode(FString(), false, -1, FString());
		}

		FString Output;
		int32 ReturnCode = -1;
		switch (RunBoundedProcess(InNodePath, TEXT("--version"), Output, ReturnCode))
		{
		case EBoundedProcessResult::LaunchFailed:
			return LocHubEnvironment::ClassifyNode(InNodePath, false, -1, FString());
		case EBoundedProcessResult::TimedOut:
		{
			FLocHubNodeCheck TimedOutCheck;
			TimedOutCheck.Path = InNodePath;
			TimedOutCheck.Status = ELocHubNodeStatus::TimedOut;
			return TimedOutCheck;
		}
		case EBoundedProcessResult::Exited:
		default:
			return LocHubEnvironment::ClassifyNode(InNodePath, true, ReturnCode, Output);
		}
	}

	/** Higher is more useful to report when nothing was Ok: a version that was merely too old beats a bare
	 *  NotFound, which beats nothing at all. */
	int32 RankNodeStatus(const ELocHubNodeStatus InStatus)
	{
		switch (InStatus)
		{
		case ELocHubNodeStatus::Ok:
			return 4;
		case ELocHubNodeStatus::TooOld:
			return 3;
		case ELocHubNodeStatus::Unreadable:
			return 2;
		case ELocHubNodeStatus::TimedOut:
			return 1;
		case ELocHubNodeStatus::NotFound:
		default:
			return 0;
		}
	}

	/** The more informative of two non-Ok checks, for the message when the search never finds an Ok candidate. */
	const FLocHubNodeCheck& PreferBetterNodeCheck(const FLocHubNodeCheck& InA, const FLocHubNodeCheck& InB)
	{
		return RankNodeStatus(InB.Status) > RankNodeStatus(InA.Status) ? InB : InA;
	}

	/** $HOME (Mac/Linux); empty on Windows, where WellKnownNodeDirs and VersionManagerRoots do not use it. */
	FString GetHomeDir()
	{
		return FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
	}

	bool TryParseVersionDirName(const FString& InName, TArray<int32>& OutParts)
	{
		FString Text = InName;
		Text.RemoveFromStart(TEXT("v"));
		TArray<FString> Parts;
		Text.ParseIntoArray(Parts, TEXT("."), true);
		if (Parts.IsEmpty())
		{
			return false;
		}
		OutParts.Reset(Parts.Num());
		for (const FString& Part : Parts)
		{
			if (!Part.IsNumeric())
			{
				return false;
			}
			OutParts.Add(FCString::Atoi(*Part));
		}
		return true;
	}

	/** True when InA's dotted version is newer than InB's; a missing trailing component reads as 0. */
	bool IsVersionNewer(const TArray<int32>& InA, const TArray<int32>& InB)
	{
		const int32 Num = FMath::Max(InA.Num(), InB.Num());
		for (int32 Index = 0; Index < Num; ++Index)
		{
			const int32 A = InA.IsValidIndex(Index) ? InA[Index] : 0;
			const int32 B = InB.IsValidIndex(Index) ? InB[Index] : 0;
			if (A != B)
			{
				return A > B;
			}
		}
		return false;
	}

	/** Mac/Linux last resort: a GUI-launched editor's process environment lacks the shell profile's PATH edits
	 *  (nvm/fnm/volta usually live there), but the user's own login shell knows where node is. Bounded by the same
	 *  poll as the version check, so a shell that hangs (broken profile, blocking prompt) cannot hang this call.
	 *  Computed at most once per editor session: the answer cannot change without restarting the editor, so a miss
	 *  is cached rather than re-running the shell (up to NodeVersionTimeoutSeconds) on every later probe. */
	FString FindNodeViaLoginShell(const ELocHubHostOS InHostOS)
	{
		static TOptional<FString> CachedResult;
		// CheckNode's only caller is StartNode, reached on the game thread whenever a tool launch needs the
		// service, but nothing here assumes that stays true, so CachedResult is still guarded against two first
		// callers racing: the lock is held across the shell launch itself, not just the check-and-store, so a
		// second caller waits for the first answer instead of starting its own shell process.
		static FCriticalSection CacheLock;
		FScopeLock Lock(&CacheLock);
		if (CachedResult.IsSet())
		{
			return CachedResult.GetValue();
		}

		const FString Shell = LocHubEnvironment::LoginShellPath(InHostOS, FPlatformMisc::GetEnvironmentVariable(TEXT("SHELL")));
		const FString Arguments = LocHubEnvironment::LoginShellNodeArguments();
		FString Output;
		int32 ReturnCode = -1;
		FString Result;
		if (RunBoundedProcess(Shell, *Arguments, Output, ReturnCode) == EBoundedProcessResult::Exited && ReturnCode == 0)
		{
			Result = LocHubEnvironment::LastExistingAbsolutePathLine(Output);
		}
		CachedResult = Result;
		return Result;
	}
}

FString LocHubEnvironment::GetProjectDir()
{
	FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	if (!ProjectDir.EndsWith(TEXT("/")))
	{
		ProjectDir += TEXT("/");
	}
	return ProjectDir;
}

TArray<FString> LocHubEnvironment::GetGameSourceDirs(const FString& InProjectDir)
{
	TArray<FString> Dirs;
	Dirs.Add(TEXT("Source"));
	for (const TSharedRef<IPlugin>& Plugin : LocHubEnvironmentPrivate::GetProjectPlugins())
	{
		const FString PluginDir = FPaths::ConvertRelativePathToFull(Plugin->GetBaseDir());
		for (const FModuleDescriptor& Module : Plugin->GetDescriptor().Modules)
		{
			const FString ModuleDir = PluginDir / TEXT("Source") / Module.Name.ToString();
			if (LocHubEnvironmentPrivate::IsGameModuleType(Module.Type) && IFileManager::Get().DirectoryExists(*ModuleDir))
			{
				Dirs.AddUnique(LocHubEnvironmentPrivate::ToProjectRelative(ModuleDir, InProjectDir));
			}
		}
	}
	return Dirs;
}

TArray<FString> LocHubEnvironment::GetGameContentDirs(const FString& InProjectDir)
{
	TArray<FString> Dirs;
	Dirs.Add(TEXT("Content"));
	for (const TSharedRef<IPlugin>& Plugin : LocHubEnvironmentPrivate::GetProjectPlugins())
	{
		const FString ContentDir = FPaths::ConvertRelativePathToFull(Plugin->GetContentDir());
		if (Plugin->CanContainContent() && IFileManager::Get().DirectoryExists(*ContentDir))
		{
			Dirs.AddUnique(LocHubEnvironmentPrivate::ToProjectRelative(ContentDir, InProjectDir));
		}
	}
	return Dirs;
}

FString LocHubEnvironment::FindExecutableOnPath(const FString& InExecutableName)
{
	for (const FString& Dir : LocHubEnvironmentPrivate::GetPathDirs())
	{
		const FString Candidate = FPaths::Combine(Dir, InExecutableName);
		if (FPaths::FileExists(Candidate))
		{
			return FPaths::ConvertRelativePathToFull(Candidate);
		}
	}
	return FString();
}

ELocHubHostOS LocHubEnvironment::CurrentHostOS()
{
#if PLATFORM_WINDOWS
	return ELocHubHostOS::Windows;
#elif PLATFORM_MAC
	return ELocHubHostOS::Mac;
#else
	return ELocHubHostOS::Linux;
#endif
}

FString LocHubEnvironment::ExecutableFileName(const FString& InTool, const ELocHubHostOS InHostOS)
{
	return InHostOS == ELocHubHostOS::Windows ? InTool + TEXT(".exe") : InTool;
}

TArray<FString> LocHubEnvironment::WellKnownNodeDirs(const ELocHubHostOS InHostOS, const FString& InHomeDir)
{
	switch (InHostOS)
	{
	case ELocHubHostOS::Mac:
		return {
			TEXT("/opt/homebrew/bin"),
			TEXT("/usr/local/bin"),
			TEXT("/opt/local/bin"),
			InHomeDir / TEXT(".volta/bin"),
		};
	case ELocHubHostOS::Linux:
		return {
			TEXT("/usr/bin"),
			TEXT("/usr/local/bin"),
			TEXT("/snap/bin"),
			InHomeDir / TEXT(".volta/bin"),
		};
	case ELocHubHostOS::Windows:
	default:
		return {
			FPlatformMisc::GetEnvironmentVariable(TEXT("ProgramFiles")) / TEXT("nodejs"),
			FPlatformMisc::GetEnvironmentVariable(TEXT("LOCALAPPDATA")) / TEXT("Volta/bin"),
		};
	}
}

TArray<FLocHubVersionRoot> LocHubEnvironment::VersionManagerRoots(const ELocHubHostOS InHostOS, const FString& InHomeDir)
{
	// Windows has no $HOME-based version-manager convention to root these paths at, and InHomeDir is empty there;
	// an empty InHomeDir on any platform (a GUI-launched process with no HOME set) means the same thing: without
	// this guard FString() / ".nvm/versions/node" silently becomes a path relative to the working directory
	// instead of doing nothing.
	if (InHostOS == ELocHubHostOS::Windows || InHomeDir.IsEmpty())
	{
		return {};
	}

	TArray<FLocHubVersionRoot> Roots;
	Roots.Add({ InHomeDir / TEXT(".nvm/versions/node"), TEXT("bin") });
	Roots.Add({ InHomeDir / TEXT(".local/share/fnm/node-versions"), TEXT("installation/bin") });
	if (InHostOS == ELocHubHostOS::Mac)
	{
		Roots.Add({ InHomeDir / TEXT("Library/Application Support/fnm/node-versions"), TEXT("installation/bin") });
	}
	Roots.Add({ InHomeDir / TEXT(".asdf/installs/nodejs"), TEXT("bin") });
	Roots.Add({ InHomeDir / TEXT(".local/share/mise/installs/node"), TEXT("bin") });
	return Roots;
}

TArray<FString> LocHubEnvironment::SortVersionDirsNewestFirst(TArray<FString> InVersionDirs)
{
	using namespace LocHubEnvironmentPrivate;

	struct FVersionedDir
	{
		FString Name;
		TArray<int32> Parts;
	};

	TArray<FVersionedDir> Versioned;
	TArray<FString> NonVersioned;
	for (FString& Dir : InVersionDirs)
	{
		TArray<int32> Parts;
		if (TryParseVersionDirName(Dir, Parts))
		{
			Versioned.Add({ MoveTemp(Dir), MoveTemp(Parts) });
		}
		else
		{
			NonVersioned.Add(MoveTemp(Dir));
		}
	}

	Algo::StableSort(Versioned, [](const FVersionedDir& InA, const FVersionedDir& InB)
	{
		return IsVersionNewer(InA.Parts, InB.Parts);
	});

	TArray<FString> Result;
	Result.Reserve(InVersionDirs.Num());
	for (FVersionedDir& Dir : Versioned)
	{
		Result.Add(MoveTemp(Dir.Name));
	}
	Result.Append(MoveTemp(NonVersioned));
	return Result;
}

TArray<FString> LocHubEnvironment::FilterCandidateVersionDirs(TArray<FString> InVersionDirs)
{
	using namespace LocHubEnvironmentPrivate;

	TArray<FString> Result;
	Result.Reserve(InVersionDirs.Num());
	for (FString& Dir : SortVersionDirsNewestFirst(MoveTemp(InVersionDirs)))
	{
		TArray<int32> Parts;
		if (TryParseVersionDirName(Dir, Parts) && Parts.Num() >= 2 && !IsNodeVersionSupported(Parts[0], Parts[1]))
		{
			// The directory name already says this is older than we support: skip it here rather than pay for a
			// bounded "node --version" launch (on the game thread, reached from StartNode when a tool launch needs
			// it) that could only confirm what the name already said.
			continue;
		}
		Result.AddUnique(MoveTemp(Dir));
	}
	return Result;
}

FString LocHubEnvironment::LoginShellPath(const ELocHubHostOS InHostOS, const FString& InShellEnvVar)
{
	if (!InShellEnvVar.IsEmpty())
	{
		return InShellEnvVar;
	}
	return InHostOS == ELocHubHostOS::Mac ? TEXT("/bin/zsh") : TEXT("/bin/bash");
}

FString LocHubEnvironment::LoginShellNodeArguments()
{
	// -lc, not -lic: a login-and-interactive shell does job control the moment it touches the terminal it
	// inherited from the editor (a background process group gets SIGTTIN/SIGTTOU and stops), so it would sit out the
	// whole bounded poll until that kills it. A login-but-not-interactive shell does not: it still sources the login
	// profile (.zprofile/.bash_profile/.profile, e.g. Homebrew's shellenv) that a GUI-launched editor's PATH misses.
	return TEXT("-lc \"command -v node\"");
}

FString LocHubEnvironment::LastExistingAbsolutePathLine(const FString& InText)
{
	TArray<FString> Lines;
	InText.ParseIntoArrayLines(Lines);
	for (int32 Index = Lines.Num() - 1; Index >= 0; --Index)
	{
		FString Line = Lines[Index].TrimStartAndEnd();
		if (Line.StartsWith(TEXT("/")) && FPaths::FileExists(Line))
		{
			return Line;
		}
	}
	return FString();
}

FString LocHubEnvironment::DisplaySearchPath(const FString& InPath, const FString& InHomeDir)
{
	FString Display = InPath;
	if (!InHomeDir.IsEmpty() && Display.StartsWith(InHomeDir))
	{
		Display = TEXT("~") + Display.Mid(InHomeDir.Len());
	}
	FPaths::NormalizeDirectoryName(Display);
	return Display;
}

FLocHubSpawnCommand LocHubEnvironment::BuildSpawnCommand(const FString& InExe, const FString& InArgs, const ELocHubHostOS InHostOS)
{
	if (InHostOS == ELocHubHostOS::Windows)
	{
		return FLocHubSpawnCommand{ false, InExe, InArgs };
	}

	if (InExe.Contains(TEXT("=")))
	{
		// env would read "a=b/node" as an assignment, not a program to run.
		return FLocHubSpawnCommand{ true, FString(), FString() };
	}

	return FLocHubSpawnCommand{ false, TEXT("/usr/bin/env"), FString::Printf(TEXT("\"%s\" %s"), *InExe, *InArgs) };
}

bool LocHubEnvironment::ParseNodeVersion(const FString& InVersionText, int32& OutMajor, int32& OutMinor)
{
	FString Text = InVersionText.TrimStartAndEnd();
	Text.RemoveFromStart(TEXT("v"));
	TArray<FString> Parts;
	Text.ParseIntoArray(Parts, TEXT("."), true);
	if (Parts.Num() < 2 || !Parts[0].IsNumeric() || !Parts[1].IsNumeric())
	{
		return false;
	}
	OutMajor = FCString::Atoi(*Parts[0]);
	OutMinor = FCString::Atoi(*Parts[1]);
	return true;
}

bool LocHubEnvironment::IsNodeVersionSupported(const int32 InMajor, const int32 InMinor)
{
	using namespace LocHubEnvironmentPrivate;
	return InMajor > MinNodeMajor || (InMajor == MinNodeMajor && InMinor >= MinNodeMinor);
}

FLocHubNodeCheck LocHubEnvironment::ClassifyNode(const FString& InPath, const bool bInRan, const int32 InReturnCode, const FString& InVersionOutput)
{
	FLocHubNodeCheck Check;
	if (InPath.IsEmpty())
	{
		Check.Status = ELocHubNodeStatus::NotFound;
		return Check;
	}

	Check.Path = InPath;
	int32 Major = 0;
	int32 Minor = 0;
	if (!bInRan || InReturnCode != 0 || !ParseNodeVersion(InVersionOutput, Major, Minor))
	{
		Check.Status = ELocHubNodeStatus::Unreadable;
		return Check;
	}

	Check.VersionText = InVersionOutput.TrimStartAndEnd();
	Check.Status = IsNodeVersionSupported(Major, Minor) ? ELocHubNodeStatus::Ok : ELocHubNodeStatus::TooOld;
	return Check;
}

FLocHubNodeCheck LocHubEnvironment::CheckNode(const TOptional<FString> InConfiguredPathOverride /*= TOptional<FString>()*/)
{
	using namespace LocHubEnvironmentPrivate;

	const FString ConfiguredPath = InConfiguredPathOverride.IsSet() ? InConfiguredPathOverride.GetValue() : GetDefault<ULocHubUserSettings>()->NodeExecutable.FilePath;
	if (!ConfiguredPath.IsEmpty())
	{
		// The setting is authoritative when set: a candidate the user pointed at that turns out wrong must be
		// reported as wrong, not silently skipped in favour of PATH.
		FLocHubNodeCheck Check = RunNodeVersionCheck(ConfiguredPath);
		Check.bFromSetting = true;
		Check.SearchedPlaces = { FString::Printf(TEXT("the Node.js Executable setting (%s)"), *ConfiguredPath) };
		return Check;
	}

	const ELocHubHostOS HostOS = CurrentHostOS();
	const FString NodeName = ExecutableFileName(TEXT("node"), HostOS);
	const FString HomeDir = GetHomeDir();

	TArray<FString> Candidates;
	TArray<FString> SearchedPlaces;

	SearchedPlaces.Add(TEXT("PATH"));
	const FString PathCandidate = FindExecutableOnPath(NodeName);
	if (!PathCandidate.IsEmpty())
	{
		Candidates.AddUnique(PathCandidate);
	}

	for (const FString& Dir : WellKnownNodeDirs(HostOS, HomeDir))
	{
		SearchedPlaces.Add(DisplaySearchPath(Dir, HomeDir));
		const FString Candidate = Dir / NodeName;
		if (FPaths::FileExists(Candidate))
		{
			Candidates.AddUnique(FPaths::ConvertRelativePathToFull(Candidate));
		}
	}

	const TArray<FLocHubVersionRoot> VersionRoots = VersionManagerRoots(HostOS, HomeDir);
	if (VersionRoots.Num() > 0)
	{
		// One line for every version manager, not one per root (nvm, fnm -- twice on Mac --, asdf, mise): the
		// per-directory layout under each is an implementation detail nobody needs spelled out in a warning message.
		SearchedPlaces.Add(TEXT("nvm/fnm/asdf/mise install folders"));
	}
	for (const FLocHubVersionRoot& Root : VersionRoots)
	{
		TArray<FString> VersionDirs;
		IFileManager::Get().FindFiles(VersionDirs, *(Root.RootDir / TEXT("*")), false, true);
		for (const FString& VersionDir : FilterCandidateVersionDirs(MoveTemp(VersionDirs)))
		{
			const FString Candidate = Root.RootDir / VersionDir / Root.BinSuffix / NodeName;
			if (FPaths::FileExists(Candidate))
			{
				Candidates.AddUnique(FPaths::ConvertRelativePathToFull(Candidate));
			}
		}
	}

	FLocHubNodeCheck Best;
	for (const FString& Candidate : Candidates)
	{
		FLocHubNodeCheck Check = RunNodeVersionCheck(Candidate);
		if (Check.Status == ELocHubNodeStatus::Ok)
		{
			return Check;
		}
		Best = PreferBetterNodeCheck(Best, Check);
	}

	if (HostOS != ELocHubHostOS::Windows)
	{
		SearchedPlaces.Add(TEXT("your login shell's PATH"));
		const FString ShellNode = FindNodeViaLoginShell(HostOS);
		// Already tried above (PATH, a well-known dir, or a version-manager install) -- do not launch node again
		// for the same file just because a second search step also found it.
		if (!ShellNode.IsEmpty() && !Candidates.Contains(FPaths::ConvertRelativePathToFull(ShellNode)))
		{
			FLocHubNodeCheck Check = RunNodeVersionCheck(ShellNode);
			if (Check.Status == ELocHubNodeStatus::Ok)
			{
				return Check;
			}
			Best = PreferBetterNodeCheck(Best, Check);
		}
	}

	Best.SearchedPlaces = MoveTemp(SearchedPlaces);
	return Best;
}

FString LocHubEnvironment::DescribeNodeProblem(const FLocHubNodeCheck& InCheck)
{
	FString Message;
	switch (InCheck.Status)
	{
	case ELocHubNodeStatus::Ok:
		return FString();
	case ELocHubNodeStatus::NotFound:
		Message = TEXT("Node.js 22.11 or newer was not found.");
		break;
	case ELocHubNodeStatus::TooOld:
		Message = FString::Printf(TEXT("Node.js %s is too old. LocHub needs Node.js 22.11 or newer."), *InCheck.VersionText);
		break;
	case ELocHubNodeStatus::Unreadable:
		Message = FString::Printf(TEXT("Node.js at %s did not report its version. Install Node.js 22.11 or newer."), *InCheck.Path);
		break;
	case ELocHubNodeStatus::TimedOut:
		Message = FString::Printf(TEXT("node --version did not answer within %.0f s."), LocHubEnvironmentPrivate::NodeVersionTimeoutSeconds);
		break;
	default:
		checkNoEntry();
		return FString();
	}

	if (InCheck.SearchedPlaces.Num() > 0)
	{
		Message += FString::Printf(TEXT(" Looked in: %s."), *FString::Join(InCheck.SearchedPlaces, TEXT(", ")));
	}
	// A bad configured setting is not fixed by pointing at the same setting again, or by a restart that will not
	// touch it: tell the user to fix or clear the one thing that is actually wrong instead.
	Message += InCheck.bFromSetting
		? TEXT(" Fix or clear the Node.js Executable setting in Editor Preferences > Plugins > LocHub.")
		: TEXT(" Set it in Editor Preferences > Plugins > LocHub > Node.js Executable, or restart the editor after installing.");
	return Message;
}
