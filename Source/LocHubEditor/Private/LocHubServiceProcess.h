// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "HAL/PlatformProcess.h"

struct FLocHubHealth;

/**
 * Keeps "node <plugin>/Resources/LocHubService/lochub_service.mjs serve" available on the configured port. A service still owned by a
 * live host (this or another editor or LocHubSync commandlet of this project) is used as is and never stopped; a
 * service left behind by a host that is no longer running is adopted and stopped like one this instance started
 * itself. It only ever owns a process whose pid a healthy /api/health answer
 * confirms -- never one identified by a pid file alone.
 */
class FLocHubServiceProcess : public TSharedFromThis<FLocHubServiceProcess>
{
public:
	struct FConfig
	{
		int32 Port = 47810;
		bool bAutoStart = true;
		/** "validated" or "approved_only" (ULocHubSettings::ReleasePolicyToString). */
		FString Policy = TEXT("validated");
		/** "anthropic", "openai", "xai", "deepseek" or "gemini" (ULocHubSettings::AiProviderToString); passed to --provider. */
		FString Provider = TEXT("anthropic");
		/** "api" or "subscription"; only Anthropic may use "subscription". Passed to --auth. */
		FString Auth = TEXT("api");
		/** Model IDs of the selected provider; passed to --translate-model / --judge-model (empty: Anthropic uses the service defaults, any other provider fails to start). */
		FString TranslateModel;
		FString JudgeModel;
		/** Absolute project folder without a trailing slash; passed to --project. */
		FString ProjectDir;
		/** Absolute path of Resources/LocHubService/lochub_service.mjs. */
		FString ServiceScript;
		/** Absolute Resources/LocHubWeb, the web app; passed to --web-dir. */
		FString WebDir;
		/** Absolute Source/ThirdParty/LocHubWebDeps, the web app's npm packages; passed to --web-deps-dir. */
		FString WebDepsDir;
		/** Folder of service.pid, service.log and brief.md. */
		FString StateDir;
		/** Lowercase hex SHA-1 of the brief.md bytes MakeDefaultConfig just wrote (WriteBriefFile); compared against
		 *  FLocHubHealth::AiBriefSha1 by IsAiConfigApplied so a Project Settings brief edit gets the same
		 *  apply-now-or-after-the-job restart as a provider/model change. */
		FString BriefSha1;
		/** The active provider's API key (ULocHubSettings::GetActiveApiKey), set as the LOCHUB_API_KEY environment
		 *  variable of the spawned child only, immediately around FPlatformProcess::CreateProc (see StartNode) --
		 *  never read back afterwards, never logged, and never put on the "serve" command line. Empty means no key. */
		FString ApiKey;
		/** ComputeKeyId(ApiKey); compared against FLocHubHealth::AiKeyId by IsAiConfigApplied so a Project Settings
		 *  key edit gets the same apply-now-or-after-the-job restart as a provider/model change, without ever
		 *  comparing or logging the key itself. */
		FString KeyId;
	};

	using FOnReady = TFunction<void(bool bOk, const FString& InError)>;

	explicit FLocHubServiceProcess(FConfig InConfig);
	~FLocHubServiceProcess();

	/** Settings of ULocHubSettings, the LocHub plugin folder and <Project>/Saved/LocHub. */
	static FConfig MakeDefaultConfig();
	static FString BuildServeArguments(const FConfig& InConfig);
	/** True when InHealth reports no "ai" object (an old build: provider empty, nothing to compare) or when its
	 *  provider and auth match InConfig's and each model matches InConfig's -- or InConfig's model is empty, meaning
	 *  the service picked its own default and there is nothing to compare -- and the brief hashes match, unless either
	 *  side has none (an old service build; a brief.md WriteBriefFile could not write), and the key ids match, unless
	 *  InHealth has no "keyId" field at all (an old service build: nothing to compare -- but, unlike the brief hash,
	 *  an explicitly empty key id on both sides still counts as a match, not a skip; key-contract.md §3). Case-sensitive:
	 *  both sides are the same wire names (ULocHubSettings::AiProviderToString and the auth equivalent). */
	static bool IsAiConfigApplied(const FConfig& InConfig, const FLocHubHealth& InHealth);
	/** Lowercase hex SHA-1 of InText's UTF-8 bytes (no BOM) -- the same bytes WriteBriefFile writes and the same
	 *  encoding cli.ts hashes on the Node side. Pinned against Node's crypto in LocHub.Service.BriefSha1Utf8. */
	static FString HashBriefUtf8(const FString& InText);
	/** Writes InBrief to InPath as UTF-8 without BOM (creating its directory), and returns HashBriefUtf8(InBrief) --
	 *  the hash of exactly the bytes just written, or an empty string (and an Error log naming the path) when the
	 *  file could not be written. Called by MakeDefaultConfig for --brief-file before every service start, so the
	 *  running process always has a fresh snapshot of the Project Settings brief. */
	static FString WriteBriefFile(const FString& InPath, const FString& InBrief);
	/** True when it is safe to signal a process previously adopted under InAdoptedExecutable now that its executable
	 *  reads InCurrentExecutable: an empty InAdoptedExecutable means this instance started the process itself
	 *  (nothing to compare, always safe); otherwise the pid may have been reused since adoption unless the two
	 *  exactly match. Guards StopProcess against signalling an adopted pid whose original process died and was
	 *  reused by an unrelated one (Mac, Linux < 5.8: an adopted handle is a bare pid with no ticker watching it die). */
	static bool MayStopAdoptedPid(const FString& InAdoptedExecutable, const FString& InCurrentExecutable);
	/** First 12 lowercase hex characters of HashBriefUtf8(InKey) (key-contract.md §3), or an empty string when
	 *  InKey is empty. Test vector: "abc" -> "a9993e364706". */
	static FString ComputeKeyId(const FString& InKey);
	/** Name of the environment variable set for the spawned "lochub serve" process only (key-contract.md §1); the
	 *  editor's own copy is never read except to capture and restore it around the spawn (see StartNode and
	 *  FLocHubScopedEnvVar). */
	static const TCHAR* const ApiKeyEnvVarName;

	FString GetBaseUrl() const;
	const FConfig& GetConfig() const;
	/** Used from the next start of the own process on; a running process keeps its port and policy until Restart. */
	void SetConfig(FConfig InConfig);

	/** Calls back once GET /api/health answers; starts node when nothing answers and auto start is on. */
	void EnsureRunning(FOnReady InOnReady);
	/** Like EnsureRunning, but a health answer that never comes never starts a process: for probing a service this
	 *  editor may not own yet (an orphan not yet adopted, or one that turns out to be another host's) without
	 *  starting a service that was never running in the first place. Calls back bOk = true with an empty error when
	 *  nothing answers -- there is no running process to apply settings to, and the next start reads the current
	 *  Config anyway. */
	void ProbeOnly(FOnReady InOnReady);
	/** Stops the own process and starts again; fails with an error if a healthy answer then comes from a service
	 *  this editor never owned. */
	void Restart(FOnReady InOnReady);
	/** Stops the own process; waiting callbacks get an error. */
	void Stop();
	bool IsOwnedProcessRunning() const;
	FString GetLogFilePath() const;
	FString GetPidFilePath() const;
	/** How many processes this instance owned that were no longer running once it had terminated them. Test seam: a
	 *  stale pid file alone must never move this counter. */
	int32 GetTerminatedProcessCount() const;
	/** True while an AI settings mismatch found during a running translation job is waiting for that job to end
	 *  before the owned process is restarted. Test seam: lets a test observe the deferred-restart wait without a
	 *  new fake-service round trip. */
	bool IsAiRestartPending() const;
	/** True once the one AI-mismatch restart for the current Config has been attempted. Test seam: lets a test see
	 *  SetConfig re-arm the attempt without driving a second restart through a fake service. */
	bool IsAiRestartTried() const;

	/** Test seam: true when a process with this pid is running. Production forwards to
	 *  FPlatformProcess::IsApplicationRunning; a test overrides it so a pid-file host's liveness can be faked
	 *  without a real second process: two hosts of one project must not adopt each other's live
	 *  service. Used only to check the host recorded in service.pid, never the node process itself. */
	TFunction<bool(uint32 InPid)> IsPidRunningFn = [](const uint32 InPid) { return FPlatformProcess::IsApplicationRunning(InPid); };

	/** Test seam: terminates the process behind InHandle, pid InPid. Production (set in the constructor) is
	 *  LocHubChildProcess::Terminate, graceful, which also waits for the exit; a test overrides it so an adopted
	 *  process is never actually killed. StopProcess() is the only place in this class that stops a process, so
	 *  this is also the one choke point a reintroduced "kill whatever pid service.pid names" regression would have
	 *  to go through. */
	TFunction<void(FProcHandle& InHandle, uint32 InPid)> TerminateProcessFn;

	/** Test seam: spawns "lochub serve". Production forwards to FPlatformProcess::CreateProc with the same launch
	 *  flags StartNode always uses (detached, hidden, really hidden, no priority modifier, no stdin pipe); a test
	 *  overrides it to observe the handover -- the LOCHUB_API_KEY value the child would have seen and whether
	 *  LocHubProcessSpawnLock was held while it ran -- without spawning a real node process. StartNode is the only
	 *  place in this class that spawns a process, so this is also the one choke point a reintroduced "set the env
	 *  var outside the lock, or after the spawn" regression would have to go through. */
	TFunction<FProcHandle(const FString& InExe, const FString& InArgs, const FString& InWorkingDir, void* InPipeWrite, uint32& OutPid)> CreateProcessFn =
		[](const FString& InExe, const FString& InArgs, const FString& InWorkingDir, void* InPipeWrite, uint32& OutPid)
		{
			return FPlatformProcess::CreateProc(*InExe, *InArgs, false, true, true, &OutPid, 0, *InWorkingDir, InPipeWrite, nullptr);
		};

	/** True while something is talking to the owned process directly, past EnsureRunning (a Push or Pull mid-sync):
	 *  the pending-restart ticker must not stop it out from under that request. Wired once, by
	 *  FLocHubEditorModule::StartupModule, to FLocHubSyncRunner::IsBusy(); unset (the default) in tests that do not
	 *  exercise this gate. */
	TFunction<bool()> IsServiceInUseFn;

private:
	void ProbeHealth();
	void OnHealthProbed(uint32 InGeneration, const FLocHubHealth& InHealth, bool bHealthy);
	/** Calls StartNode and moves this instance into "starting" on success, or fails the waiters on error. */
	void StartOrFail();
	bool StartNode(FString& OutError);
	bool OnTick(float InDeltaTime);
	void DrainOutput();
	void StopProcess();
	/** Deletes a leftover service.pid without touching whatever process it names. */
	void RemoveStalePidFile();
	/** While we own no process: if service.pid names the pid a healthy answer just confirmed, take ownership of it. */
	void TryAdoptOrphan(uint32 InHealthPid);
	void FinishWaiters(bool bOk, const FString& InError);
	/** Starts (if not already running) the ticker that re-probes every few seconds while an AI-mismatch restart is
	 *  waiting for a running translation job to end. */
	void StartAiRestartPendingTicker();
	/** Resets the pending flag and removes its ticker; safe to call when neither is set. */
	void ClearAiRestartPending();

	FConfig Config;
	TArray<FOnReady> Waiters;
	bool bProbing = false;
	bool bStarting = false;
	/** Set by Restart(): the probe that follows must restart a service it owns or adopts, not only keep it, even
	 *  when its data is not stale. Consumed (reset) by the next OnHealthProbed. */
	bool bRestartRequested = false;
	/** True once an AI-mismatch restart has been attempted for the current Config, so OnHealthProbed never loops
	 *  restarting a service whose fresh process still disagrees. Reset by SetConfig whenever Provider/Auth/
	 *  TranslateModel/JudgeModel/KeyId/BriefSha1 differ from the previous Config. */
	bool bAiRestartTried = false;
	/** True while an AI-mismatch restart is deferred behind a running translation job; drives AiRestartPendingTickerHandle
	 *  and gates the one-per-deferral user notification. Cleared on a match, on a restart, on Stop() and in the
	 *  destructor. */
	bool bAiRestartPending = false;
	/** Re-probes through EnsureRunning while bAiRestartPending is set and the process is still ours. */
	FTSTicker::FDelegateHandle AiRestartPendingTickerHandle;
	/** Set by ProbeOnly(): the next probe must not start a process when nothing answers healthy. Consumed (reset)
	 *  by the next OnHealthProbed, the same way bRestartRequested is. */
	bool bProbeOnlyRequested = false;
	double StartDeadline = 0.0;
	/** Bumped by Stop(); a probe's answer is ignored once its captured generation falls behind. */
	uint32 ProbeGeneration = 0;

	/** FPlatformProcess::IsProcRunning takes a non-const handle. */
	mutable FProcHandle ProcessHandle;
	uint32 ProcessId = 0;
	/** Executable of an adopted process, captured by TryAdoptOrphan when OpenProcess succeeded; empty for a process
	 *  this instance started itself (StartNode). Reset alongside ProcessId in StopProcess. */
	FString AdoptedExecutable;
	void* PipeRead = nullptr;
	void* PipeWrite = nullptr;
	/** Service output read from PipeRead but not yet written to service.log: an incomplete UTF-8 sequence at the end
	 *  of one read, completed by the next. */
	TArray<uint8> PendingOutputBytes;
	FTSTicker::FDelegateHandle TickerHandle;
	int32 TerminatedProcessCount = 0;
};
