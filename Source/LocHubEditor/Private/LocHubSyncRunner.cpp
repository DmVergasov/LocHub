// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSyncRunner.h"

#include "Containers/Ticker.h"
#include "HAL/FileManager.h"
#include "Internationalization/InternationalizationManifest.h"
#include "Internationalization/TextLocalizationManager.h"
#include "Internationalization/TextLocalizationResource.h"
#include "LocHubCoverage.h"
#include "LocHubDevNotes.h"
#include "LocHubEnvironment.h"
#include "LocHubGlyphChecker.h"
#include "LocHubImport.h"
#include "LocHubJson.h"
#include "LocHubServiceClient.h"
#include "LocHubServiceProcess.h"
#include "LocHubSettings.h"
#include "LocHubSnapshot.h"
#include "LocHubSyncLock.h"
#include "LocTextHelper.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

namespace LocHubSyncRunnerPrivate
{
	/** POST /api/export/ack is sent at most this many times per culture (contract: retry a failed acknowledgement). */
	constexpr int32 MaxAckAttempts = 3;

	FString DescribeReport(const TCHAR* InWhat, const FLocHubPushReport& InReport)
	{
		return FString::Printf(TEXT("%s: %d added, %d changed, %d cosmetic, %d retired, %d revived, %d human edits kept."),
			InWhat, InReport.Added, InReport.Changed, InReport.Cosmetic, InReport.Tombstoned, InReport.Revived, InReport.HumanEdits);
	}

	FString ProposalsPath(const FString& InProjectDir)
	{
		return InProjectDir / TEXT("Saved/LocHub/DevNotesProposals.md");
	}
}

FLocHubSyncContext FLocHubSyncContext::MakeForTarget(const ULocalizationTarget& InTarget, const bool bLoadGlyphFonts)
{
	const ULocHubSettings* Settings = GetDefault<ULocHubSettings>();

	FLocHubSyncContext NewContext;
	NewContext.ProjectDir = LocHubEnvironment::GetProjectDir();
	NewContext.Target = FLocHubTargetPaths::FromTarget(InTarget);
	NewContext.UiSourcePatterns = Settings->UiSourcePatterns;
	NewContext.CoverageExcludePatterns = Settings->CoverageExcludePatterns;
	for (const FString& Dir : LocHubEnvironment::GetGameSourceDirs(NewContext.ProjectDir))
	{
		NewContext.CoverageSourceRoots.Add(NewContext.ProjectDir / Dir);
	}
	for (const FString& Dir : LocHubEnvironment::GetGameContentDirs(NewContext.ProjectDir))
	{
		NewContext.CoverageContentRoots.Add(NewContext.ProjectDir / Dir);
	}
	NewContext.ExpectedPolicy = ULocHubSettings::ReleasePolicyToString(Settings->ReleasePolicy);
	NewContext.bWriteAssetDevNotes = Settings->bWriteDevNotesToAssets;
	if (bLoadGlyphFonts)
	{
		NewContext.GlyphChecker = FLocHubGlyphChecker::FromSettings(*Settings, NewContext.ProjectDir, NewContext.Notes);
	}
	return NewContext;
}

FLocHubSyncRunner::FLocHubSyncRunner(TSharedRef<FLocHubServiceProcess> InService)
	: Service(MoveTemp(InService))
{
}

FLocHubSyncRunner::~FLocHubSyncRunner()
{
	if (AckRetryTickerHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(AckRetryTickerHandle);
	}
}

bool FLocHubSyncRunner::IsBusy() const
{
	return bBusy;
}

void FLocHubSyncRunner::Push(FLocHubSyncContext InContext, FLocHubPushOptions InOptions, FOnFinished InOnFinished)
{
	if (!Begin(InContext.ProjectDir, TEXT("Push"), MoveTemp(InOnFinished)))
	{
		return;
	}
	Context = MoveTemp(InContext);
	PushOptions = MoveTemp(InOptions);

	FLocHubSnapshot Snapshot;
	FString Error;
	if (!LocHubSnapshot::Build(Context.Target, Context.UiSourcePatterns, Snapshot, Error))
	{
		Fail(TEXT("LocHub Push failed: ") + Error);
		return;
	}
	if (Context.bScanCoverage)
	{
		Snapshot.bHasCoverage = true;
		LocHubCoverage::ScanRoots(Context.ProjectDir, Context.CoverageSourceRoots, Context.CoverageContentRoots, Context.CoverageExcludePatterns, Snapshot.Coverage);
	}
	Result.Details.Add(FString::Printf(TEXT("Snapshot of %s: %d strings, %d coverage findings."), *Snapshot.Target, Snapshot.Entries.Num(), Snapshot.Coverage.Num()));
	SnapshotJson = LocHubJson::SnapshotToJson(Snapshot);

	Service->EnsureRunning(BindReady(&FLocHubSyncRunner::PushOnServiceReady));
}

void FLocHubSyncRunner::Pull(FLocHubSyncContext InContext, FOnFinished InOnFinished)
{
	if (!Begin(InContext.ProjectDir, TEXT("Pull"), MoveTemp(InOnFinished)))
	{
		return;
	}
	Context = MoveTemp(InContext);
	Result.Details.Append(Context.Notes);

	FText LoadError;
	Helper = Context.Target.LoadHelper(LoadError);
	if (!Helper.IsValid())
	{
		Fail(FString::Printf(TEXT("LocHub Pull failed: cannot read target %s: %s"), *Context.Target.TargetName, *LoadError.ToString()));
		return;
	}
	PendingCultures = Context.Target.ForeignCultures;

	// Reconciled before the first export, exactly like Push: an archive edited outside LocHub since the last
	// Push must become a human_edit before the export loop can overwrite it.
	FLocHubSnapshot Snapshot;
	FString Error;
	if (!LocHubSnapshot::Build(Context.Target, Context.UiSourcePatterns, Snapshot, Error))
	{
		Fail(TEXT("LocHub Pull failed: ") + Error);
		return;
	}
	ReconcileJson = LocHubJson::ArchivesToJson(Snapshot.Archives);

	Service->EnsureRunning(BindReady(&FLocHubSyncRunner::PullOnServiceReady));
}

bool FLocHubSyncRunner::Begin(const FString& InProjectDir, const TCHAR* InOperation, FOnFinished&& InOnFinished)
{
	if (bBusy)
	{
		FLocHubSyncResult Busy;
		Busy.Summary = FString::Printf(TEXT("LocHub %s skipped: another Push or Pull is running."), InOperation);
		if (InOnFinished)
		{
			InOnFinished(Busy);
		}
		return false;
	}

	const FString LockPath = FLocHubSyncLock::GetDefaultPath(InProjectDir);
	const FString HolderName = FString::Printf(TEXT("%s (%s)"), InOperation, IsRunningCommandlet() ? TEXT("commandlet") : TEXT("editor"));
	TUniquePtr<FLocHubSyncLock> NewLock = MakeUnique<FLocHubSyncLock>();
	FString CurrentHolder;
	if (!NewLock->TryAcquire(LockPath, HolderName, CurrentHolder))
	{
		FLocHubSyncResult Locked;
		Locked.Summary = FString::Printf(TEXT("LocHub %s skipped: %s is held by %s."), InOperation, *LockPath, *CurrentHolder);
		if (InOnFinished)
		{
			InOnFinished(Locked);
		}
		return false;
	}

	bBusy = true;
	Lock = MoveTemp(NewLock);
	OnFinished = MoveTemp(InOnFinished);
	Operation = InOperation;
	Result = FLocHubSyncResult();
	SnapshotJson.Reset();
	ReconcileJson.Reset();
	Helper.Reset();
	PendingCultures.Reset();
	CurrentCulture.Reset();
	PendingAcks.Reset();
	CurrentAckJson.Reset();
	AckAttempts = 0;
	AppliedIds.Reset();
	bPartialFailure = false;
	UpdatedCultures.Reset();
	return true;
}

void FLocHubSyncRunner::Finish()
{
	if (AckRetryTickerHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(AckRetryTickerHandle);
		AckRetryTickerHandle.Reset();
	}
	Lock.Reset();
	Helper.Reset();
	bBusy = false;

	// The callback may start the next run at once, so the state is handed over before it is called.
	FOnFinished Callback = MoveTemp(OnFinished);
	OnFinished = nullptr;
	const FLocHubSyncResult Finished = MoveTemp(Result);
	Result = FLocHubSyncResult();
	if (Callback)
	{
		Callback(Finished);
	}

	// Released only now that the callback has everything it needs: fonts held by the glyph checker's
	// TStrongObjectPtr<UFont>, megabytes of snapshot and reconcile JSON. Skipped if the callback already started a
	// new run -- bBusy is back on by then, and this must not clear state that new run just set up.
	if (!bBusy)
	{
		Context = FLocHubSyncContext();
		PushOptions = FLocHubPushOptions();
		SnapshotJson.Reset();
		ReconcileJson.Reset();
	}
}

void FLocHubSyncRunner::Fail(const FString& InSummary)
{
	Result.bSuccess = false;
	Result.Summary = InSummary;
	if (!UpdatedCultures.IsEmpty())
	{
		// The archive of an earlier culture in this Pull is already on disk without its ack; say so.
		Result.Summary += FString::Printf(TEXT(" Archives of %s were updated; run Pull again to finish."), *FString::Join(UpdatedCultures, TEXT(", ")));
	}
	Finish();
}

TFunction<void(const FLocHubHttpResult&)> FLocHubSyncRunner::BindStep(const FHttpStep InStep)
{
	const TWeakPtr<FLocHubSyncRunner> WeakSelf = AsWeak();
	return [WeakSelf, InStep](const FLocHubHttpResult& InResult)
	{
		if (const TSharedPtr<FLocHubSyncRunner> This = WeakSelf.Pin())
		{
			(This.Get()->*InStep)(InResult);
		}
	};
}

TFunction<void(bool, const FString&)> FLocHubSyncRunner::BindReady(const FReadyStep InStep)
{
	const TWeakPtr<FLocHubSyncRunner> WeakSelf = AsWeak();
	return [WeakSelf, InStep](const bool bOk, const FString& InError)
	{
		if (const TSharedPtr<FLocHubSyncRunner> This = WeakSelf.Pin())
		{
			(This.Get()->*InStep)(bOk, InError);
		}
	};
}

FLocHubServiceClient FLocHubSyncRunner::MakeClient() const
{
	return FLocHubServiceClient(Service->GetBaseUrl());
}

void FLocHubSyncRunner::PushOnServiceReady(const bool bOk, const FString& InError)
{
	if (!bOk)
	{
		Fail(TEXT("LocHub Push failed: ") + InError);
		return;
	}
	MakeClient().Push(SnapshotJson, true, BindStep(&FLocHubSyncRunner::PushOnDryRun));
}

void FLocHubSyncRunner::PushOnDryRun(const FLocHubHttpResult& InResult)
{
	FLocHubPushReport Report;
	if (!InResult.IsOk() || !LocHubJson::ParsePushReport(InResult.Body, Report))
	{
		Fail(InResult.Describe(TEXT("LocHub Push (dry run) failed")));
		return;
	}
	Result.PushReport = Report;
	Result.Details.Add(LocHubSyncRunnerPrivate::DescribeReport(TEXT("Dry run"), Report));

	if (PushOptions.bDryRunOnly)
	{
		Result.bSuccess = true;
		Result.Summary = LocHubSyncRunnerPrivate::DescribeReport(TEXT("LocHub Push dry run"), Report);
		Finish();
		return;
	}
	if (Report.Tombstoned > 0 && PushOptions.ConfirmTombstones && !PushOptions.ConfirmTombstones(Report))
	{
		Result.bCancelled = true;
		Result.Summary = FString::Printf(TEXT("LocHub Push cancelled: it would retire %d strings."), Report.Tombstoned);
		Finish();
		return;
	}
	MakeClient().Push(SnapshotJson, false, BindStep(&FLocHubSyncRunner::PushOnFinal));
}

void FLocHubSyncRunner::PushOnFinal(const FLocHubHttpResult& InResult)
{
	FLocHubPushReport Report;
	if (!InResult.IsOk() || !LocHubJson::ParsePushReport(InResult.Body, Report))
	{
		Fail(InResult.Describe(TEXT("LocHub Push failed")));
		return;
	}
	Result.PushReport = Report;
	Result.bSuccess = true;
	Result.Summary = LocHubSyncRunnerPrivate::DescribeReport(TEXT("LocHub Push"), Report);
	Finish();
}

void FLocHubSyncRunner::PullOnServiceReady(const bool bOk, const FString& InError)
{
	if (!bOk)
	{
		Fail(TEXT("LocHub Pull failed: ") + InError);
		return;
	}
	MakeClient().Reconcile(ReconcileJson, BindStep(&FLocHubSyncRunner::PullOnReconcile));
}

void FLocHubSyncRunner::PullOnReconcile(const FLocHubHttpResult& InResult)
{
	// No export without a reconcile: an export would overwrite a translation a person edited in the archive
	// outside LocHub since the last Push (CONTRACT.md "Pull protocol" step 0).
	int32 HumanEdits = 0;
	if (!InResult.IsOk() || !LocHubJson::ParseReconcileReport(InResult.Body, HumanEdits))
	{
		Fail(InResult.Describe(TEXT("LocHub Pull: reconciling archive edits failed")));
		return;
	}
	Result.Details.Add(FString::Printf(TEXT("Reconciled archives: %d translation(s) edited outside LocHub kept."), HumanEdits));
	PullNextCulture();
}

void FLocHubSyncRunner::PullNextCulture()
{
	if (PendingCultures.IsEmpty())
	{
		PullCompile();
		return;
	}
	CurrentCulture = PendingCultures[0];
	PendingCultures.RemoveAt(0);
	MakeClient().GetExport(CurrentCulture, BindStep(&FLocHubSyncRunner::PullOnExport));
}

void FLocHubSyncRunner::PullOnExport(const FLocHubHttpResult& InResult)
{
	FLocHubExport Export;
	if (!InResult.IsOk() || !LocHubJson::ParseExport(InResult.Body, Export))
	{
		Fail(InResult.Describe(FString::Printf(TEXT("LocHub Pull: export of %s failed"), *CurrentCulture)));
		return;
	}
	if (!Context.ExpectedPolicy.IsEmpty() && !Export.Policy.Equals(Context.ExpectedPolicy, ESearchCase::CaseSensitive))
	{
		Result.Details.Add(FString::Printf(TEXT("The service exports with policy '%s' while the settings ask for '%s'; Tools > LocHub > Restart Service applies the settings."), *Export.Policy, *Context.ExpectedPolicy));
	}

	const FLocHubImportResult Import = LocHubImport::Import(*Helper, CurrentCulture, Export.Entries, Context.GlyphChecker.Get());
	Result.Written += Import.Written.Num();
	Result.Rejected += Import.Rejected.Num();
	Result.Details.Add(FString::Printf(TEXT("%s: %d written, %d rejected, %d skipped because the source text changed, %d skipped because the key is no longer gathered."),
		*CurrentCulture, Import.Written.Num(), Import.Rejected.Num(), Import.SkippedStale, Import.SkippedUnknown));
	for (const FLocHubAckRejected& Rejected : Import.Rejected)
	{
		// The unitId alone (16 hex) does not tell a person which string failed.
		Result.Details.Add(FString::Printf(TEXT("Rejected %s %s,%s: %s \u2014 \"%s\""), *CurrentCulture, *Rejected.Namespace, *Rejected.Key,
			*FString::Join(Rejected.Errors, TEXT(" | ")), *Rejected.Translation));
	}

	if (Import.bArchiveChanged)
	{
		FString SaveError;
		if (!LocHubImport::SaveArchive(*Helper, CurrentCulture, SaveError))
		{
			Fail(FString::Printf(TEXT("LocHub Pull: could not save the %s archive: %s"), *CurrentCulture, *SaveError));
			return;
		}
		UpdatedCultures.Add(CurrentCulture);
	}

	// Acknowledged only after the archive and the .locres are on disk (Service/CONTRACT.md, "Pull protocol").
	if (!Import.Written.IsEmpty() || !Import.Rejected.IsEmpty())
	{
		FLocHubExportAck& Ack = PendingAcks.AddDefaulted_GetRef();
		Ack.Culture = CurrentCulture;
		Ack.Written = Import.Written;
		Ack.Rejected = Import.Rejected;
	}
	PullNextCulture();
}

void FLocHubSyncRunner::PullCompile()
{
	FString CompileError;
	if (!LocHubImport::CompileLocRes(*Helper, Context.Target, CompileError))
	{
		Fail(TEXT("LocHub Pull: ") + CompileError);
		return;
	}
	Result.Details.Add(FString::Printf(TEXT("Compiled %s for %d cultures."), *Context.Target.LocResName, Context.Target.GetAllCultures().Num()));
	// The engine caches the project's native culture from Game.locmeta once and only InitGameTextLocalization clears it;
	// RefreshResources does not. A Pull that wrote the first locmeta in a running editor would otherwise leave the
	// cached "" in place and EnableGameLocalizationPreview returns early until a restart. UE 5.8,
	// TextLocalizationResource.cpp GetNativeProjectCultureName / TextLocalizationManager.cpp EnableGameLocalizationPreview.
	TextLocalizationResourceUtil::ClearNativeProjectCultureName();
	if (Context.bRefreshLiveText && !IsRunningCommandlet())
	{
		FTextLocalizationManager::Get().RefreshResources();
	}
	PullNextAck();
}

void FLocHubSyncRunner::PullNextAck()
{
	if (PendingAcks.IsEmpty())
	{
		MakeClient().GetAnsweredInbox(BindStep(&FLocHubSyncRunner::PullOnInbox));
		return;
	}
	const FLocHubExportAck Ack = PendingAcks[0];
	PendingAcks.RemoveAt(0);
	CurrentCulture = Ack.Culture;
	CurrentAckJson = LocHubJson::ExportAckToJson(Ack);
	AckAttempts = 1;
	MakeClient().PostExportAck(CurrentAckJson, BindStep(&FLocHubSyncRunner::PullOnAck));
}

void FLocHubSyncRunner::PullOnAck(const FLocHubHttpResult& InResult)
{
	// A lost connection or a server error may pass; a 4xx answer will not change on a resend.
	const bool bRetryable = !InResult.bConnected || InResult.Code >= 500;
	if (!InResult.IsOk() && bRetryable && AckAttempts < LocHubSyncRunnerPrivate::MaxAckAttempts)
	{
		++AckAttempts;
		Result.Details.Add(InResult.Describe(FString::Printf(TEXT("Acknowledgement for %s failed, sending it again (attempt %d)"), *CurrentCulture, AckAttempts)));
		// Space retries out instead of hammering a temporarily 5xx service three times back-to-back.
		const TWeakPtr<FLocHubSyncRunner> WeakSelf = AsWeak();
		AckRetryTickerHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakSelf](float) -> bool
		{
			if (const TSharedPtr<FLocHubSyncRunner> This = WeakSelf.Pin())
			{
				This->AckRetryTickerHandle.Reset();
				This->MakeClient().PostExportAck(This->CurrentAckJson, This->BindStep(&FLocHubSyncRunner::PullOnAck));
			}
			return false; // One-shot.
		}), AckRetryDelaySeconds);
		return;
	}
	if (!InResult.IsOk())
	{
		// The archive is already written; the next Pull exports and acknowledges the same texts again.
		bPartialFailure = true;
		Result.Details.Add(InResult.Describe(FString::Printf(TEXT("Acknowledgement for %s failed"), *CurrentCulture)));
	}
	PullNextAck();
}

void FLocHubSyncRunner::PullOnInbox(const FLocHubHttpResult& InResult)
{
	TArray<FLocHubInboxRow> Rows;
	if (!InResult.IsOk() || !LocHubJson::ParseInbox(InResult.Body, Rows))
	{
		bPartialFailure = true;
		Result.Details.Add(InResult.Describe(TEXT("Answered questions could not be read")));
		PullFinish();
		return;
	}

// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_OLDER_THAN(5, 8, 0)
	// No developer notes before UE 5.8: nothing is written back and nothing is marked applied,
	// so the service keeps the answers "answered" and keeps sending them to the translator (answersByUnit).
	const bool bHasAnswers = Rows.ContainsByPredicate([](const FLocHubInboxRow& InRow)
	{
		return !InRow.Answer.TrimStartAndEnd().IsEmpty();
	});
	if (bHasAnswers)
	{
		Result.Details.Add(TEXT("Answered questions stay in LocHub and still reach the translator. Writing them into developer notes needs Unreal Engine 5.8 or later."));
	}
	PullFinish();
#else
	// One DevNotes write per text: answers about the same (namespace, key) are merged. FLocKey compares case-sensitively.
	using FUnitKey = TPair<FLocKey, FLocKey>;
	TArray<FUnitKey> Order;
	TMap<FUnitKey, TArray<const FLocHubInboxRow*>> Groups;
	for (const FLocHubInboxRow& Row : Rows)
	{
		const FUnitKey UnitKey(Row.Namespace, Row.Key);
		TArray<const FLocHubInboxRow*>* Group = Groups.Find(UnitKey);
		if (Group == nullptr)
		{
			Order.Add(UnitKey);
			Group = &Groups.Add(UnitKey);
		}
		Group->Add(&Row);
	}

	TArray<FLocHubDevNotesProposal> Proposals;
	for (const FUnitKey& UnitKey : Order)
	{
		ApplyAnswerGroup(Groups[UnitKey], Proposals);
	}

	const FString ProposalsPath = LocHubSyncRunnerPrivate::ProposalsPath(Context.ProjectDir);
	if (Proposals.IsEmpty())
	{
		IFileManager::Get().Delete(*ProposalsPath, false, false, true);
	}
	else
	{
		FFileHelper::SaveStringToFile(LocHubDevNotes::BuildProposalMarkdown(Proposals), *ProposalsPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
		Result.Details.Add(FString::Printf(TEXT("%d texts need their DevNotes edited by hand: %s"), Proposals.Num(), *ProposalsPath));
	}

	if (AppliedIds.IsEmpty())
	{
		PullFinish();
		return;
	}
	MakeClient().PostInboxApplied(LocHubJson::InboxAppliedToJson(AppliedIds), BindStep(&FLocHubSyncRunner::PullOnApplied));
#endif
}

void FLocHubSyncRunner::ApplyAnswerGroup(const TArray<const FLocHubInboxRow*>& InRows, TArray<FLocHubDevNotesProposal>& OutProposals)
{
	const FLocHubInboxRow& First = *InRows[0];
	const FString ManifestNotes = FindManifestDevNotes(First.Namespace, First.Key);

	TArray<LocHubDevNotes::FQuestionAndAnswer> Pending;
	TArray<FString> PendingIds;
	for (const FLocHubInboxRow* Row : InRows)
	{
		const FString Line = LocHubDevNotes::FormatAnswer(Row->Question, Row->Answer);
		if (Row->Answer.TrimStartAndEnd().IsEmpty() || LocHubDevNotes::IsAnswerInDevNotes(ManifestNotes, Line))
		{
			// Nothing to write, or a person already added the answer and gathered.
			AppliedIds.Add(Row->Id);
			continue;
		}
		Pending.Emplace(Row->Question, Row->Answer);
		PendingIds.Add(Row->Id);
	}
	if (Pending.IsEmpty())
	{
		return;
	}

	FString Reason;
	const bool bIsAsset = !LocHubDevNotes::PackageNameFromOrigin(First.Origin).IsEmpty();
	if (bIsAsset && Context.bWriteAssetDevNotes)
	{
		if (LocHubDevNotes::WriteToAsset(First.Origin, First.Namespace, First.Key, Pending, Reason))
		{
			AppliedIds.Append(PendingIds);
			Result.Details.Add(FString::Printf(TEXT("DevNotes of %s, %s written to %s."), *First.Namespace, *First.Key, *LocHubDevNotes::PackageNameFromOrigin(First.Origin)));
			return;
		}
	}
	else if (bIsAsset)
	{
		Reason = TEXT("Writing DevNotes to assets is off (Project Settings > Plugins > LocHub).");
	}
	else
	{
		Reason = TEXT("The text is defined in C++ or has no origin.");
	}

	FLocHubDevNotesProposal& Proposal = OutProposals.AddDefaulted_GetRef();
	Proposal.Namespace = First.Namespace;
	Proposal.Key = First.Key;
	Proposal.Origin = First.Origin;
	Proposal.Source = First.Source;
	Proposal.CurrentDevNotes = ManifestNotes;
	Proposal.ProposedDevNotes = LocHubDevNotes::MergeDevNotes(ManifestNotes, Pending);
	Proposal.Reason = Reason;
}

FString FLocHubSyncRunner::FindManifestDevNotes(const FString& InNamespace, const FString& InKey) const
{
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	const TSharedPtr<FManifestEntry> Entry = Helper.IsValid() ? Helper->FindSourceText(InNamespace, InKey) : nullptr;
	const FManifestContext* ManifestContext = Entry.IsValid() ? Entry->FindContextByKey(InKey) : nullptr;
	return ManifestContext != nullptr ? ManifestContext->DevNotes : FString();
#else
	return FString();
#endif
}

void FLocHubSyncRunner::PullOnApplied(const FLocHubHttpResult& InResult)
{
	if (!InResult.IsOk())
	{
		bPartialFailure = true;
		Result.Details.Add(InResult.Describe(TEXT("Marking answered questions as applied failed")));
	}
	PullFinish();
}

void FLocHubSyncRunner::PullFinish()
{
	Result.bSuccess = !bPartialFailure;
	Result.Summary = FString::Printf(TEXT("LocHub Pull: %d translations written, %d rejected%s."), Result.Written, Result.Rejected,
		bPartialFailure ? TEXT(", with errors (see Output Log)") : TEXT(""));
	Finish();
}
