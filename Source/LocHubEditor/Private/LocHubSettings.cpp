// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSettings.h"

ULocHubSettings::ULocHubSettings()
{
	UiSourcePatterns = { TEXT("*/UI/*"), TEXT("*/Hud/*"), TEXT("*/Widgets/*"), TEXT("*/Menus/*"), TEXT("*/WBP_*") };
	CoverageExcludePatterns = { TEXT("Source/*Editor/*"), TEXT("*/Tests/*"), TEXT("*/ThirdParty/*"), TEXT("*.generated.h") };
	AnthropicModels.TranslateModel = TEXT("claude-opus-5-5");
	AnthropicModels.JudgeModel = TEXT("claude-sonnet-5");
	OpenAiModels.TranslateModel = TEXT("gpt-6-sol");
	OpenAiModels.JudgeModel = TEXT("gpt-6-luna");
	XaiModels.TranslateModel = TEXT("grok-4.7");
	XaiModels.JudgeModel = TEXT("grok-4.7");
	DeepSeekModels.TranslateModel = TEXT("deepseek-v4-pro");
	DeepSeekModels.JudgeModel = TEXT("deepseek-flash");
	GeminiModels.TranslateModel = TEXT("gemini-3.8-flash");
	GeminiModels.JudgeModel = TEXT("gemini-3.5-flash-lite");
	SetupForeignCultures = { TEXT("de"), TEXT("fr"), TEXT("es"), TEXT("ja") };
}

FName ULocHubSettings::GetCategoryName() const
{
	return TEXT("Plugins");
}

FString ULocHubSettings::ReleasePolicyToString(const ELocHubReleasePolicy InPolicy)
{
	switch (InPolicy)
	{
	case ELocHubReleasePolicy::ApprovedOnly:
		return TEXT("approved_only");
	case ELocHubReleasePolicy::Validated:
	default:
		return TEXT("validated");
	}
}

FString ULocHubSettings::AiProviderToString(const ELocHubAiProvider InProvider)
{
	switch (InProvider)
	{
	case ELocHubAiProvider::OpenAI:
		return TEXT("openai");
	case ELocHubAiProvider::XAI:
		return TEXT("xai");
	case ELocHubAiProvider::DeepSeek:
		return TEXT("deepseek");
	case ELocHubAiProvider::Gemini:
		return TEXT("gemini");
	case ELocHubAiProvider::Anthropic:
	default:
		return TEXT("anthropic");
	}
}

FString ULocHubSettings::AnthropicAuthToString(const ELocHubAnthropicAuth InAuth)
{
	switch (InAuth)
	{
	case ELocHubAnthropicAuth::ClaudeSubscription:
		return TEXT("subscription");
	case ELocHubAnthropicAuth::ApiKey:
	default:
		return TEXT("api");
	}
}

const FLocHubAiModels& ULocHubSettings::GetActiveModels() const
{
	switch (AiProvider)
	{
	case ELocHubAiProvider::OpenAI:
		return OpenAiModels;
	case ELocHubAiProvider::XAI:
		return XaiModels;
	case ELocHubAiProvider::DeepSeek:
		return DeepSeekModels;
	case ELocHubAiProvider::Gemini:
		return GeminiModels;
	case ELocHubAiProvider::Anthropic:
	default:
		return AnthropicModels;
	}
}

const FString& ULocHubSettings::GetActiveApiKey() const
{
	switch (AiProvider)
	{
	case ELocHubAiProvider::OpenAI:
		return OpenAiApiKey;
	case ELocHubAiProvider::XAI:
		return XaiApiKey;
	case ELocHubAiProvider::DeepSeek:
		return DeepSeekApiKey;
	case ELocHubAiProvider::Gemini:
		return GeminiApiKey;
	case ELocHubAiProvider::Anthropic:
	default:
		return AnthropicApiKey;
	}
}
