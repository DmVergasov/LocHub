// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "LocHubServiceClient.h"
#include "LocHubServiceProcess.h"
#include "LocHubSettings.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/OutputDevice.h"
#include "Misc/OutputDeviceRedirector.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Tests/LocHubFakeService.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubCustomEndpointTestsPrivate
{
	FLocHubServiceProcess::FOnReady RecordOutcome(const TSharedRef<LocHubTests::FAsyncOutcome>& InOutcome)
	{
		return [InOutcome](const bool bOk, const FString& InError)
		{
			InOutcome->bDone = true;
			InOutcome->bOk = bOk;
			InOutcome->Error = InError;
		};
	}

	/** A complete Custom endpoint config holding the values of the Node side's second settings-id test vector. Its
	 *  service script does not exist, so a test that uses it unchanged never spawns anything. */
	FLocHubServiceProcess::FConfig MakeCustomConfig(const FString& InTempDir, const int32 InPort)
	{
		FLocHubServiceProcess::FConfig Config;
		Config.Port = InPort;
		Config.bAutoStart = true;
		Config.ProjectDir = InTempDir.LeftChop(1);
		Config.ServiceScript = InTempDir / TEXT("NoService/Resources/LocHubService/lochub_service.mjs");
		Config.StateDir = InTempDir / TEXT("State");
		Config.Provider = TEXT("custom");
		Config.Auth = TEXT("api");
		Config.TranslateModel = TEXT("qwen3:8b");
		Config.JudgeModel = TEXT("qwen3:8b");
		Config.ApiKey = TEXT("test-key-custom");
		Config.KeyId = FLocHubServiceProcess::ComputeKeyId(Config.ApiKey);
		Config.CustomBaseUrl = TEXT("https://example.test/openai/v1");
		Config.CustomKeyHeader = TEXT("api-key");
		Config.CustomStructuredOutput = TEXT("prompt_only");
		Config.CustomPriceIn = TEXT("0.15");
		Config.CustomPriceOut = TEXT("0.6");
		Config.CustomMaxParallel = 4;
		Config.CustomRequestTimeoutSeconds = 120;
		Config.CustomSettingsId = FLocHubServiceProcess::ComputeCustomSettingsId(Config);
		return Config;
	}

	/** /api/health body of an owned service still running Anthropic with a Claude subscription while the test's
	 *  config asks for a Custom endpoint: an AI settings mismatch that restarts the owned service. */
	FString BuildMismatchHealthBody(const uint32 InPid, const FString& InProjectDir)
	{
		FString EscapedDir = InProjectDir;
		EscapedDir.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
		return FString::Printf(TEXT("{\"ok\":true,\"pid\":%u,\"projectDir\":\"%s\",\"stale\":false,")
			TEXT("\"ai\":{\"provider\":\"anthropic\",\"auth\":\"subscription\",\"translateModel\":\"claude-opus-5-5\",\"judgeModel\":\"claude-sonnet-5\"},")
			TEXT("\"jobRunning\":false}"),
			InPid, *EscapedDir);
	}

	/** Captures every GLog line while registered, so the editor log line (not just service.log) can be checked for a
	 *  hidden base URL. GLog calls Serialize from its primary logging thread -- in the editor the dedicated
	 *  "OutputDeviceRedirector" thread, the game thread only under -NoLogThread -- so Text is read only after
	 *  RemoveOutputDevice, which waits for that thread to leave the device. */
	struct FLocHubCapturedLog : public FOutputDevice
	{
		FString Text;

		virtual ~FLocHubCapturedLog() override
		{
			// Stop Tests dequeues a pending latent command unrun and so frees this device while GLog still holds it.
			// GLog (GetGlobalLogSingleton()) is a function-local static that is never null; the guard here is just
			// defensive -- RemoveOutputDevice on a device that is not registered does nothing either way.
			if (FOutputDeviceRedirector* const Log = GLog)
			{
				Log->RemoveOutputDevice(this);
			}
		}

		virtual void Serialize(const TCHAR* InData, ELogVerbosity::Type InVerbosity, const FName& InCategory) override
		{
			Text += InData;
			Text += TEXT("\n");
		}
	};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointSettingsWireTest,
	"LocHub.CustomEndpoint.SettingsWire",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointSettingsWireTest::RunTest(const FString& Parameters)
{
	// "lochub serve --provider/--key-header/--structured-output" accept exactly these strings (Service/src/cli.ts,
	// Service/src/customEndpoint.ts). Case-sensitive (M-4): TestEqual on strings ignores case, and the service does not.
	TestEqualSensitive(TEXT("Custom provider wire name"), ULocHubSettings::AiProviderToString(ELocHubAiProvider::Custom), TEXT("custom"));
	TestEqualSensitive(TEXT("Bearer key header wire name"), ULocHubSettings::CustomKeyHeaderToString(ELocHubCustomKeyHeader::Bearer), TEXT("bearer"));
	TestEqualSensitive(TEXT("api-key key header wire name"), ULocHubSettings::CustomKeyHeaderToString(ELocHubCustomKeyHeader::ApiKey), TEXT("api-key"));
	TestEqualSensitive(TEXT("JSON Schema wire name"), ULocHubSettings::StructuredOutputToString(ELocHubStructuredOutput::JsonSchema), TEXT("json_schema"));
	TestEqualSensitive(TEXT("JSON Object wire name"), ULocHubSettings::StructuredOutputToString(ELocHubStructuredOutput::JsonObject), TEXT("json_object"));
	TestEqualSensitive(TEXT("Prompt Only wire name"), ULocHubSettings::StructuredOutputToString(ELocHubStructuredOutput::PromptOnly), TEXT("prompt_only"));

	ULocHubSettings* Settings = NewObject<ULocHubSettings>();
	Settings->AiProvider = ELocHubAiProvider::Custom;
	Settings->CustomApiKey = TEXT("test-key-custom");
	Settings->CustomModels.TranslateModel = TEXT("qwen3:8b");
	TestEqual(TEXT("The Custom active key is the Custom API Key"), Settings->GetActiveApiKey(), FString(TEXT("test-key-custom")));
	TestEqual(TEXT("The Custom active models are Custom Models"), Settings->GetActiveModels().TranslateModel, FString(TEXT("qwen3:8b")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointServeArgumentsTest,
	"LocHub.CustomEndpoint.ServeArguments",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointServeArgumentsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	const FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TEXT("C:/LocHubCustomEndpoint/"), LocHubTests::DeadServicePort);
	const FString Arguments = FLocHubServiceProcess::BuildServeArguments(Config);
	TestTrue(TEXT("The custom provider is on the serve line"), Arguments.Contains(TEXT(" --provider custom --auth api "), ESearchCase::CaseSensitive));
	TestTrue(TEXT("Every Custom flag but the Base URL, with the values exactly as hashed"),
		Arguments.Contains(TEXT(" --key-header api-key --structured-output prompt_only --price-in 0.15 --price-out 0.6 --max-parallel 4 --request-timeout 120"), ESearchCase::CaseSensitive));
	TestFalse(TEXT("The API key never reaches the serve line"), Arguments.Contains(TEXT("test-key-custom")));
	// I-1: the Base URL travels only through LOCHUB_CUSTOM_BASE_URL (see LocHub.CustomEndpoint.StartErrorHidesBaseUrl),
	// never on the serve line -- so the engine cannot log it on a failed spawn (Windows) or mis-split it at a
	// trailing '=' (macOS).
	TestFalse(TEXT("--base-url never reaches the serve line"), Arguments.Contains(TEXT("--base-url")));
	TestFalse(TEXT("No part of the Base URL reaches the serve line"), Arguments.Contains(TEXT("example.test")));

	FLocHubServiceProcess::FConfig OpenAi = Config;
	OpenAi.Provider = TEXT("openai");
	const FString OpenAiArguments = FLocHubServiceProcess::BuildServeArguments(OpenAi);
	TestFalse(TEXT("No Custom flag for a built-in provider"), OpenAiArguments.Contains(TEXT("--key-header")) || OpenAiArguments.Contains(TEXT("--max-parallel")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointSettingsIdTest,
	"LocHub.CustomEndpoint.SettingsId",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointSettingsIdTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	// Both vectors are pinned on the Node side too (Service/test/customEndpoint.test.ts, customSettingsIdOf).
	FLocHubServiceProcess::FConfig Defaults;
	Defaults.CustomBaseUrl = TEXT("http://localhost:11434/v1");
	Defaults.CustomKeyHeader = TEXT("bearer");
	Defaults.CustomStructuredOutput = TEXT("json_schema");
	Defaults.CustomPriceIn = TEXT("0");
	Defaults.CustomPriceOut = TEXT("0");
	Defaults.CustomMaxParallel = 2;
	Defaults.CustomRequestTimeoutSeconds = 600;
	TestEqualSensitive(TEXT("Settings id matches the Node side (first vector)"), FLocHubServiceProcess::ComputeCustomSettingsId(Defaults), TEXT("048a672d4a62"));
	TestEqualSensitive(TEXT("Settings id matches the Node side (second vector)"),
		FLocHubServiceProcess::ComputeCustomSettingsId(MakeCustomConfig(TEXT("C:/LocHubCustomEndpoint/"), LocHubTests::DeadServicePort)), TEXT("27d001e56f42"));

	FLocHubServiceProcess::FConfig OtherTimeout = Defaults;
	OtherTimeout.CustomRequestTimeoutSeconds = 601;
	TestFalse(TEXT("Any Custom field changes the settings id"),
		FLocHubServiceProcess::ComputeCustomSettingsId(OtherTimeout).Equals(FLocHubServiceProcess::ComputeCustomSettingsId(Defaults)));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointReduceBaseUrlTest,
	"LocHub.CustomEndpoint.ReduceBaseUrl",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointReduceBaseUrlTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("The path is dropped"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://localhost:11434/v1")), TEXT("http://localhost:11434"));
	TestEqual(TEXT("User info, path, query and fragment are dropped"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("https://user:secret-pw@example.test:8443/openai/v1?token=secret-token#part")), TEXT("https://example.test:8443"));
	TestEqual(TEXT("A query right after the host is dropped"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://127.0.0.1:1234?token=secret-token")), TEXT("http://127.0.0.1:1234"));
	TestEqual(TEXT("No scheme: nothing to show"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("A raw password holding '/' never shows"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://user:secret/pw@localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("A raw password holding '?' never shows"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://user:secret?pw@localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("A '\\' ends the host, as WHATWG reads it for http(s)"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://127.0.0.1:11434\\v1?token=secret-token")), TEXT("http://127.0.0.1:11434"));
	TestEqual(TEXT("An escaped '@' before the host never shows the password"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://user:secret%40localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("Text in front of the scheme never shows"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("user:secret@http://localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("An IPv6 host keeps its port"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://[::1]:11434/v1")), TEXT("http://[::1]:11434"));
	TestEqual(TEXT("A raw '/' in a password before an escaped '@' never shows the password"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://user:qqq/zzz%40localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("The same with an IPv6 host past the escaped '@'"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://user:qqq/zzz%40[::1]:11434/v1")), TEXT(""));
	TestEqual(TEXT("The same with an uppercase scheme"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("HTTP://user:qqq/zzz%40localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("An '@' escaped twice never shows either"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://user:qqqzzz%2540localhost:11434/v1")), TEXT(""));
	TestEqual(TEXT("A non-digit port never shows"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://host:abc/v1")), TEXT(""));
	TestEqual(TEXT("A space in the host never shows"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://ho st:11434")), TEXT(""));
	TestEqual(TEXT("An empty host never shows"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://:11434")), TEXT(""));
	TestEqual(TEXT("A port above 65535 never shows (M-2)"), FLocHubServiceProcess::ReduceBaseUrl(TEXT("http://example.test:70000/v1")), TEXT(""));
	// M-3: the whitelist only guarantees scheme://host[:port] of this exact shape leaves the function -- it does not
	// close every raw '/' in a password ahead of a "%40" when the text before the '/' is 1-5 digits, since those
	// digits then parse as a real port and the reduction is not empty.
	TestEqual(TEXT("A digit-only password prefix before a raw '/' and an escaped '@' still reduces to host:port (M-3)"),
		FLocHubServiceProcess::ReduceBaseUrl(TEXT("https://svc:2024/Secret%40api.example.com/v1")), TEXT("https://svc:2024"));

	TestEqual(TEXT("The log line of a Custom endpoint shows only scheme, host and port"),
		FLocHubServiceProcess::DescribeAiConfig(TEXT("custom"), TEXT("api"), TEXT("https://user:secret-pw@example.test/openai/v1?token=secret-token"), TEXT("qwen3:8b"), TEXT("qwen3:8b")),
		TEXT("custom/api https://example.test qwen3:8b/qwen3:8b"));
	TestEqual(TEXT("The log line of a built-in provider is unchanged"),
		FLocHubServiceProcess::DescribeAiConfig(TEXT("anthropic"), TEXT("api"), FString(), TEXT("claude-opus-5-5"), TEXT("claude-sonnet-5")),
		TEXT("anthropic/api claude-opus-5-5/claude-sonnet-5"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointConfigProblemTest,
	"LocHub.CustomEndpoint.ConfigProblem",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointConfigProblemTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TEXT("C:/LocHubCustomEndpoint/"), LocHubTests::DeadServicePort);
	TestTrue(TEXT("A complete Custom config has no problem"), FLocHubServiceProcess::DescribeConfigProblem(Config).IsEmpty());

	// M-2: a wrong or missing scheme keeps this message.
	const FString SchemeProblem = TEXT("Set Base URL in Project Settings > Plugins > LocHub > AI; it must start with http:// or https://.");
	for (const TCHAR* Url : { TEXT(""), TEXT("localhost:11434/v1"), TEXT("ftp://example.test/v1") })
	{
		Config.CustomBaseUrl = Url;
		TestEqual(*FString::Printf(TEXT("Base URL '%s' is refused for its scheme"), Url), FLocHubServiceProcess::DescribeConfigProblem(Config), SchemeProblem);
	}

	// M-2: a URL that does start with http(s):// but has no acceptable host (an empty host, a port above 65535, or a
	// character ReduceBaseUrl's whitelist never accepts) gets a distinct message that does not claim the scheme is
	// the problem.
	const FString HostProblem = TEXT("Set Base URL in Project Settings > Plugins > LocHub > AI to an http:// or https:// URL with a ")
		TEXT("host name or IP address, such as http://localhost:11434/v1.");
	for (const TCHAR* Url : { TEXT("http://"), TEXT("http://:11434"), TEXT("http://example.test:70000/v1"),
		TEXT("http://user:qqqzzz%2540localhost:11434/v1") })
	{
		Config.CustomBaseUrl = Url;
		TestEqual(*FString::Printf(TEXT("Base URL '%s' is refused for its host"), Url), FLocHubServiceProcess::DescribeConfigProblem(Config), HostProblem);
	}

	// I-1: the '"' and the trailing '\' no longer break anything -- the serve line never carries the Base URL at
	// all any more (it travels through LOCHUB_CUSTOM_BASE_URL), so a URL that would have broken its quoting is no
	// longer this function's concern.
	Config.CustomBaseUrl = TEXT("http://example.test:11434/v1\"");
	TestTrue(TEXT("A '\"' in the path is no longer refused"), FLocHubServiceProcess::DescribeConfigProblem(Config).IsEmpty());
	Config.CustomBaseUrl = TEXT("http://example.test:11434\\");
	TestTrue(TEXT("A trailing '\\' is no longer refused"), FLocHubServiceProcess::DescribeConfigProblem(Config).IsEmpty());

	// M-2: the user-info message also names the %40 escape for a literal '@' in the path or query.
	const FString UserInfoProblem = TEXT("Remove the user name and password from Base URL in Project Settings > Plugins > LocHub > AI; ")
		TEXT("put the key in API Key instead. A literal '@' in the path or query must be written as %40.");

	Config.CustomBaseUrl = TEXT("http://user:secret-pw@localhost:11434/v1");
	const FString UserInfoResult = FLocHubServiceProcess::DescribeConfigProblem(Config);
	TestEqual(TEXT("User info in Base URL is refused"), UserInfoResult, UserInfoProblem);
	TestFalse(TEXT("The refusal never echoes the password"), UserInfoResult.Contains(TEXT("secret-pw")));

	Config.CustomBaseUrl = TEXT("http://user:secret/pw@localhost:11434/v1");
	TestEqual(TEXT("User info whose password holds '/' is refused"), FLocHubServiceProcess::DescribeConfigProblem(Config), UserInfoProblem);

	// A '%40' that leaves ReduceBaseUrl no host at all is user info too, whether it sits right after the userinfo
	// separator or past a raw '/' in the password that ended the authority early.
	for (const TCHAR* Url : { TEXT("http://user:secret%40localhost:11434/v1"), TEXT("http://secret%40localhost:11434/v1"),
		TEXT("http://user:qqq/zzz%40localhost:11434/v1"), TEXT("http://user:qqq/zzz%40[::1]:11434/v1"),
		TEXT("HTTP://user:qqq/zzz%40localhost:11434/v1") })
	{
		Config.CustomBaseUrl = Url;
		TestEqual(*FString::Printf(TEXT("An escaped '@' in '%s' is refused as user info"), Url), FLocHubServiceProcess::DescribeConfigProblem(Config), UserInfoProblem);
	}

	Config.CustomBaseUrl = TEXT("HTTPS://example.test/openai/v1?api-version=preview");
	TestTrue(TEXT("Scheme case and a query string are fine"), FLocHubServiceProcess::DescribeConfigProblem(Config).IsEmpty());

	Config.TranslateModel.Reset();
	TestEqual(TEXT("An empty Translate Model is refused"), FLocHubServiceProcess::DescribeConfigProblem(Config),
		TEXT("Set Custom Models > Translate Model in Project Settings > Plugins > LocHub > AI."));

	FLocHubServiceProcess::FConfig OpenAi = Config;
	OpenAi.Provider = TEXT("openai");
	OpenAi.CustomBaseUrl.Reset();
	TestTrue(TEXT("Built-in providers are never refused here"), FLocHubServiceProcess::DescribeConfigProblem(OpenAi).IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointNotStartedWithoutTranslateModelTest,
	"LocHub.CustomEndpoint.NotStartedWithoutTranslateModel",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointNotStartedWithoutTranslateModelTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	// EnsureRunning probes /api/health first; nothing listens on DeadServicePort.
	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TempDir, LocHubTests::DeadServicePort);
	Config.TranslateModel.Reset();
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	const TSharedRef<bool> bSpawned = MakeShared<bool>(false);
	Service->CreateProcessFn = [bSpawned](const FString&, const FString&, const FString&, void*, uint32&) -> FProcHandle
	{
		*bSpawned = true;
		return FProcHandle();
	};

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, bSpawned, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("The service is not started"), Outcome->bOk);
		TestEqual(TEXT("The error names the missing Translate Model"), Outcome->Error,
			FString(TEXT("Set Custom Models > Translate Model in Project Settings > Plugins > LocHub > AI.")));
		TestFalse(TEXT("No process was spawned"), *bSpawned);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointStartErrorHidesBaseUrlTest,
	"LocHub.CustomEndpoint.StartErrorHidesBaseUrl",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointStartErrorHidesBaseUrlTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TempDir, LocHubTests::DeadServicePort);
	Config.CustomBaseUrl = TEXT("http://127.0.0.1:11434/v1?token=secret-token");
	Config.CustomSettingsId = FLocHubServiceProcess::ComputeCustomSettingsId(Config);
	// The script must exist so StartNode reaches the spawn instead of stopping at "service script is missing".
	TestTrue(TEXT("Service script fixture written"), LocHubTests::WriteTextFile(Config.ServiceScript, FString()));

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	const TSharedRef<FString> RecordedArguments = MakeShared<FString>();
	// I-1(b): the fake CreateProcessFn reads LOCHUB_CUSTOM_BASE_URL during the call, the same way
	// LocHub.Service.StartNodeKeyHandover reads LOCHUB_API_KEY.
	const FString PreviousBaseUrlEnvValue = FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::BaseUrlEnvVarName);
	const TSharedRef<FString> RecordedBaseUrlEnv = MakeShared<FString>(TEXT("(never observed)"));
	Service->CreateProcessFn = [RecordedArguments, RecordedBaseUrlEnv](const FString&, const FString& InArgs, const FString&, void*, uint32&) -> FProcHandle
	{
		*RecordedArguments = InArgs;
		*RecordedBaseUrlEnv = FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::BaseUrlEnvVarName);
		// Invalid on purpose: StartNode takes its "Could not start" path, whose error text reaches a notification.
		return FProcHandle();
	};

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, RecordedArguments, RecordedBaseUrlEnv, PreviousBaseUrlEnvValue, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("The fake spawn reports failure"), Outcome->bOk);
		// I-1(a): the serve line carries no part of the Base URL and no --base-url at all any more.
		TestFalse(TEXT("The serve line never carries --base-url"), RecordedArguments->Contains(TEXT("--base-url")));
		TestFalse(TEXT("The serve line never carries any part of the Base URL"),
			RecordedArguments->Contains(TEXT("11434")) || RecordedArguments->Contains(TEXT("secret-token")));
		// I-1(b): the child sees the full, unreduced Base URL through the environment instead.
		TestEqual(TEXT("The child sees the full Base URL through LOCHUB_CUSTOM_BASE_URL"), *RecordedBaseUrlEnv,
			FString(TEXT("http://127.0.0.1:11434/v1?token=secret-token")));
		// I-1(c): the editor's own environment is back to what it was before the call.
		TestEqual(TEXT("LOCHUB_CUSTOM_BASE_URL is restored after the call"),
			FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::BaseUrlEnvVarName), PreviousBaseUrlEnvValue);
		TestFalse(TEXT("The start error never shows any part of the Base URL"),
			Outcome->Error.Contains(TEXT("secret-token")) || Outcome->Error.Contains(TEXT("11434")));
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointStartLogHidesBaseUrlTest,
	"LocHub.CustomEndpoint.StartLogHidesBaseUrl",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointStartLogHidesBaseUrlTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	AddExpectedMessage(TEXT("libcurl"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString TempDir = LocHubTests::MakeTempDir();
	FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TempDir, LocHubTests::DeadServicePort);
	Config.CustomBaseUrl = TEXT("http://127.0.0.1:11434/v1?token=secret-token");
	Config.CustomSettingsId = FLocHubServiceProcess::ComputeCustomSettingsId(Config);
	TestTrue(TEXT("Service script fixture written"), LocHubTests::WriteTextFile(Config.ServiceScript, FString()));

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	const FString PreviousBaseUrlEnvValue = FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::BaseUrlEnvVarName);
	const TSharedRef<FString> RecordedBaseUrlEnv = MakeShared<FString>(TEXT("(never observed)"));
	const TFunction<FProcHandle(const FString&, const FString&, const FString&, void*, uint32&)> SpawnForReal = Service->CreateProcessFn;
	Service->CreateProcessFn = [SpawnForReal, RecordedBaseUrlEnv](const FString& InExe, const FString&, const FString& InWorkingDir, void* InPipeWrite, uint32& OutPid) -> FProcHandle
	{
		// I-1(b): the child would see the full Base URL through the environment on this, the successful-spawn path.
		*RecordedBaseUrlEnv = FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::BaseUrlEnvVarName);
		// A real child that exits at once instead of "serve": StartNode takes its success path and writes the same
		// argument line to service.log (and the editor log) that a real start would.
		return SpawnForReal(InExe, TEXT("--version"), InWorkingDir, InPipeWrite, OutPid);
	};

	// Captures GLog for the duration of the start so the editor log line (LocHubServiceProcess.cpp's "Started the
	// LocHub service" UE_LOG) is pinned too, not just service.log.
	const TSharedRef<FLocHubCapturedLog> Captured = MakeShared<FLocHubCapturedLog>();
	GLog->AddOutputDevice(&Captured.Get());

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Service, Outcome, Captured, RecordedBaseUrlEnv, PreviousBaseUrlEnvValue, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		// StartNode's line was queued for GLog's logging thread: deliver everything queued so far, then detach.
		GLog->FlushThreadedLogs();
		GLog->RemoveOutputDevice(&Captured.Get());
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestFalse(TEXT("The child exits during start"), Outcome->bOk);
		FString Log;
		TestTrue(TEXT("service.log was written"), FFileHelper::LoadFileToString(Log, *Service->GetLogFilePath()));
		// I-1(a): neither log carries --base-url any more; both name the endpoint reduced to scheme://host[:port] only.
		TestFalse(TEXT("service.log never carries --base-url"), Log.Contains(TEXT("--base-url"), ESearchCase::CaseSensitive));
		TestTrue(TEXT("service.log names the reduced endpoint"), Log.Contains(TEXT("(endpoint http://127.0.0.1:11434)"), ESearchCase::CaseSensitive));
		TestFalse(TEXT("service.log never shows the Base URL's path or query"), Log.Contains(TEXT("secret-token")) || Log.Contains(TEXT("11434/v1")));
		TestFalse(TEXT("The editor log never carries --base-url"), Captured->Text.Contains(TEXT("--base-url"), ESearchCase::CaseSensitive));
		TestTrue(TEXT("The editor log names the reduced endpoint"), Captured->Text.Contains(TEXT("(endpoint http://127.0.0.1:11434)"), ESearchCase::CaseSensitive));
		TestFalse(TEXT("The editor log never shows the Base URL's path or query"),
			Captured->Text.Contains(TEXT("secret-token")) || Captured->Text.Contains(TEXT("11434/v1")));
		// I-1(b)/(c): the successful path hands the child the full URL through the environment and restores it after.
		TestEqual(TEXT("The child sees the full Base URL through LOCHUB_CUSTOM_BASE_URL"), *RecordedBaseUrlEnv,
			FString(TEXT("http://127.0.0.1:11434/v1?token=secret-token")));
		TestEqual(TEXT("LOCHUB_CUSTOM_BASE_URL is restored after the call"),
			FPlatformMisc::GetEnvironmentVariable(FLocHubServiceProcess::BaseUrlEnvVarName), PreviousBaseUrlEnvValue);
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointMakeDefaultConfigTest,
	"LocHub.CustomEndpoint.MakeDefaultConfig",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointMakeDefaultConfigTest::RunTest(const FString& Parameters)
{
	// MakeDefaultConfig reads the live ULocHubSettings CDO (no injection seam), so this mutates it for the duration of
	// the test and restores every touched field; SaveConfig is never called, so DefaultEditor.ini is untouched.
	ULocHubSettings* Settings = GetMutableDefault<ULocHubSettings>();
	const ELocHubAiProvider PreviousProvider = Settings->AiProvider;
	const FString PreviousBaseUrl = Settings->CustomBaseUrl;
	const FString PreviousKey = Settings->CustomApiKey;
	const ELocHubCustomKeyHeader PreviousKeyHeader = Settings->CustomKeyHeader;
	const FLocHubAiModels PreviousModels = Settings->CustomModels;
	const ELocHubStructuredOutput PreviousStructuredOutput = Settings->CustomStructuredOutput;
	const float PreviousPriceIn = Settings->CustomInputPricePerMTok;
	const float PreviousPriceOut = Settings->CustomOutputPricePerMTok;
	const int32 PreviousMaxParallel = Settings->CustomMaxParallelRequests;
	const int32 PreviousTimeout = Settings->CustomRequestTimeoutSeconds;
	ON_SCOPE_EXIT
	{
		Settings->AiProvider = PreviousProvider;
		Settings->CustomBaseUrl = PreviousBaseUrl;
		Settings->CustomApiKey = PreviousKey;
		Settings->CustomKeyHeader = PreviousKeyHeader;
		Settings->CustomModels = PreviousModels;
		Settings->CustomStructuredOutput = PreviousStructuredOutput;
		Settings->CustomInputPricePerMTok = PreviousPriceIn;
		Settings->CustomOutputPricePerMTok = PreviousPriceOut;
		Settings->CustomMaxParallelRequests = PreviousMaxParallel;
		Settings->CustomRequestTimeoutSeconds = PreviousTimeout;
	};

	Settings->AiProvider = ELocHubAiProvider::Custom;
	Settings->CustomBaseUrl = TEXT(" https://example.test/openai/v1/ ");
	Settings->CustomApiKey = TEXT("test-key-custom");
	Settings->CustomKeyHeader = ELocHubCustomKeyHeader::ApiKey;
	Settings->CustomModels.TranslateModel = TEXT("qwen3:8b");
	Settings->CustomModels.JudgeModel.Reset();
	Settings->CustomStructuredOutput = ELocHubStructuredOutput::PromptOnly;
	Settings->CustomInputPricePerMTok = 0.15f;
	Settings->CustomOutputPricePerMTok = 0.6f;
	Settings->CustomMaxParallelRequests = 4;
	Settings->CustomRequestTimeoutSeconds = 120;

	const FLocHubServiceProcess::FConfig Config = FLocHubServiceProcess::MakeDefaultConfig();
	// Wire and id pins, case-sensitive (M-4): TestEqual on strings ignores case, and the service does not.
	TestEqualSensitive(TEXT("Provider of a Custom config"), Config.Provider, TEXT("custom"));
	TestEqualSensitive(TEXT("The Custom API Key goes to the child"), Config.ApiKey, TEXT("test-key-custom"));
	TestEqualSensitive(TEXT("Base URL trimmed of spaces and one trailing slash"), Config.CustomBaseUrl, TEXT("https://example.test/openai/v1"));
	TestEqualSensitive(TEXT("An empty Judge Model judges with the Translate Model"), Config.JudgeModel, TEXT("qwen3:8b"));
	TestEqualSensitive(TEXT("Key header wire name in the config"), Config.CustomKeyHeader, TEXT("api-key"));
	TestEqualSensitive(TEXT("Structured output wire name in the config"), Config.CustomStructuredOutput, TEXT("prompt_only"));
	TestEqualSensitive(TEXT("Input price as it goes on the serve line"), Config.CustomPriceIn, TEXT("0.15"));
	TestEqualSensitive(TEXT("Output price as it goes on the serve line"), Config.CustomPriceOut, TEXT("0.6"));
	TestEqualSensitive(TEXT("Settings id of these values (the Node side's second vector)"), Config.CustomSettingsId, TEXT("27d001e56f42"));

	// ClampMin/ClampMax guard only the Details panel; a hand-edited DefaultEditor.ini must still start the service.
	Settings->CustomMaxParallelRequests = 99;
	Settings->CustomRequestTimeoutSeconds = 5;
	Settings->CustomInputPricePerMTok = -1.0f;
	const FLocHubServiceProcess::FConfig Clamped = FLocHubServiceProcess::MakeDefaultConfig();
	TestEqual(TEXT("Max Parallel Requests clamped to 32 when the ini holds 99"), Clamped.CustomMaxParallel, 32);
	TestEqual(TEXT("Request Timeout clamped to 30 when the ini holds 5"), Clamped.CustomRequestTimeoutSeconds, 30);
	TestEqual(TEXT("A negative price goes out as 0"), Clamped.CustomPriceIn, TEXT("0"));

	Settings->CustomMaxParallelRequests = 0;
	Settings->CustomRequestTimeoutSeconds = 99999;
	Settings->CustomOutputPricePerMTok = -0.5f;
	const FLocHubServiceProcess::FConfig ClampedLow = FLocHubServiceProcess::MakeDefaultConfig();
	TestEqual(TEXT("Max Parallel Requests clamped to 1 when the ini holds 0"), ClampedLow.CustomMaxParallel, 1);
	TestEqual(TEXT("Request Timeout clamped to 300 when the ini holds 99999"), ClampedLow.CustomRequestTimeoutSeconds, 300);
	TestEqual(TEXT("A negative output price goes out as 0"), ClampedLow.CustomPriceOut, TEXT("0"));

	// M-6: a non-finite price (as a hand-edited ini's "1e39" parses to) is clamped to 0 too, not left as "inf" --
	// which FString::SanitizeFloat would otherwise write out, and the service's parsePrice would then refuse,
	// stopping the service from starting on exactly the malformed ini value MakeDefaultConfig means to survive.
	Settings->CustomInputPricePerMTok = FCString::Atof(TEXT("1e39"));
	TestTrue(TEXT("1e39 parses to a non-finite float"), !FMath::IsFinite(Settings->CustomInputPricePerMTok));
	const FLocHubServiceProcess::FConfig NonFinitePrice = FLocHubServiceProcess::MakeDefaultConfig();
	TestEqual(TEXT("A non-finite price goes out as 0"), NonFinitePrice.CustomPriceIn, TEXT("0"));

	// Hidden Custom fields edited while another provider is active must not reach that provider's config (and so
	// can never trigger a restart of it).
	Settings->AiProvider = ELocHubAiProvider::OpenAI;
	const FLocHubServiceProcess::FConfig OpenAi = FLocHubServiceProcess::MakeDefaultConfig();
	TestTrue(TEXT("Another provider carries no Custom settings"),
		OpenAi.CustomBaseUrl.IsEmpty() && OpenAi.CustomSettingsId.IsEmpty() && OpenAi.CustomMaxParallel == 0 && OpenAi.CustomPriceIn.IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointIsAiConfigAppliedTest,
	"LocHub.CustomEndpoint.IsAiConfigApplied",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointIsAiConfigAppliedTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	const FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TEXT("C:/LocHubCustomEndpoint/"), LocHubTests::DeadServicePort);
	FLocHubHealth Health;
	Health.AiProvider = TEXT("custom");
	Health.AiAuth = TEXT("api");
	Health.AiTranslateModel = TEXT("qwen3:8b");
	Health.AiJudgeModel = TEXT("qwen3:8b");
	Health.AiKeyId = Config.KeyId;
	Health.bHasAiKeyId = true;
	Health.AiCustomSettingsId = Config.CustomSettingsId;
	Health.bHasAiCustomSettingsId = true;
	TestTrue(TEXT("The same Custom settings id is applied"), FLocHubServiceProcess::IsAiConfigApplied(Config, Health));

	Health.AiCustomSettingsId = TEXT("000000000000");
	TestFalse(TEXT("A different Custom settings id is not applied"), FLocHubServiceProcess::IsAiConfigApplied(Config, Health));

	Health.bHasAiCustomSettingsId = false;
	TestTrue(TEXT("No customSettingsId in health (an older service) counts as applied"), FLocHubServiceProcess::IsAiConfigApplied(Config, Health));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointHealthTest,
	"LocHub.CustomEndpoint.Health",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointHealthTest::RunTest(const FString& Parameters)
{
	FLocHubHealth Custom;
	const bool bCustomParsed = FLocHubServiceClient::ParseHealth(
		TEXT("{\"ok\":true,\"ai\":{\"provider\":\"custom\",\"auth\":\"api\",\"translateModel\":\"qwen3:8b\",\"judgeModel\":\"qwen3:8b\",\"keyId\":\"\",")
		TEXT("\"customSettingsId\":\"048a672d4a62\",\"endpoint\":{\"url\":\"http://127.0.0.1:11434\",\"status\":\"ok\"}}}"),
		Custom);
	TestTrue(TEXT("Parses"), bCustomParsed);
	TestTrue(TEXT("Custom settings id present"), Custom.bHasAiCustomSettingsId);
	TestEqual(TEXT("Custom settings id parsed"), Custom.AiCustomSettingsId, TEXT("048a672d4a62"));
	TestEqual(TEXT("Endpoint URL parsed"), Custom.AiEndpointUrl, TEXT("http://127.0.0.1:11434"));

	FLocHubHealth BuiltIn;
	const bool bBuiltInParsed = FLocHubServiceClient::ParseHealth(
		TEXT("{\"ok\":true,\"ai\":{\"provider\":\"deepseek\",\"auth\":\"api\",\"translateModel\":\"m1\",\"judgeModel\":\"m2\",\"keyId\":\"\"}}"), BuiltIn);
	TestTrue(TEXT("Parses"), bBuiltInParsed);
	TestFalse(TEXT("A built-in provider has no Custom settings id"), BuiltIn.bHasAiCustomSettingsId);
	TestTrue(TEXT("...and no endpoint"), BuiltIn.AiEndpointUrl.IsEmpty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCustomEndpointCustomOnlyChangeRearmsRestartTest,
	"LocHub.CustomEndpoint.CustomOnlyChangeRearmsRestart",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCustomEndpointCustomOnlyChangeRearmsRestartTest::RunTest(const FString& Parameters)
{
	using namespace LocHubCustomEndpointTestsPrivate;

	// Same setup as LocHub.Service.KeyOnlyChangeRearmsRestart: earn a real IsAiRestartTried() == true through an
	// actual mismatch restart, then prove that changing only a Custom endpoint setting re-arms it.
	const FString TempDir = LocHubTests::MakeTempDir();
	const FString ProjectDir = TempDir.LeftChop(1);
	const uint32 NodePid = FPlatformProcess::GetCurrentProcessId();
	const uint32 DeadHostPid = NodePid + 1;

	const TSharedRef<FLocHubFakeService> Fake = MakeShared<FLocHubFakeService>(LocHubTests::FakeServicePort, ProjectDir);
	if (!TestTrue(TEXT("Fake service is bound"), Fake->IsBound()))
	{
		return false;
	}
	Fake->SetResponse(TEXT("/api/health"), 200, BuildMismatchHealthBody(NodePid, ProjectDir));

	const FLocHubServiceProcess::FConfig Config = MakeCustomConfig(TempDir, LocHubTests::FakeServicePort);
	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(Config);
	IFileManager::Get().MakeDirectory(*Service->GetConfig().StateDir, true);
	TestTrue(TEXT("Pid file written"), FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), NodePid, DeadHostPid), *Service->GetPidFilePath()));
	Service->IsPidRunningFn = [](uint32) { return false; };
	const TSharedRef<TArray<uint32>> Terminated = MakeShared<TArray<uint32>>();
	Service->TerminateProcessFn = [Terminated](FProcHandle&, const uint32 InPid) { Terminated->Add(InPid); };

	// M-5: captures GLog so the "Restarting the LocHub service ... AI settings changed" line (only unit-tested
	// through DescribeAiConfig itself before this) is pinned through the real call site that formats it.
	const TSharedRef<FLocHubCapturedLog> Captured = MakeShared<FLocHubCapturedLog>();
	GLog->AddOutputDevice(&Captured.Get());

	const TSharedRef<LocHubTests::FAsyncOutcome> Outcome = MakeShared<LocHubTests::FAsyncOutcome>();
	Service->EnsureRunning(RecordOutcome(Outcome));

	const double Deadline = FPlatformTime::Seconds() + 15.0;
	// Fake is captured so the HTTP listener outlives RunTest: the probe is answered only on a later tick.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Fake, Service, Outcome, Terminated, Captured, NodePid, Deadline, TempDir]() -> bool
	{
		if (!Outcome->bDone && FPlatformTime::Seconds() < Deadline)
		{
			return false;
		}
		// The restart line was queued for GLog's logging thread: deliver everything queued so far, then detach.
		GLog->FlushThreadedLogs();
		GLog->RemoveOutputDevice(&Captured.Get());
		TestTrue(TEXT("Answered without hanging"), Outcome->bDone);
		TestTrue(TEXT("The owned service was stopped for the new AI settings"), Terminated->Contains(NodePid));
		TestTrue(TEXT("The restart attempt is used"), Service->IsAiRestartTried());
		TestTrue(TEXT("The restart log line names the reduced Custom endpoint"),
			Captured->Text.Contains(TEXT("custom/api https://example.test qwen3:8b/qwen3:8b"), ESearchCase::CaseSensitive));
		TestFalse(TEXT("The restart log line never shows the Base URL path"),
			Captured->Text.Contains(TEXT("/openai/v1"), ESearchCase::CaseSensitive));

		Service->SetConfig(Service->GetConfig());
		TestTrue(TEXT("An unchanged Custom config keeps the attempt used"), Service->IsAiRestartTried());

		FLocHubServiceProcess::FConfig CustomOnly = Service->GetConfig();
		CustomOnly.CustomMaxParallel = 8;
		CustomOnly.CustomSettingsId = FLocHubServiceProcess::ComputeCustomSettingsId(CustomOnly);
		Service->SetConfig(CustomOnly);
		TestFalse(TEXT("A Custom-only change re-arms the restart attempt"), Service->IsAiRestartTried());
		LocHubTests::DeleteTempDir(TempDir);
		return true;
	}));
	return true;
}

#endif
