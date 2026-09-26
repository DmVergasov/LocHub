// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Bridge/LocHubBridgeClient.h"
#include "Bridge/LocHubBrowserBridge.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformTime.h"
#include "LocHubEnvironment.h"
#include "Tests/LocHubFakeService.h"
#include "Tests/LocHubTestUtils.h"
#include "UObject/Class.h"
#include "UObject/UnrealType.h"
#include "WebJSFunction.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeJsContractTest,
	"LocHub.Bridge.BrowserBridge.JsContract",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeJsContractTest::RunTest(const FString& Parameters)
{
	struct FJsMethod
	{
		const TCHAR* JsName;
		int32 NumStringArgs;
	};

	// window.ue.lochub as Web/src/bridge.ts calls it. CEF finds the UFUNCTION by the lower-cased name and passes
	// arguments by position, so every argument has to be a string.
	const FJsMethod Methods[] = {
		{ TEXT("openorigin"), 1 },
		{ TEXT("setpreviewculture"), 1 },
		{ TEXT("applylive"), 2 },
	};

	const UClass* BridgeClass = ULocHubBrowserBridge::StaticClass();
	for (const FJsMethod& Method : Methods)
	{
		const UFunction* Function = BridgeClass->FindFunctionByName(FName(Method.JsName));
		if (!TestNotNull(FString::Printf(TEXT("%s is a UFUNCTION"), Method.JsName), Function))
		{
			continue;
		}

		int32 NumStringArgs = 0;
		int32 NumOtherArgs = 0;
		for (TFieldIterator<FProperty> It(Function); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
		{
			if (It->HasAnyPropertyFlags(CPF_ReturnParm))
			{
				continue;
			}

			if (It->IsA<FStrProperty>())
			{
				++NumStringArgs;
			}
			else
			{
				++NumOtherArgs;
			}
		}

		TestEqual(FString::Printf(TEXT("%s takes the web app's string arguments"), Method.JsName), NumStringArgs, Method.NumStringArgs);
		TestEqual(FString::Printf(TEXT("%s takes nothing but strings"), Method.JsName), NumOtherArgs, 0);
		TestNotNull(FString::Printf(TEXT("%s answers with a bool"), Method.JsName), CastField<FBoolProperty>(Function->GetReturnProperty()));
	}

	// Response-based methods answer through one FWebJSResponse (CEFJSScripting.cpp, PromiseParam) instead of a bool:
	// CEF fills that parameter itself and passes only the string arguments by position.
	struct FJsResponseMethod
	{
		const TCHAR* JsName;
		int32 NumStringArgs;
	};

	const FJsResponseMethod ResponseMethods[] = {
		{ TEXT("sync"), 1 },
		{ TEXT("picktextfile"), 2 },
		{ TEXT("savetextfile"), 4 },
	};

	for (const FJsResponseMethod& Method : ResponseMethods)
	{
		const UFunction* Function = BridgeClass->FindFunctionByName(FName(Method.JsName));
		if (!TestNotNull(FString::Printf(TEXT("%s is a UFUNCTION"), Method.JsName), Function))
		{
			continue;
		}

		int32 NumStringArgs = 0;
		int32 NumResponseArgs = 0;
		int32 NumOtherArgs = 0;
		for (TFieldIterator<FProperty> It(Function); It && It->HasAnyPropertyFlags(CPF_Parm); ++It)
		{
			const FStructProperty* StructProperty = CastField<FStructProperty>(*It);
			if (It->IsA<FStrProperty>())
			{
				++NumStringArgs;
			}
			else if (StructProperty != nullptr && StructProperty->Struct->IsChildOf(FWebJSResponse::StaticStruct()))
			{
				++NumResponseArgs;
			}
			else
			{
				++NumOtherArgs;
			}
		}
		TestEqual(FString::Printf(TEXT("%s takes the web app's string arguments"), Method.JsName), NumStringArgs, Method.NumStringArgs);
		TestEqual(FString::Printf(TEXT("%s answers through one FWebJSResponse"), Method.JsName), NumResponseArgs, 1);
		TestEqual(FString::Printf(TEXT("%s takes nothing else and returns nothing"), Method.JsName), NumOtherArgs, 0);
	}

	// Each refusal below writes one "LocHub bridge rejected" warning; the test expects exactly these six.
	AddExpectedMessagePlain(TEXT("LocHub bridge rejected"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 6);
	ULocHubBrowserBridge* Bridge = NewObject<ULocHubBrowserBridge>();
	TestFalse(TEXT("an empty origin opens nothing"), Bridge->OpenOrigin(FString()));
	TestFalse(TEXT("a malformed culture is refused"), Bridge->SetPreviewCulture(TEXT("../ru")));
	TestFalse(TEXT("entries that are not JSON are refused"), Bridge->ApplyLive(TEXT("ru"), TEXT("not json")));
	TestFalse(TEXT("an empty entry list is refused"), Bridge->ApplyLive(TEXT("ru"), TEXT("[]")));
	// An unknown action is refused before anything runs; a response without a page drops the rejection quietly.
	Bridge->Sync(TEXT("gather"), FWebJSResponse());
	// An invalid file name is refused before the dialog is even scheduled; no real dialog opens in this test.
	Bridge->SaveTextFile(TEXT("Export Glossary"), TEXT("../glossary.csv"), TEXT("CSV files (*.csv)|*.csv"), TEXT("a,b\n"), FWebJSResponse());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeReconnectBackoffTest,
	"LocHub.Bridge.Client.ReconnectBackoff",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeReconnectBackoffTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("the first retry comes after a second"), FLocHubBridgeClient::GetReconnectDelaySeconds(0), 1.0);
	TestEqual(TEXT("the delay doubles"), FLocHubBridgeClient::GetReconnectDelaySeconds(3), 8.0);
	TestEqual(TEXT("the last doubling"), FLocHubBridgeClient::GetReconnectDelaySeconds(4), 16.0);
	TestEqual(TEXT("then a steady half minute"), FLocHubBridgeClient::GetReconnectDelaySeconds(5), 30.0);
	TestEqual(TEXT("the cap holds for long outages"), FLocHubBridgeClient::GetReconnectDelaySeconds(1000), 30.0);
	TestEqual(TEXT("a negative index is the first attempt"), FLocHubBridgeClient::GetReconnectDelaySeconds(-1), 1.0);

	for (int32 Attempt = 1; Attempt < 10; ++Attempt)
	{
		TestTrue(FString::Printf(TEXT("attempt %d never waits less than the one before"), Attempt),
			FLocHubBridgeClient::GetReconnectDelaySeconds(Attempt) >= FLocHubBridgeClient::GetReconnectDelaySeconds(Attempt - 1));
	}

	// A stopped service refuses every reconnect, and each refusal
	// would log a LogHttp warning unless the stream URL is listed in http.UrlPatternsToDisableFailedLog. Start()
	// registers it once; starting again must not add a second copy.
	IConsoleVariable* DisableFailedLogCVar = IConsoleManager::Get().FindConsoleVariable(TEXT("http.UrlPatternsToDisableFailedLog"));
	if (TestNotNull(TEXT("the engine exposes http.UrlPatternsToDisableFailedLog"), DisableFailedLogCVar))
	{
		const FString Pattern = TEXT("127.0.0.1:54321/api/bridge/stream");
		// The variable is global: restore it so this test's port does not leak into later tests or the session.
		const FString PatternsBeforeTest = DisableFailedLogCVar->GetString();
		const TSharedRef<FLocHubBridgeClient> Client = MakeShared<FLocHubBridgeClient>();

		Client->Start(TEXT("http://127.0.0.1:54321"));
		TArray<FString> PatternsAfterFirstStart;
		DisableFailedLogCVar->GetString().ParseIntoArrayWS(PatternsAfterFirstStart);
		TestEqual(TEXT("the stream URL pattern appears once after the first start"),
			PatternsAfterFirstStart.FilterByPredicate([&Pattern](const FString& InEntry) { return InEntry.Equals(Pattern, ESearchCase::CaseSensitive); }).Num(), 1);

		Client->Start(TEXT("http://127.0.0.1:54321"));
		TArray<FString> PatternsAfterSecondStart;
		DisableFailedLogCVar->GetString().ParseIntoArrayWS(PatternsAfterSecondStart);
		TestEqual(TEXT("the stream URL pattern still appears once after a second start"),
			PatternsAfterSecondStart.FilterByPredicate([&Pattern](const FString& InEntry) { return InEntry.Equals(Pattern, ESearchCase::CaseSensitive); }).Num(), 1);

		Client->Stop();
		DisableFailedLogCVar->Set(*PatternsBeforeTest, ECVF_SetByCode);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeSseActivityTimeoutTest,
	"LocHub.Bridge.Client.SseActivityTimeout",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeSseActivityTimeoutTest::RunTest(const FString& Parameters)
{
	// The value used everywhere the HTTP backend is not NSURLSession, whatever the connection timeout.
	const float Standard = FLocHubBridgeClient::EffectiveSseActivityTimeout(false, 30.0f);
	TestTrue(TEXT("the standard timeout outlasts the 30 s engine default"), Standard > 30.0f);
	TestEqual(TEXT("off Apple a short connection timeout changes nothing"), FLocHubBridgeClient::EffectiveSseActivityTimeout(false, 10.0f), Standard);
	TestEqual(TEXT("off Apple a long connection timeout changes nothing"), FLocHubBridgeClient::EffectiveSseActivityTimeout(false, 120.0f), Standard);

	TestEqual(TEXT("on Apple the activity timeout never exceeds the connection timeout"), FLocHubBridgeClient::EffectiveSseActivityTimeout(true, 30.0f), 30.0f);
	TestEqual(TEXT("on Apple a longer connection timeout keeps the standard value"), FLocHubBridgeClient::EffectiveSseActivityTimeout(true, 120.0f), Standard);
	TestEqual(TEXT("on Apple an equal connection timeout keeps the standard value"), FLocHubBridgeClient::EffectiveSseActivityTimeout(true, Standard), Standard);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeHttpConnectionTimeoutWarningTest,
	"LocHub.Bridge.Client.HttpConnectionTimeoutWarning",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeHttpConnectionTimeoutWarningTest::RunTest(const FString& Parameters)
{
	TestFalse(TEXT("off Apple, a short connection timeout is never worth the warning"), FLocHubBridgeClient::ShouldWarnAboutHttpConnectionTimeout(false, 10.0f));
	TestFalse(TEXT("on Apple, a connection timeout above the heartbeat needs no warning"), FLocHubBridgeClient::ShouldWarnAboutHttpConnectionTimeout(true, 30.0f));
	TestTrue(TEXT("on Apple, a connection timeout at the heartbeat warns"), FLocHubBridgeClient::ShouldWarnAboutHttpConnectionTimeout(true, 15.0f));
	TestTrue(TEXT("on Apple, a connection timeout below the heartbeat warns"), FLocHubBridgeClient::ShouldWarnAboutHttpConnectionTimeout(true, 10.0f));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeFollowsUrlChangeTest,
	"LocHub.Bridge.Client.FollowsUrlChange",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeFollowsUrlChangeTest::RunTest(const FString& Parameters)
{
	// A Service Port change must move the bridge without waiting for an editor restart --
	// FLocHubEditorModule::SyncServiceConfig() does this by calling Start() again once GetBaseUrl() differs.
	const TSharedRef<FLocHubBridgeClient> Client = MakeShared<FLocHubBridgeClient>();
	Client->Start(TEXT("http://127.0.0.1:54341"));
	TestEqual(TEXT("The client runs on the URL it was started with"), Client->GetBaseUrl(), FString(TEXT("http://127.0.0.1:54341")));

	Client->Start(TEXT("http://127.0.0.1:54342"));
	TestEqual(TEXT("The client follows a later Start() to a new URL"), Client->GetBaseUrl(), FString(TEXT("http://127.0.0.1:54342")));

	Client->Stop();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeRefusesOtherProjectTest,
	"LocHub.Bridge.Client.RefusesOtherProject",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeRefusesOtherProjectTest::RunTest(const FString& Parameters)
{
	// A stream must never open against a service that identifies as another project.
	AddExpectedMessage(TEXT("LocHub bridge: the service on"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString OtherProjectDirWithSlash = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, OtherProjectDirWithSlash.LeftChop(1));
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// The fake answers healthy but as a different project than this one (LocHubEnvironment::GetProjectDir()).
	TestNotEqual(TEXT("The fake's project differs from this one"), OtherProjectDirWithSlash.LeftChop(1), LocHubEnvironment::GetProjectDir().LeftChop(1));

	const TSharedRef<FLocHubBridgeClient> Client = MakeShared<FLocHubBridgeClient>();
	Client->Start(Fake->GetBaseUrl());
	// OnTick's automatic reconnect is suppressed for the whole Automation run (GIsAutomationTesting); this test wants
	// one real, expected attempt instead of waiting on that gate.
	Client->ConnectNowForTests();

	const double Deadline = FPlatformTime::Seconds() + 10.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Client, Deadline, OtherProjectDirWithSlash]() -> bool
	{
		if (Client->IsHealthCheckPending() && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestFalse(TEXT("The health answer was handled within the deadline"), Client->IsHealthCheckPending());
		TestFalse(TEXT("The health endpoint was asked"), Fake->GetRequests(TEXT("/api/health")).IsEmpty());
		TestFalse(TEXT("Never connects to another project's service"), Client->IsConnected());
		TestEqual(TEXT("The SSE stream is never opened"), Client->GetStreamOpenAttempts(), 0);
		Client->Stop();
		LocHubTests::DeleteTempDir(OtherProjectDirWithSlash);
		return true;
	}));
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
