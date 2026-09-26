// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubEnvironment.h"
#include "LocHubTargetPaths.h"
#include "LocTextHelper.h"
#include "HAL/PlatformProcess.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubEnvironmentTestsPrivate
{
	bool HasRoot(const TArray<FLocHubVersionRoot>& InRoots, const FString& InRootDir)
	{
		for (const FLocHubVersionRoot& Root : InRoots)
		{
			if (Root.RootDir == InRootDir)
			{
				return true;
			}
		}
		return false;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentRootsTest,
	"LocHub.Environment.Roots",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentRootsTest::RunTest(const FString& Parameters)
{
	const FString ProjectDir = LocHubEnvironment::GetProjectDir();
	TestTrue(TEXT("Project dir ends with a slash"), ProjectDir.EndsWith(TEXT("/")));

	const TArray<FString> SourceDirs = LocHubEnvironment::GetGameSourceDirs(ProjectDir);
	if (TestTrue(TEXT("Source dirs"), SourceDirs.Num() > 0))
	{
		TestEqual(TEXT("Project Source comes first"), SourceDirs[0], TEXT("Source"));
	}
	for (const FString& Dir : SourceDirs)
	{
		// LocHubEditor is an Editor module: its strings are not game text.
		TestFalse(*FString::Printf(TEXT("Editor module %s is not a game source dir"), *Dir), Dir.Contains(TEXT("LocHubEditor")));
	}

	const TArray<FString> ContentDirs = LocHubEnvironment::GetGameContentDirs(ProjectDir);
	if (TestTrue(TEXT("Content dirs"), ContentDirs.Num() > 0))
	{
		TestEqual(TEXT("Project Content comes first"), ContentDirs[0], TEXT("Content"));
	}

	TestTrue(TEXT("Unknown tool is not found"), LocHubEnvironment::FindExecutableOnPath(TEXT("lochub-no-such-tool-7f3a.exe")).IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubTargetPathsLoadHelperTest,
	"LocHub.TargetPaths.LoadHelper",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubTargetPathsLoadHelperTest::RunTest(const FString& Parameters)
{
	const FString TempDir = LocHubTests::MakeTempDir();
	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Data"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("Source/Game/Hud.cpp(10)"), FString(), FString() },
	});

	FText Error;
	const TSharedPtr<FLocTextHelper> Helper = Paths.LoadHelper(Error);
	if (TestTrue(TEXT("Helper loads"), Helper.IsValid()))
	{
		TestTrue(TEXT("Manifest entry is there"), Helper->FindSourceText(LocHubTests::Namespace, TEXT("Pause")).IsValid());
	}
	TestEqual(TEXT("All cultures = native + foreign"), Paths.GetAllCultures().Num(), 2);

	FLocHubTargetPaths Missing = Paths;
	Missing.DataDir = TempDir / TEXT("NoSuchData");
	FText MissingError;
	TestFalse(TEXT("No manifest, no helper"), Missing.LoadHelper(MissingError).IsValid());
	TestFalse(TEXT("The error says why"), MissingError.IsEmpty());

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentNodeCheckClassifyTest,
	"LocHub.Environment.NodeCheck.Classify",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentNodeCheckClassifyTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	TestEqual(TEXT("Empty path is NotFound"), ClassifyNode(FString(), false, -1, FString()).Status, ELocHubNodeStatus::NotFound);
	TestEqual(TEXT("v22.11.0 is Ok"), ClassifyNode(TEXT("C:/node/node.exe"), true, 0, TEXT("v22.11.0\n")).Status, ELocHubNodeStatus::Ok);
	TestEqual(TEXT("v24.3.0 is Ok"), ClassifyNode(TEXT("C:/node/node.exe"), true, 0, TEXT("v24.3.0")).Status, ELocHubNodeStatus::Ok);

	const FLocHubNodeCheck TooOld = ClassifyNode(TEXT("C:/node/node.exe"), true, 0, TEXT("v22.10.9"));
	TestEqual(TEXT("v22.10.9 is TooOld"), TooOld.Status, ELocHubNodeStatus::TooOld);
	TestEqual(TEXT("TooOld keeps the version text"), TooOld.VersionText, TEXT("v22.10.9"));

	TestEqual(TEXT("Not ran is Unreadable"), ClassifyNode(TEXT("C:/node/node.exe"), false, -1, FString()).Status, ELocHubNodeStatus::Unreadable);
	TestEqual(TEXT("Exit code 1 is Unreadable"), ClassifyNode(TEXT("C:/node/node.exe"), true, 1, TEXT("v22.11.0")).Status, ELocHubNodeStatus::Unreadable);
	TestEqual(TEXT("Garbage output is Unreadable"), ClassifyNode(TEXT("C:/node/node.exe"), true, 0, TEXT("garbage")).Status, ELocHubNodeStatus::Unreadable);

	TestTrue(TEXT("Ok has no problem text"), DescribeNodeProblem(ClassifyNode(TEXT("C:/node/node.exe"), true, 0, TEXT("v22.11.0"))).IsEmpty());

	FLocHubNodeCheck NotFound;
	NotFound.Status = ELocHubNodeStatus::NotFound;
	TestTrue(TEXT("NotFound mentions the required version"), DescribeNodeProblem(NotFound).Contains(TEXT("22.11")));
	TestTrue(TEXT("TooOld mentions the found version"), DescribeNodeProblem(TooOld).Contains(TooOld.VersionText));

	FLocHubNodeCheck Unreadable;
	Unreadable.Status = ELocHubNodeStatus::Unreadable;
	Unreadable.Path = TEXT("C:/node/node.exe");
	TestTrue(TEXT("Unreadable mentions the path"), DescribeNodeProblem(Unreadable).Contains(Unreadable.Path));

	FLocHubNodeCheck TimedOut;
	TimedOut.Status = ELocHubNodeStatus::TimedOut;
	TestTrue(TEXT("TimedOut mentions the poll deadline"), DescribeNodeProblem(TimedOut).Contains(TEXT("5 s")));

	TestTrue(TEXT("NotFound points at the settings section"), DescribeNodeProblem(NotFound).Contains(TEXT("Editor Preferences > Plugins > LocHub > Node.js Executable")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentExecutableFileNameTest,
	"LocHub.Environment.ExecutableFileName",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentExecutableFileNameTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	TestEqual(TEXT("Windows node"), ExecutableFileName(TEXT("node"), ELocHubHostOS::Windows), TEXT("node.exe"));
	TestEqual(TEXT("Windows git"), ExecutableFileName(TEXT("git"), ELocHubHostOS::Windows), TEXT("git.exe"));
	TestEqual(TEXT("Mac node"), ExecutableFileName(TEXT("node"), ELocHubHostOS::Mac), TEXT("node"));
	TestEqual(TEXT("Linux node"), ExecutableFileName(TEXT("node"), ELocHubHostOS::Linux), TEXT("node"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentWellKnownNodeDirsTest,
	"LocHub.Environment.WellKnownNodeDirs",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentWellKnownNodeDirsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	const FString Home = TEXT("/home/tester");
	const TArray<FString> MacDirs = WellKnownNodeDirs(ELocHubHostOS::Mac, Home);
	TestTrue(TEXT("Mac: Homebrew (Apple Silicon)"), MacDirs.Contains(TEXT("/opt/homebrew/bin")));
	TestTrue(TEXT("Mac: Homebrew (Intel) / local"), MacDirs.Contains(TEXT("/usr/local/bin")));
	TestTrue(TEXT("Mac: MacPorts"), MacDirs.Contains(TEXT("/opt/local/bin")));
	TestTrue(TEXT("Mac: Volta under home"), MacDirs.Contains(Home / TEXT(".volta/bin")));

	const TArray<FString> LinuxDirs = WellKnownNodeDirs(ELocHubHostOS::Linux, Home);
	TestTrue(TEXT("Linux: /usr/bin"), LinuxDirs.Contains(TEXT("/usr/bin")));
	TestTrue(TEXT("Linux: /usr/local/bin"), LinuxDirs.Contains(TEXT("/usr/local/bin")));
	TestTrue(TEXT("Linux: snap"), LinuxDirs.Contains(TEXT("/snap/bin")));
	TestTrue(TEXT("Linux: Volta under home"), LinuxDirs.Contains(Home / TEXT(".volta/bin")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentVersionManagerRootsTest,
	"LocHub.Environment.VersionManagerRoots",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentVersionManagerRootsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	const FString Home = TEXT("/home/tester");
	using LocHubEnvironmentTestsPrivate::HasRoot;

	const TArray<FLocHubVersionRoot> LinuxRoots = VersionManagerRoots(ELocHubHostOS::Linux, Home);
	TestTrue(TEXT("Linux: nvm"), HasRoot(LinuxRoots, Home / TEXT(".nvm/versions/node")));
	TestTrue(TEXT("Linux: fnm"), HasRoot(LinuxRoots, Home / TEXT(".local/share/fnm/node-versions")));
	TestTrue(TEXT("Linux: asdf"), HasRoot(LinuxRoots, Home / TEXT(".asdf/installs/nodejs")));
	TestTrue(TEXT("Linux: mise"), HasRoot(LinuxRoots, Home / TEXT(".local/share/mise/installs/node")));
	TestFalse(TEXT("Linux: no fnm Application Support root"), HasRoot(LinuxRoots, Home / TEXT("Library/Application Support/fnm/node-versions")));

	const TArray<FLocHubVersionRoot> MacRoots = VersionManagerRoots(ELocHubHostOS::Mac, Home);
	TestTrue(TEXT("Mac: nvm"), HasRoot(MacRoots, Home / TEXT(".nvm/versions/node")));
	TestTrue(TEXT("Mac: fnm Application Support"), HasRoot(MacRoots, Home / TEXT("Library/Application Support/fnm/node-versions")));
	TestEqual(TEXT("Mac has one more root than Linux (fnm Application Support)"), MacRoots.Num(), LinuxRoots.Num() + 1);

	// I-1: Windows has no $HOME-based version-manager convention, and InHomeDir is empty there in practice; either
	// way, a version-manager root must never come back as a garbage relative path.
	TestTrue(TEXT("Windows: no roots at all"), VersionManagerRoots(ELocHubHostOS::Windows, TEXT("C:/Users/tester")).IsEmpty());
	TestTrue(TEXT("Empty home on Linux: no roots"), VersionManagerRoots(ELocHubHostOS::Linux, FString()).IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentSortVersionDirsTest,
	"LocHub.Environment.SortVersionDirsNewestFirst",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentSortVersionDirsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	const TArray<FString> Sorted = SortVersionDirsNewestFirst({ TEXT("22.11.0"), TEXT("junk"), TEXT("v9.0.0"), TEXT("v24.3.0") });
	TestEqual(TEXT("Four entries survive"), Sorted.Num(), 4);
	if (Sorted.Num() == 4)
	{
		TestEqual(TEXT("Newest first"), Sorted[0], TEXT("v24.3.0"));
		TestEqual(TEXT("Then the next"), Sorted[1], TEXT("22.11.0"));
		TestEqual(TEXT("Then the oldest version"), Sorted[2], TEXT("v9.0.0"));
		TestEqual(TEXT("Junk goes last"), Sorted[3], TEXT("junk"));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentLoginShellPathTest,
	"LocHub.Environment.LoginShellPath",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentLoginShellPathTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	TestEqual(TEXT("Mac fallback is zsh"), LoginShellPath(ELocHubHostOS::Mac, FString()), TEXT("/bin/zsh"));
	TestEqual(TEXT("Linux fallback is bash"), LoginShellPath(ELocHubHostOS::Linux, FString()), TEXT("/bin/bash"));
	TestEqual(TEXT("$SHELL wins when set"), LoginShellPath(ELocHubHostOS::Mac, TEXT("/usr/local/bin/fish")), TEXT("/usr/local/bin/fish"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentConfiguredNodeSettingTest,
	"LocHub.Environment.NodeCheck.ConfiguredSetting",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentConfiguredNodeSettingTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString NotNodePath = TempDir / TEXT("not-node.txt");
	LocHubTests::WriteTextFile(NotNodePath, TEXT("not an executable"));

	// I-1: this used to reach FPlatformProcess::CreateProc(NotNodePath) directly on every platform, and on Linux
	// that logged "posix_spawnp() failed" at Error (UnixPlatformProcess.cpp ~1127) once CreateProc's own
	// AttemptToMakeExecIfNotAlready chmod +x still left posix_spawnp failing with ENOEXEC. RunBoundedProcess now
	// launches every candidate through LocHubEnvironment::BuildSpawnCommand's /usr/bin/env wrapper on Mac/Linux, so
	// env is what actually calls posix_spawn/exec and NotNodePath's failure to run it (ENOEXEC) surfaces as env's
	// own exit 126/127 -- nothing in this process logs "posix_spawnp() failed" for it any more, on any platform.

	// A configured setting is checked alone: a bad path there must be reported as bad, never silently skipped in
	// favour of a real node.exe elsewhere on PATH.
	const FLocHubNodeCheck Check = CheckNode(NotNodePath);
	TestNotEqual(TEXT("A bad configured path is never Ok"), Check.Status, ELocHubNodeStatus::Ok);
	TestTrue(TEXT("The check came from the setting"), Check.bFromSetting);
	TestEqual(TEXT("PATH is not searched: the checked path is exactly the configured one"), Check.Path, NotNodePath);
	const FString Problem = DescribeNodeProblem(Check);
	TestTrue(TEXT("The message names the setting"), Problem.Contains(TEXT("Node.js Executable setting")));
	// m-5: a bad candidate that came from the setting is fixed by touching that setting, not by a restart that
	// will not change it.
	TestTrue(TEXT("The message says to fix or clear the setting"), Problem.Contains(TEXT("Fix or clear")));
	TestFalse(TEXT("The message does not suggest a restart"), Problem.Contains(TEXT("restart the editor")));

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentLoginShellNodeArgumentsTest,
	"LocHub.Environment.LoginShellNodeArguments",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentLoginShellNodeArgumentsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	// Non-interactive (-lc, not -lic): an interactive shell in a background process group does job control on the
	// terminal it inherited from the editor and stops there until the bounded poll kills it.
	TestEqual(TEXT("Non-interactive login shell, command -v node"), LoginShellNodeArguments(), TEXT("-lc \"command -v node\""));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentLastExistingAbsolutePathLineTest,
	"LocHub.Environment.LastExistingAbsolutePathLine",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentLastExistingAbsolutePathLineTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	// I-2: an alias or a shell-function wrapper answers "command -v node" without a real path at all, and a path
	// that does not exist on disk must not be accepted just because it looks like one.
	TestTrue(TEXT("An alias line is not a path"), LastExistingAbsolutePathLine(TEXT("alias node='/usr/bin/env node'")).IsEmpty());
	TestTrue(TEXT("A bare function name is not a path"), LastExistingAbsolutePathLine(TEXT("node")).IsEmpty());
	TestTrue(TEXT("A non-existent absolute path is rejected"), LastExistingAbsolutePathLine(TEXT("junk\n/no/such/file/at/all")).IsEmpty());

	// The real function only ever runs on Mac/Linux, where an absolute path starts with "/". On Windows, a path
	// that starts with "/" but names no drive letter is "rooted": the OS resolves it against this process's own
	// current drive, so the fixture below is created there (rather than under FPlatformProcess::UserTempDir(),
	// usually a different drive) to make this half of the test meaningful here too.
	const FString Cwd = FPlatformProcess::GetCurrentWorkingDirectory();
	if (TestTrue(TEXT("The working directory names a drive"), Cwd.Len() > 2 && Cwd[1] == TEXT(':')))
	{
		const FString DriveRoot = Cwd.Left(2);
		const FString FullDir = DriveRoot / TEXT("LocHubEnvironmentTestsTemp") / FGuid::NewGuid().ToString(EGuidFormats::Digits);
		const FString FullFile = FullDir / TEXT("node");
		const FString RootedLine = FullFile.Mid(2);
		LocHubTests::WriteTextFile(FullFile, TEXT("not really node, just needs to exist"));

		TestEqual(TEXT("An existing rooted path after junk is picked"), LastExistingAbsolutePathLine(FString::Printf(TEXT("junk\n%s"), *RootedLine)), RootedLine);
		TestEqual(TEXT("Trailing logout-script text after the path is ignored"), LastExistingAbsolutePathLine(FString::Printf(TEXT("%s\nLogging out\nSession terminated"), *RootedLine)), RootedLine);

		LocHubTests::DeleteTempDir(FullDir);
	}

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentFilterCandidateVersionDirsTest,
	"LocHub.Environment.FilterCandidateVersionDirs",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentFilterCandidateVersionDirsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	// I-3: a directory whose name already says it is below the supported minimum is dropped without ever being
	// worth a "node --version" launch; an unparseable name stays, as a last resort, newest-first among versions.
	const TArray<FString> Filtered = FilterCandidateVersionDirs({ TEXT("v18.20.0"), TEXT("v22.12.0"), TEXT("garbage") });
	TestEqual(TEXT("Below-minimum version dropped, two candidates remain"), Filtered.Num(), 2);
	TestFalse(TEXT("v18.20.0 is not a candidate"), Filtered.Contains(TEXT("v18.20.0")));
	TestTrue(TEXT("v22.12.0 stays a candidate"), Filtered.Contains(TEXT("v22.12.0")));
	TestTrue(TEXT("An unparseable name stays a candidate"), Filtered.Contains(TEXT("garbage")));

	const TArray<FString> Deduplicated = FilterCandidateVersionDirs({ TEXT("v22.12.0"), TEXT("v22.12.0") });
	TestEqual(TEXT("Duplicates collapse into one candidate"), Deduplicated.Num(), 1);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentBuildSpawnCommandTest,
	"LocHub.Environment.BuildSpawnCommand",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentBuildSpawnCommandTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	// Windows: CreateProc still gets InExe/InArgs verbatim -- the Mac/Linux posix_spawn failure modes below do not
	// exist there, so there is nothing to route through env.
	const FLocHubSpawnCommand WindowsCommand = BuildSpawnCommand(TEXT("C:/node/node.exe"), TEXT("--version"), ELocHubHostOS::Windows);
	TestFalse(TEXT("Windows is never rejected"), WindowsCommand.bRejected);
	TestEqual(TEXT("Windows exe unchanged"), WindowsCommand.Exe, TEXT("C:/node/node.exe"));
	TestEqual(TEXT("Windows args unchanged"), WindowsCommand.Args, TEXT("--version"));

	// A '=' in the path only matters to env; Windows spawns InExe directly, so there is nothing to reject.
	TestFalse(TEXT("Windows never rejects on '='"), BuildSpawnCommand(TEXT("C:/a=b/node.exe"), TEXT("--version"), ELocHubHostOS::Windows).bRejected);

	// I-1: on Mac and Linux every candidate is routed through /usr/bin/env, so a file that exists but cannot execute
	// becomes exit 126/127 (already reported as Unreadable) instead of a Fatal posix_spawn (UE 5.6 Mac) or a chmod
	// of the user's file (Linux's CreateProc).
	const TArray<ELocHubHostOS> PosixHosts = { ELocHubHostOS::Mac, ELocHubHostOS::Linux };
	for (const ELocHubHostOS HostOS : PosixHosts)
	{
		const FLocHubSpawnCommand Command = BuildSpawnCommand(TEXT("/opt/homebrew/bin/node"), TEXT("--version"), HostOS);
		TestFalse(TEXT("A normal path is not rejected"), Command.bRejected);
		TestEqual(TEXT("Wrapped through /usr/bin/env"), Command.Exe, TEXT("/usr/bin/env"));
		TestEqual(TEXT("Candidate quoted, original args kept as given"), Command.Args, TEXT("\"/opt/homebrew/bin/node\" --version"));

		// env would read "a=b/node" as an environment assignment, never as a program to run: reject rather than
		// silently mis-launch it.
		TestTrue(TEXT("A path containing '=' is rejected, not wrapped"), BuildSpawnCommand(TEXT("/tmp/a=b/node"), TEXT("--version"), HostOS).bRejected);
	}

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubEnvironmentDisplaySearchPathTest,
	"LocHub.Environment.DisplaySearchPath",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubEnvironmentDisplaySearchPathTest::RunTest(const FString& Parameters)
{
	using namespace LocHubEnvironment;

	// m-4: $HOME collapses to "~" so a warning message does not spell out the user's home directory.
	TestEqual(TEXT("Home prefix collapses to ~"), DisplaySearchPath(TEXT("/home/tester/.volta/bin"), TEXT("/home/tester")), TEXT("~/.volta/bin"));
	TestEqual(TEXT("No home prefix, path unchanged"), DisplaySearchPath(TEXT("/usr/local/bin"), TEXT("/home/tester")), TEXT("/usr/local/bin"));
	// I-1: a Windows env-var path built with FString::operator/ mixes backslash and forward slash; the display
	// copy must not show that mix (empty InHomeDir on Windows makes the ~ collapse a no-op).
	TestEqual(TEXT("Mixed Windows slashes normalize to forward slash"), DisplaySearchPath(TEXT("C:\\Program Files/nodejs"), FString()), TEXT("C:/Program Files/nodejs"));

	return true;
}

#endif
