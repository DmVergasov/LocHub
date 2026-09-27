// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubServiceProcess.h"

#include "HAL/FileManager.h"
#include "HAL/PlatformTime.h"
#include "Interfaces/IPluginManager.h"
#include "LocHubChildProcess.h"
#include "LocHubEditorModule.h"
#include "LocHubEnvironment.h"
#include "LocHubLog.h"
#include "LocHubProcessSpawnLock.h"
#include "LocHubScopedEnvVar.h"
#include "LocHubServiceClient.h"
#include "LocHubSettings.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Misc/SecureHash.h"

namespace LocHubServiceProcessPrivate
{
	constexpr double StartTimeoutSeconds = 20.0;
	constexpr float TickIntervalSeconds = 0.5f;
	/** How often the pending-restart ticker re-probes while an AI-mismatch restart waits for a running job to end. */
	constexpr float AiRestartPendingPollSeconds = 5.0f;
	/** An API key past this length is treated as no key at all (M-2): Windows' ::SetEnvironmentVariable rejects a
	 *  value over 32,767 characters and every platform's SetEnvironmentVar then logs the failed value itself
	 *  (WindowsPlatformMisc.cpp "Failed to set EnvironmentVariable: %s to : %s"), which would put the key in the
	 *  log. No real provider key is anywhere near this long. */
	constexpr int32 MaxApiKeyLength = 4096;

	/** First whitespace-separated token of InText as a pid, or 0 when it has none (service.pid's node pid). */
	uint32 ParseLeadingPid(const FString& InText)
	{
		TArray<FString> Parts;
		InText.ParseIntoArrayWS(Parts);
		uint32 Pid = 0;
		if (Parts.Num() > 0)
		{
			LexFromString(Pid, *Parts[0]);
		}
		return Pid;
	}

	/** A Length Check culture ratio override key the service accepts (cli.ts): ASCII letters, digits, '-' and '_', starting
	 *  with a letter -- a culture ("pt-BR") or a language ("de"). */
	bool IsLengthCultureKey(const FString& InKey)
	{
		for (int32 Index = 0; Index < InKey.Len(); ++Index)
		{
			const TCHAR Char = InKey[Index];
			const bool bLetter = (Char >= TEXT('a') && Char <= TEXT('z')) || (Char >= TEXT('A') && Char <= TEXT('Z'));
			const bool bDigitOrSeparator = (Char >= TEXT('0') && Char <= TEXT('9')) || Char == TEXT('-') || Char == TEXT('_');
			if (!bLetter && (Index == 0 || !bDigitOrSeparator))
			{
				return false;
			}
		}
		return !InKey.IsEmpty();
	}

	/** The Length Check flags of a check that is off: what BuildLengthArguments writes when it is disabled and what a
	 *  service started without any --length-* flag reports (Service/src/lengthCheck.ts lengthArgsOf, LENGTH_CHECK_OFF). */
	const TCHAR* const LengthCheckOffArguments = TEXT("--length-check off");

	/** The Length Check flags a service started with InConfig reports as ai.lengthArgs: no flags means its own default, off. */
	FString ExpectedLengthArgs(const FLocHubServiceProcess::FConfig& InConfig)
	{
		return InConfig.LengthArguments.IsEmpty() ? FString(LengthCheckOffArguments) : InConfig.LengthArguments;
	}

	/** A price from a hand-edited ini, clamped to 0 or above -- and to 0, not left as is, when it is not even a
	 *  real number (M-6): FMath::Max(Inf, 0.0f) stays Inf, and FString::SanitizeFloat then writes out "inf", which
	 *  the service's parsePrice refuses, stopping it from starting on exactly the malformed ini value this is
	 *  meant to survive. */
	float SanitizePrice(const float InValue)
	{
		return FMath::IsFinite(InValue) ? FMath::Max(InValue, 0.0f) : 0.0f;
	}
}

const TCHAR* const FLocHubServiceProcess::ApiKeyEnvVarName = TEXT("LOCHUB_API_KEY");
const TCHAR* const FLocHubServiceProcess::BaseUrlEnvVarName = TEXT("LOCHUB_CUSTOM_BASE_URL");

FLocHubServiceProcess::FLocHubServiceProcess(FConfig InConfig)
	: TerminateProcessFn([](FProcHandle& InHandle, const uint32 InPid) { LocHubChildProcess::Terminate(InHandle, InPid, ELocHubStopMode::Graceful); })
	, Config(MoveTemp(InConfig))
{
}

FLocHubServiceProcess::~FLocHubServiceProcess()
{
	// Nobody waits any more: drop the callbacks without calling them, then stop the own process.
	Waiters.Reset();
	ClearAiRestartPending();
	StopProcess();
}

FLocHubServiceProcess::FConfig FLocHubServiceProcess::MakeDefaultConfig()
{
	const ULocHubSettings* Settings = GetDefault<ULocHubSettings>();

	FConfig Result;
	Result.Port = Settings->ServicePort;
	Result.bAutoStart = Settings->bAutoStartService;
	Result.Policy = ULocHubSettings::ReleasePolicyToString(Settings->ReleasePolicy);
	Result.Provider = ULocHubSettings::AiProviderToString(Settings->AiProvider);
	Result.Auth = Settings->AiProvider == ELocHubAiProvider::Anthropic ? ULocHubSettings::AnthropicAuthToString(Settings->AnthropicAuth) : FString(TEXT("api"));
	Result.TranslateModel = Settings->GetActiveModels().TranslateModel;
	Result.JudgeModel = Settings->GetActiveModels().JudgeModel;
	// Only in API-key auth: Claude Subscription mode never hands the Anthropic key to the service (M-1). A key
	// typed while Subscription is active still sits in Project Settings, ready the moment Auth switches back, but
	// never reaches the child's environment or a restart comparison while it does not apply.
	Result.ApiKey = Result.Auth == TEXT("api") ? Settings->GetActiveApiKey() : FString();
	if (Result.ApiKey.Len() > LocHubServiceProcessPrivate::MaxApiKeyLength)
	{
		// The length only, never the value: see MaxApiKeyLength's comment for why this is worth a Warning.
		UE_LOG(LogLocHub, Warning, TEXT("The configured API key is %d characters long, further than any real provider key; treating it as no key."), Result.ApiKey.Len());
		Result.ApiKey.Reset();
	}
	Result.KeyId = ComputeKeyId(Result.ApiKey);
	// Filled only while Custom is the provider: a Custom field edited while it is hidden never changes another
	// provider's config, and so never restarts its service.
	if (Settings->AiProvider == ELocHubAiProvider::Custom)
	{
		// A local user often runs one model: an empty Judge Model judges with the translate model. The service keeps
		// requiring both flags, so the fallback lives here.
		if (Result.JudgeModel.IsEmpty())
		{
			Result.JudgeModel = Result.TranslateModel;
		}
		FString BaseUrl = Settings->CustomBaseUrl.TrimStartAndEnd();
		BaseUrl.RemoveFromEnd(TEXT("/"));
		Result.CustomBaseUrl = BaseUrl;
		Result.CustomKeyHeader = ULocHubSettings::CustomKeyHeaderToString(Settings->CustomKeyHeader);
		Result.CustomStructuredOutput = ULocHubSettings::StructuredOutputToString(Settings->CustomStructuredOutput);
		// Clamped again here: ClampMin/ClampMax guard only the Details panel, not a hand-edited DefaultEditor.ini, and
		// the service refuses to start on a value outside these ranges.
		Result.CustomPriceIn = FString::SanitizeFloat(LocHubServiceProcessPrivate::SanitizePrice(Settings->CustomInputPricePerMTok), 0);
		Result.CustomPriceOut = FString::SanitizeFloat(LocHubServiceProcessPrivate::SanitizePrice(Settings->CustomOutputPricePerMTok), 0);
		Result.CustomMaxParallel = FMath::Clamp(Settings->CustomMaxParallelRequests, 1, 32);
		Result.CustomRequestTimeoutSeconds = FMath::Clamp(Settings->CustomRequestTimeoutSeconds, 30, 300);
		Result.CustomSettingsId = ComputeCustomSettingsId(Result);
	}

	FString ProjectDir = LocHubEnvironment::GetProjectDir();
	ProjectDir.RemoveFromEnd(TEXT("/"));
	Result.ProjectDir = ProjectDir;

	const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("LocHub"));
	const FString PluginDir = Plugin.IsValid() ? FPaths::ConvertRelativePathToFull(Plugin->GetBaseDir()) : ProjectDir / TEXT("Plugins/LocHub");
	Result.ServiceScript = PluginDir / TEXT("Resources/LocHubService/lochub_service.mjs");
	Result.WebDir = PluginDir / TEXT("Resources/LocHubWeb");
	Result.WebDepsDir = PluginDir / TEXT("Source/ThirdParty/LocHubWebDeps");
	Result.StateDir = ProjectDir / TEXT("Saved/LocHub");

	// Written before every start, even when empty, so the running process always has a fresh snapshot of the
	// Project Settings brief (Brief BS design); the hash lets IsAiConfigApplied tell a brief-only edit apart from
	// an unrelated settings change without ever comparing the brief text itself.
	Result.BriefSha1 = WriteBriefFile(Result.StateDir / TEXT("brief.md"), Settings->ProjectBrief);
	Result.LengthArguments = BuildLengthArguments(*Settings);
	return Result;
}

FString FLocHubServiceProcess::BuildServeArguments(const FConfig& InConfig)
{
	FString Arguments = FString::Printf(TEXT("\"%s\" serve --project \"%s\" --port %d --policy %s --provider %s --auth %s --translate-model \"%s\" --judge-model \"%s\" --web-dir \"%s\" --web-deps-dir \"%s\" --brief-file \"%s\""),
		*InConfig.ServiceScript, *InConfig.ProjectDir, InConfig.Port, *InConfig.Policy, *InConfig.Provider, *InConfig.Auth, *InConfig.TranslateModel,
		*InConfig.JudgeModel, *InConfig.WebDir, *InConfig.WebDepsDir, *(InConfig.StateDir / TEXT("brief.md")));
	if (InConfig.Provider.Equals(TEXT("custom"), ESearchCase::CaseSensitive))
	{
		// The key never goes here, and neither does the Base URL: they reach the child only through
		// LOCHUB_API_KEY and LOCHUB_CUSTOM_BASE_URL (StartNode). The engine itself can log the whole serve line on
		// a failed spawn (Windows' CreateProcess) or mis-split it at a trailing '=' (macOS), so anything worth
		// keeping off a log line travels in the environment instead of on this command line.
		Arguments += FString::Printf(TEXT(" --key-header %s --structured-output %s --price-in %s --price-out %s --max-parallel %d --request-timeout %d"),
			*InConfig.CustomKeyHeader, *InConfig.CustomStructuredOutput, *InConfig.CustomPriceIn, *InConfig.CustomPriceOut,
			InConfig.CustomMaxParallel, InConfig.CustomRequestTimeoutSeconds);
	}
	// Unquoted on purpose: the flags hold no spaces (BuildLengthArguments skips a culture key that would), and the service
	// echoes them back verbatim as /api/health's ai.lengthArgs.
	if (!InConfig.LengthArguments.IsEmpty())
	{
		Arguments += TEXT(" ") + InConfig.LengthArguments;
	}
	return Arguments;
}

FString FLocHubServiceProcess::BuildLengthArguments(const ULocHubSettings& InSettings)
{
	if (!InSettings.bEnableLengthCheck)
	{
		return LocHubServiceProcessPrivate::LengthCheckOffArguments;
	}

	// Two decimals: the precision the service applies a ratio with (Service/src/lengthCheck.ts lengthLimitFor), and the form
	// its lengthArgsOf writes the flags back in, so the /api/health comparison matches character for character.
	FString Arguments = FString::Printf(TEXT("--length-check %s --length-scope %s --length-ratio %.2f --length-extra %d"),
		*ULocHubSettings::LengthSeverityToString(InSettings.LengthSeverity),
		*ULocHubSettings::LengthScopeToString(InSettings.LengthCheckScope),
		FMath::Clamp(InSettings.MaxLengthRatio, 1.0f, 5.0f),
		FMath::Clamp(InSettings.ExtraCharacters, 0, 100));

	TArray<TPair<FString, float>> Overrides;
	TSet<FString> Seen;
	for (const TPair<FString, float>& Override : InSettings.CultureRatioOverrides)
	{
		const FString Culture = Override.Key.TrimStartAndEnd();
		if (Culture.IsEmpty())
		{
			// A row just added in Project Settings and not named yet: nothing to apply, nothing to warn about.
			continue;
		}
		// "serve" refuses a key it cannot read (cli.ts), which would stop the service from starting at all: skip it instead.
		if (!LocHubServiceProcessPrivate::IsLengthCultureKey(Culture) || Seen.Contains(Culture))
		{
			UE_LOG(LogLocHub, Warning, TEXT("Length Check: skipping the culture ratio override \"%s\": use a culture or language code such as de or pt-BR, listed once."), *Override.Key);
			continue;
		}
		Seen.Add(Culture);
		Overrides.Emplace(Culture, FMath::Clamp(Override.Value, 1.0f, 5.0f));
	}
	if (Overrides.Num() > 0)
	{
		Overrides.Sort([](const TPair<FString, float>& InA, const TPair<FString, float>& InB) { return InA.Key < InB.Key; });
		TArray<FString> Pairs;
		for (const TPair<FString, float>& Override : Overrides)
		{
			Pairs.Add(FString::Printf(TEXT("%s=%.2f"), *Override.Key, Override.Value));
		}
		Arguments += TEXT(" --length-ratios ") + FString::Join(Pairs, TEXT(","));
	}
	Arguments += InSettings.bTellTranslator ? TEXT(" --length-hint on") : TEXT(" --length-hint off");
	return Arguments;
}

FString FLocHubServiceProcess::HashBriefUtf8(const FString& InText)
{
	const FTCHARToUTF8 Utf8(*InText);
	uint8 Digest[FSHA1::DigestSize];
	FSHA1::HashBuffer(Utf8.Get(), Utf8.Length(), Digest);
	return BytesToHexLower(Digest, FSHA1::DigestSize);
}

FString FLocHubServiceProcess::ComputeKeyId(const FString& InKey)
{
	// Same rule as an absent key on the service side (key-contract.md §3): empty in, empty out, never SHA-1("").
	return InKey.IsEmpty() ? FString() : HashBriefUtf8(InKey).Left(12);
}

FString FLocHubServiceProcess::ComputeCustomSettingsId(const FConfig& InConfig)
{
	const TArray<FString> Values = {
		InConfig.CustomBaseUrl,
		InConfig.CustomKeyHeader,
		InConfig.CustomStructuredOutput,
		InConfig.CustomPriceIn,
		InConfig.CustomPriceOut,
		FString::FromInt(InConfig.CustomMaxParallel),
		FString::FromInt(InConfig.CustomRequestTimeoutSeconds)};
	return HashBriefUtf8(FString::Join(Values, TEXT("\n"))).Left(12);
}

FString FLocHubServiceProcess::ReduceBaseUrl(const FString& InUrl)
{
	const int32 SchemeEnd = InUrl.Find(TEXT("://"), ESearchCase::CaseSensitive);
	if (SchemeEnd == INDEX_NONE)
	{
		return FString();
	}
	// Everything before "://" is shown as is, so it has to be the scheme itself: the restart line logs this before
	// DescribeConfigProblem runs, and a pasted "user:password@" or header in front of the scheme would reach it.
	const FString Scheme = InUrl.Left(SchemeEnd);
	if (!Scheme.Equals(TEXT("http"), ESearchCase::IgnoreCase) && !Scheme.Equals(TEXT("https"), ESearchCase::IgnoreCase))
	{
		return FString();
	}
	const int32 AuthorityStart = SchemeEnd + 3;
	int32 AuthorityEnd = InUrl.Len();
	for (int32 Index = AuthorityStart; Index < InUrl.Len(); ++Index)
	{
		const TCHAR Char = InUrl[Index];
		// '\' ends the authority too: WHATWG URL parsing treats it as '/' for http and https.
		if (Char == TEXT('/') || Char == TEXT('?') || Char == TEXT('#') || Char == TEXT('\\'))
		{
			AuthorityEnd = Index;
			break;
		}
	}
	// An '@' past the authority may close user info whose raw password holds one of the characters above, which
	// ended the authority early: show no host at all rather than the start of a password.
	if (InUrl.Find(TEXT("@"), ESearchCase::CaseSensitive, ESearchDir::FromStart, AuthorityEnd) != INDEX_NONE)
	{
		return FString();
	}
	FString Authority = InUrl.Mid(AuthorityStart, AuthorityEnd - AuthorityStart);
	// User info ("user:password@") never leaves this function.
	int32 AtIndex = INDEX_NONE;
	if (Authority.FindLastChar(TEXT('@'), AtIndex))
	{
		Authority = Authority.RightChop(AtIndex + 1);
	}
	// Whitelist, not another special case: only a host of this shape, optionally followed by ':' and 1-5 digits no
	// greater than 65535, ever leaves this function. Anything else -- a '%' (an escaped '@' among them), a
	// non-digit port, a port above 65535, a second ':', an empty host, a space or non-ASCII -- reduces to empty, so
	// nothing of it is ever shown. This guarantees only that whatever leaves here is scheme://host[:port] of
	// exactly this shape -- it does not close every raw '/', '?', '#' or '\' in a password ahead of a "%40" (M-3):
	// when the text before that delimiter happens to be 1-5 digits no greater than 65535
	// (https://svc:2024/Secret%40api.example.com/v1), those digits parse as a port and "svc:2024" reduces through.
	// By URL semantics that really is the host and port, so the rule this function exists for -- never more than
	// scheme://host[:port] leaves it -- still holds; see LocHub.CustomEndpoint.ReduceBaseUrl's digit-only password
	// prefix case.
	int32 HostEnd = 0;
	if (Authority.StartsWith(TEXT("["), ESearchCase::CaseSensitive))
	{
		// A bracketed IPv6 literal: '[', hex digits, ':' or '.', then ']'.
		int32 BracketEnd = INDEX_NONE;
		for (int32 Index = 1; Index < Authority.Len(); ++Index)
		{
			const TCHAR Char = Authority[Index];
			if (Char == TEXT(']'))
			{
				BracketEnd = Index;
				break;
			}
			const bool bHex = (Char >= TEXT('0') && Char <= TEXT('9')) || (Char >= TEXT('a') && Char <= TEXT('f')) || (Char >= TEXT('A') && Char <= TEXT('F'));
			if (!bHex && Char != TEXT(':') && Char != TEXT('.'))
			{
				return FString();
			}
		}
		if (BracketEnd <= 1)
		{
			// No closing ']', or an empty "[]".
			return FString();
		}
		HostEnd = BracketEnd + 1;
	}
	else
	{
		for (; HostEnd < Authority.Len(); ++HostEnd)
		{
			const TCHAR Char = Authority[HostEnd];
			const bool bLetter = (Char >= TEXT('a') && Char <= TEXT('z')) || (Char >= TEXT('A') && Char <= TEXT('Z'));
			const bool bDigit = Char >= TEXT('0') && Char <= TEXT('9');
			if (!bLetter && !bDigit && Char != TEXT('.') && Char != TEXT('-') && Char != TEXT('_'))
			{
				break;
			}
		}
		if (HostEnd == 0)
		{
			// No host at all.
			return FString();
		}
	}
	if (HostEnd == Authority.Len())
	{
		return InUrl.Left(AuthorityStart) + Authority;
	}
	if (Authority[HostEnd] != TEXT(':'))
	{
		// Trailing bytes after the host that are not a port separator.
		return FString();
	}
	const int32 PortLen = Authority.Len() - HostEnd - 1;
	if (PortLen < 1 || PortLen > 5)
	{
		return FString();
	}
	for (int32 Index = HostEnd + 1; Index < Authority.Len(); ++Index)
	{
		if (Authority[Index] < TEXT('0') || Authority[Index] > TEXT('9'))
		{
			return FString();
		}
	}
	// A port above 65535 (M-2) cannot be a real TCP port: DescribeConfigProblem refuses these too, by way of an
	// empty reduction giving it no acceptable host.
	if (FCString::Atoi(*Authority.RightChop(HostEnd + 1)) > 65535)
	{
		return FString();
	}
	return InUrl.Left(AuthorityStart) + Authority;
}

FString FLocHubServiceProcess::DescribeAiConfig(const FString& InProvider, const FString& InAuth, const FString& InEndpoint, const FString& InTranslateModel, const FString& InJudgeModel)
{
	const FString Reduced = ReduceBaseUrl(InEndpoint);
	const FString Endpoint = Reduced.IsEmpty() ? FString() : Reduced + TEXT(" ");
	return FString::Printf(TEXT("%s/%s %s%s/%s"), *InProvider, *InAuth, *Endpoint, *InTranslateModel, *InJudgeModel);
}

FString FLocHubServiceProcess::DescribeConfigProblem(const FConfig& InConfig)
{
	if (!InConfig.Provider.Equals(TEXT("custom"), ESearchCase::CaseSensitive))
	{
		return FString();
	}
	const FString& Url = InConfig.CustomBaseUrl;
	const bool bHttpScheme = Url.StartsWith(TEXT("http://"), ESearchCase::IgnoreCase) || Url.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase);
	const FString Reduced = ReduceBaseUrl(Url);
	// Any '@' is user info or cannot be told apart from it (a raw password may hold '/', '?' or '#'), and so is a
	// "%40" that leaves ReduceBaseUrl no host to show: the user-info '@' written escaped. Either would put a password
	// on the serve line, and the service's fetch refuses such a URL anyway; a real '@' in the path or query can be
	// written %40.
	if (bHttpScheme && (Url.Contains(TEXT("@"), ESearchCase::CaseSensitive)
		|| (Reduced.IsEmpty() && Url.Contains(TEXT("%40"), ESearchCase::CaseSensitive))))
	{
		return TEXT("Remove the user name and password from Base URL in Project Settings > Plugins > LocHub > AI; ")
			TEXT("put the key in API Key instead. A literal '@' in the path or query must be written as %40.");
	}
	if (!bHttpScheme)
	{
		// A wrong or missing scheme: distinct from "has a scheme but no acceptable host" below (M-2), so the
		// message points at the right half of the URL.
		return TEXT("Set Base URL in Project Settings > Plugins > LocHub > AI; it must start with http:// or https://.");
	}
	// ReduceBaseUrl keeps "scheme://" plus a host of the shape it accepts (including a port up to 65535) and
	// returns empty otherwise (":port" alone included), so a reduced form no longer than its "scheme://" has no
	// acceptable host.
	const bool bHasHost = Reduced.Len() > Url.Find(TEXT("://"), ESearchCase::CaseSensitive) + 3;
	if (!bHasHost)
	{
		return TEXT("Set Base URL in Project Settings > Plugins > LocHub > AI to an http:// or https:// URL with a ")
			TEXT("host name or IP address, such as http://localhost:11434/v1.");
	}
	if (InConfig.TranslateModel.IsEmpty())
	{
		return TEXT("Set Custom Models > Translate Model in Project Settings > Plugins > LocHub > AI.");
	}
	return FString();
}

FString FLocHubServiceProcess::WriteBriefFile(const FString& InPath, const FString& InBrief)
{
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(InPath), true);
	if (!FFileHelper::SaveStringToFile(InBrief, *InPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
	{
		// The path only: the brief is project text and never goes to a log line.
		UE_LOG(LogLocHub, Error, TEXT("Cannot write the LocHub project brief to %s."), *InPath);
		return FString();
	}
	return HashBriefUtf8(InBrief);
}

FString FLocHubServiceProcess::GetBaseUrl() const
{
	return FString::Printf(TEXT("http://127.0.0.1:%d"), Config.Port);
}

const FLocHubServiceProcess::FConfig& FLocHubServiceProcess::GetConfig() const
{
	return Config;
}

void FLocHubServiceProcess::SetConfig(FConfig InConfig)
{
	// Case-sensitive like IsAiConfigApplied: FString's != ignores case, so a case-only model fix would not re-arm the
	// one restart attempt and the mismatch would stay forever. Every field IsAiConfigApplied compares re-arms it, the
	// brief hash and key id included: otherwise a brief or key edit after an earlier AI restart would neither restart
	// nor wait for the job. Compared by KeyId, never by ApiKey itself, so the key never needs to reach this log-free path.
	const bool bAiConfigChanged = !Config.Provider.Equals(InConfig.Provider, ESearchCase::CaseSensitive)
		|| !Config.Auth.Equals(InConfig.Auth, ESearchCase::CaseSensitive)
		|| !Config.TranslateModel.Equals(InConfig.TranslateModel, ESearchCase::CaseSensitive)
		|| !Config.JudgeModel.Equals(InConfig.JudgeModel, ESearchCase::CaseSensitive)
		|| !Config.KeyId.Equals(InConfig.KeyId, ESearchCase::CaseSensitive)
		|| !Config.BriefSha1.Equals(InConfig.BriefSha1, ESearchCase::CaseSensitive)
		|| !Config.CustomSettingsId.Equals(InConfig.CustomSettingsId, ESearchCase::CaseSensitive)
		|| !Config.LengthArguments.Equals(InConfig.LengthArguments, ESearchCase::CaseSensitive);
	if (bAiConfigChanged)
	{
		bAiRestartTried = false;
	}
	if (Config.Port != InConfig.Port)
	{
		// The owned process keeps the old port until a restart actually runs; a pending AI restart's ticker would
		// otherwise keep polling the new port forever and never find the process it was waiting to restart.
		ClearAiRestartPending();
	}
	Config = MoveTemp(InConfig);
}

bool FLocHubServiceProcess::IsAiConfigApplied(const FConfig& InConfig, const FLocHubHealth& InHealth)
{
	if (InHealth.AiProvider.IsEmpty())
	{
		// No "ai" object at all (an old build): nothing to compare.
		return true;
	}
	if (!InConfig.Provider.Equals(InHealth.AiProvider, ESearchCase::CaseSensitive)
		|| !InConfig.Auth.Equals(InHealth.AiAuth, ESearchCase::CaseSensitive))
	{
		return false;
	}
	const bool bTranslateModelApplied = InConfig.TranslateModel.IsEmpty()
		|| InConfig.TranslateModel.Equals(InHealth.AiTranslateModel, ESearchCase::CaseSensitive);
	const bool bJudgeModelApplied = InConfig.JudgeModel.IsEmpty()
		|| InConfig.JudgeModel.Equals(InHealth.AiJudgeModel, ESearchCase::CaseSensitive);
	// An old service build reports no briefSha1 at all -- nothing to compare, same rule as the empty-provider
	// case above but scoped to just this field, since the rest of "ai" is already present and matching. An empty
	// config hash means brief.md could not be written (WriteBriefFile): nothing to compare either, or every probe
	// would restart the service over a file the editor cannot write.
	const bool bBriefApplied = InHealth.AiBriefSha1.IsEmpty()
		|| InConfig.BriefSha1.IsEmpty()
		|| InConfig.BriefSha1.Equals(InHealth.AiBriefSha1, ESearchCase::CaseSensitive);
	// Unlike the brief hash, an empty key id is a real, comparable value (no key configured), not a stand-in for
	// "nothing to compare" -- only the field being absent altogether (an old service build) skips the comparison;
	// "both empty" then falls out of the ordinary string equality below (key-contract.md §3).
	const bool bKeyApplied = !InHealth.bHasAiKeyId
		|| InConfig.KeyId.Equals(InHealth.AiKeyId, ESearchCase::CaseSensitive);
	// The service reports customSettingsId only for the Custom provider (an older service never): absent means
	// nothing to compare -- a provider switch already differs in provider and models above.
	const bool bCustomApplied = !InHealth.bHasAiCustomSettingsId || InConfig.CustomSettingsId.Equals(InHealth.AiCustomSettingsId, ESearchCase::CaseSensitive);
	// Like the key id, only an old service build without the field skips the comparison.
	const bool bLengthApplied = !InHealth.bHasAiLengthArgs
		|| LocHubServiceProcessPrivate::ExpectedLengthArgs(InConfig).Equals(InHealth.AiLengthArgs, ESearchCase::CaseSensitive);
	return bTranslateModelApplied && bJudgeModelApplied && bBriefApplied && bKeyApplied && bCustomApplied && bLengthApplied;
}

bool FLocHubServiceProcess::MayStopAdoptedPid(const FString& InAdoptedExecutable, const FString& InCurrentExecutable)
{
	return InAdoptedExecutable.IsEmpty()
		|| (!InCurrentExecutable.IsEmpty() && InAdoptedExecutable.Equals(InCurrentExecutable, ESearchCase::CaseSensitive));
}

void FLocHubServiceProcess::EnsureRunning(FOnReady InOnReady)
{
	Waiters.Add(MoveTemp(InOnReady));
	// This caller needs a service: a probe-only probe it joins must start one when nothing answers.
	bProbeOnlyRequested = false;
	if (bProbing || bStarting)
	{
		return;
	}
	ProbeHealth();
}

void FLocHubServiceProcess::ProbeOnly(FOnReady InOnReady)
{
	Waiters.Add(MoveTemp(InOnReady));
	if (bProbing || bStarting)
	{
		// Join unnarrowed: the answer in flight runs the same AI check against the Config just set.
		return;
	}
	bProbeOnlyRequested = true;
	ProbeHealth();
}

void FLocHubServiceProcess::Restart(FOnReady InOnReady)
{
	Stop();
	// The probe that EnsureRunning triggers below must restart a service it owns or adopts, even when its data is
	// not stale -- otherwise Restart silently keeps an already-running orphan of an old build.
	bRestartRequested = true;
	// Wrap the caller's callback: a healthy answer we still do not own after the attempt above means Restart found
	// someone else's already-running service rather than restarting anything.
	const TWeakPtr<FLocHubServiceProcess> WeakSelf = AsWeak();
	// The port this restart probes; a settings change during the async probe must not rename it in the message.
	const int32 RestartPort = Config.Port;
	EnsureRunning([WeakSelf, RestartPort, OnReady = MoveTemp(InOnReady)](const bool bOk, const FString& InError)
	{
		const TSharedPtr<FLocHubServiceProcess> This = WeakSelf.Pin();
		if (bOk && This.IsValid() && !This->IsOwnedProcessRunning())
		{
			if (OnReady)
			{
				OnReady(false, FString::Printf(TEXT("The LocHub service on port %d was not started by this editor; restart it where it runs."), RestartPort));
			}
			return;
		}
		if (OnReady)
		{
			OnReady(bOk, InError);
		}
	});
}

void FLocHubServiceProcess::Stop()
{
	// Bump first: a probe already in flight must find itself stale and leave bProbing alone when it answers.
	++ProbeGeneration;
	bProbing = false;
	// A probe-only probe still in flight is about to be dropped by the generation bump above without ever reaching
	// OnHealthProbed's own reset: clear it here too, or a Restart's own probe right after would misread it as its own.
	bProbeOnlyRequested = false;
	ClearAiRestartPending();
	StopProcess();
	FinishWaiters(false, TEXT("The LocHub service was stopped."));
}

bool FLocHubServiceProcess::IsOwnedProcessRunning() const
{
	return ProcessHandle.IsValid() && FPlatformProcess::IsProcRunning(ProcessHandle);
}

FString FLocHubServiceProcess::GetLogFilePath() const
{
	return Config.StateDir / TEXT("service.log");
}

FString FLocHubServiceProcess::GetPidFilePath() const
{
	return Config.StateDir / TEXT("service.pid");
}

int32 FLocHubServiceProcess::GetTerminatedProcessCount() const
{
	return TerminatedProcessCount;
}

bool FLocHubServiceProcess::IsAiRestartPending() const
{
	return bAiRestartPending;
}

bool FLocHubServiceProcess::IsAiRestartTried() const
{
	return bAiRestartTried;
}

void FLocHubServiceProcess::ProbeHealth()
{
	bProbing = true;
	const uint32 Generation = ProbeGeneration;
	const TWeakPtr<FLocHubServiceProcess> WeakSelf = AsWeak();
	FLocHubServiceClient(GetBaseUrl()).GetHealth([WeakSelf, Generation](const FLocHubHttpResult& InResult)
	{
		const TSharedPtr<FLocHubServiceProcess> This = WeakSelf.Pin();
		if (!This.IsValid())
		{
			return;
		}
		FLocHubHealth Health;
		const bool bParsed = FLocHubServiceClient::ParseHealth(InResult.Body, Health);
		const bool bHealthy = InResult.IsOk() && bParsed && Health.bOk;
		This->OnHealthProbed(Generation, Health, bHealthy);
	});
}

void FLocHubServiceProcess::OnHealthProbed(const uint32 InGeneration, const FLocHubHealth& InHealth, const bool bHealthy)
{
	if (InGeneration != ProbeGeneration)
	{
		// Stop()/Restart() moved on while this probe was in flight: a newer probe, or nobody, owns
		// bProbing and Waiters now -- do not touch either.
		return;
	}
	bProbing = false;
	// Captured once per probe, whatever the outcome: a restart that lands on a service already answering healthy
	// must act in this same call; a restart that has to start a fresh node consumes the flag on this
	// first, unhealthy probe, but by the time the fresh process answers it is ours anyway (bAnswerIsOurs below).
	const bool bFromRestart = bRestartRequested;
	bRestartRequested = false;
	const bool bProbeOnly = bProbeOnlyRequested;
	bProbeOnlyRequested = false;

	if (!bHealthy)
	{
		if (bStarting || Waiters.IsEmpty())
		{
			// While starting, the ticker probes again until the deadline.
			return;
		}
		if (IsOwnedProcessRunning())
		{
			FinishWaiters(false, FString::Printf(TEXT("The LocHub service runs but does not answer %s/api/health. Use Tools > LocHub > Restart Service. Log: %s"), *GetBaseUrl(), *GetLogFilePath()));
			return;
		}
		if (bProbeOnly)
		{
			// Nothing runs, so nothing has settings to apply; the next start reads the current Config.
			FinishWaiters(true, FString());
			return;
		}
		if (!Config.bAutoStart)
		{
			FinishWaiters(false, FString::Printf(TEXT("The LocHub service is not running on %s and auto start is off (Project Settings > Plugins > LocHub)."), *GetBaseUrl()));
			return;
		}
		StartOrFail();
		return;
	}

	if (InHealth.Pid == 0 || InHealth.ProjectDir.IsEmpty())
	{
		// An old dist/ build that does not report its identity: never usable, whether it is ours or not. It
		// cannot be adopted (no confirmed pid) or stopped from here, so name the pid service.pid still has, if any,
		// and the exact action that clears it.
		bStarting = false;
		FString PidFileText;
		const uint32 OutdatedPid = FFileHelper::LoadFileToString(PidFileText, *GetPidFilePath())
			? LocHubServiceProcessPrivate::ParseLeadingPid(PidFileText)
			: 0;
		const FString Message = OutdatedPid != 0
			? FString::Printf(TEXT("The service on port %d does not report its project (an outdated LocHub service). End node.exe pid %u (named by Saved/LocHub/service.pid) or restart it where it runs."), Config.Port, OutdatedPid)
			: FString::Printf(TEXT("The service on port %d does not report its project (an outdated LocHub service). Restart it where it runs."), Config.Port);
		FinishWaiters(false, Message);
		return;
	}

	if (!FLocHubServiceClient::IsSameProjectDir(InHealth.ProjectDir, Config.ProjectDir))
	{
		bStarting = false;
		FinishWaiters(false, FString::Printf(TEXT("Port %d is used by the LocHub service of %s; set another Service Port in Project Settings > Plugins > LocHub."), Config.Port, *FLocHubServiceClient::NormalizeProjectDir(InHealth.ProjectDir)));
		return;
	}

	// An adopted process has no ticker watching it, so its death is only noticed here, before it can be mistaken
	// for "ours" below just because the handle is still valid.
	if (ProcessHandle.IsValid() && !bStarting && !IsOwnedProcessRunning())
	{
		StopProcess();
	}

	if (!ProcessHandle.IsValid())
	{
		TryAdoptOrphan(InHealth.Pid);
	}

	// "Ours" is decided by the pid the health answer actually reports, not by handle validity alone -- a foreign
	// service can answer while our own start is still in flight.
	const bool bAnswerIsOurs = ProcessHandle.IsValid() && InHealth.Pid == ProcessId;

	if (InHealth.bStale || (bFromRestart && bAnswerIsOurs))
	{
		if (bAnswerIsOurs)
		{
			// Owned (started or just adopted): restart it in place so it reloads Localization/LocHub, or -- for a
			// plain Restart request -- so it picks up new code and settings even when its data is not stale.
			// Waiters are kept; they get their answer once the fresh process reports healthy.
			UE_LOG(LogLocHub, Display, TEXT("Restarting the LocHub service (pid %u)%s."), ProcessId,
				InHealth.bStale ? TEXT(", its data is older than Localization/LocHub on disk") : TEXT(""));
			// The fresh process picks up the current Config (AI settings included), so a deferred AI restart has
			// nothing left to wait for.
			ClearAiRestartPending();
			StopProcess();
			StartOrFail();
			return;
		}
		bStarting = false;
		FinishWaiters(false, FString::Printf(TEXT("The LocHub service on port %d holds data older than Localization/LocHub on disk (a source control sync?). Restart that service, then try again."), Config.Port));
		return;
	}

	if (!IsAiConfigApplied(Config, InHealth))
	{
		if (bAnswerIsOurs)
		{
			// Named separately from DescribeAiConfig: the brief text and the key itself must never reach a log
			// line, only whether either changed.
			const bool bBriefChanged = !Config.BriefSha1.Equals(InHealth.AiBriefSha1, ESearchCase::CaseSensitive);
			const bool bKeyChanged = InHealth.bHasAiKeyId && !Config.KeyId.Equals(InHealth.AiKeyId, ESearchCase::CaseSensitive);
			const bool bCustomChanged = InHealth.bHasAiCustomSettingsId && !Config.CustomSettingsId.Equals(InHealth.AiCustomSettingsId, ESearchCase::CaseSensitive);
			const bool bLengthChanged = InHealth.bHasAiLengthArgs
				&& !LocHubServiceProcessPrivate::ExpectedLengthArgs(Config).Equals(InHealth.AiLengthArgs, ESearchCase::CaseSensitive);
			const FString BriefNote = FString(bBriefChanged ? TEXT(", brief changed") : TEXT(""))
				+ (bKeyChanged ? TEXT(", key changed") : TEXT(""))
				+ (bCustomChanged ? TEXT(", custom endpoint settings changed") : TEXT(""))
				+ (bLengthChanged ? TEXT(", length check changed") : TEXT(""));
			if (!InHealth.bJobRunning && !bAiRestartTried)
			{
				bAiRestartTried = true;
				// Whatever wait was pending is over: this restart applies the new AI settings right now.
				ClearAiRestartPending();
				UE_LOG(LogLocHub, Display, TEXT("Restarting the LocHub service (pid %u): AI settings changed (%s -> %s)%s."), ProcessId,
					*DescribeAiConfig(InHealth.AiProvider, InHealth.AiAuth, InHealth.AiEndpointUrl, InHealth.AiTranslateModel, InHealth.AiJudgeModel),
					*DescribeAiConfig(Config.Provider, Config.Auth, Config.CustomBaseUrl, Config.TranslateModel, Config.JudgeModel), *BriefNote);
				StopProcess();
				StartOrFail();
				return;
			}
			bStarting = false;
			if (InHealth.bJobRunning && !bAiRestartTried)
			{
				if (!bAiRestartPending)
				{
					// First deferral for this mismatch: arm the re-probe ticker so the restart happens as soon as
					// the job ends, without waiting for the next Open LocHub, Push, Pull or Restart Service.
					bAiRestartPending = true;
					StartAiRestartPendingTicker();
					FLocHubEditorModule::Notify(TEXT("LocHub: AI settings apply when the running translation job finishes."), true);
					UE_LOG(LogLocHub, Display, TEXT("LocHub AI settings changed; they apply when the running translation job finishes."));
				}
			}
			else
			{
				// Already tried once for this Config and the fresh process still disagrees: never loop restarting.
				ClearAiRestartPending();
				UE_LOG(LogLocHub, Warning, TEXT("The LocHub service (pid %u) still reports AI settings %s after a restart; Project Settings now ask for %s%s. Use Tools > LocHub > Restart Service."), ProcessId,
					*DescribeAiConfig(InHealth.AiProvider, InHealth.AiAuth, InHealth.AiEndpointUrl, InHealth.AiTranslateModel, InHealth.AiJudgeModel),
					*DescribeAiConfig(Config.Provider, Config.Auth, Config.CustomBaseUrl, Config.TranslateModel, Config.JudgeModel), *BriefNote);
			}
			FinishWaiters(true, FString());
			return;
		}
		bStarting = false;
		UE_LOG(LogLocHub, Warning, TEXT("The LocHub service on port %d runs with other AI settings and was not started by this editor; restart it where it runs."), Config.Port);
		FinishWaiters(true, FString());
		return;
	}

	bStarting = false;
	// Settings now match what the owned process reports: any deferred restart wait is resolved.
	ClearAiRestartPending();
	FinishWaiters(true, FString());
}

void FLocHubServiceProcess::StartOrFail()
{
	// A dead owned/adopted handle reaching here (e.g. an adopted process that died with no ticker to notice) would
	// otherwise be silently overwritten by StartNode's CreateProc, leaking the old OS handle.
	if (ProcessHandle.IsValid() && !IsOwnedProcessRunning())
	{
		StopProcess();
	}

	FString StartError;
	if (!StartNode(StartError))
	{
		bStarting = false;
		FinishWaiters(false, StartError);
		return;
	}
	bStarting = true;
	StartDeadline = FPlatformTime::Seconds() + LocHubServiceProcessPrivate::StartTimeoutSeconds;
}

bool FLocHubServiceProcess::StartNode(FString& OutError)
{
	// Health did not answer: whatever service.pid names is not confirmed alive by anyone, so it is only ever
	// removed here, never killed on its say-so alone.
	RemoveStalePidFile();

	// Settings that can never start the service fail here, with a fix the user can act on, before Node.js is even
	// looked for: the service would only exit with a usage error nobody sees.
	const FString ConfigProblem = DescribeConfigProblem(Config);
	if (!ConfigProblem.IsEmpty())
	{
		OutError = ConfigProblem;
		return false;
	}

	// Every tool launch reaches this same classification -- there is no separate check at editor startup any more.
	const FLocHubNodeCheck NodeCheck = LocHubEnvironment::CheckNode();
	if (NodeCheck.Status != ELocHubNodeStatus::Ok)
	{
		OutError = LocHubEnvironment::DescribeNodeProblem(NodeCheck);
		if (OnNodeProblemFn)
		{
			OnNodeProblemFn(NodeCheck);
		}
		return false;
	}
	const FString& Node = NodeCheck.Path;

	if (!FPaths::FileExists(Config.ServiceScript))
	{
		OutError = FString::Printf(TEXT("The LocHub service script is missing: %s. Reinstall the plugin; in the source repository run 'npm run build' in Service/."), *Config.ServiceScript);
		return false;
	}

	IFileManager::Get().MakeDirectory(*Config.StateDir, true);
	if (!FPlatformProcess::CreatePipe(PipeRead, PipeWrite))
	{
		OutError = TEXT("Could not create a pipe for the LocHub service output.");
		return false;
	}

	const FString Arguments = BuildServeArguments(Config);
	// Unlike the key, the Custom base URL used to reach this line too (as --base-url) and had to be redacted before
	// it could be logged. It travels only through LOCHUB_CUSTOM_BASE_URL now (I-1), so Arguments never carries it
	// and is always safe to log, spawn-fail error or write to service.log exactly as built.
	uint32 NewProcessId = 0;
	{
		// LocHubProcessSpawnLock held for the whole section: without it, a concurrent CreateProc elsewhere in the
		// process (LocHubEnvironment::RunBoundedProcess, or any other holder listed in LocHubProcessSpawnLock.h)
		// could inherit LOCHUB_API_KEY or LOCHUB_CUSTOM_BASE_URL on Windows (CreateProcess snapshots the
		// environment at the moment it is called) or race this SetEnvironmentVar/CreateProc/SetEnvironmentVar
		// sequence on Mac/Linux (setenv/unsetenv concurrent with posix_spawn is a data race in the C library, not
		// just a logical one).
		FScopeLock SpawnLock(&LocHubProcessSpawnLock::Get());
		// Scoped tightly around the spawn: CreateProc snapshots the editor's environment for the child at this
		// point, and each destructor below restores the editor's own value (or clears it) before anything else
		// runs, so no later child this editor starts -- and no log line, since neither is ever printed -- ever
		// sees either.
		const FLocHubScopedEnvVar ApiKeyEnvVar(ApiKeyEnvVarName, Config.ApiKey);
		const FLocHubScopedEnvVar BaseUrlEnvVar(BaseUrlEnvVarName, Config.CustomBaseUrl);
		ProcessHandle = CreateProcessFn(Node, Arguments, Config.ProjectDir, PipeWrite, NewProcessId);
	}
	if (!ProcessHandle.IsValid())
	{
		FPlatformProcess::ClosePipe(PipeRead, PipeWrite);
		PipeRead = nullptr;
		PipeWrite = nullptr;
		OutError = FString::Printf(TEXT("Could not start %s %s"), *Node, *Arguments);
		return false;
	}
	ProcessId = NewProcessId;

	// "<nodePid> <hostPid>": the host pid lets another host of this project tell a live owner's service apart from
	// an orphan left by one that is gone, instead of adopting (and later killing) a service still in use.
	// A one-number file from an older build is still readable -- ParseLeadingPid/TryAdoptOrphan
	// treat a missing host as unknown and fall back to the pre-fix "adopt when the node pid matches" behaviour.
	FFileHelper::SaveStringToFile(FString::Printf(TEXT("%u %u"), ProcessId, FPlatformProcess::GetCurrentProcessId()), *GetPidFilePath());
	// The serve line no longer names a Custom endpoint (its Base URL travels in the environment), so the start line
	// does, reduced to scheme://host[:port] like everywhere else it is shown.
	const FString EndpointNote = Config.Provider.Equals(TEXT("custom"), ESearchCase::CaseSensitive)
		? FString::Printf(TEXT(" (endpoint %s)"), *ReduceBaseUrl(Config.CustomBaseUrl))
		: FString();
	FFileHelper::SaveStringToFile(FString::Printf(TEXT("[LocHub] %s %s%s\n"), *Node, *Arguments, *EndpointNote), *GetLogFilePath(), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
	UE_LOG(LogLocHub, Display, TEXT("Started the LocHub service (pid %u): %s %s%s"), ProcessId, *Node, *Arguments, *EndpointNote);

	const TWeakPtr<FLocHubServiceProcess> WeakSelf = AsWeak();
	TickerHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakSelf](const float InDeltaTime) -> bool
	{
		const TSharedPtr<FLocHubServiceProcess> This = WeakSelf.Pin();
		return This.IsValid() && This->OnTick(InDeltaTime);
	}), LocHubServiceProcessPrivate::TickIntervalSeconds);
	return true;
}

bool FLocHubServiceProcess::OnTick(const float InDeltaTime)
{
	DrainOutput();

	if (!IsOwnedProcessRunning())
	{
		int32 ReturnCode = 0;
		FPlatformProcess::GetProcReturnCode(ProcessHandle, &ReturnCode);
		UE_LOG(LogLocHub, Display, TEXT("The LocHub service (pid %u) exited with code %d."), ProcessId, ReturnCode);
		const bool bWasStarting = bStarting;
		// Returning false removes this ticker; StopProcess must not remove it a second time.
		TickerHandle.Reset();
		StopProcess();
		if (bWasStarting)
		{
			FinishWaiters(false, FString::Printf(TEXT("The LocHub service exited during start (code %d). Log: %s"), ReturnCode, *GetLogFilePath()));
		}
		return false;
	}

	if (bStarting && FPlatformTime::Seconds() > StartDeadline)
	{
		TickerHandle.Reset();
		StopProcess();
		FinishWaiters(false, FString::Printf(TEXT("The LocHub service did not answer %s/api/health within %.0f s. Log: %s"), *GetBaseUrl(), LocHubServiceProcessPrivate::StartTimeoutSeconds, *GetLogFilePath()));
		return false;
	}

	if (bStarting && !bProbing)
	{
		ProbeHealth();
	}
	return true;
}

void FLocHubServiceProcess::DrainOutput()
{
	if (PipeRead == nullptr)
	{
		return;
	}
	// Bytes rather than FPlatformProcess::ReadPipe, which on Linux reads at most 4 KB per call and decodes it as ANSI;
	// and on every platform a read can end inside a UTF-8 character, whose rest arrives with the next read.
	LocHubChildProcess::ReadAvailableBytes(PipeRead, PendingOutputBytes);
	const FString Output = LocHubChildProcess::ConsumeCompleteUtf8(PendingOutputBytes);
	if (!Output.IsEmpty())
	{
		FFileHelper::SaveStringToFile(Output, *GetLogFilePath(), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM, &IFileManager::Get(), FILEWRITE_Append);
	}
}

void FLocHubServiceProcess::StopProcess()
{
	if (TickerHandle.IsValid())
	{
		FTSTicker::RemoveTicker(TickerHandle);
		TickerHandle.Reset();
	}
	if (ProcessHandle.IsValid())
	{
		if (FPlatformProcess::IsProcRunning(ProcessHandle))
		{
			// An adopted process (Mac, Linux < 5.8: OpenProcess is a bare pid, no ticker watches it die) may have
			// died and had its pid reused by an unrelated process since TryAdoptOrphan captured AdoptedExecutable;
			// refuse to signal it rather than kill whatever now holds that pid (I-1).
			if (MayStopAdoptedPid(AdoptedExecutable, FPlatformProcess::GetApplicationName(ProcessId)))
			{
				UE_LOG(LogLocHub, Display, TEXT("Stopping the LocHub service (pid %u)."), ProcessId);
				TerminateProcessFn(ProcessHandle, ProcessId);
				// Counted by what the process did, not by the request: on Mac/Linux it can outlast the bounded wait, and a
				// test's TerminateProcessFn ends nothing at all.
				if (!FPlatformProcess::IsProcRunning(ProcessHandle))
				{
					++TerminatedProcessCount;
				}
			}
			else
			{
				UE_LOG(LogLocHub, Warning, TEXT("pid %u no longer runs the adopted LocHub service; it is not stopped."), ProcessId);
			}
		}
		FPlatformProcess::CloseProc(ProcessHandle);
		ProcessHandle = FProcHandle();
		IFileManager::Get().Delete(*GetPidFilePath());
	}
	ProcessId = 0;
	AdoptedExecutable.Reset();
	if (PipeRead != nullptr || PipeWrite != nullptr)
	{
		FPlatformProcess::ClosePipe(PipeRead, PipeWrite);
		PipeRead = nullptr;
		PipeWrite = nullptr;
	}
	PendingOutputBytes.Reset();
	bStarting = false;
}

void FLocHubServiceProcess::RemoveStalePidFile()
{
	FString PidText;
	if (!FFileHelper::LoadFileToString(PidText, *GetPidFilePath()))
	{
		return;
	}
	IFileManager::Get().Delete(*GetPidFilePath());

	const uint32 StalePid = LocHubServiceProcessPrivate::ParseLeadingPid(PidText);
	UE_LOG(LogLocHub, Display, TEXT("Removed a stale service.pid (pid %u) without stopping that process."), StalePid);
}

void FLocHubServiceProcess::TryAdoptOrphan(const uint32 InHealthPid)
{
	FString PidText;
	if (!FFileHelper::LoadFileToString(PidText, *GetPidFilePath()))
	{
		return;
	}
	// "<nodePid> <hostPid>"; a one-number file from an older build reads HostPid == 0 (unknown host,
	// same as pre-fix behaviour: adopt when the node pid matches).
	TArray<FString> Parts;
	PidText.ParseIntoArrayWS(Parts);
	uint32 FilePid = 0;
	uint32 HostPid = 0;
	if (Parts.Num() > 0)
	{
		LexFromString(FilePid, *Parts[0]);
	}
	if (Parts.Num() > 1)
	{
		LexFromString(HostPid, *Parts[1]);
	}
	if (FilePid == 0 || FilePid != InHealthPid)
	{
		// service.pid names someone else's process (or none the health answer confirms); use the service as is,
		// without owning it.
		return;
	}
	// A live editor or LocHubSync commandlet of this project still owns it: use it, never adopt it -- adopting
	// would terminate it under its owner when this host exits. A reused host pid only suppresses adoption (the
	// safe side); "this process" is always allowed to (re-)adopt its own service.
	if (HostPid != 0 && HostPid != FPlatformProcess::GetCurrentProcessId() && IsPidRunningFn(HostPid))
	{
		return;
	}

	FProcHandle Handle = FPlatformProcess::OpenProcess(FilePid);
	if (!Handle.IsValid())
	{
		return;
	}
	ProcessHandle = Handle;
	ProcessId = FilePid;
	// Captured now, while OpenProcess just confirmed this pid: on Mac and Linux < 5.8 the handle is a bare pid with
	// no ticker watching it die, so by the time StopProcess runs the pid may belong to an unrelated process (I-1).
	AdoptedExecutable = FPlatformProcess::GetApplicationName(FilePid);
	UE_LOG(LogLocHub, Display, TEXT("Adopted the LocHub service left by a previous session (pid %u)."), FilePid);
}

void FLocHubServiceProcess::FinishWaiters(const bool bOk, const FString& InError)
{
	// A callback may call EnsureRunning again; it lands in a fresh list.
	TArray<FOnReady> Finished = MoveTemp(Waiters);
	Waiters.Reset();
	for (FOnReady& Waiter : Finished)
	{
		if (Waiter)
		{
			Waiter(bOk, InError);
		}
	}
}

void FLocHubServiceProcess::StartAiRestartPendingTicker()
{
	if (AiRestartPendingTickerHandle.IsValid())
	{
		return;
	}
	const TWeakPtr<FLocHubServiceProcess> WeakSelf = AsWeak();
	AiRestartPendingTickerHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakSelf](const float) -> bool
	{
		const TSharedPtr<FLocHubServiceProcess> This = WeakSelf.Pin();
		if (!This.IsValid())
		{
			return false;
		}
		if (!This->bAiRestartPending || !This->IsOwnedProcessRunning())
		{
			// The process this wait was watching is gone, or the wait was already resolved elsewhere; returning
			// false removes this ticker, so reset the handle here rather than through ClearAiRestartPending (that
			// would remove a ticker still mid-tick).
			This->bAiRestartPending = false;
			This->AiRestartPendingTickerHandle.Reset();
			return false;
		}
		if (This->IsServiceInUseFn && This->IsServiceInUseFn())
		{
			// A Push or Pull is talking to the owned process directly, past EnsureRunning, with its own timeouts up
			// to 120 s: restarting it now would kill that request mid-flight. Wait for the next poll.
			return true;
		}
		This->EnsureRunning(FOnReady());
		return true;
	}), LocHubServiceProcessPrivate::AiRestartPendingPollSeconds);
}

void FLocHubServiceProcess::ClearAiRestartPending()
{
	bAiRestartPending = false;
	if (AiRestartPendingTickerHandle.IsValid())
	{
		FTSTicker::RemoveTicker(AiRestartPendingTickerHandle);
		AiRestartPendingTickerHandle.Reset();
	}
}
