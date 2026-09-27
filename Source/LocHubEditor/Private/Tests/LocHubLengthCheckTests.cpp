// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubServiceClient.h"
#include "LocHubServiceProcess.h"
#include "LocHubSettings.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubLengthCheckTestsPrivate
{
	/** The Project Settings defaults as "serve" flags; Service/test/cli.test.ts round-trips the same string. */
	const TCHAR* const DefaultArguments = TEXT("--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 4 --length-hint on");

	/** Every Length Check field set explicitly to its documented default: NewObject copies the class defaults, which the
	 *  host project's Config/DefaultEditor.ini may have changed. */
	ULocHubSettings* MakeDefaultLengthSettings()
	{
		ULocHubSettings* Settings = NewObject<ULocHubSettings>();
		Settings->bEnableLengthCheck = true;
		Settings->LengthCheckScope = ELocHubLengthScope::UiStrings;
		Settings->MaxLengthRatio = 1.3f;
		Settings->ExtraCharacters = 4;
		Settings->CultureRatioOverrides.Reset();
		Settings->bTellTranslator = true;
		Settings->LengthSeverity = ELocHubLengthSeverity::Warning;
		return Settings;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubLengthCheckSettingsWireTest,
	"LocHub.LengthCheck.SettingsWire",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubLengthCheckSettingsWireTest::RunTest(const FString& Parameters)
{
	// "lochub serve --length-scope/--length-check" accept exactly these strings (Service/src/cli.ts); the service side
	// is case-sensitive (cli.ts), so these pins must be too.
	TestEqualSensitive(TEXT("UiStrings"), ULocHubSettings::LengthScopeToString(ELocHubLengthScope::UiStrings), TEXT("ui"));
	TestEqualSensitive(TEXT("AllStrings"), ULocHubSettings::LengthScopeToString(ELocHubLengthScope::AllStrings), TEXT("all"));
	TestEqualSensitive(TEXT("Warning"), ULocHubSettings::LengthSeverityToString(ELocHubLengthSeverity::Warning), TEXT("warning"));
	TestEqualSensitive(TEXT("MustConfirm"), ULocHubSettings::LengthSeverityToString(ELocHubLengthSeverity::MustConfirm), TEXT("confirm"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubLengthCheckArgumentsTest,
	"LocHub.LengthCheck.Arguments",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubLengthCheckArgumentsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubLengthCheckTestsPrivate;

	ULocHubSettings* Settings = MakeDefaultLengthSettings();
	TestEqualSensitive(TEXT("Project Settings defaults"), FLocHubServiceProcess::BuildLengthArguments(*Settings), FString(DefaultArguments));

	Settings->LengthCheckScope = ELocHubLengthScope::AllStrings;
	Settings->LengthSeverity = ELocHubLengthSeverity::MustConfirm;
	Settings->MaxLengthRatio = 0.5f;
	Settings->ExtraCharacters = 250;
	Settings->bTellTranslator = false;
	Settings->CultureRatioOverrides.Add(TEXT("pt-BR"), 1.2f);
	Settings->CultureRatioOverrides.Add(TEXT("ja"), 9.0f);
	Settings->CultureRatioOverrides.Add(TEXT(" de "), 1.5f);
	Settings->CultureRatioOverrides.Add(TEXT("de DE"), 1.4f);
	// A key that repeats another after trimming: "serve" refuses a repeated culture (cli.ts), so one is skipped.
	Settings->CultureRatioOverrides.Add(TEXT("ja "), 9.0f);
	AddExpectedMessagePlain(TEXT("Length Check: skipping the culture ratio override \"ja"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	AddExpectedMessagePlain(TEXT("Length Check: skipping the culture ratio override \"de DE\""), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	// The same literal as Service/test/cli.test.ts and lengthCheck.test.ts: overrides trimmed, sorted and clamped, the
	// ratio and extra clamped, an invalid culture skipped.
	TestEqualSensitive(TEXT("Every flag"), FLocHubServiceProcess::BuildLengthArguments(*Settings),
		FString(TEXT("--length-check confirm --length-scope all --length-ratio 1.00 --length-extra 100 --length-ratios de=1.50,ja=5.00,pt-BR=1.20 --length-hint off")));

	Settings->bEnableLengthCheck = false;
	TestEqualSensitive(TEXT("Disabled: only the off switch"), FLocHubServiceProcess::BuildLengthArguments(*Settings), FString(TEXT("--length-check off")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubLengthCheckServeArgumentsTest,
	"LocHub.LengthCheck.ServeArguments",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubLengthCheckServeArgumentsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubLengthCheckTestsPrivate;

	FLocHubServiceProcess::FConfig Config;
	Config.ServiceScript = TEXT("D:/LocHub/Resources/LocHubService/lochub_service.mjs");
	Config.ProjectDir = TEXT("D:/Projects/Game");
	Config.StateDir = TEXT("D:/Projects/Game/Saved/LocHub");
	const FString WithoutLength = FLocHubServiceProcess::BuildServeArguments(Config);
	TestFalse(TEXT("No length flags without LengthArguments"), WithoutLength.Contains(TEXT("--length-")));
	Config.LengthArguments = DefaultArguments;
	TestEqualSensitive(TEXT("Length flags come last, unquoted"), FLocHubServiceProcess::BuildServeArguments(Config), WithoutLength + TEXT(" ") + DefaultArguments);

	const FLocHubServiceProcess::FConfig Default = FLocHubServiceProcess::MakeDefaultConfig();
	TestTrue(TEXT("MakeDefaultConfig passes Length Check flags"), Default.LengthArguments.StartsWith(TEXT("--length-check "), ESearchCase::CaseSensitive));
	TestEqualSensitive(TEXT("...built from the Project Settings"), Default.LengthArguments, FLocHubServiceProcess::BuildLengthArguments(*GetDefault<ULocHubSettings>()));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubLengthCheckHealthTest,
	"LocHub.LengthCheck.Health",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubLengthCheckHealthTest::RunTest(const FString& Parameters)
{
	using namespace LocHubLengthCheckTestsPrivate;

	FLocHubHealth Current;
	TestTrue(TEXT("Parses"), FLocHubServiceClient::ParseHealth(TEXT("{\"ok\":true,\"ai\":{\"provider\":\"anthropic\",\"lengthArgs\":\"--length-check off\"}}"), Current));
	TestTrue(TEXT("lengthArgs present"), Current.bHasAiLengthArgs);
	TestEqualSensitive(TEXT("lengthArgs"), Current.AiLengthArgs, FString(TEXT("--length-check off")));
	FLocHubHealth Older;
	TestTrue(TEXT("Older body parses"), FLocHubServiceClient::ParseHealth(TEXT("{\"ok\":true,\"ai\":{\"provider\":\"anthropic\"}}"), Older));
	TestFalse(TEXT("An older service: no lengthArgs"), Older.bHasAiLengthArgs);

	FLocHubServiceProcess::FConfig Config;
	Config.Provider = TEXT("anthropic");
	Config.Auth = TEXT("api");
	Config.LengthArguments = DefaultArguments;
	FLocHubHealth Health;
	Health.AiProvider = TEXT("anthropic");
	Health.AiAuth = TEXT("api");
	Health.bHasAiLengthArgs = true;
	Health.AiLengthArgs = DefaultArguments;
	TestTrue(TEXT("Same Length Check"), FLocHubServiceProcess::IsAiConfigApplied(Config, Health));
	FLocHubHealth Different = Health;
	Different.AiLengthArgs = TEXT("--length-check off");
	TestFalse(TEXT("Different Length Check: a restart-worthy change"), FLocHubServiceProcess::IsAiConfigApplied(Config, Different));
	FLocHubHealth NoField = Different;
	NoField.bHasAiLengthArgs = false;
	TestTrue(TEXT("An older service without lengthArgs counts as applied"), FLocHubServiceProcess::IsAiConfigApplied(Config, NoField));
	FLocHubServiceProcess::FConfig NoFlags = Config;
	NoFlags.LengthArguments.Reset();
	TestTrue(TEXT("No flags passed equals the service's own default, off"), FLocHubServiceProcess::IsAiConfigApplied(NoFlags, Different));
	TestFalse(TEXT("No flags passed, but the service runs a Length Check"), FLocHubServiceProcess::IsAiConfigApplied(NoFlags, Health));
	return true;
}

#endif
