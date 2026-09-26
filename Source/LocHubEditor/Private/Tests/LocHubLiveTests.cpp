// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/PlatformTime.h"
#include "Internationalization/InternationalizationArchive.h"
#include "LocHubEnvironment.h"
#include "LocHubJson.h"
#include "LocHubServiceClient.h"
#include "LocHubServiceProcess.h"
#include "LocHubSyncRunner.h"
#include "LocHubTargetPaths.h"
#include "LocTextHelper.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubLiveTestsPrivate
{
	constexpr double StepTimeoutSeconds = 90.0;
	constexpr float HttpTimeoutSeconds = 30.0f;

	/** Shared by the latent steps: one asynchronous call at a time; once a step fails the rest are skipped. */
	struct FLiveState
	{
		TSharedPtr<FLocHubServiceProcess> Service;
		TSharedPtr<FLocHubSyncRunner> Runner;
		FString TempDir;
		FLocHubTargetPaths Paths;
		bool bStarted = false;
		bool bFinished = false;
		bool bFailed = false;
		double Deadline = 0.0;
		FLocHubSyncResult RunResult;
		FLocHubHttpResult HttpResult;
		FString UnitId;
	};

	FLocHubSyncRunner::FOnFinished RecordRun(const TSharedRef<FLiveState>& InState)
	{
		return [InState](const FLocHubSyncResult& InResult)
		{
			InState->RunResult = InResult;
			InState->bFinished = true;
		};
	}

	FLocHubServiceClient::FOnResult RecordHttp(const TSharedRef<FLiveState>& InState)
	{
		return [InState](const FLocHubHttpResult& InResult)
		{
			InState->HttpResult = InResult;
			InState->bFinished = true;
		};
	}

	void BeginStep(FLiveState& InOutState)
	{
		InOutState.bStarted = true;
		InOutState.bFinished = false;
		InOutState.Deadline = FPlatformTime::Seconds() + StepTimeoutSeconds;
	}

	/** True while the current step still waits for its callback. */
	bool IsWaiting(const FLiveState& InState)
	{
		return !InState.bFinished && FPlatformTime::Seconds() < InState.Deadline;
	}

	void EndStep(FLiveState& InOutState, const bool bOk)
	{
		InOutState.bStarted = false;
		InOutState.bFailed = InOutState.bFailed || !bOk;
	}

	FLocHubServiceClient MakeClient()
	{
		return FLocHubServiceClient(FString::Printf(TEXT("http://127.0.0.1:%d"), LocHubTests::LiveServicePort));
	}

	FLocHubSyncContext MakeContext(const FLiveState& InState)
	{
		FLocHubSyncContext Context;
		Context.ProjectDir = InState.TempDir;
		Context.Target = InState.Paths;
		Context.ExpectedPolicy = TEXT("validated");
		Context.bScanCoverage = false;
		Context.bRefreshLiveText = false;
		Context.bWriteAssetDevNotes = false;
		return Context;
	}

	/** Id of the unit with InKey in a GET /api/cells answer (empty when absent) and its cell's archiveHash. */
	FString FindUnitId(const FString& InCellsJson, const TCHAR* InKey, FString& OutArchiveHash)
	{
		OutArchiveHash.Reset();
		const TSharedPtr<FJsonObject> Root = LocHubJson::ParseObject(InCellsJson);
		const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
		if (!Root.IsValid() || !Root->TryGetArrayField(TEXT("rows"), Rows))
		{
			return FString();
		}
		for (const TSharedPtr<FJsonValue>& Row : *Rows)
		{
			const TSharedPtr<FJsonObject>* RowObject = nullptr;
			const TSharedPtr<FJsonObject>* Unit = nullptr;
			if (!Row.IsValid() || !Row->TryGetObject(RowObject) || !(*RowObject)->TryGetObjectField(TEXT("unit"), Unit))
			{
				continue;
			}
			FString Key;
			FString Id;
			if (!(*Unit)->TryGetStringField(TEXT("key"), Key) || !Key.Equals(InKey, ESearchCase::CaseSensitive) || !(*Unit)->TryGetStringField(TEXT("id"), Id))
			{
				continue;
			}
			const TSharedPtr<FJsonObject>* Cell = nullptr;
			if ((*RowObject)->TryGetObjectField(TEXT("cell"), Cell))
			{
				(*Cell)->TryGetStringField(TEXT("archiveHash"), OutArchiveHash);
			}
			return Id;
		}
		return FString();
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubLiveRoundTripTest,
	"LocHubLive.RoundTrip",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubLiveRoundTripTest::RunTest(const FString& Parameters)
{
	using namespace LocHubLiveTestsPrivate;

	const FLocHubServiceProcess::FConfig Defaults = FLocHubServiceProcess::MakeDefaultConfig();
	if (!FPaths::FileExists(Defaults.ServiceScript))
	{
		AddError(FString::Printf(TEXT("The LocHub service script is missing: %s. Reinstall the plugin; in the source repository run 'npm run build' in Service/."), *Defaults.ServiceScript));
		return false;
	}
	if (LocHubEnvironment::FindExecutableOnPath(LocHubEnvironment::ExecutableFileName(TEXT("node"), LocHubEnvironment::CurrentHostOS())).IsEmpty())
	{
		AddError(TEXT("node is not on PATH; the live round trip needs Node 22.11 or newer."));
		return false;
	}

	// The first health probes hit a closed port on purpose; curl reports each refused connection.
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const TSharedRef<FLiveState> State = MakeShared<FLiveState>();
	State->TempDir = LocHubTests::MakeTempDir();
	State->Paths = LocHubTests::WriteTarget(State->TempDir / TEXT("Content/Localization/Test"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("Source/Game/Hud.cpp(10)"), FString(), FString() },
	});

	FLocHubServiceProcess::FConfig Config;
	Config.Port = LocHubTests::LiveServicePort;
	Config.bAutoStart = true;
	Config.Policy = TEXT("validated");
	Config.ProjectDir = State->TempDir.LeftChop(1);
	Config.ServiceScript = Defaults.ServiceScript;
	Config.StateDir = State->TempDir / TEXT("Saved/LocHub");
	State->Service = MakeShared<FLocHubServiceProcess>(Config);
	State->Runner = MakeShared<FLocHubSyncRunner>(State->Service.ToSharedRef());

	// Step 1: the port must be free, or the answers would come from somebody else's project.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		if (!State->bStarted)
		{
			BeginStep(*State);
			MakeClient().GetHealth(RecordHttp(State));
			return false;
		}
		if (IsWaiting(*State))
		{
			return false;
		}
		EndStep(*State, TestFalse(TEXT("Port 47852 is free before the test starts its own service"), State->HttpResult.bConnected));
		return true;
	}));

	// Step 2: Push starts the service and sends the fixture.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		if (State->bFailed)
		{
			return true;
		}
		if (!State->bStarted)
		{
			BeginStep(*State);
			State->Runner->Push(MakeContext(*State), FLocHubPushOptions(), RecordRun(State));
			return false;
		}
		if (IsWaiting(*State))
		{
			return false;
		}
		const bool bOk = TestTrue(TEXT("Push finished"), State->bFinished)
			&& TestTrue(FString::Printf(TEXT("Push succeeded: %s"), *State->RunResult.Summary), State->RunResult.bSuccess);
		EndStep(*State, bOk);
		return true;
	}));

	// Step 3: the pushed unit is visible to the web API.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		if (State->bFailed)
		{
			return true;
		}
		if (!State->bStarted)
		{
			BeginStep(*State);
			MakeClient().Send(TEXT("GET"), TEXT("/api/cells?culture=ru"), FString(), HttpTimeoutSeconds, RecordHttp(State));
			return false;
		}
		if (IsWaiting(*State))
		{
			return false;
		}
		FString ArchiveHash;
		State->UnitId = FindUnitId(State->HttpResult.Body, TEXT("Pause"), ArchiveHash);
		const bool bOk = TestTrue(State->HttpResult.Describe(TEXT("GET /api/cells")), State->HttpResult.IsOk())
			&& TestFalse(TEXT("The pushed unit is listed"), State->UnitId.IsEmpty());
		EndStep(*State, bOk);
		return true;
	}));

	// Step 4: a person edits the translation in the web app.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		if (State->bFailed)
		{
			return true;
		}
		if (!State->bStarted)
		{
			BeginStep(*State);
			const FString Path = FString::Printf(TEXT("/api/cells/ru/%s/edit"), *State->UnitId);
			MakeClient().Send(TEXT("POST"), Path, TEXT("{\"text\":\"Pause RU\",\"actor\":\"LocHubLive\"}"), HttpTimeoutSeconds, RecordHttp(State));
			return false;
		}
		if (IsWaiting(*State))
		{
			return false;
		}
		EndStep(*State, TestTrue(State->HttpResult.Describe(TEXT("POST edit")), State->HttpResult.IsOk()));
		return true;
	}));

	// Step 5: Pull writes the released translation into the archive and acknowledges it.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		if (State->bFailed)
		{
			return true;
		}
		if (!State->bStarted)
		{
			BeginStep(*State);
			State->Runner->Pull(MakeContext(*State), RecordRun(State));
			return false;
		}
		if (IsWaiting(*State))
		{
			return false;
		}
		bool bOk = TestTrue(TEXT("Pull finished"), State->bFinished)
			&& TestTrue(FString::Printf(TEXT("Pull succeeded: %s"), *State->RunResult.Summary), State->RunResult.bSuccess);
		FText LoadError;
		const TSharedPtr<FLocTextHelper> Helper = State->Paths.LoadHelper(LoadError);
		if (bOk && TestTrue(TEXT("Archive reloads"), Helper.IsValid()))
		{
			const TSharedPtr<FArchiveEntry> Pause = Helper->FindTranslation(TEXT("ru"), LocHubTests::Namespace, TEXT("Pause"), nullptr);
			bOk = TestTrue(TEXT("The edited translation is in the archive"), Pause.IsValid() && Pause->Translation.Text.Equals(TEXT("Pause RU"), ESearchCase::CaseSensitive));
		}
		EndStep(*State, bOk);
		return true;
	}));

	// Step 6: the service recorded the acknowledgement.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		if (State->bFailed)
		{
			return true;
		}
		if (!State->bStarted)
		{
			BeginStep(*State);
			MakeClient().Send(TEXT("GET"), TEXT("/api/cells?culture=ru"), FString(), HttpTimeoutSeconds, RecordHttp(State));
			return false;
		}
		if (IsWaiting(*State))
		{
			return false;
		}
		FString ArchiveHash;
		FindUnitId(State->HttpResult.Body, TEXT("Pause"), ArchiveHash);
		EndStep(*State, TestFalse(TEXT("The acknowledged cell has an archive hash"), ArchiveHash.IsEmpty()));
		return true;
	}));

	// Step 7: always runs; the test's own node process goes away with its pid file.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() -> bool
	{
		const FString PidFile = State->Service->GetPidFilePath();
		State->Service->Stop();
		TestFalse(TEXT("The own service process is stopped"), State->Service->IsOwnedProcessRunning());
		TestFalse(TEXT("The pid file is removed"), FPaths::FileExists(PidFile));
		State->Runner.Reset();
		State->Service.Reset();
		LocHubTests::DeleteTempDir(State->TempDir);
		return true;
	}));
	return true;
}

#endif
