// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "LocHubTargetPaths.h"
#include "LocHubTypes.h"

class FLocHubGlyphChecker;
class FLocHubServiceClient;
class FLocHubServiceProcess;
class FLocHubSyncLock;
class FLocTextHelper;
class ULocalizationTarget;
struct FLocHubDevNotesProposal;
struct FLocHubHttpResult;

/** Everything a Push or Pull needs besides the service: built from the settings in the editor, by hand in tests. */
struct FLocHubSyncContext
{
	/** Target files, ULocHubSettings and project roots; bLoadGlyphFonts loads the glyph check fonts (Pull needs them). */
	static FLocHubSyncContext MakeForTarget(const ULocalizationTarget& InTarget, bool bLoadGlyphFonts);

	/** Absolute, with a trailing slash; the lock and the proposals file live under its Saved/LocHub. */
	FString ProjectDir;
	FLocHubTargetPaths Target;
	TArray<FString> UiSourcePatterns;
	TArray<FString> CoverageExcludePatterns;
	/** Absolute folders. */
	TArray<FString> CoverageSourceRoots;
	TArray<FString> CoverageContentRoots;
	TSharedPtr<FLocHubGlyphChecker> GlyphChecker;
	/** Report lines known before the run (for example why the glyph check is off). */
	TArray<FString> Notes;
	/** Release policy the settings ask for; Pull reports when the service exports with another one. */
	FString ExpectedPolicy;
	bool bScanCoverage = true;
	/** FTextLocalizationManager::RefreshResources after Pull; never in a commandlet. */
	bool bRefreshLiveText = true;
	bool bWriteAssetDevNotes = true;
};

struct FLocHubPushOptions
{
	/** Stop after the dry run and report its numbers. */
	bool bDryRunOnly = false;
	/** Asked when the dry run would retire strings; false cancels. Unset: go on without asking (CI). */
	TFunction<bool(const FLocHubPushReport&)> ConfirmTombstones;
};

struct FLocHubSyncResult
{
	bool bSuccess = false;
	bool bCancelled = false;
	/** One line for a notification. */
	FString Summary;
	/** Report lines for the Output Log. */
	TArray<FString> Details;
	FLocHubPushReport PushReport;
	int32 Written = 0;
	int32 Rejected = 0;
};

/** One Push or Pull at a time, under Saved/LocHub/sync.lock; every step continues from an HTTP callback. */
class FLocHubSyncRunner : public TSharedFromThis<FLocHubSyncRunner>
{
public:
	using FOnFinished = TFunction<void(const FLocHubSyncResult&)>;

	explicit FLocHubSyncRunner(TSharedRef<FLocHubServiceProcess> InService);
	~FLocHubSyncRunner();

	bool IsBusy() const;
	/** Calls back exactly once; synchronously when busy or when the lock is taken. */
	void Push(FLocHubSyncContext InContext, FLocHubPushOptions InOptions, FOnFinished InOnFinished);
	/** Calls back exactly once; synchronously when busy or when the lock is taken. */
	void Pull(FLocHubSyncContext InContext, FOnFinished InOnFinished);

	/** Test seam: delay before an ack retry; automation tests set this to 0 to skip the wait. */
	float AckRetryDelaySeconds = 1.0f;

private:
	using FHttpStep = void (FLocHubSyncRunner::*)(const FLocHubHttpResult&);
	using FReadyStep = void (FLocHubSyncRunner::*)(bool, const FString&);

	bool Begin(const FString& InProjectDir, const TCHAR* InOperation, FOnFinished&& InOnFinished);
	void Finish();
	void Fail(const FString& InSummary);
	TFunction<void(const FLocHubHttpResult&)> BindStep(FHttpStep InStep);
	TFunction<void(bool, const FString&)> BindReady(FReadyStep InStep);
	FLocHubServiceClient MakeClient() const;

	void PushOnServiceReady(bool bOk, const FString& InError);
	void PushOnDryRun(const FLocHubHttpResult& InResult);
	void PushOnFinal(const FLocHubHttpResult& InResult);

	void PullOnServiceReady(bool bOk, const FString& InError);
	void PullOnReconcile(const FLocHubHttpResult& InResult);
	void PullNextCulture();
	void PullOnExport(const FLocHubHttpResult& InResult);
	void PullCompile();
	void PullNextAck();
	void PullOnAck(const FLocHubHttpResult& InResult);
	void PullOnInbox(const FLocHubHttpResult& InResult);
	void PullOnApplied(const FLocHubHttpResult& InResult);
	void PullFinish();
	void ApplyAnswerGroup(const TArray<const FLocHubInboxRow*>& InRows, TArray<FLocHubDevNotesProposal>& OutProposals);
	FString FindManifestDevNotes(const FString& InNamespace, const FString& InKey) const;

	TSharedRef<FLocHubServiceProcess> Service;
	TUniquePtr<FLocHubSyncLock> Lock;
	bool bBusy = false;
	FOnFinished OnFinished;
	FString Operation;
	FLocHubSyncContext Context;
	FLocHubPushOptions PushOptions;
	FLocHubSyncResult Result;
	FString SnapshotJson;
	/** Body of POST /api/reconcile: the archives Pull is about to export, built before the first GET /api/export. */
	FString ReconcileJson;
	TSharedPtr<FLocTextHelper> Helper;
	TArray<FString> PendingCultures;
	FString CurrentCulture;
	TArray<FLocHubExportAck> PendingAcks;
	/** The acknowledgement in flight, kept for a resend. */
	FString CurrentAckJson;
	int32 AckAttempts = 0;
	/** One-shot retry timer for a failed ack; removed in Finish() and the destructor. */
	FTSTicker::FDelegateHandle AckRetryTickerHandle;
	TArray<FString> AppliedIds;
	bool bPartialFailure = false;
	/** Cultures whose archive was actually written to disk this Pull, for the partial-update notice. */
	TArray<FString> UpdatedCultures;
};
