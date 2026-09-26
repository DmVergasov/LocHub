// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/** Outcome of one HTTP call to the service. */
struct FLocHubHttpResult
{
	/** False when no HTTP response came back (nothing listens, timeout). */
	bool bConnected = false;
	int32 Code = 0;
	FString Body;

	bool IsOk() const;
	/** One line for a report: what failed and how. */
	FString Describe(const FString& InWhat) const;
};

/** Parsed GET /api/health body (fix E contract): identifies the service and reports data freshness. */
struct FLocHubHealth
{
	bool bOk = false;
	/** The service's own process id; 0 when the body does not report it (an old dist/ build). */
	uint32 Pid = 0;
	/** Absolute project folder the service was started with (Node's path.resolve); empty when not reported. */
	FString ProjectDir;
	/** True when Localization/LocHub changed on disk after the service loaded it. */
	bool bStale = false;
	/** Wire values of the optional "ai" object (ai.provider/auth/translateModel/judgeModel); empty when the body
	 *  has no "ai" object at all (an old dist/ build) or the individual field is absent. */
	FString AiProvider;
	FString AiAuth;
	FString AiTranslateModel;
	FString AiJudgeModel;
	/** Wire value of ai.briefSha1 (lowercase hex SHA-1 of the --brief-file file's raw bytes as read, before any BOM
	 *  strip); empty when absent -- no "ai" object at all, or an "ai" object from a build that predates this field. */
	FString AiBriefSha1;
	/** Wire value of ai.keyId (key-contract.md §3): first 12 lowercase hex characters of the SHA-1 of the active
	 *  provider's API key's UTF-8 bytes, or "" when the service has no key. Only meaningful when bHasAiKeyId is
	 *  true -- unlike AiBriefSha1, an explicitly empty value here is a real "no key" answer to compare, not a
	 *  stand-in for "field absent" (both-empty is a valid match, not something to skip; see IsAiConfigApplied). */
	FString AiKeyId;
	/** True when the "ai" object had a "keyId" field at all; false for an "ai" object from a build that predates
	 *  this field, the one case IsAiConfigApplied treats as "nothing to compare". */
	bool bHasAiKeyId = false;
	/** True while a translation job has status "running" (optional top-level "jobRunning"); false when absent. */
	bool bJobRunning = false;
};

/** JSON over HTTP to "lochub serve" (Service/CONTRACT.md); callbacks run on the game thread. */
class FLocHubServiceClient
{
public:
	using FOnResult = TFunction<void(const FLocHubHttpResult&)>;

	explicit FLocHubServiceClient(FString InBaseUrl);

	const FString& GetBaseUrl() const;
	void Send(const FString& InVerb, const FString& InPathAndQuery, const FString& InBody, float InTimeoutSeconds, FOnResult InOnResult) const;

	void GetHealth(FOnResult InOnResult) const;
	void Push(const FString& InSnapshotJson, bool bDryRun, FOnResult InOnResult) const;
	/** POST /api/reconcile: InBodyJson is exactly the "archives" object of a Push snapshot. */
	void Reconcile(const FString& InBodyJson, FOnResult InOnResult) const;
	void GetExport(const FString& InCulture, FOnResult InOnResult) const;
	void PostExportAck(const FString& InAckJson, FOnResult InOnResult) const;
	void GetAnsweredInbox(FOnResult InOnResult) const;
	void PostInboxApplied(const FString& InAppliedJson, FOnResult InOnResult) const;

	/** False when the body is not valid JSON or the mandatory "ok" field is missing. */
	static bool ParseHealth(const FString& InJson, FLocHubHealth& OutHealth);
	/** Absolute, forward-slashed, no trailing slash: the form a service's reported projectDir is compared in. */
	static FString NormalizeProjectDir(const FString& InPath);
	/** The one rule deciding whether a service belongs to this project (the process manager and the bridge share it):
	 *  FPaths::IsSamePath of both normalized paths, so case-insensitive on Windows only. */
	static bool IsSameProjectDir(const FString& InReportedDir, const FString& InThisProjectDir);

private:
	FString BaseUrl;
};
