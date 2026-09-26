// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/SoftObjectPtr.h"
#include "LocHubSettings.generated.h"

class UFont;

/** Which service strings a Pull may write into the archives. */
UENUM()
enum class ELocHubReleasePolicy : uint8
{
	/** AI drafts that passed the automatic checks, plus everything a human approved or edited. */
	Validated,
	/** Only strings a human approved or edited. */
	ApprovedOnly,
};

/** Which AI provider translates. */
UENUM()
enum class ELocHubAiProvider : uint8
{
	/** Claude, or the signed-in Claude Code subscription. */
	Anthropic,
	/** OpenAI GPT models. */
	OpenAI UMETA(DisplayName = "OpenAI"),
	/** xAI Grok models. */
	XAI UMETA(DisplayName = "xAI (Grok)"),
	/** DeepSeek models. */
	DeepSeek UMETA(DisplayName = "DeepSeek"),
	/** Google Gemini models. */
	Gemini UMETA(DisplayName = "Google Gemini"),
};

/** How LocHub signs in to Anthropic. */
UENUM()
enum class ELocHubAnthropicAuth : uint8
{
	/** The API Key set below. */
	ApiKey UMETA(DisplayName = "API Key"),
	/** The signed-in Claude Code CLI ("claude" on PATH) and its Claude subscription. */
	ClaudeSubscription UMETA(DisplayName = "Claude Subscription"),
};

/** The two models of one provider: the translator and the cheaper judge that grades it. */
USTRUCT()
struct FLocHubAiModels
{
	GENERATED_BODY()

	/** Model ID that writes the translations, exactly as the provider's API spells it. */
	UPROPERTY(EditAnywhere, Category = "AI")
	FString TranslateModel;

	/** Model ID that grades the translations; usually a cheaper model of the same provider. */
	UPROPERTY(EditAnywhere, Category = "AI")
	FString JudgeModel;
};

/** Project-wide LocHub settings, stored in Config/DefaultEditor.ini. */
UCLASS(config = Editor, defaultconfig, meta = (DisplayName = "LocHub"))
class LOCHUBEDITOR_API ULocHubSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	ULocHubSettings();

	virtual FName GetCategoryName() const override;

	/** Wire name of a policy for "lochub serve --policy" and the export response: "validated" or "approved_only". */
	static FString ReleasePolicyToString(ELocHubReleasePolicy InPolicy);
	/** Wire name of a provider for "lochub serve --provider": "anthropic", "openai", "xai", "deepseek" or "gemini". */
	static FString AiProviderToString(ELocHubAiProvider InProvider);
	/** Wire name of an Anthropic auth mode for "lochub serve --auth": "api" or "subscription". */
	static FString AnthropicAuthToString(ELocHubAnthropicAuth InAuth);

	/** Models of the selected provider. */
	const FLocHubAiModels& GetActiveModels() const;
	/** API key of the selected provider. */
	const FString& GetActiveApiKey() const;

	/** Local port of "lochub serve". */
	UPROPERTY(EditAnywhere, config, Category = "Service", meta = (ClampMin = "1024", ClampMax = "65535"))
	int32 ServicePort = 47810;

	/** Start "node <plugin>/Resources/LocHubService/lochub_service.mjs serve" when Push, Pull or Open finds no service on the port. */
	UPROPERTY(EditAnywhere, config, Category = "Service")
	bool bAutoStartService = true;

	/** Passed to the service when it starts; a running service keeps its policy until Tools > LocHub > Restart Service. */
	UPROPERTY(EditAnywhere, config, Category = "Service")
	ELocHubReleasePolicy ReleasePolicy = ELocHubReleasePolicy::Validated;

	/** Applied to the running LocHub service right away; while a translation job runs, right after the job finishes. */
	UPROPERTY(EditAnywhere, config, Category = "AI")
	ELocHubAiProvider AiProvider = ELocHubAiProvider::Anthropic;

	/** API Key: uses the key set below. Claude Subscription: the signed-in Claude Code CLI, run hidden with no tools. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::Anthropic", EditConditionHides))
	ELocHubAnthropicAuth AnthropicAuth = ELocHubAnthropicAuth::ApiKey;

	/** Anthropic API key, sent to the LocHub service process only while it runs and only in API Key auth; saved in
	 *  Config/DefaultEditor.ini with the other LocHub settings. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "API Key", PasswordField = "true", EditCondition = "AiProvider == ELocHubAiProvider::Anthropic && AnthropicAuth == ELocHubAnthropicAuth::ApiKey", EditConditionHides))
	FString AnthropicApiKey;

	/** Claude models. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::Anthropic", EditConditionHides))
	FLocHubAiModels AnthropicModels;

	/** OpenAI API key, sent to the LocHub service process only while it runs; saved in Config/DefaultEditor.ini with the other LocHub settings. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "API Key", PasswordField = "true", EditCondition = "AiProvider == ELocHubAiProvider::OpenAI", EditConditionHides))
	FString OpenAiApiKey;

	/** OpenAI models. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::OpenAI", EditConditionHides))
	FLocHubAiModels OpenAiModels;

	/** xAI API key, sent to the LocHub service process only while it runs; saved in Config/DefaultEditor.ini with the other LocHub settings. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "API Key", PasswordField = "true", EditCondition = "AiProvider == ELocHubAiProvider::XAI", EditConditionHides))
	FString XaiApiKey;

	/** xAI models. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::XAI", EditConditionHides))
	FLocHubAiModels XaiModels;

	/** DeepSeek API key, sent to the LocHub service process only while it runs; saved in Config/DefaultEditor.ini with the other LocHub settings. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "API Key", PasswordField = "true", EditCondition = "AiProvider == ELocHubAiProvider::DeepSeek", EditConditionHides))
	FString DeepSeekApiKey;

	/** DeepSeek models. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::DeepSeek", EditConditionHides))
	FLocHubAiModels DeepSeekModels;

	/** Google Gemini API key, sent to the LocHub service process only while it runs; saved in Config/DefaultEditor.ini with the other LocHub settings. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "API Key", PasswordField = "true", EditCondition = "AiProvider == ELocHubAiProvider::Gemini", EditConditionHides))
	FString GeminiApiKey;

	/** Google Gemini models. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::Gemini", EditConditionHides))
	FLocHubAiModels GeminiModels;

	/** What the game is, its setting and tone, who the player is, and anything else a translator must know before
	 *  touching a single string. Sent with every translation and review request, for every culture. Applied to the
	 *  running LocHub service the same way an AI Provider or model change is: right away, or, while a translation
	 *  job is running, right after that job finishes. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (MultiLine = "true"))
	FString ProjectBrief;

	/** A string whose manifest source location matches any of these wildcards is sent as widget text (LocHub.Kind = ui). */
	UPROPERTY(EditAnywhere, config, Category = "Push")
	TArray<FString> UiSourcePatterns;

	/** Paths relative to the project folder that the coverage report skips. */
	UPROPERTY(EditAnywhere, config, Category = "Push")
	TArray<FString> CoverageExcludePatterns;

	/** Every listed font must have a glyph for every character of a translation, or Pull rejects it. Empty list: no glyph check. */
	UPROPERTY(EditAnywhere, config, Category = "Pull")
	TArray<TSoftObjectPtr<UFont>> GlyphCheckFonts;

	/** Font files (for example RmlUi fonts) that are checked the same way as Glyph Check Fonts. */
	UPROPERTY(EditAnywhere, config, Category = "Pull", meta = (RelativeToGameDir, FilePathFilter = "Font files (*.ttf, *.otf)|*.ttf;*.otf"))
	TArray<FFilePath> GlyphCheckFontFiles;

	/** Write answered translator questions into DevNotes of asset texts. Off: every answer goes to Saved/LocHub/DevNotesProposals.md. Needs Unreal Engine 5.8 or later; on 5.6 and 5.7 answers stay in LocHub and still reach the translator. */
	UPROPERTY(EditAnywhere, config, Category = "Pull")
	bool bWriteDevNotesToAssets = true;

	/** Cultures that Tools > LocHub > Set Up Localization Target adds next to the native culture. Set Up never removes a culture. */
	UPROPERTY(EditAnywhere, config, Category = "Localization Target")
	TArray<FString> SetupForeignCultures;
};
