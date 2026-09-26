// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Async/Async.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "LocHubEnvironment.h"
#include "LocHubJson.h"
#include "LocHubProcessSpawnLock.h"
#include "LocHubScopedEnvVar.h"
#include "LocHubServiceClient.h"
#include "LocHubServiceProcess.h"
#include "LocHubSettings.h"
#include "LocHubSyncLock.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Misc/SecureHash.h"
#include "Tests/LocHubFakeService.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubServiceTestsPrivate
{
	using FResults = TMap<FString, FLocHubHttpResult>;

	FLocHubServiceClient::FOnResult RecordAs(const TSharedRef<FResults>& InResults, const FString& InName)
	{
		return [InResults, InName](const FLocHubHttpResult& InResult)
		{
			InResults->Add(InName, InResult);
		};
	}

	FLocHubServiceProcess::FOnReady RecordOutcome(const TSharedRef<LocHubTests::FAsyncOutcome>& InOutcome)
	{
		return [InOutcome](const bool bOk, const FString& InError)
		{
			InOutcome->bDone = true;
			InOutcome->bOk = bOk;
			InOutcome->Error = InError;
		};
	}

	FLocHubServiceProcess::FConfig MakeTestConfig(const FString& InTempDir, const int32 InPort, const bool bAutoStart)
	{
		FLocHubServiceProcess::FConfig Config;
		Config.Port = InPort;
		Config.bAutoStart = bAutoStart;
		Config.ProjectDir = InTempDir.LeftChop(1);
		Config.ServiceScript = InTempDir / TEXT("NoService/Resources/LocHubService/lochub_service.mjs");
		Config.StateDir = InTempDir / TEXT("State");
		return Config;
	}

	/** /api/health body of an owned/adopted service that still answers with the Anthropic settings it started with,
	 *  while the test's FConfig asks for a different provider (AI-mismatch restart tests). */
	FString BuildAiMismatchHealthBody(const uint32 InPid, const FString& InProjectDir, const bool bJobRunning)
	{
		FString EscapedDir = InProjectDir;
		EscapedDir.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
		return FString::Printf(TEXT("{\"ok\":true,\"pid\":%u,\"projectDir\":\"%s\",\"stale\":false,")
			TEXT("\"ai\":{\"provider\":\"anthropic\",\"auth\":\"subscription\",\"translateModel\":\"claude-opus-5-5\",\"judgeModel\":\"claude-sonnet-5\"},")
			TEXT("\"jobRunning\":%s}"),
			InPid, *EscapedDir, bJobRunning ? TEXT("true") : TEXT("false"));
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSyncLockExclusiveTest,
	"LocHub.SyncLock.Exclusive",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSyncLockExclusiveTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("Default path"), FLocHubSyncLock::GetDefaultPath(TEXT("D:/Project/")), TEXT("D:/Project/Saved/LocHub/sync.lock"));

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString LockPath = TempDir / TEXT("Saved/LocHub/sync.lock");
	FString Holder;

	FLocHubSyncLock First;
	TestTrue(TEXT("First acquires"), First.TryAcquire(LockPath, TEXT("Push (editor)"), Holder));
	TestTrue(TEXT("First holds"), First.IsHeld());

	FLocHubSyncLock Second;
	TestFalse(TEXT("Second is refused while the first holds"), Second.TryAcquire(LockPath, TEXT("Pull (commandlet)"), Holder));
	TestTrue(TEXT("Refusal names the holder"), Holder.Contains(TEXT("Push (editor)")));
	TestFalse(TEXT("Second does not hold"), Second.IsHeld());

	First.Release();
	TestTrue(TEXT("Second acquires after release"), Second.TryAcquire(LockPath, TEXT("Pull (commandlet)"), Holder));
	Second.Release();

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceHelpersTest,
	"LocHub.Service.Helpers",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceHelpersTest::RunTest(const FString& Parameters)
{
	int32 Major = 0;
	int32 Minor = 0;
	TestTrue(TEXT("Node version parses"), LocHubEnvironment::ParseNodeVersion(TEXT("v22.11.0\r\n"), Major, Minor));
	TestEqual(TEXT("Major"), Major, 22);
	TestEqual(TEXT("Minor"), Minor, 11);
	TestFalse(TEXT("Garbage does not parse"), LocHubEnvironment::ParseNodeVersion(TEXT("not a version"), Major, Minor));
	TestTrue(TEXT("22.11 is enough"), LocHubEnvironment::IsNodeVersionSupported(22, 11));
	TestFalse(TEXT("22.10 is not"), LocHubEnvironment::IsNodeVersionSupported(22, 10));
	TestTrue(TEXT("23.0 is enough"), LocHubEnvironment::IsNodeVersionSupported(23, 0));
	TestFalse(TEXT("20.99 is not"), LocHubEnvironment::IsNodeVersionSupported(20, 99));

	const FString PluginDir = TEXT("C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/Marketplace/LocHub");
	FLocHubServiceProcess::FConfig Config;
	Config.Port = 47999;
	Config.Policy = TEXT("approved_only");
	Config.Provider = TEXT("openai");
	Config.Auth = TEXT("api");
	Config.TranslateModel = TEXT("gpt-6-sol");
	Config.JudgeModel = TEXT("gpt-6-luna");
	Config.ProjectDir = TEXT("D:/Projects/My Game");
	Config.ServiceScript = PluginDir / TEXT("Resources/LocHubService/lochub_service.mjs");
	Config.WebDir = PluginDir / TEXT("Resources/LocHubWeb");
	Config.WebDepsDir = PluginDir / TEXT("Source/ThirdParty/LocHubWebDeps");
	Config.StateDir = TEXT("D:/Projects/My Game/Saved/LocHub");
	TestEqual(TEXT("Serve arguments keep paths with spaces whole"), FLocHubServiceProcess::BuildServeArguments(Config),
		TEXT("\"C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/Marketplace/LocHub/Resources/LocHubService/lochub_service.mjs\" serve --project \"D:/Projects/My Game\" --port 47999 --policy approved_only --provider openai --auth api --translate-model \"gpt-6-sol\" --judge-model \"gpt-6-luna\" --web-dir \"C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/Marketplace/LocHub/Resources/LocHubWeb\" --web-deps-dir \"C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/Marketplace/LocHub/Source/ThirdParty/LocHubWebDeps\" --brief-file \"D:/Projects/My Game/Saved/LocHub/brief.md\""));
	TestEqual(TEXT("Base URL"), MakeShared<FLocHubServiceProcess>(Config)->GetBaseUrl(), TEXT("http://127.0.0.1:47999"));

	// The key never appears in the serve arguments (key-contract.md §1): only LOCHUB_API_KEY, set around the spawn,
	// hands it to the child.
	Config.ApiKey = TEXT("test-key-not-real");
	TestFalse(TEXT("The key is not in the serve arguments"), FLocHubServiceProcess::BuildServeArguments(Config).Contains(TEXT("test-key-not-real")));

	const FLocHubServiceProcess::FConfig Default = FLocHubServiceProcess::MakeDefaultConfig();
	TestTrue(TEXT("Script is the plugin's bundled service"), Default.ServiceScript.EndsWith(TEXT("/Resources/LocHubService/lochub_service.mjs")));
	TestTrue(TEXT("Web app folder"), Default.WebDir.EndsWith(TEXT("/Resources/LocHubWeb")));
	TestTrue(TEXT("Web deps folder"), Default.WebDepsDir.EndsWith(TEXT("/Source/ThirdParty/LocHubWebDeps")));
	TestTrue(TEXT("State lives in Saved/LocHub"), Default.StateDir.EndsWith(TEXT("Saved/LocHub")));
	TestFalse(TEXT("Project dir has no trailing slash"), Default.ProjectDir.EndsWith(TEXT("/")));
	TestTrue(TEXT("Port is a user port"), Default.Port >= 1024 && Default.Port <= 65535);
	TestTrue(TEXT("Brief hash is a lowercase hex SHA-1"), Default.BriefSha1.Len() == 40 && Default.BriefSha1 == Default.BriefSha1.ToLower());
	TestTrue(TEXT("Key id is empty or 12 lowercase hex characters"), Default.KeyId.IsEmpty() || (Default.KeyId.Len() == 12 && Default.KeyId == Default.KeyId.ToLower()));
	TestEqual(TEXT("Key id matches ComputeKeyId of the same key"), Default.KeyId, FLocHubServiceProcess::ComputeKeyId(Default.ApiKey));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceMakeDefaultConfigKeyGateTest,
	"LocHub.Service.MakeDefaultConfigKeyGate",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceMakeDefaultConfigKeyGateTest::RunTest(const FString& Parameters)
{
	// R2-M4: MakeDefaultConfig reads the live ULocHubSettings CDO directly, with no injection seam (unlike
	// GetActiveApiKey, which LocHubSettingsTests.cpp exercises through a transient NewObject instance instead).
	// Proving M-1's auth gate and the length cap here means mutating the CDO for the duration of this test and
	// restoring every touched field afterwards; SaveConfig is never called, so Config/DefaultEditor.ini is untouched.
	ULocHubSettings* Settings = GetMutableDefault<ULocHubSettings>();
	const ELocHubAiProvider PreviousProvider = Settings->AiProvider;
	const ELocHubAnthropicAuth PreviousAuth = Settings->AnthropicAuth;
	const FString PreviousKey = Settings->AnthropicApiKey;
	ON_SCOPE_EXIT
	{
		Settings->AiProvider = PreviousProvider;
		Settings->AnthropicAuth = PreviousAuth;
		Settings->AnthropicApiKey = PreviousKey;
	};

	Settings->AiProvider = ELocHubAiProvider::Anthropic;
	Settings->AnthropicApiKey = TEXT("test-key-not-real");

	Settings->AnthropicAuth = ELocHubAnthropicAuth::ClaudeSubscription;
	const FLocHubServiceProcess::FConfig SubscriptionConfig = FLocHubServiceProcess::MakeDefaultConfig();
	TestTrue(TEXT("Claude Subscription auth never gets the key"), SubscriptionConfig.ApiKey.IsEmpty());
	TestTrue(TEXT("...and so has no key id either"), SubscriptionConfig.KeyId.IsEmpty());

	Settings->AnthropicAuth = ELocHubAnthropicAuth::ApiKey;
	const FLocHubServiceProcess::FConfig ApiKeyConfig = FLocHubServiceProcess::MakeDefaultConfig();
	TestEqual(TEXT("API Key auth passes the configured key through"), ApiKeyConfig.ApiKey, FString(TEXT("test-key-not-real")));
	TestEqual(TEXT("Key id matches the passed-through key"), ApiKeyConfig.KeyId, FLocHubServiceProcess::ComputeKeyId(TEXT("test-key-not-real")));

	// A key past the 4096-character cap is treated as no key at all. The exact match below (not a substring
	// Contains check) pins the whole logged line, so a regression that also logged the key value itself -- not
	// just its length -- would leave this message unmatched and fail the test, instead of silently passing
	// because "characters long" still appears somewhere in a longer line.
	const FString OverlongKey = FString::ChrN(4097, TEXT('k'));
	AddExpectedMessagePlain(
		FString::Printf(TEXT("The configured API key is %d characters long, further than any real provider key; treating it as no key."), OverlongKey.Len()),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Exact, 1);
	Settings->AnthropicApiKey = OverlongKey;
	const FLocHubServiceProcess::FConfig OverlongConfig = FLocHubServiceProcess::MakeDefaultConfig();
	TestTrue(TEXT("A key over the length cap is treated as no key"), OverlongConfig.ApiKey.IsEmpty());
	TestTrue(TEXT("...and gets no key id either"), OverlongConfig.KeyId.IsEmpty());

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceProjectDirComparisonTest,
	"LocHub.Service.ProjectDirComparison",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceProjectDirComparisonTest::RunTest(const FString& Parameters)
{
	const FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()) / TEXT("LocHubDirCompare/Project");

	TestEqual(TEXT("normalized: no trailing slash"), FLocHubServiceClient::NormalizeProjectDir(ProjectDir + TEXT("/")), ProjectDir);
	TestTrue(TEXT("a trailing slash does not make another folder"), FLocHubServiceClient::IsSameProjectDir(ProjectDir + TEXT("/"), ProjectDir));
#if PLATFORM_WINDOWS
	// Backslashes separate folders only on Windows; on Mac/Linux a path that starts with one is relative (FPaths::IsRelative).
	TestEqual(TEXT("normalized: forward slashes, no trailing slash"),
		FLocHubServiceClient::NormalizeProjectDir(ProjectDir.Replace(TEXT("/"), TEXT("\\")) + TEXT("\\")), ProjectDir);
	TestTrue(TEXT("a trailing slash and backslashes do not make another folder"),
		FLocHubServiceClient::IsSameProjectDir(ProjectDir + TEXT("/"), ProjectDir.Replace(TEXT("/"), TEXT("\\"))));
#endif
	TestFalse(TEXT("a sibling folder is another project"),
		FLocHubServiceClient::IsSameProjectDir(ProjectDir, ProjectDir + TEXT("2")));
	// The engine's own rule (FPaths::IsSamePath): case matters wherever the file system can tell two folders apart by
	// case alone, i.e. everywhere but Windows.
	TestEqual(TEXT("a case-only difference is the same folder only on Windows"),
		FLocHubServiceClient::IsSameProjectDir(ProjectDir, ProjectDir.ToUpper()), PLATFORM_MICROSOFT != 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceHealthTest,
	"LocHub.Service.Health",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceHealthTest::RunTest(const FString& Parameters)
{
	FLocHubHealth WithAi;
	const bool bWithAiParsed = FLocHubServiceClient::ParseHealth(
		TEXT("{\"ok\":true,\"ai\":{\"provider\":\"deepseek\",\"auth\":\"api\",\"translateModel\":\"m1\",\"judgeModel\":\"m2\",\"keyId\":\"a9993e364706\"},\"jobRunning\":true}"),
		WithAi);
	TestTrue(TEXT("Parses"), bWithAiParsed);
	TestEqual(TEXT("Provider"), WithAi.AiProvider, TEXT("deepseek"));
	TestEqual(TEXT("Auth"), WithAi.AiAuth, TEXT("api"));
	TestEqual(TEXT("Translate model"), WithAi.AiTranslateModel, TEXT("m1"));
	TestEqual(TEXT("Judge model"), WithAi.AiJudgeModel, TEXT("m2"));
	TestTrue(TEXT("Key id present"), WithAi.bHasAiKeyId);
	TestEqual(TEXT("Key id"), WithAi.AiKeyId, TEXT("a9993e364706"));
	TestTrue(TEXT("Job running"), WithAi.bJobRunning);

	FLocHubHealth WithoutAi;
	const bool bWithoutAiParsed = FLocHubServiceClient::ParseHealth(TEXT("{\"ok\":true}"), WithoutAi);
	TestTrue(TEXT("Old body still parses"), bWithoutAiParsed);
	TestTrue(TEXT("Provider empty"), WithoutAi.AiProvider.IsEmpty());
	TestTrue(TEXT("Auth empty"), WithoutAi.AiAuth.IsEmpty());
	TestTrue(TEXT("Translate model empty"), WithoutAi.AiTranslateModel.IsEmpty());
	TestTrue(TEXT("Judge model empty"), WithoutAi.AiJudgeModel.IsEmpty());
	TestFalse(TEXT("No \"ai\" object at all: key id field absent"), WithoutAi.bHasAiKeyId);
	TestFalse(TEXT("Job not running"), WithoutAi.bJobRunning);

	FLocHubHealth WithAiNoKeyId;
	const bool bWithAiNoKeyIdParsed = FLocHubServiceClient::ParseHealth(TEXT("{\"ok\":true,\"ai\":{\"provider\":\"anthropic\"}}"), WithAiNoKeyId);
	TestTrue(TEXT("Parses"), bWithAiNoKeyIdParsed);
	TestFalse(TEXT("An \"ai\" object from a build that predates the field: key id absent"), WithAiNoKeyId.bHasAiKeyId);

	FLocHubHealth WithEmptyKeyId;
	const bool bWithEmptyKeyIdParsed = FLocHubServiceClient::ParseHealth(TEXT("{\"ok\":true,\"ai\":{\"provider\":\"anthropic\",\"keyId\":\"\"}}"), WithEmptyKeyId);
	TestTrue(TEXT("Parses"), bWithEmptyKeyIdParsed);
	TestTrue(TEXT("An explicitly empty keyId is still a present field"), WithEmptyKeyId.bHasAiKeyId);
	TestTrue(TEXT("Its value is empty"), WithEmptyKeyId.AiKeyId.IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceIsAiConfigAppliedTest,
	"LocHub.Service.IsAiConfigApplied",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceIsAiConfigAppliedTest::RunTest(const FString& Parameters)
{
	FLocHubServiceProcess::FConfig Config;
	Config.Provider = TEXT("deepseek");
	Config.Auth = TEXT("api");
	Config.TranslateModel = TEXT("m1");
	Config.JudgeModel = TEXT("m2");

	FLocHubHealth Health;
	Health.AiProvider = TEXT("deepseek");
	Health.AiAuth = TEXT("api");
	Health.AiTranslateModel = TEXT("m1");
	Health.AiJudgeModel = TEXT("m2");
	TestTrue(TEXT("Same values"), FLocHubServiceProcess::IsAiConfigApplied(Config, Health));

	FLocHubHealth DifferentProvider = Health;
	DifferentProvider.AiProvider = TEXT("openai");
	TestFalse(TEXT("Different provider"), FLocHubServiceProcess::IsAiConfigApplied(Config, DifferentProvider));

	FLocHubHealth DifferentAuth = Health;
	DifferentAuth.AiAuth = TEXT("subscription");
	TestFalse(TEXT("Different auth"), FLocHubServiceProcess::IsAiConfigApplied(Config, DifferentAuth));

	FLocHubServiceProcess::FConfig ConfigWithEmptyModel = Config;
	ConfigWithEmptyModel.TranslateModel.Empty();
	FLocHubHealth AnyReportedModel = Health;
	AnyReportedModel.AiTranslateModel = TEXT("whatever-the-service-picked");
	TestTrue(TEXT("Empty config model is not compared"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithEmptyModel, AnyReportedModel));

	FLocHubServiceProcess::FConfig ConfigModelA = Config;
	ConfigModelA.TranslateModel = TEXT("a");
	FLocHubHealth HealthModelB = Health;
	HealthModelB.AiTranslateModel = TEXT("b");
	TestFalse(TEXT("Config model a vs reported b"), FLocHubServiceProcess::IsAiConfigApplied(ConfigModelA, HealthModelB));

	FLocHubHealth NoAi;
	TestTrue(TEXT("Health without ai (old build)"), FLocHubServiceProcess::IsAiConfigApplied(Config, NoAi));

	FLocHubServiceProcess::FConfig ConfigWithBrief = Config;
	ConfigWithBrief.BriefSha1 = TEXT("aaaa");
	FLocHubHealth HealthSameBrief = Health;
	HealthSameBrief.AiBriefSha1 = TEXT("aaaa");
	TestTrue(TEXT("Same brief hash"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithBrief, HealthSameBrief));

	FLocHubHealth HealthDifferentBrief = Health;
	HealthDifferentBrief.AiBriefSha1 = TEXT("bbbb");
	TestFalse(TEXT("Same models, different brief hash"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithBrief, HealthDifferentBrief));

	FLocHubHealth HealthNoBriefField = Health;
	HealthNoBriefField.AiBriefSha1.Empty();
	TestTrue(TEXT("Health without briefSha1 (old build) counts as applied"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithBrief, HealthNoBriefField));

	// WriteBriefFile returns no hash when brief.md could not be written: nothing to compare, or every probe would
	// restart the service over a file the editor cannot write.
	TestTrue(TEXT("Config without a brief hash (unwritten brief.md) counts as applied"), FLocHubServiceProcess::IsAiConfigApplied(Config, HealthDifferentBrief));

	FLocHubServiceProcess::FConfig ConfigWithKey = Config;
	ConfigWithKey.KeyId = TEXT("a9993e364706");
	FLocHubHealth HealthSameKey = Health;
	HealthSameKey.bHasAiKeyId = true;
	HealthSameKey.AiKeyId = TEXT("a9993e364706");
	TestTrue(TEXT("Same key id"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithKey, HealthSameKey));

	FLocHubHealth HealthDifferentKey = Health;
	HealthDifferentKey.bHasAiKeyId = true;
	HealthDifferentKey.AiKeyId = TEXT("000000000000");
	TestFalse(TEXT("Different key id"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithKey, HealthDifferentKey));

	FLocHubHealth HealthNoKeyIdField = Health;
	HealthNoKeyIdField.bHasAiKeyId = false;
	TestTrue(TEXT("Health without a keyId field (old build) counts as applied"), FLocHubServiceProcess::IsAiConfigApplied(ConfigWithKey, HealthNoKeyIdField));

	FLocHubHealth HealthEmptyKeyField = Health;
	HealthEmptyKeyField.bHasAiKeyId = true;
	HealthEmptyKeyField.AiKeyId = FString();
	TestTrue(TEXT("No key configured, service reports no key either: both-empty is a match"), FLocHubServiceProcess::IsAiConfigApplied(Config, HealthEmptyKeyField));
	TestFalse(TEXT("No key configured, but the service still reports one: not applied, unlike the brief-hash rule"), FLocHubServiceProcess::IsAiConfigApplied(Config, HealthDifferentKey));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceNotRunningTest,
	"LocHub.Service.NotRunning",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceNotRunningTest::RunTest(const FString& Parameters)
{
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(LocHubServiceTestsPrivate::MakeTestConfig(TempDir, LocHubTests::DeadServicePort, false));
	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(LocHubServiceTestsPrivate::RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("Not ready"), Outcome->bOk);
		TestTrue(TEXT("The error points at the auto start setting"), Outcome->Error.Contains(TEXT("auto start")));
		TestFalse(TEXT("No process was started"), Service->IsOwnedProcessRunning());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceMissingScriptTest,
	"LocHub.Service.MissingScript",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceMissingScriptTest::RunTest(const FString& Parameters)
{
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(LocHubServiceTestsPrivate::MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true));
	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(LocHubServiceTestsPrivate::RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("Not ready"), Outcome->bOk);
		// Without Node on PATH the Node error comes first; with Node the missing build is reported.
		TestTrue(TEXT("The error says what is missing"), Outcome->Error.Contains(TEXT("is missing")) || Outcome->Error.Contains(TEXT("Node.js")));
		TestFalse(TEXT("No process was started"), Service->IsOwnedProcessRunning());
		TestFalse(TEXT("No pid file"), FPaths::FileExists(Service->GetPidFilePath()));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubClientFakeServiceTest,
	"LocHub.Client.FakeService",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubClientFakeServiceTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}

	const TSharedRef<FResults> Results = MakeShared<FResults>();
	const FLocHubServiceClient Client(Fake->GetBaseUrl());
	const FLocHubServiceClient Dead(FString::Printf(TEXT("http://127.0.0.1:%d"), LocHubTests::DeadServicePort));
	Client.GetHealth(RecordAs(Results, TEXT("health")));
	Dead.GetHealth(RecordAs(Results, TEXT("dead")));
	Client.Push(TEXT("{\"target\":\"Test\"}"), true, RecordAs(Results, TEXT("push")));
	Client.GetExport(TEXT("ru"), RecordAs(Results, TEXT("export")));
	Client.PostInboxApplied(LocHubJson::InboxAppliedToJson({ TEXT("q1") }), RecordAs(Results, TEXT("applied")));
	// A POST without a body still goes out as JSON: the service answers 415 otherwise (contract).
	Client.Send(TEXT("POST"), TEXT("/api/export/ack"), FString(), 10.0f, RecordAs(Results, TEXT("emptyPost")));

	const double Deadline = FPlatformTime::Seconds() + 20.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Results, Deadline]() -> bool
	{
		if (Results->Num() < 6 && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		if (!TestEqual(TEXT("Every call answered"), Results->Num(), 6))
		{
			return true;
		}

		bool bHealthy = false;
		TestTrue(TEXT("Health is 2xx"), (*Results)[TEXT("health")].IsOk());
		TestTrue(TEXT("Health parses"), LocHubJson::ParseHealth((*Results)[TEXT("health")].Body, bHealthy) && bHealthy);
		TestFalse(TEXT("Dead port has no connection"), (*Results)[TEXT("dead")].bConnected);
		TestFalse(TEXT("Dead port is not ok"), (*Results)[TEXT("dead")].IsOk());

		const TArray<FLocHubFakeService::FRecordedRequest> Pushes = Fake->GetRequests(TEXT("/api/push"));
		if (TestEqual(TEXT("One push"), Pushes.Num(), 1))
		{
			const FString* DryRun = Pushes[0].QueryParams.Find(TEXT("dryRun"));
			TestTrue(TEXT("Dry run is a query parameter"), DryRun != nullptr && *DryRun == TEXT("1"));
			TestTrue(TEXT("Body arrives"), Pushes[0].Body.Contains(TEXT("\"target\":\"Test\"")));
			TestTrue(TEXT("Push is sent as JSON"), Pushes[0].ContentType.StartsWith(TEXT("application/json")));
		}
		const TArray<FLocHubFakeService::FRecordedRequest> EmptyPosts = Fake->GetRequests(TEXT("/api/export/ack"));
		if (TestEqual(TEXT("One empty POST"), EmptyPosts.Num(), 1))
		{
			TestTrue(TEXT("Empty POST is sent as JSON"), EmptyPosts[0].ContentType.StartsWith(TEXT("application/json")));
			TestEqual(TEXT("Empty POST carries an empty JSON object"), EmptyPosts[0].Body, TEXT("{}"));
		}
		const TArray<FLocHubFakeService::FRecordedRequest> Exports = Fake->GetRequests(TEXT("/api/export"));
		if (TestEqual(TEXT("One export"), Exports.Num(), 1))
		{
			const FString* Culture = Exports[0].QueryParams.Find(TEXT("culture"));
			TestTrue(TEXT("Culture is a query parameter"), Culture != nullptr && *Culture == TEXT("ru"));
		}
		const TArray<FLocHubFakeService::FRecordedRequest> Applied = Fake->GetRequests(TEXT("/api/inbox/applied"));
		if (TestEqual(TEXT("One applied"), Applied.Num(), 1))
		{
			TestTrue(TEXT("Applied ids are sent"), Applied[0].Body.Contains(TEXT("q1")));
		}
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceRefusesOtherProjectTest,
	"LocHub.Service.RefusesOtherProject",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceRefusesOtherProjectTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString OtherProjectDirWithSlash = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, OtherProjectDirWithSlash.LeftChop(1));
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true));
	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Deadline, TempDir, OtherProjectDirWithSlash]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("Refused"), Outcome->bOk);
		TestTrue(TEXT("Names the port"), Outcome->Error.Contains(FString::Printf(TEXT("Port %d"), LocHubTests::FakeServicePort)));
		TestTrue(TEXT("Points at the Service Port setting"), Outcome->Error.Contains(TEXT("Service Port")));
		LocHubTests::DeleteTempDir(TempDir);
		LocHubTests::DeleteTempDir(OtherProjectDirWithSlash);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceRefusesUnidentifiedServiceTest,
	"LocHub.Service.RefusesUnidentifiedService",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceRefusesUnidentifiedServiceTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// Old dist/ build: no "pid"/"projectDir" in the health body.
	Fake->SetResponse(TEXT("/api/health"), 200, TEXT("{\"ok\":true}"));

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true));
	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("Refused"), Outcome->bOk);
		TestTrue(TEXT("Says the build is outdated"), Outcome->Error.Contains(TEXT("outdated LocHub service")));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceStalePidFileNotKilledTest,
	"LocHub.Service.StalePidFileNotKilled",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceStalePidFileNotKilledTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true));
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	// Names a pid nothing on this machine is expected to run as; StartNode must never try to stop it.
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(TEXT("999999"), *Service->GetPidFilePath()));
	// The old "kill whatever pid service.pid names" path, if it came back, would have to go through this seam --
	// StopProcess() is the only place in the class that ever terminates a process (Minor A, C; test gap noted in
	// the re-review: the pid file alone must never move this).
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, Terminated, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("Not ready"), Outcome->bOk);
		TestFalse(TEXT("The stale pid file is gone"), FPaths::FileExists(Service->GetPidFilePath()));
		TestEqual(TEXT("Nothing was terminated"), Service->GetTerminatedProcessCount(), 0);
		TestEqual(TEXT("The termination seam recorded nothing"), Terminated->Num(), 0);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceForeignStaleFailsTest,
	"LocHub.Service.ForeignStaleFails",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceForeignStaleFailsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// Same project, but a pid this instance never started or adopted, and stale data.
	Fake->SetResponse(TEXT("/api/health"), 200, FString::Printf(TEXT("{\"ok\":true,\"pid\":4321,\"projectDir\":\"%s\",\"stale\":true}"), *ProjectDir));

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, false));
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	// A pid file naming a different pid than the health answer: foreign, must not be adopted.
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(TEXT("111"), *Service->GetPidFilePath()));

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("Refused"), Outcome->bOk);
		TestTrue(TEXT("Says the data is stale"), Outcome->Error.Contains(TEXT("older than Localization/LocHub")));
		TestFalse(TEXT("Nothing was adopted"), Service->IsOwnedProcessRunning());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceAdoptsOrphanOfDeadHostTest,
	"LocHub.Service.AdoptsOrphanOfDeadHost",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceAdoptsOrphanOfDeadHostTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	// The node pid is this test process's own pid, so FPlatformProcess::OpenProcess/IsProcRunning genuinely see a
	// running process without spawning a second one; the host pid is unrelated and its liveness is faked below.
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	Fake->SetHealth(NodePid, ProjectDir, false);

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true));
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("Ready"), Outcome->bOk);
		TestTrue(TEXT("The orphan of the dead host is adopted"), Service->IsOwnedProcessRunning());
		TestEqual(TEXT("Adoption itself terminates nothing"), Terminated->Num(), 0);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceKeepsServiceOfLiveHostTest,
	"LocHub.Service.KeepsServiceOfLiveHost",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceKeepsServiceOfLiveHostTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	// A host pid distinct from this test process; its liveness is faked true below: a live host of
	// this project keeps its service, it is never adopted out from under it.
	const uint32 LiveHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	Fake->SetHealth(NodePid, ProjectDir, false);

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true));
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, LiveHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return true; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("Used as is"), Outcome->bOk);
		TestFalse(TEXT("Not adopted"), Service->IsOwnedProcessRunning());
		Service->Stop();
		TestEqual(TEXT("Stop terminates nothing"), Terminated->Num(), 0);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceRestartRestartsAdoptedOrphanTest,
	"LocHub.Service.RestartRestartsAdoptedOrphan",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceRestartRestartsAdoptedOrphanTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// Fresh data (not stale): a Restart that ignores staleness would silently keep this orphan running an old build.
	Fake->SetHealth(NodePid, ProjectDir, false);

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true));
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	// A first action in a new session, exactly as the regression scenario describes: nothing was adopted yet when
	// Restart is pressed, so Stop() finds no owned process and the adoption happens inside the probe Restart triggers.
	Service->Restart(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, NodePid, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("The adopted orphan was stopped through the termination seam"), Terminated->Contains(NodePid));
		TestFalse(TEXT("Not ready: the old process is gone and no service.pid names a fresh one"), Outcome->bOk);
		TestTrue(TEXT("A start was attempted"), Outcome->Error.Contains(TEXT("is missing")) || Outcome->Error.Contains(TEXT("Node.js")));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceProbeAfterStopIgnoredTest,
	"LocHub.Service.ProbeAfterStopIgnored",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceProbeAfterStopIgnoredTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, TempDir.LeftChop(1));
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true));

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome1 = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome1));
	// The probe above is still in flight (nothing has ticked yet): Stop() must resolve this waiter itself, and its
	// eventual, now-stale answer must not be allowed to resolve a waiter registered after Stop().
	Service->Stop();
	TestTrue(TEXT("Stop resolves the waiter it holds synchronously"), Outcome1->bDone);
	TestFalse(TEXT("The stopped waiter is not ready"), Outcome1->bOk);
	TestTrue(TEXT("The stopped waiter is told it was stopped"), Outcome1->Error.Contains(TEXT("stopped")));

	// Point at the healthy fake so only a fresh probe (not the stale dead-port one) can make this waiter succeed.
	Service->SetConfig(MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true));
	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome2 = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome2));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome2, Deadline, TempDir]() -> bool
	{
		if (!Outcome2->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("The fresh waiter answers"), Outcome2->bDone);
		TestTrue(TEXT("The fresh waiter is resolved by the new probe, not the stale one"), Outcome2->bOk);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceAiMismatchRestartsOwnedTest,
	"LocHub.Service.AiMismatchRestartsOwned",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceAiMismatchRestartsOwnedTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	// The node pid is this test process's own pid, so adoption sees a genuinely running process (same trick as
	// FLocHubServiceRestartRestartsAdoptedOrphanTest); the host pid is unrelated and faked dead so it is adopted.
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// Fresh data (not stale), but the running process still answers with the old AI settings: OnHealthProbed must
	// restart it for the new Project Settings, exactly like the stale-data restart, once.
	Fake->SetResponse(TEXT("/api/health"), 200, BuildAiMismatchHealthBody(NodePid, ProjectDir, false));

	FLocHubServiceProcess::FConfig Config = MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true);
	Config.Provider = TEXT("deepseek");
	Config.Auth = TEXT("api");
	Config.TranslateModel = TEXT("deepseek-v4-pro");
	Config.JudgeModel = TEXT("deepseek-flash");
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	// Fake is captured so the HTTP listener outlives RunTest: the probe is answered only on a later tick.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, NodePid, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("The owned service was stopped for the new AI settings"), Terminated->Contains(NodePid));
		TestEqual(TEXT("One restart attempt"), Terminated->Num(), 1);
		TestFalse(TEXT("Not ready: no service.pid names a fresh process to answer"), Outcome->bOk);
		TestTrue(TEXT("A start was attempted"), Outcome->Error.Contains(TEXT("is missing")) || Outcome->Error.Contains(TEXT("Node.js")));

		// The one attempt is re-armed by any change the health probe compares -- a brief-only edit included, or a later
		// brief edit would find the attempt used up and neither restart nor wait for the job.
		TestTrue(TEXT("The restart attempt is used"), Service->IsAiRestartTried());
		Service->SetConfig(Service->GetConfig());
		TestTrue(TEXT("An unchanged Config keeps the attempt used"), Service->IsAiRestartTried());
		FLocHubServiceProcess::FConfig BriefOnly = Service->GetConfig();
		BriefOnly.BriefSha1 = TEXT("0123456789abcdef0123456789abcdef01234567");
		Service->SetConfig(BriefOnly);
		TestFalse(TEXT("A brief-only change re-arms the restart attempt"), Service->IsAiRestartTried());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceKeyOnlyChangeRearmsRestartTest,
	"LocHub.Service.KeyOnlyChangeRearmsRestart",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceKeyOnlyChangeRearmsRestartTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	// Same setup as FLocHubServiceAiMismatchRestartsOwnedTest: earn a real bAiRestartTried == true through an
	// actual mismatch restart, then prove a key-only Config change re-arms it too, isolated from every other field
	// (key-contract.md §3; SetConfig compares KeyId, never the raw ApiKey).
	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	Fake->SetResponse(TEXT("/api/health"), 200, BuildAiMismatchHealthBody(NodePid, ProjectDir, false));

	FLocHubServiceProcess::FConfig Config = MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true);
	Config.Provider = TEXT("deepseek");
	Config.Auth = TEXT("api");
	Config.TranslateModel = TEXT("deepseek-v4-pro");
	Config.JudgeModel = TEXT("deepseek-flash");
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	// Fake is captured so the HTTP listener outlives RunTest: the probe is answered only on a later tick.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, NodePid, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("The owned service was stopped for the new AI settings"), Terminated->Contains(NodePid));
		TestTrue(TEXT("The restart attempt is used"), Service->IsAiRestartTried());

		FLocHubServiceProcess::FConfig KeyOnly = Service->GetConfig();
		KeyOnly.KeyId = TEXT("a9993e364706");
		Service->SetConfig(KeyOnly);
		TestFalse(TEXT("A key-only change re-arms the restart attempt"), Service->IsAiRestartTried());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceAiMismatchDuringJobKeepsServiceTest,
	"LocHub.Service.AiMismatchDuringJobKeepsService",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceAiMismatchDuringJobKeepsServiceTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// Same mismatch as above, but a translation job is running: must not restart mid-job.
	Fake->SetResponse(TEXT("/api/health"), 200, BuildAiMismatchHealthBody(NodePid, ProjectDir, true));

	FLocHubServiceProcess::FConfig Config = MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true);
	Config.Provider = TEXT("deepseek");
	Config.Auth = TEXT("api");
	Config.TranslateModel = TEXT("deepseek-v4-pro");
	Config.JudgeModel = TEXT("deepseek-flash");
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	// Fired from inside the latent command below, once the first (mismatched) probe has resolved: a caller that
	// probes again before the job ends (the next Open LocHub, Push or Pull) sees the settings reverted to what the
	// still-running service already reports, so the deferred restart wait must clear without a restart.
	const TSharedRef<LocHubTests::FAsyncOutcome> MatchOutcome = MakeShared<LocHubTests::FAsyncOutcome>();
	const TSharedRef<bool> bMatchProbeStarted = MakeShared<bool>(false);

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	// Fake is captured so the HTTP listener outlives RunTest: the probe is answered only on a later tick.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, MatchOutcome, bMatchProbeStarted, Deadline, TempDir]() -> bool
	{
		if (!*bMatchProbeStarted)
		{
			if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
			{
				return false;
			}
			TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
			TestTrue(TEXT("Used as is while the job runs"), Outcome->bOk);
			TestEqual(TEXT("Nothing was restarted"), Terminated->Num(), 0);
			TestTrue(TEXT("The adopted service is still tracked as running"), Service->IsOwnedProcessRunning());
			TestTrue(TEXT("Waits for the job to finish"), Service->IsAiRestartPending());

			FLocHubServiceProcess::FConfig MatchingConfig = Service->GetConfig();
			MatchingConfig.Provider = TEXT("anthropic");
			MatchingConfig.Auth = TEXT("subscription");
			MatchingConfig.TranslateModel = TEXT("claude-opus-5-5");
			MatchingConfig.JudgeModel = TEXT("claude-sonnet-5");
			Service->SetConfig(MatchingConfig);
			Service->EnsureRunning(RecordOutcome(MatchOutcome));
			*bMatchProbeStarted = true;
			return false;
		}

		if (!MatchOutcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("The matching probe answers"), MatchOutcome->bDone);
		TestTrue(TEXT("Used as is: settings now match"), MatchOutcome->bOk);
		TestFalse(TEXT("The pending wait clears once nothing is mismatched"), Service->IsAiRestartPending());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceProbeOnlyNeverStartsTest,
	"LocHub.Service.ProbeOnlyNeverStarts",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceProbeOnlyNeverStartsTest::RunTest(const FString& Parameters)
{
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	// Auto start is on: only ProbeOnly's own contract -- never StartOrFail when nothing answers healthy -- can be
	// what keeps this from starting a process, unlike FLocHubServiceNotRunningTest (auto start off).
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(LocHubServiceTestsPrivate::MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true));
	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->ProbeOnly(LocHubServiceTestsPrivate::RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		// Nothing runs, so there is nothing to fail applying settings to; ProbeOnly must not report
		// "not running" either, or every settings edit before the service is first opened pops a red toast.
		TestTrue(TEXT("Ready: nothing to apply settings to"), Outcome->bOk);
		TestTrue(TEXT("No error"), Outcome->Error.IsEmpty());
		TestFalse(TEXT("Probe-only never starts a process"), Service->IsOwnedProcessRunning());
		TestFalse(TEXT("No pid file"), FPaths::FileExists(Service->GetPidFilePath()));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceProbeOnlyThenEnsureRunningStartsTest,
	"LocHub.Service.ProbeOnlyThenEnsureRunningStarts",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceProbeOnlyThenEnsureRunningStartsTest::RunTest(const FString& Parameters)
{
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(LocHubServiceTestsPrivate::MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true));

	const TSharedRef<LocHubTests::FAsyncOutcome> ProbeOutcome = MakeShared<LocHubTests::FAsyncOutcome>();
	const TSharedRef<LocHubTests::FAsyncOutcome> EnsureOutcome = MakeShared<LocHubTests::FAsyncOutcome>();
	// Same frame, before either probe's HTTP callback returns: EnsureRunning joins the probe ProbeOnly just started
	// and must still get a start attempt, not the probe-only "not running" answer.
	Service->ProbeOnly(LocHubServiceTestsPrivate::RecordOutcome(ProbeOutcome));
	Service->EnsureRunning(LocHubServiceTestsPrivate::RecordOutcome(EnsureOutcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, ProbeOutcome, EnsureOutcome, Deadline, TempDir]() -> bool
	{
		if (!EnsureOutcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("The joined probe-only caller answers too"), ProbeOutcome->bDone);
		TestTrue(TEXT("The EnsureRunning caller answers"), EnsureOutcome->bDone);
		TestFalse(TEXT("Not ready"), EnsureOutcome->bOk);
		TestTrue(TEXT("A start was attempted"), EnsureOutcome->Error.Contains(TEXT("is missing")) || EnsureOutcome->Error.Contains(TEXT("Node.js")));
		TestFalse(TEXT("\"not running\" is not the answer"), EnsureOutcome->Error.Contains(TEXT("is not running on")));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceRestartAfterProbeOnlyStartsTest,
	"LocHub.Service.RestartAfterProbeOnlyStarts",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceRestartAfterProbeOnlyStartsTest::RunTest(const FString& Parameters)
{
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(LocHubServiceTestsPrivate::MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true));

	const TSharedRef<LocHubTests::FAsyncOutcome> ProbeOutcome = MakeShared<LocHubTests::FAsyncOutcome>();
	const TSharedRef<LocHubTests::FAsyncOutcome> RestartOutcome = MakeShared<LocHubTests::FAsyncOutcome>();
	// The probe below is still in flight when Restart's own Stop() bumps the generation and would have discarded it
	// before it could reset bProbeOnlyRequested itself: the flag must not leak into Restart's probe.
	Service->ProbeOnly(LocHubServiceTestsPrivate::RecordOutcome(ProbeOutcome));
	Service->Restart(LocHubServiceTestsPrivate::RecordOutcome(RestartOutcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, ProbeOutcome, RestartOutcome, Deadline, TempDir]() -> bool
	{
		if (!RestartOutcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Stop() resolves the probe-only waiter it holds"), ProbeOutcome->bDone);
		TestTrue(TEXT("Restart answers"), RestartOutcome->bDone);
		TestFalse(TEXT("Not ready"), RestartOutcome->bOk);
		TestTrue(TEXT("A start was attempted, not \"not running\""),
			RestartOutcome->Error.Contains(TEXT("is missing")) || RestartOutcome->Error.Contains(TEXT("Node.js")));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServicePendingTickerSkipsWhileInUseTest,
	"LocHub.Service.PendingTickerSkipsWhileInUse",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServicePendingTickerSkipsWhileInUseTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	// A translation job is running: the first probe defers the AI-mismatch restart and arms the pending ticker.
	Fake->SetResponse(TEXT("/api/health"), 200, BuildAiMismatchHealthBody(NodePid, ProjectDir, true));

	FLocHubServiceProcess::FConfig Config = MakeTestConfig(TempDir, LocHubTests::FakeServicePort, true);
	Config.Provider = TEXT("deepseek");
	Config.Auth = TEXT("api");
	Config.TranslateModel = TEXT("deepseek-v4-pro");
	Config.JudgeModel = TEXT("deepseek-flash");
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double SetupDeadline = FPlatformTime::Seconds() + 15.0;
	const TSharedRef<double> GateUntil = MakeShared<double>(0.0);

	// Phase 1: let the first mismatch-during-job probe arm the pending ticker, then flip the fake to "job ended"
	// and gate the ticker with IsServiceInUseFn -- as if a Push or Pull were now talking to the service directly.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, NodePid, ProjectDir, GateUntil, SetupDeadline]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < SetupDeadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("Used as is while the job runs"), Outcome->bOk);
		TestTrue(TEXT("Waits for the job to finish"), Service->IsAiRestartPending());
		TestEqual(TEXT("Nothing restarted yet"), Terminated->Num(), 0);

		Fake->SetResponse(TEXT("/api/health"), 200, BuildAiMismatchHealthBody(NodePid, ProjectDir, false));
		Service->IsServiceInUseFn = []() { return true; };
		*GateUntil = FPlatformTime::Seconds() + 8.0;
		return true;
	}));

	// Phase 2: give the ticker (a few seconds' interval) a couple of chances to fire while gated; despite the job
	// having ended (a restart is now due), it must do nothing while something else is using the service.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Terminated, GateUntil]() -> bool
	{
		if (FPlatformTime::Seconds() < *GateUntil)
		{
			return false;
		}
		TestEqual(TEXT("Gated: no restart attempt"), Terminated->Num(), 0);
		TestTrue(TEXT("The owned process is still tracked as running"), Service->IsOwnedProcessRunning());
		TestTrue(TEXT("The wait is still pending, not resolved by a skipped tick"), Service->IsAiRestartPending());

		Service->IsServiceInUseFn = []() { return false; };
		*GateUntil = FPlatformTime::Seconds() + 10.0;
		return true;
	}));

	// Phase 3: ungated, the next tick finds the job ended and restarts -- the observable that only moves once the
	// gate is lifted, proving phase 2's silence was the gate and not some other reason.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Terminated, NodePid, GateUntil, TempDir]() -> bool
	{
		if (Terminated->Num() == 0 && FPlatformTime::Seconds() < *GateUntil)
		{
			return false;
		}
		TestTrue(TEXT("The owned process was stopped for the restart once ungated"), Terminated->Contains(NodePid));
		TestFalse(TEXT("The pending wait is resolved"), Service->IsAiRestartPending());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceBriefSha1Test,
	"LocHub.Service.BriefSha1Utf8",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceBriefSha1Test::RunTest(const FString& Parameters)
{
	// Pinned against Node's crypto (createHash('sha1').update(Buffer.from(text, 'utf8')).digest('hex')) run on the
	// exact same text (cli.ts hashes the brief file's raw UTF-8 bytes the same way): a mismatch here means C++ and
	// Node disagree about what bytes a brief hashes over.
	const FString Text = TEXT("LocHub brief: \"quotes\", a backslash \\ and Кириллица.\nLine two.");
	TestEqual(TEXT("Matches Node's crypto SHA-1 of the UTF-8 bytes"), FLocHubServiceProcess::HashBriefUtf8(Text), TEXT("b7bd2ced0eb18d7ce60c72e0a0bd8ee0317cd680"));
	TestEqual(TEXT("Empty brief hashes to the SHA-1 of empty input"), FLocHubServiceProcess::HashBriefUtf8(FString()), TEXT("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceKeyIdTest,
	"LocHub.Service.KeyId",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceKeyIdTest::RunTest(const FString& Parameters)
{
	// Test vector from key-contract.md §3.
	TestEqual(TEXT("\"abc\" -> first 12 hex chars of its SHA-1"), FLocHubServiceProcess::ComputeKeyId(TEXT("abc")), TEXT("a9993e364706"));
	TestTrue(TEXT("Empty key -> empty id, never SHA-1(\"\")"), FLocHubServiceProcess::ComputeKeyId(FString()).IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubScopedEnvVarTest,
	"LocHub.ScopedEnvVar.SetsAndRestores",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubScopedEnvVarTest::RunTest(const FString& Parameters)
{
	// A test-only name, never the production LOCHUB_API_KEY (M-2): this test must not touch the variable a
	// concurrent service start elsewhere could be reading.
	const FString Name = TEXT("LOCHUB_TEST_SCOPED_ENV_VAR");

	// Restores this process's own starting value (expected: absent) once the test ends, on every exit path,
	// instead of an unconditional "" at the end that could have clobbered a real pre-existing value.
	FLocHubScopedEnvVar Outer(Name, FPlatformMisc::GetEnvironmentVariable(*Name));

	// Starts absent. FPlatformMisc::GetEnvironmentVariable(GenericPlatformMisc.h:619) returns a plain FString with
	// no way to report whether a variable is absent or set to "" -- there is no lower-level engine API this class
	// or this test can call instead -- so IsEmpty() below is the strongest assertion available for "absent";
	// it cannot add a separate "absent, not empty" check.
	FPlatformMisc::SetEnvironmentVar(*Name, nullptr);
	{
		FLocHubScopedEnvVar Scoped(Name, TEXT("test-key-not-real"));
		TestEqual(TEXT("Set inside the scope"), FPlatformMisc::GetEnvironmentVariable(*Name), FString(TEXT("test-key-not-real")));
	}
	TestTrue(TEXT("Cleared after the scope when it started absent"), FPlatformMisc::GetEnvironmentVariable(*Name).IsEmpty());

	// Starts with a value: the destructor must put it back, not clear it.
	FPlatformMisc::SetEnvironmentVar(*Name, TEXT("previous-value"));
	{
		FLocHubScopedEnvVar Scoped(Name, TEXT("test-key-not-real"));
		TestEqual(TEXT("Set inside the scope"), FPlatformMisc::GetEnvironmentVariable(*Name), FString(TEXT("test-key-not-real")));
	}
	TestEqual(TEXT("Restored after the scope"), FPlatformMisc::GetEnvironmentVariable(*Name), FString(TEXT("previous-value")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceStartNodeKeyHandoverTest,
	"LocHub.Service.StartNodeKeyHandover",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceStartNodeKeyHandoverTest::RunTest(const FString& Parameters)
{
	using namespace LocHubServiceTestsPrivate;

	// I-2: proves the handover itself (StartNode's lock -> set LOCHUB_API_KEY -> spawn -> restore), which no test
	// exercised before this one -- CreateProcessFn is the seam added for exactly this. Pins the env var's name too,
	// which a test that only reads FLocHubServiceProcess::ApiKeyEnvVarName back (as this one otherwise would) can
	// never catch a misspelling of.
	TestEqual(TEXT("The env var name matches the Node side (cli.ts, providers.ts, server.ts, llmShared.ts)"),
		FString(FLocHubServiceProcess::ApiKeyEnvVarName), FString(TEXT("LOCHUB_API_KEY")));

	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	FLocHubServiceProcess::FConfig Config = MakeTestConfig(TempDir, LocHubTests::DeadServicePort, true);
	Config.ApiKey = TEXT("test-key-not-real");
	// The one gate most other tests deliberately fail before reaching (their ServiceScript never exists): here it
	// must exist, so StartNode actually reaches the lock/spawn section instead of stopping at "service script is
	// missing".
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Config.ServiceScript), true);
	TestTrue(TEXT("Service script fixture written"), LocHubTests::WriteTextFile(Config.ServiceScript, FString()));

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);

	const FString PreviousKeyEnvValue = FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::ApiKeyEnvVarName);
	const TSharedRef<FString> RecordedKey = MakeShared<FString>(TEXT("(never observed)"));
	const TSharedRef<bool> bLockWasHeld = MakeShared<bool>(false);
	Service->CreateProcessFn = [RecordedKey, bLockWasHeld](const FString&, const FString&, const FString&, void*, uint32&) -> FProcHandle
	{
		*RecordedKey = FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::ApiKeyEnvVarName);
		// Run from another thread: TryLock() on the thread that is itself holding the lock around this call would
		// trivially succeed (FCriticalSection is recursive). The probe both locks and unlocks on that same helper
		// thread -- unlocking a recursive mutex from a thread that never locked it is undefined behaviour on both
		// platforms this runs on (Windows CRITICAL_SECTION, Linux PTHREAD_MUTEX_RECURSIVE), and would leave the
		// process-wide lock held forever on exactly the regression this test exists to catch.
		const bool bAcquiredElsewhere = Async(EAsyncExecution::Thread, []
		{
			FCriticalSection& SpawnLock = LocHubProcessSpawnLock::Get();
			if (!SpawnLock.TryLock())
			{
				return false;
			}
			SpawnLock.Unlock();
			return true;
		}).Get();
		*bLockWasHeld = !bAcquiredElsewhere;
		// Invalid on purpose: StartNode must fail cleanly (no real child, no pipe leak) rather than this fake
		// pretending to have started something.
		return FProcHandle();
	};

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, RecordedKey, bLockWasHeld, PreviousKeyEnvValue, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("The fake spawn reports failure"), Outcome->bOk);
		TestEqual(TEXT("The child would have seen exactly the configured key"), *RecordedKey, FString(TEXT("test-key-not-real")));
		TestTrue(TEXT("LocHubProcessSpawnLock was held for the whole set-env/spawn/restore section"), *bLockWasHeld);
		TestEqual(TEXT("The variable is back to its previous value afterwards"),
			FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::ApiKeyEnvVarName), PreviousKeyEnvValue);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceWriteBriefFileTest,
	"LocHub.Service.WriteBriefFile",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceWriteBriefFileTest::RunTest(const FString& Parameters)
{
	const FString TempDir = LocHubTests::MakeTempDir();
	const FString Path = TempDir / TEXT("brief.md");
	const FString Text = TEXT("LocHub brief: \"quotes\", a backslash \\ and Кириллица.\nLine two.");

	const FString Hash = FLocHubServiceProcess::WriteBriefFile(Path, Text);
	TestEqual(TEXT("Returns the same hash HashBriefUtf8 would"), Hash, FLocHubServiceProcess::HashBriefUtf8(Text));

	TArray<uint8> Bytes;
	TestTrue(TEXT("File exists"), FFileHelper::LoadFileToArray(Bytes, *Path));
	TestFalse(TEXT("No UTF-8 BOM"), Bytes.Num() >= 3 && Bytes[0] == 0xEF && Bytes[1] == 0xBB && Bytes[2] == 0xBF);
	uint8 Digest[FSHA1::DigestSize];
	FSHA1::HashBuffer(Bytes.GetData(), Bytes.Num(), Digest);
	TestEqual(TEXT("The returned hash matches exactly the bytes on disk"), Hash, BytesToHexLower(Digest, FSHA1::DigestSize));

	// A regular file where the brief's folder should be: the folder cannot be created, so nothing is written and no
	// hash may be claimed for bytes that are not on disk.
	const FString Blocker = TempDir / TEXT("NotAFolder");
	TestTrue(TEXT("Blocking file written"), FFileHelper::SaveStringToFile(TEXT("x"), *Blocker));
	AddExpectedError(TEXT("Cannot write the LocHub project brief"), EAutomationExpectedErrorFlags::Contains, 1);
	TestTrue(TEXT("An unwritable brief returns no hash"), FLocHubServiceProcess::WriteBriefFile(Blocker / TEXT("brief.md"), Text).IsEmpty());

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubServiceMayStopAdoptedPidTest,
	"LocHub.Service.MayStopAdoptedPid",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubServiceMayStopAdoptedPidTest::RunTest(const FString& Parameters)
{
	TestTrue(TEXT("Own child (nothing captured): always safe"), FLocHubServiceProcess::MayStopAdoptedPid(FString(), TEXT("/usr/bin/node")));
	TestTrue(TEXT("Own child even when the current executable cannot be read"), FLocHubServiceProcess::MayStopAdoptedPid(FString(), FString()));
	TestTrue(TEXT("Adopted, still the same executable"), FLocHubServiceProcess::MayStopAdoptedPid(TEXT("/usr/bin/node"), TEXT("/usr/bin/node")));
	TestFalse(TEXT("Adopted, pid now runs a different executable"), FLocHubServiceProcess::MayStopAdoptedPid(TEXT("/usr/bin/node"), TEXT("/usr/bin/Terminal")));
	TestFalse(TEXT("Adopted, current executable cannot be read (pid gone or reused by something unreadable)"), FLocHubServiceProcess::MayStopAdoptedPid(TEXT("/usr/bin/node"), FString()));
	return true;
}

#endif
