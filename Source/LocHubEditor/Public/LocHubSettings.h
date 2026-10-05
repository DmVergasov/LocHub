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
	/** Any server that speaks the OpenAI Chat Completions API: a local model (Ollama, LM Studio), a router or a private deployment. */
	Custom UMETA(DisplayName = "Custom (OpenAI-compatible)"),
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

/** How a Custom endpoint receives the API key. */
UENUM()
enum class ELocHubCustomKeyHeader : uint8
{
	/** "Authorization: Bearer <key>", what most OpenAI-compatible servers expect. */
	Bearer UMETA(DisplayName = "Authorization: Bearer"),
	/** "api-key: <key>", what Azure OpenAI expects. */
	ApiKey UMETA(DisplayName = "api-key"),
};

/** How a Custom endpoint is asked to answer in JSON. */
UENUM()
enum class ELocHubStructuredOutput : uint8
{
	/** Strict response_format json_schema: the most reliable, where the server supports it. */
	JsonSchema UMETA(DisplayName = "JSON Schema"),
	/** response_format json_object, with the schema in the system prompt. */
	JsonObject UMETA(DisplayName = "JSON Object"),
	/** No response_format at all; the schema goes in the system prompt. For servers that reject response_format. */
	PromptOnly UMETA(DisplayName = "Prompt Only"),
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

/** Which strings the Length Check measures. */
UENUM()
enum class ELocHubLengthScope : uint8
{
	/** Only strings sent as widget text: those matching Ui Source Patterns (LocHub.Kind = ui). */
	UiStrings UMETA(DisplayName = "UI strings"),
	/** Every string. */
	AllStrings UMETA(DisplayName = "All strings"),
};

/** What a translation over its length limit gets. */
UENUM()
enum class ELocHubLengthSeverity : uint8
{
	/** A hint: the string is flagged for review and approves as usual. */
	Warning,
	/** Approve and Save need "anyway", and an AI draft over the limit is written Needs fix. */
	MustConfirm UMETA(DisplayName = "Must Confirm"),
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
	/** Wire name of a provider for "lochub serve --provider": "anthropic", "openai", "xai", "deepseek", "gemini" or "custom". */
	static FString AiProviderToString(ELocHubAiProvider InProvider);
	/** Wire name of an Anthropic auth mode for "lochub serve --auth": "api" or "subscription". */
	static FString AnthropicAuthToString(ELocHubAnthropicAuth InAuth);
	/** Wire name of a Custom key header for "lochub serve --key-header": "bearer" or "api-key". */
	static FString CustomKeyHeaderToString(ELocHubCustomKeyHeader InKeyHeader);
	/** Wire name of a Custom structured output mode for "lochub serve --structured-output": "json_schema", "json_object" or "prompt_only". */
	static FString StructuredOutputToString(ELocHubStructuredOutput InMode);
	/** Wire name of a Length Check scope for "lochub serve --length-scope": "ui" or "all". */
	static FString LengthScopeToString(ELocHubLengthScope InScope);
	/** Wire name of a Length Check severity for "lochub serve --length-check": "warning" or "confirm". */
	static FString LengthSeverityToString(ELocHubLengthSeverity InSeverity);

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

	/** Base URL of the OpenAI-compatible API, for example http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1
	 *  (LM Studio). Must start with http:// or https://; LocHub adds /chat/completions and /models to it. Logs show
	 *  only its scheme, host and port. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Base URL", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	FString CustomBaseUrl;

	/** Optional: leave empty for a local server that needs no key, and no auth header is sent. Sent to the LocHub
	 *  service process only while it runs; saved in Config/DefaultEditor.ini with the other LocHub settings. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "API Key", PasswordField = "true", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	FString CustomApiKey;

	/** How the API key is sent: Authorization: Bearer for most servers, api-key for Azure OpenAI. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Key Header", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	ELocHubCustomKeyHeader CustomKeyHeader = ELocHubCustomKeyHeader::Bearer;

	/** Model IDs exactly as the endpoint lists them. Translate Model is required; an empty Judge Model uses the Translate Model. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	FLocHubAiModels CustomModels;

	/** How LocHub asks for JSON. Start with JSON Schema; if the server rejects it or the answers break, try JSON Object, then Prompt Only. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Structured Output", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	ELocHubStructuredOutput CustomStructuredOutput = ELocHubStructuredOutput::JsonSchema;

	/** USD per 1M input tokens, for both models. With Output Price also 0, estimates show no cost and Max USD cannot limit spending. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Input Price (USD per 1M tokens)", ClampMin = "0", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	float CustomInputPricePerMTok = 0.0f;

	/** USD per 1M output tokens, for both models. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Output Price (USD per 1M tokens)", ClampMin = "0", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	float CustomOutputPricePerMTok = 0.0f;

	/** Most requests LocHub sends to the endpoint at once, across all running jobs. Keep it low for a local model on one GPU. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Max Parallel Requests", ClampMin = "1", ClampMax = "32", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	int32 CustomMaxParallelRequests = 2;

	/** How long one request may take before LocHub gives up on it and splits its strings into smaller requests. At most
	 *  300 seconds: a slow local model finishes through the smaller requests, not through a longer wait. */
	UPROPERTY(EditAnywhere, config, Category = "AI", meta = (DisplayName = "Request Timeout (seconds)", ClampMin = "30", ClampMax = "300", EditCondition = "AiProvider == ELocHubAiProvider::Custom", EditConditionHides))
	int32 CustomRequestTimeoutSeconds = 300;

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

	/** The language the project's source text is written in, and the one LocHub translates from (for example en, or zh-Hans for a game written in Chinese). Tools > LocHub > Set Up Localization Target gives it to a target that has no native culture yet; a target that has one keeps it, change it in the Localization Dashboard. A name the engine does not know falls back to en. */
	UPROPERTY(EditAnywhere, config, Category = "Localization Target")
	FString SetupNativeCulture;

	/** Cultures that Tools > LocHub > Set Up Localization Target adds next to the native culture. Set Up never removes a culture. */
	UPROPERTY(EditAnywhere, config, Category = "Localization Target")
	TArray<FString> SetupForeignCultures;

	/** Flag translations that are likely too long for the UI, and tell the AI translator the limit. Applied to the running LocHub service the same way an AI Provider change is: right away, or, while a translation job runs, right after that job finishes. Strings translated earlier keep their review band until a job or an edit checks them again. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (DisplayName = "Enable Length Check"))
	bool bEnableLengthCheck = true;

	/** UI strings: only strings sent as widget text (Ui Source Patterns under Push). All strings: every string. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (EditCondition = "bEnableLengthCheck"))
	ELocHubLengthScope LengthCheckScope = ELocHubLengthScope::UiStrings;

	/** A translation may be this many times as long as the source, in visible characters: placeholders and tags count 0, CJK characters 2. Two decimals are used. A Chinese, Japanese or Korean source translated into a Latin-script language needs a higher ratio, about 1.8. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (ClampMin = "1.0", ClampMax = "5.0", EditCondition = "bEnableLengthCheck"))
	float MaxLengthRatio = 1.3f;

	/** Characters allowed on top of the ratio, so a very short string ("OK", "Back") is not flagged for a few extra letters. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (ClampMin = "0", ClampMax = "100", EditCondition = "bEnableLengthCheck"))
	int32 ExtraCharacters = 4;

	/** A ratio for one culture ("pt-BR") or a whole language ("de", used for every German culture) instead of Max Length Ratio; an exact culture wins over its language. Values outside 1.0-5.0 are clamped; a key that is not a culture or language code is skipped with a warning in the log. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (EditCondition = "bEnableLengthCheck"))
	TMap<FString, float> CultureRatioOverrides;

	/** Send each string's limit with the translation request, so the AI aims for a translation that fits. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (DisplayName = "Tell the Translator", EditCondition = "bEnableLengthCheck"))
	bool bTellTranslator = true;

	/** Warning: a translation over its limit is flagged for review and approves as usual. Must Confirm: approving or saving it needs "Approve anyway" / "Save anyway", and an AI draft over the limit is written Needs fix, so the next job translates it again. */
	UPROPERTY(EditAnywhere, config, Category = "Length Check", meta = (EditCondition = "bEnableLengthCheck"))
	ELocHubLengthSeverity LengthSeverity = ELocHubLengthSeverity::Warning;
};
