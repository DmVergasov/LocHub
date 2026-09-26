// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "HAL/FileManager.h"
#include "LocHubSettings.h"
#include "LocHubUserSettings.h"
#include "Misc/AutomationTest.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSettingsReleasePolicyWireTest,
	"LocHub.Settings.ReleasePolicyWire",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSettingsReleasePolicyWireTest::RunTest(const FString& Parameters)
{
	// "lochub serve --policy" and GET /api/export use exactly these strings (Service/CONTRACT.md).
	TestEqual(TEXT("Validated"), ULocHubSettings::ReleasePolicyToString(ELocHubReleasePolicy::Validated), TEXT("validated"));
	TestEqual(TEXT("ApprovedOnly"), ULocHubSettings::ReleasePolicyToString(ELocHubReleasePolicy::ApprovedOnly), TEXT("approved_only"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSettingsAiProviderWireTest,
	"LocHub.Settings.AiProviderWire",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSettingsAiProviderWireTest::RunTest(const FString& Parameters)
{
	// "lochub serve --provider/--auth" accept exactly these strings (Service/src/cli.ts).
	TestEqual(TEXT("Anthropic"), ULocHubSettings::AiProviderToString(ELocHubAiProvider::Anthropic), TEXT("anthropic"));
	TestEqual(TEXT("OpenAI"), ULocHubSettings::AiProviderToString(ELocHubAiProvider::OpenAI), TEXT("openai"));
	TestEqual(TEXT("XAI"), ULocHubSettings::AiProviderToString(ELocHubAiProvider::XAI), TEXT("xai"));
	TestEqual(TEXT("DeepSeek"), ULocHubSettings::AiProviderToString(ELocHubAiProvider::DeepSeek), TEXT("deepseek"));
	TestEqual(TEXT("Gemini"), ULocHubSettings::AiProviderToString(ELocHubAiProvider::Gemini), TEXT("gemini"));
	TestEqual(TEXT("ApiKey"), ULocHubSettings::AnthropicAuthToString(ELocHubAnthropicAuth::ApiKey), TEXT("api"));
	TestEqual(TEXT("ClaudeSubscription"), ULocHubSettings::AnthropicAuthToString(ELocHubAnthropicAuth::ClaudeSubscription), TEXT("subscription"));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSettingsActiveModelsTest,
	"LocHub.Settings.ActiveModels",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSettingsActiveModelsTest::RunTest(const FString& Parameters)
{
	ULocHubSettings* Settings = NewObject<ULocHubSettings>();
	Settings->OpenAiModels.TranslateModel = TEXT("translate-a");
	Settings->GeminiModels.TranslateModel = TEXT("translate-b");
	Settings->AiProvider = ELocHubAiProvider::OpenAI;
	TestEqual(TEXT("OpenAI section"), Settings->GetActiveModels().TranslateModel, FString(TEXT("translate-a")));
	Settings->AiProvider = ELocHubAiProvider::Gemini;
	TestEqual(TEXT("Gemini section"), Settings->GetActiveModels().TranslateModel, FString(TEXT("translate-b")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSettingsActiveApiKeyTest,
	"LocHub.Settings.ActiveApiKey",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSettingsActiveApiKeyTest::RunTest(const FString& Parameters)
{
	ULocHubSettings* Settings = NewObject<ULocHubSettings>();
	Settings->AnthropicApiKey = TEXT("test-key-anthropic");
	Settings->OpenAiApiKey = TEXT("test-key-openai");
	Settings->XaiApiKey = TEXT("test-key-xai");
	Settings->DeepSeekApiKey = TEXT("test-key-deepseek");
	Settings->GeminiApiKey = TEXT("test-key-gemini");

	Settings->AiProvider = ELocHubAiProvider::Anthropic;
	TestEqual(TEXT("Anthropic"), Settings->GetActiveApiKey(), FString(TEXT("test-key-anthropic")));
	Settings->AiProvider = ELocHubAiProvider::OpenAI;
	TestEqual(TEXT("OpenAI"), Settings->GetActiveApiKey(), FString(TEXT("test-key-openai")));
	Settings->AiProvider = ELocHubAiProvider::XAI;
	TestEqual(TEXT("xAI"), Settings->GetActiveApiKey(), FString(TEXT("test-key-xai")));
	Settings->AiProvider = ELocHubAiProvider::DeepSeek;
	TestEqual(TEXT("DeepSeek"), Settings->GetActiveApiKey(), FString(TEXT("test-key-deepseek")));
	Settings->AiProvider = ELocHubAiProvider::Gemini;
	TestEqual(TEXT("Gemini"), Settings->GetActiveApiKey(), FString(TEXT("test-key-gemini")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubUserSettingsRegistrationTest,
	"LocHub.Settings.UserSettingsRegistration",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubUserSettingsRegistrationTest::RunTest(const FString& Parameters)
{
	// Editor Preferences > Plugins > LocHub > Node.js Executable: SettingsEditorModule registers a UDeveloperSettings
	// CDO under exactly GetContainerName()/GetCategoryName()/GetSectionName().
	const ULocHubUserSettings* Settings = GetDefault<ULocHubUserSettings>();
	TestEqual(TEXT("Container is Editor Preferences, not Project Settings"), Settings->GetContainerName(), FName(TEXT("Editor")));
	TestEqual(TEXT("Category is Plugins"), Settings->GetCategoryName(), FName(TEXT("Plugins")));
	TestEqual(TEXT("Section is LocHub"), Settings->GetSectionName(), FName(TEXT("LocHub")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSettingsProjectBriefRoundTripTest,
	"LocHub.Settings.ProjectBriefRoundTrip",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSettingsProjectBriefRoundTripTest::RunTest(const FString& Parameters)
{
	// A temporary ini, never the project's real Config/DefaultEditor.ini: SaveConfig/LoadConfig write and read
	// exactly the file named here when one is given explicitly.
	const FString TempIni = FPaths::ProjectSavedDir() / TEXT("LocHubTests/ProjectBriefRoundTrip.ini");
	IFileManager::Get().Delete(*TempIni);
	GConfig->UnloadFile(TempIni);

	// Several lines, double quotes, a backslash and Cyrillic: multi-line FString values are the risky part of
	// UE's ini serialization.
	const FString Brief = TEXT("Line one.\nLine two with \"quotes\" and a backslash \\.\nЛиния три на кириллице.");

	ULocHubSettings* Writer = NewObject<ULocHubSettings>(GetTransientPackage(), NAME_None, RF_Transient);
	Writer->ProjectBrief = Brief;
	// NewObject copies the CDO, which holds whatever this project's own Config/DefaultEditor.ini has -- real keys
	// included when this suite runs against a live project. SaveConfig writes every inherited config property
	// (UObject::SaveConfig compares only against the super CDO), so the five key fields must be cleared on the
	// writer before the file below is written, or a real key would land in a test-written file (key-contract.md §5).
	Writer->AnthropicApiKey.Reset();
	Writer->OpenAiApiKey.Reset();
	Writer->XaiApiKey.Reset();
	Writer->DeepSeekApiKey.Reset();
	Writer->GeminiApiKey.Reset();
	Writer->SaveConfig(CPF_Config, *TempIni);

	ULocHubSettings* Reader = NewObject<ULocHubSettings>(GetTransientPackage(), NAME_None, RF_Transient);
	Reader->LoadConfig(nullptr, *TempIni);

	TestEqual(TEXT("ProjectBrief survives SaveConfig -> LoadConfig through a temporary ini"), Reader->ProjectBrief, Brief);

	GConfig->UnloadFile(TempIni);
	IFileManager::Get().Delete(*TempIni);
	return true;
}

#endif
