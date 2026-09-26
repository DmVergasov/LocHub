// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/PlatformTime.h"
#include "Internationalization/InternationalizationArchive.h"
#include "LocHubJson.h"
#include "LocHubServiceProcess.h"
#include "LocHubSyncLock.h"
#include "LocHubSyncRunner.h"
#include "LocHubTypes.h"
#include "LocTextHelper.h"
#include "Misc/AutomationTest.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Tests/LocHubFakeService.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubRunnerTestsPrivate
{
	struct FRunOutcome
	{
		bool bDone = false;
		FLocHubSyncResult Result;
	};

	FLocHubSyncRunner::FOnFinished RecordRun(const TSharedRef<FRunOutcome>& InOutcome)
	{
		return [InOutcome](const FLocHubSyncResult& InResult)
		{
			InOutcome->bDone = true;
			InOutcome->Result = InResult;
		};
	}

	TSharedRef<FLocHubServiceProcess> MakeServiceForFake(const FString& InTempDir)
	{
		FLocHubServiceProcess::FConfig Config;
		Config.Port = LocHubTests::FakeServicePort;
		Config.bAutoStart = false;
		Config.ProjectDir = InTempDir.LeftChop(1);
		Config.ServiceScript = InTempDir / TEXT("NoService/Resources/LocHubService/lochub_service.mjs");
		Config.StateDir = InTempDir / TEXT("State");
		return MakeShared<FLocHubServiceProcess>(Config);
	}

	FLocHubSyncContext MakeContext(const FString& InTempDir, const FLocHubTargetPaths& InPaths)
	{
		FLocHubSyncContext Context;
		Context.ProjectDir = InTempDir;
		Context.Target = InPaths;
		Context.UiSourcePatterns = { TEXT("*/Hud/*") };
		Context.CoverageSourceRoots = { InTempDir / TEXT("Source") };
		Context.CoverageContentRoots = { InTempDir / TEXT("Content") };
		Context.ExpectedPolicy = TEXT("validated");
		Context.bRefreshLiveText = false;
		return Context;
	}

	FString PushReportJson(const int32 InTombstoned)
	{
		return FString::Printf(TEXT("{\"added\":2,\"changed\":0,\"cosmetic\":0,\"tombstoned\":%d,\"revived\":0,\"humanEdits\":0}"), InTombstoned);
	}

	const FJsonObject* FindEntryWithKey(const TArray<TSharedPtr<FJsonValue>>& InEntries, const TCHAR* InKey)
	{
		for (const TSharedPtr<FJsonValue>& Value : InEntries)
		{
			const TSharedPtr<FJsonObject>& Object = Value->AsObject();
			if (Object.IsValid() && Object->GetStringField(TEXT("key")) == InKey)
			{
				return Object.Get();
			}
		}
		return nullptr;
	}

	// A preprocessor directive inside a macro argument list is undefined behavior (MSVC on UE 5.6 fails to
	// parse it), so the version check for Pull's DevNotes outcome lives in its own function, not inline in
	// the ADD_LATENT_AUTOMATION_COMMAND lambda.
	void CheckDevNotesOutcome(FAutomationTestBase& InTest, const TSharedRef<FLocHubFakeService>& InFake, const FString& InTempDir, const TSharedRef<FRunOutcome>& InOutcome)
	{
		// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
		const TArray<FLocHubFakeService::FRecordedRequest> Applied = InFake->GetRequests(TEXT("/api/inbox/applied"));
		if (InTest.TestEqual(TEXT("One applied call"), Applied.Num(), 1))
		{
			const TSharedPtr<FJsonObject> Body = LocHubJson::ParseObject(Applied[0].Body);
			if (InTest.TestTrue(TEXT("Applied is JSON"), Body.IsValid()) && InTest.TestEqual(TEXT("One applied id"), Body->GetArrayField(TEXT("ids")).Num(), 1))
			{
				InTest.TestEqual(TEXT("Answer already in the manifest is applied"), Body->GetArrayField(TEXT("ids"))[0]->AsString(), TEXT("q1"));
			}
		}

		FString Proposals;
		InTest.TestTrue(TEXT("Proposals file is written"), FFileHelper::LoadFileToString(Proposals, *(InTempDir / TEXT("Saved/LocHub/DevNotesProposals.md"))));
		InTest.TestTrue(TEXT("The C++ text is proposed"), Proposals.Contains(TEXT("Pending")));
		InTest.TestTrue(TEXT("With its answer"), Proposals.Contains(TEXT("Q: Who says it? A: The foreman")));
#else
		InTest.TestEqual(TEXT("Nothing is marked applied before UE 5.8"), InFake->GetRequests(TEXT("/api/inbox/applied")).Num(), 0);
		InTest.TestFalse(TEXT("No proposals file before UE 5.8"), FPaths::FileExists(InTempDir / TEXT("Saved/LocHub/DevNotesProposals.md")));
		InTest.TestTrue(TEXT("Pull says answers stay in LocHub"), InOutcome->Result.Details.ContainsByPredicate([](const FString& InLine)
		{
			return InLine.Contains(TEXT("needs Unreal Engine 5.8"));
		}));
#endif
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerPushSendsSnapshotTest,
	"LocHub.Runner.PushSendsSnapshot",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerPushSendsSnapshotTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	// The temp dir (this Pull/Push's project dir) must exist before the fake, so its default health answer can
	// report the same project (F1's identity check, carried into F2).
	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	Fake->SetResponse(TEXT("/api/push"), 200, PushReportJson(0));

	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Speed"), TEXT("Speed"), TEXT("Source/Game/Hud/HudSpeed.cpp(10)"), FString(), TEXT("Speed RU") },
		{ TEXT("Load"), TEXT("Load"), TEXT("Source/Game/Jobs/Loader.cpp(12)"), FString(), FString() },
	});
	LocHubTests::WriteTextFile(TempDir / TEXT("Source/Game/Hud/HudSpeed.cpp"), TEXT("Label = FText::FromString(TEXT(\"KM/H\"));"));

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Push(MakeContext(TempDir, Paths), FLocHubPushOptions(), RecordRun(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 30.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Runner, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Push finished"), Outcome->bDone);
		TestTrue(TEXT("Push succeeded"), Outcome->Result.bSuccess);
		TestEqual(TEXT("Report is from the service"), Outcome->Result.PushReport.Added, 2);

		const TArray<FLocHubFakeService::FRecordedRequest> Pushes = Fake->GetRequests(TEXT("/api/push"));
		if (TestEqual(TEXT("Dry run, then the real push"), Pushes.Num(), 2))
		{
			const FString* DryRun = Pushes[0].QueryParams.Find(TEXT("dryRun"));
			TestTrue(TEXT("First push is a dry run"), DryRun != nullptr && *DryRun == TEXT("1"));
			TestNull(TEXT("Second push is real"), Pushes[1].QueryParams.Find(TEXT("dryRun")));

			const TSharedPtr<FJsonObject> Body = LocHubJson::ParseObject(Pushes[1].Body);
			if (TestTrue(TEXT("Snapshot is JSON"), Body.IsValid()))
			{
				TestEqual(TEXT("Entries"), Body->GetArrayField(TEXT("entries")).Num(), 2);
				TestEqual(TEXT("ru archive"), Body->GetObjectField(TEXT("archives"))->GetArrayField(TEXT("ru")).Num(), 1);
				const TArray<TSharedPtr<FJsonValue>>& Coverage = Body->GetArrayField(TEXT("coverage"));
				if (TestEqual(TEXT("One coverage finding"), Coverage.Num(), 1))
				{
					TestEqual(TEXT("Coverage file"), Coverage[0]->AsObject()->GetStringField(TEXT("file")), TEXT("Source/Game/Hud/HudSpeed.cpp"));
				}
				const FJsonObject* Speed = FindEntryWithKey(Body->GetArrayField(TEXT("entries")), TEXT("Speed"));
				if (TestNotNull(TEXT("Speed entry"), Speed))
				{
					TestEqual(TEXT("Widget kind"), Speed->GetObjectField(TEXT("metadata"))->GetStringField(LocHub::KindMetadataKey), FString(LocHub::KindUi));
				}
			}
		}

		FLocHubSyncLock Probe;
		FString Holder;
		TestTrue(TEXT("The lock is released"), Probe.TryAcquire(FLocHubSyncLock::GetDefaultPath(TempDir), TEXT("Test"), Holder));
		Probe.Release();
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerPushCancelsOnTombstonesTest,
	"LocHub.Runner.PushCancelsOnTombstones",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerPushCancelsOnTombstonesTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	Fake->SetResponse(TEXT("/api/push"), 200, PushReportJson(3));

	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Speed"), TEXT("Speed"), TEXT("Source/Game/Hud/HudSpeed.cpp(10)"), FString(), FString() },
	});

	const TSharedRef<int32> ConfirmCalls = MakeShared<int32>(0);
	FLocHubPushOptions Options;
	Options.ConfirmTombstones = [ConfirmCalls](const FLocHubPushReport& InReport)
	{
		++(*ConfirmCalls);
		return false;
	};

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Push(MakeContext(TempDir, Paths), Options, RecordRun(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 30.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Runner, Outcome, ConfirmCalls, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Push finished"), Outcome->bDone);
		TestTrue(TEXT("Push is cancelled"), Outcome->Result.bCancelled);
		TestFalse(TEXT("Cancelled is not a success"), Outcome->Result.bSuccess);
		TestEqual(TEXT("Asked once"), *ConfirmCalls, 1);
		TestEqual(TEXT("Only the dry run reached the service"), Fake->GetRequests(TEXT("/api/push")).Num(), 1);
		TestFalse(TEXT("Runner is free again"), Runner->IsBusy());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerRespectsLockTest,
	"LocHub.Runner.RespectsLock",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerRespectsLockTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Speed"), TEXT("Speed"), TEXT("Source/Game/Hud/HudSpeed.cpp(10)"), FString(), FString() },
	});

	FLocHubSyncLock OtherSession;
	FString Holder;
	TestTrue(TEXT("Other session holds the lock"), OtherSession.TryAcquire(FLocHubSyncLock::GetDefaultPath(TempDir), TEXT("Pull (other session)"), Holder));

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Push(MakeContext(TempDir, Paths), FLocHubPushOptions(), RecordRun(Outcome));

	TestTrue(TEXT("Refused at once"), Outcome->bDone);
	TestFalse(TEXT("Refusal is not a success"), Outcome->Result.bSuccess);
	TestTrue(TEXT("Refusal names the lock file"), Outcome->Result.Summary.Contains(TEXT("sync.lock")));
	TestTrue(TEXT("Refusal names the holder"), Outcome->Result.Summary.Contains(TEXT("other session")));
	TestFalse(TEXT("Runner is not busy"), Runner->IsBusy());
	TestEqual(TEXT("Nothing was sent"), Fake->GetRequests(TEXT("/api/push")).Num(), 0);

	OtherSession.Release();
	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerPullWritesAcksAndNotesTest,
	"LocHub.Runner.PullWritesAcksAndNotes",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerPullWritesAcksAndNotesTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	Fake->SetResponse(TEXT("/api/export"), 200, TEXT("{\"culture\":\"ru\",\"policy\":\"validated\",\"entries\":[")
		TEXT("{\"unitId\":\"u1\",\"namespace\":\"LocHubTest\",\"key\":\"Pause\",\"source\":\"Pause\",\"translation\":\"Pause RU\"},")
		TEXT("{\"unitId\":\"u2\",\"namespace\":\"LocHubTest\",\"key\":\"Bales\",\"source\":\"{Count} bales\",\"translation\":\"{Count} {Broken} RU\"},")
		TEXT("{\"unitId\":\"u3\",\"namespace\":\"LocHubTest\",\"key\":\"Answered\",\"source\":\"Older English\",\"translation\":\"Answered RU\"}]}"));
	Fake->SetResponse(TEXT("/api/inbox"), 200, TEXT("{\"rows\":[")
		TEXT("{\"item\":{\"id\":\"q1\",\"unitId\":\"u3\",\"culture\":\"ru\",\"question\":\"Verb or noun?\",\"answer\":\"Verb\"},")
		TEXT("\"unit\":{\"namespace\":\"LocHubTest\",\"key\":\"Answered\",\"source\":\"Answered\",\"origin\":\"Source/Game/Hud/Hud.cpp(30)\",\"devNotes\":\"\"}},")
		TEXT("{\"item\":{\"id\":\"q2\",\"unitId\":\"u4\",\"culture\":\"ru\",\"question\":\"Who says it?\",\"answer\":\"The foreman\"},")
		TEXT("\"unit\":{\"namespace\":\"LocHubTest\",\"key\":\"Pending\",\"source\":\"Pending\",\"origin\":\"Source/Game/Hud/Hud.cpp(40)\",\"devNotes\":\"\"}}]}"));

	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("/Game/UI/WBP_Pause.WBP_Pause_C:WidgetTree.Title.Text"), FString(), FString() },
		{ TEXT("Bales"), TEXT("{Count} bales"), TEXT("Source/Game/Hud/Hud.cpp(20)"), FString(), TEXT("old {Count}") },
		// A person already put the answer of q1 into the notes and gathered.
		{ TEXT("Answered"), TEXT("Answered"), TEXT("Source/Game/Hud/Hud.cpp(30)"), TEXT("Q: Verb or noun? A: Verb"), FString() },
		{ TEXT("Pending"), TEXT("Pending"), TEXT("Source/Game/Hud/Hud.cpp(40)"), FString(), FString() },
	});

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Pull(MakeContext(TempDir, Paths), RecordRun(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 30.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Runner, Outcome, Deadline, TempDir, Paths]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Pull finished"), Outcome->bDone);
		TestTrue(TEXT("Pull succeeded"), Outcome->Result.bSuccess);
		TestEqual(TEXT("One written"), Outcome->Result.Written, 1);
		TestEqual(TEXT("One rejected"), Outcome->Result.Rejected, 1);

		const TArray<FLocHubFakeService::FRecordedRequest> Acks = Fake->GetRequests(TEXT("/api/export/ack"));
		if (TestEqual(TEXT("One ack"), Acks.Num(), 1))
		{
			const TSharedPtr<FJsonObject> Ack = LocHubJson::ParseObject(Acks[0].Body);
			if (TestTrue(TEXT("Ack is JSON"), Ack.IsValid()))
			{
				const TArray<TSharedPtr<FJsonValue>>& Written = Ack->GetArrayField(TEXT("written"));
				const TArray<TSharedPtr<FJsonValue>>& Rejected = Ack->GetArrayField(TEXT("rejected"));
				if (TestEqual(TEXT("Written in ack"), Written.Num(), 1))
				{
					TestEqual(TEXT("Written unit"), Written[0]->AsObject()->GetStringField(TEXT("unitId")), TEXT("u1"));
				}
				if (TestEqual(TEXT("Rejected in ack"), Rejected.Num(), 1))
				{
					TestEqual(TEXT("Rejected unit"), Rejected[0]->AsObject()->GetStringField(TEXT("unitId")), TEXT("u2"));
					TestEqual(TEXT("Rejected text"), Rejected[0]->AsObject()->GetStringField(TEXT("translation")), TEXT("{Count} {Broken} RU"));
				}
			}
		}

		CheckDevNotesOutcome(*this, Fake, TempDir, Outcome);

		FText Error;
		const TSharedPtr<FLocTextHelper> Helper = Paths.LoadHelper(Error);
		if (TestTrue(TEXT("Archive reloads"), Helper.IsValid()))
		{
			const TSharedPtr<FArchiveEntry> Pause = Helper->FindTranslation(TEXT("ru"), LocHubTests::Namespace, TEXT("Pause"), nullptr);
			TestTrue(TEXT("Accepted translation is in the archive"), Pause.IsValid() && Pause->Translation.Text == TEXT("Pause RU"));
		}
		TestTrue(TEXT("ru LocRes is compiled"), FPaths::FileExists(Paths.DataDir / TEXT("ru") / Paths.LocResName));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerPullRetriesAckTest,
	"LocHub.Runner.PullRetriesAck",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerPullRetriesAckTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	Fake->SetResponse(TEXT("/api/export"), 200, TEXT("{\"culture\":\"ru\",\"policy\":\"validated\",\"entries\":[")
		TEXT("{\"unitId\":\"u1\",\"namespace\":\"LocHubTest\",\"key\":\"Pause\",\"source\":\"Pause\",\"translation\":\"Pause RU\"}]}"));
	Fake->SetResponse(TEXT("/api/export/ack"), 500, TEXT("{\"error\":\"store is busy\"}"));

	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("Source/Game/Hud/Hud.cpp(10)"), FString(), FString() },
	});

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	// The retry now waits ~1 s between attempts via a ticker; 0 keeps this test fast and deterministic.
	Runner->AckRetryDelaySeconds = 0.0f;
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Pull(MakeContext(TempDir, Paths), RecordRun(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 30.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Runner, Outcome, Deadline, TempDir, Paths]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Pull finished"), Outcome->bDone);
		TestFalse(TEXT("A lost acknowledgement is reported"), Outcome->Result.bSuccess);
		TestEqual(TEXT("The acknowledgement is sent MaxAckAttempts times"), Fake->GetRequests(TEXT("/api/export/ack")).Num(), 3);

		FText Error;
		const TSharedPtr<FLocTextHelper> Helper = Paths.LoadHelper(Error);
		if (TestTrue(TEXT("Archive reloads"), Helper.IsValid()))
		{
			const TSharedPtr<FArchiveEntry> Pause = Helper->FindTranslation(TEXT("ru"), LocHubTests::Namespace, TEXT("Pause"), nullptr);
			TestTrue(TEXT("The archive keeps the translation"), Pause.IsValid() && Pause->Translation.Text == TEXT("Pause RU"));
		}
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerPullReconcilesBeforeExportTest,
	"LocHub.Runner.PullReconcilesBeforeExport",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerPullReconcilesBeforeExportTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	Fake->SetResponse(TEXT("/api/reconcile"), 200, TEXT("{\"humanEdits\":1}"));

	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("Source/Game/Hud/Hud.cpp(10)"), FString(), TEXT("Pause RU") },
	});

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Pull(MakeContext(TempDir, Paths), RecordRun(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 30.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Runner, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Pull finished"), Outcome->bDone);
		TestTrue(TEXT("Pull succeeded"), Outcome->Result.bSuccess);
		TestTrue(TEXT("The reconcile result is reported"), Outcome->Result.Details.ContainsByPredicate([](const FString& InLine)
		{
			return InLine.Contains(TEXT("Reconciled archives: 1"));
		}));

		const TArray<FLocHubFakeService::FRecordedRequest> Reconciles = Fake->GetRequests(TEXT("/api/reconcile"));
		const TArray<FLocHubFakeService::FRecordedRequest> Exports = Fake->GetRequests(TEXT("/api/export"));
		if (TestEqual(TEXT("One reconcile call"), Reconciles.Num(), 1) && TestTrue(TEXT("At least one export call"), Exports.Num() >= 1))
		{
			TestTrue(TEXT("Reconcile happens before the first export"), Reconciles[0].Index < Exports[0].Index);

			const TSharedPtr<FJsonObject> Body = LocHubJson::ParseObject(Reconciles[0].Body);
			if (TestTrue(TEXT("Reconcile body is JSON"), Body.IsValid()))
			{
				const TSharedPtr<FJsonObject>* Archives = nullptr;
				if (TestTrue(TEXT("Reconcile body has archives"), Body->TryGetObjectField(TEXT("archives"), Archives)))
				{
					TestEqual(TEXT("Reconcile carries the target's ru archive entries"), (*Archives)->GetArrayField(TEXT("ru")).Num(), 1);
				}
			}
		}

		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubRunnerPullStopsWhenReconcileFailsTest,
	"LocHub.Runner.PullStopsWhenReconcileFails",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubRunnerPullStopsWhenReconcileFailsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubRunnerTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	Fake->SetResponse(TEXT("/api/reconcile"), 409, TEXT("{\"error\":\"files_changed_on_disk\",")
		TEXT("\"message\":\"Localization/LocHub changed on disk since the service loaded it (a source control sync?). Restart the LocHub service.\"}"));

	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("Source/Game/Hud/Hud.cpp(10)"), FString(), FString() },
	});

	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(MakeServiceForFake(TempDir));
	const TSharedRef<FRunOutcome> Outcome = MakeShared<FRunOutcome>();
	Runner->Pull(MakeContext(TempDir, Paths), RecordRun(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 30.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Runner, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Pull finished"), Outcome->bDone);
		TestFalse(TEXT("Pull fails"), Outcome->Result.bSuccess);
		TestTrue(TEXT("Failure names the service's message"), Outcome->Result.Summary.Contains(TEXT("files_changed_on_disk")));
		TestEqual(TEXT("Exactly one reconcile attempt"), Fake->GetRequests(TEXT("/api/reconcile")).Num(), 1);
		TestEqual(TEXT("No export request was made"), Fake->GetRequests(TEXT("/api/export")).Num(), 0);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

#endif
