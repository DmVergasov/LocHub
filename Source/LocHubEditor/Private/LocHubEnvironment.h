// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/**
 * Host platform the discovery functions below build their search tables for. LocHubEnvironment::CurrentHostOS()
 * is the only place that reads PLATFORM_WINDOWS / PLATFORM_MAC to pick one; every function that takes it as a
 * parameter is a pure function of (platform, input), so it compiles and is unit-tested for all three platforms on
 * a Windows machine.
 */
enum class ELocHubHostOS : uint8
{
	Windows,
	Mac,
	Linux,
};

/** A version-manager install root: its immediate children are version directories (SortVersionDirsNewestFirst),
 *  and the tool's executable sits at <RootDir>/<VersionDir>/<BinSuffix>. */
struct FLocHubVersionRoot
{
	FString RootDir;
	FString BinSuffix;
};

/** What LocHubEnvironment::CheckNode found about Node.js on this machine. */
enum class ELocHubNodeStatus : uint8
{
	Ok,			// A supported Node.js (22.11+) was found and answered "node --version"
	NotFound,	// No Node.js found anywhere CheckNode looked
	TooOld,		// Found, but older than 22.11
	Unreadable,	// Found, but "node --version" failed or printed something unparsable
	TimedOut	// Found, but "node --version" did not exit within CheckNode's poll deadline
};

/** Result of LocHubEnvironment::CheckNode / ClassifyNode. */
struct FLocHubNodeCheck
{
	ELocHubNodeStatus Status = ELocHubNodeStatus::NotFound;
	FString Path;			// absolute path of the Node.js executable checked, when there was one to check
	FString VersionText;	// trimmed "node --version" output, e.g. "v20.11.1"

	/** True when the search stopped at the configured Node.js Executable setting (ULocHubUserSettings) instead of
	 *  going on to PATH, well-known install directories and version managers. */
	bool bFromSetting = false;
	/** Where CheckNode looked before giving up, in search order, for DescribeNodeProblem to list. Empty for a
	 *  check built directly by ClassifyNode rather than by a full CheckNode search. */
	TArray<FString> SearchedPlaces;
};

/** What BuildSpawnCommand decided InExe/InArgs should become before FPlatformProcess::CreateProc. bRejected true
 *  means the caller must fail without spawning anything at all (Exe/Args are left empty); otherwise Exe/Args are
 *  exactly what to hand to CreateProc -- unchanged on Windows, or InExe wrapped through /usr/bin/env on Mac/Linux. */
struct FLocHubSpawnCommand
{
	bool bRejected = false;
	FString Exe;
	FString Args;
};

/** Where the project keeps game text, and where tools are on this machine. */
namespace LocHubEnvironment
{
	/** Absolute project folder with a trailing slash. */
	FString GetProjectDir();
	/** "Source" plus the Source folder of every runtime module of an enabled project plugin; relative to the project. */
	TArray<FString> GetGameSourceDirs(const FString& InProjectDir);
	/** "Content" plus the Content folder of every enabled project plugin that can contain content; relative to the project. */
	TArray<FString> GetGameContentDirs(const FString& InProjectDir);
	/** Absolute path of InExecutableName in a PATH folder, or an empty string. */
	FString FindExecutableOnPath(const FString& InExecutableName);

	/** PLATFORM_WINDOWS / PLATFORM_MAC / else Linux: the current host, for the one-line platform choice everything
	 *  else in this file is parameterized on instead of branching internally. */
	ELocHubHostOS CurrentHostOS();
	/** "<InTool>.exe" on Windows; InTool unchanged on Mac and Linux. */
	FString ExecutableFileName(const FString& InTool, ELocHubHostOS InHostOS);
	/** Directories a package manager or the Node.js installer commonly puts node in that a Finder/Launcher-started
	 *  editor's PATH may not include: a GUI-launched Mac process does not inherit the user's shell profile PATH
	 *  (Epic's own GitSourceControlUtils.cpp probes /usr/local/bin and /opt/local/bin directly for the same reason).
	 *  Mac and Linux entries are rooted at InHomeDir; Windows entries read ProgramFiles and LOCALAPPDATA directly,
	 *  so only the Mac/Linux entries are deterministic enough to unit-test. */
	TArray<FString> WellKnownNodeDirs(ELocHubHostOS InHostOS, const FString& InHomeDir);
	/** Version-manager install roots (nvm, fnm, asdf, mise) under InHomeDir; Mac additionally has fnm's Application
	 *  Support location. Empty on Windows -- there is no $HOME-based version-manager convention there -- and empty
	 *  whenever InHomeDir itself is empty, which would otherwise build a path relative to the working directory
	 *  instead of one rooted at nothing. */
	TArray<FLocHubVersionRoot> VersionManagerRoots(ELocHubHostOS InHostOS, const FString& InHomeDir);
	/** Descending by version ("v22.11.0" and "22.11.0" both parse); a name that does not parse as a dotted numeric
	 *  version sorts after every one that does, keeping its relative order among themselves. */
	TArray<FString> SortVersionDirsNewestFirst(TArray<FString> InVersionDirs);
	/** InVersionDirs, sorted newest first (SortVersionDirsNewestFirst) and reduced to the ones worth a bounded
	 *  "node --version" launch: a name whose parsed version is already below IsNodeVersionSupported's minimum is
	 *  dropped -- the directory name alone answers the question, so launching node for it would only waste a
	 *  bounded poll on the game/pool thread -- while a name that does not parse as a version stays, as a last
	 *  resort, in SortVersionDirsNewestFirst's order. Also de-duplicates by name. */
	TArray<FString> FilterCandidateVersionDirs(TArray<FString> InVersionDirs);
	/** InShellEnvVar (typically $SHELL), or the platform default when it is empty -- a GUI-launched editor can have
	 *  no $SHELL at all: /bin/zsh on Mac, /bin/bash on Linux. */
	FString LoginShellPath(ELocHubHostOS InHostOS, const FString& InShellEnvVar);
	/** "-lc \"command -v node\"": non-interactive (-lc, not -lic) so the shell never does job control on the
	 *  terminal it inherited from the editor, while -l still sources the login profile (.zprofile/.bash_profile/
	 *  .profile, e.g. Homebrew's shellenv) that a GUI-launched editor's PATH misses. Exposed as a pure function so
	 *  the exact argument string is unit-tested. */
	FString LoginShellNodeArguments();
	/** The last line of InText that is an absolute path to an existing file, trimmed; empty when none qualifies.
	 *  "command -v node" answers unreliably: an alias prints "alias node='...'", a lazy nvm shell-function wrapper
	 *  prints bare "node", a terminal title escape sequence without its own newline can glue onto the real path,
	 *  and .bash_logout/.zlogout run (and can print) after the command exits. Every line is tried from the end and
	 *  a non-match is skipped rather than accepted as the final answer. */
	FString LastExistingAbsolutePathLine(const FString& InText);
	/** InPath for a user-facing "Looked in" list: an InHomeDir prefix collapsed to "~" (a no-op when InHomeDir is
	 *  empty, i.e. on Windows) and slashes normalized to "/", so a Windows env-var path built with backslashes
	 *  (e.g. %ProgramFiles%) does not show up half-slash, half-backslash next to Mac/Linux's forward-slash paths. */
	FString DisplaySearchPath(const FString& InPath, const FString& InHomeDir);

	/** Pure: what RunBoundedProcess should hand FPlatformProcess::CreateProc for InExe InArgs on InHostOS, instead
	 *  of spawning InExe directly. On Mac and Linux, a file that exists but cannot execute makes posix_spawn Fatal
	 *  on UE 5.6 Mac (MacPlatformProcess.cpp:544-547) and makes the Unix CreateProc chmod +x the user's file
	 *  (UnixPlatformProcess.cpp's AttemptToMakeExecIfNotAlready); /usr/bin/env always spawns, turning "cannot
	 *  execute" into exit 126/127, which ClassifyNode already reports as Unreadable, and execs in place (same pid,
	 *  same process group), so LocHubChildProcess::Terminate needs no change. A path containing '=' is rejected
	 *  instead of wrapped, since env would read "a=b/node" as an environment assignment, never as a program to run.
	 *  Windows: InExe/InArgs unchanged, never rejected. Parameterized by InHostOS rather than #if so it compiles
	 *  and is unit-tested for all three hosts on a Windows machine. */
	FLocHubSpawnCommand BuildSpawnCommand(const FString& InExe, const FString& InArgs, ELocHubHostOS InHostOS);

	/** "v22.11.0" -> 22, 11. */
	bool ParseNodeVersion(const FString& InVersionText, int32& OutMajor, int32& OutMinor);
	/** Node 22.11 or newer. */
	bool IsNodeVersionSupported(int32 InMajor, int32 InMinor);
	/** Pure: classifies what a version check observed; no process, no disk. */
	FLocHubNodeCheck ClassifyNode(const FString& InPath, bool bInRan, int32 InReturnCode, const FString& InVersionOutput);
	/**
	 * Finds a supported Node.js and returns the first candidate a bounded "node --version" (5 s poll) calls Ok,
	 * searching in this order: the configured Node.js Executable setting alone, when it is set; PATH;
	 * WellKnownNodeDirs; VersionManagerRoots via FilterCandidateVersionDirs (newest version first, dirs below the
	 * supported minimum skipped without a launch); and, on Mac/Linux only, as a last resort, LoginShellNodeArguments
	 * through the same bounded poll -- computed at most once per editor session and skipped when it names a
	 * candidate already tried above. Every candidate is checked at most once (de-duplicated by its normalized full
	 * path). When nothing is Ok, the best non-Ok result (e.g. a TooOld found on PATH beats a NotFound from an empty
	 * well-known dir) is returned with FLocHubNodeCheck::SearchedPlaces filled in for DescribeNodeProblem.
	 * InConfiguredPathOverride is a test seam: unset (the default) reads ULocHubUserSettings::NodeExecutable; a
	 * test passes a path directly instead, so "the setting names a bad path" can be exercised without touching the
	 * user's real settings object.
	 */
	FLocHubNodeCheck CheckNode(TOptional<FString> InConfiguredPathOverride = TOptional<FString>());
	/** English, user-facing; empty for Ok. NotFound: "Node.js 22.11 or newer was not found." TooOld: "Node.js
	 *  <VersionText> is too old. LocHub needs Node.js 22.11 or newer." Unreadable: "Node.js at <Path> did not
	 *  report its version. Install Node.js 22.11 or newer." TimedOut: "node --version did not answer within 5 s."
	 *  Every non-Ok status then lists InCheck.SearchedPlaces (when CheckNode filled them in), then either points at
	 *  Editor Preferences > Plugins > LocHub > Node.js Executable, or, when InCheck.bFromSetting is true (the
	 *  setting itself was the bad candidate), says to fix or clear that setting instead. */
	FString DescribeNodeProblem(const FLocHubNodeCheck& InCheck);
}
