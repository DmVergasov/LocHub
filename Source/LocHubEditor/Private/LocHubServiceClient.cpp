// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubServiceClient.h"

#include "Dom/JsonObject.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace LocHubServiceClientPrivate
{
	constexpr float HealthTimeoutSeconds = 3.0f;
	constexpr float PushTimeoutSeconds = 120.0f;
	constexpr float ExportTimeoutSeconds = 60.0f;
	constexpr float DefaultTimeoutSeconds = 30.0f;
	constexpr int32 MaxBodyInReport = 300;
}

bool FLocHubHttpResult::IsOk() const
{
	return bConnected && Code >= 200 && Code < 300;
}

FString FLocHubHttpResult::Describe(const FString& InWhat) const
{
	if (!bConnected)
	{
		return FString::Printf(TEXT("%s: no answer from the LocHub service."), *InWhat);
	}
	return FString::Printf(TEXT("%s: HTTP %d %s"), *InWhat, Code, *Body.Left(LocHubServiceClientPrivate::MaxBodyInReport));
}

FLocHubServiceClient::FLocHubServiceClient(FString InBaseUrl)
	: BaseUrl(MoveTemp(InBaseUrl))
{
}

const FString& FLocHubServiceClient::GetBaseUrl() const
{
	return BaseUrl;
}

void FLocHubServiceClient::Send(const FString& InVerb, const FString& InPathAndQuery, const FString& InBody, const float InTimeoutSeconds, FOnResult InOnResult) const
{
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(BaseUrl + InPathAndQuery);
	Request->SetVerb(InVerb);
	Request->SetTimeout(InTimeoutSeconds);
	Request->SetHeader(TEXT("Accept"), TEXT("application/json"));
	const bool bHasBody = InVerb.Equals(TEXT("POST"), ESearchCase::CaseSensitive) || InVerb.Equals(TEXT("PUT"), ESearchCase::CaseSensitive);
	if (bHasBody)
	{
		// The service answers 415 to any POST/PUT that is not JSON, an empty one included (contract).
		Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
		Request->SetContentAsString(InBody.IsEmpty() ? FString(TEXT("{}")) : InBody);
	}
	Request->OnProcessRequestComplete().BindLambda([OnResult = MoveTemp(InOnResult)](FHttpRequestPtr InRequest, FHttpResponsePtr InResponse, const bool bConnectedSuccessfully)
	{
		FLocHubHttpResult Result;
		Result.bConnected = bConnectedSuccessfully && InResponse.IsValid();
		if (InResponse.IsValid())
		{
			Result.Code = InResponse->GetResponseCode();
			Result.Body = InResponse->GetContentAsString();
		}
		if (OnResult)
		{
			OnResult(Result);
		}
	});
	Request->ProcessRequest();
}

void FLocHubServiceClient::GetHealth(FOnResult InOnResult) const
{
	Send(TEXT("GET"), TEXT("/api/health"), FString(), LocHubServiceClientPrivate::HealthTimeoutSeconds, MoveTemp(InOnResult));
}

void FLocHubServiceClient::Push(const FString& InSnapshotJson, const bool bDryRun, FOnResult InOnResult) const
{
	const TCHAR* Path = bDryRun ? TEXT("/api/push?dryRun=1") : TEXT("/api/push");
	Send(TEXT("POST"), Path, InSnapshotJson, LocHubServiceClientPrivate::PushTimeoutSeconds, MoveTemp(InOnResult));
}

void FLocHubServiceClient::Reconcile(const FString& InBodyJson, FOnResult InOnResult) const
{
	Send(TEXT("POST"), TEXT("/api/reconcile"), InBodyJson, LocHubServiceClientPrivate::DefaultTimeoutSeconds, MoveTemp(InOnResult));
}

void FLocHubServiceClient::GetExport(const FString& InCulture, FOnResult InOnResult) const
{
	const FString Path = TEXT("/api/export?culture=") + FGenericPlatformHttp::UrlEncode(InCulture);
	Send(TEXT("GET"), Path, FString(), LocHubServiceClientPrivate::ExportTimeoutSeconds, MoveTemp(InOnResult));
}

void FLocHubServiceClient::PostExportAck(const FString& InAckJson, FOnResult InOnResult) const
{
	Send(TEXT("POST"), TEXT("/api/export/ack"), InAckJson, LocHubServiceClientPrivate::DefaultTimeoutSeconds, MoveTemp(InOnResult));
}

void FLocHubServiceClient::GetAnsweredInbox(FOnResult InOnResult) const
{
	Send(TEXT("GET"), TEXT("/api/inbox?status=answered"), FString(), LocHubServiceClientPrivate::DefaultTimeoutSeconds, MoveTemp(InOnResult));
}

void FLocHubServiceClient::PostInboxApplied(const FString& InAppliedJson, FOnResult InOnResult) const
{
	Send(TEXT("POST"), TEXT("/api/inbox/applied"), InAppliedJson, LocHubServiceClientPrivate::DefaultTimeoutSeconds, MoveTemp(InOnResult));
}

bool FLocHubServiceClient::ParseHealth(const FString& InJson, FLocHubHealth& OutHealth)
{
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(InJson);
	TSharedPtr<FJsonObject> Root;
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	FLocHubHealth Health;
	if (!Root->TryGetBoolField(TEXT("ok"), Health.bOk))
	{
		return false;
	}
	Root->TryGetNumberField(TEXT("pid"), Health.Pid);
	Root->TryGetStringField(TEXT("projectDir"), Health.ProjectDir);
	Root->TryGetBoolField(TEXT("stale"), Health.bStale);
	Root->TryGetBoolField(TEXT("jobRunning"), Health.bJobRunning);

	const TSharedPtr<FJsonObject>* AiObject = nullptr;
	if (Root->TryGetObjectField(TEXT("ai"), AiObject) && AiObject != nullptr && AiObject->IsValid())
	{
		(*AiObject)->TryGetStringField(TEXT("provider"), Health.AiProvider);
		(*AiObject)->TryGetStringField(TEXT("auth"), Health.AiAuth);
		(*AiObject)->TryGetStringField(TEXT("translateModel"), Health.AiTranslateModel);
		(*AiObject)->TryGetStringField(TEXT("judgeModel"), Health.AiJudgeModel);
		(*AiObject)->TryGetStringField(TEXT("briefSha1"), Health.AiBriefSha1);
		Health.bHasAiKeyId = (*AiObject)->TryGetStringField(TEXT("keyId"), Health.AiKeyId);
		Health.bHasAiLengthArgs = (*AiObject)->TryGetStringField(TEXT("lengthArgs"), Health.AiLengthArgs);
		Health.bHasAiCustomSettingsId = (*AiObject)->TryGetStringField(TEXT("customSettingsId"), Health.AiCustomSettingsId);
		const TSharedPtr<FJsonObject>* EndpointObject = nullptr;
		if ((*AiObject)->TryGetObjectField(TEXT("endpoint"), EndpointObject) && EndpointObject != nullptr && EndpointObject->IsValid())
		{
			(*EndpointObject)->TryGetStringField(TEXT("url"), Health.AiEndpointUrl);
		}
	}
	OutHealth = MoveTemp(Health);
	return true;
}

FString FLocHubServiceClient::NormalizeProjectDir(const FString& InPath)
{
	FString Full = FPaths::ConvertRelativePathToFull(InPath);
	FPaths::NormalizeDirectoryName(Full);
	return Full;
}

bool FLocHubServiceClient::IsSameProjectDir(const FString& InReportedDir, const FString& InThisProjectDir)
{
	// FPaths::IsSamePath ignores case only on Windows, where a drive letter or folder may be reported in another case;
	// a Mac or Linux file system can hold two project folders whose names differ only in case.
	return FPaths::IsSamePath(NormalizeProjectDir(InReportedDir), NormalizeProjectDir(InThisProjectDir));
}
