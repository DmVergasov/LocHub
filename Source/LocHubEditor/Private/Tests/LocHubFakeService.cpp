// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Tests/LocHubFakeService.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HttpPath.h"
#include "HttpServerConstants.h"
#include "HttpServerModule.h"
#include "HttpServerRequest.h"
#include "HttpServerResponse.h"
#include "IHttpRouter.h"

namespace LocHubFakeServicePrivate
{
	struct FRouteSpec
	{
		const TCHAR* Path;
		EHttpServerRequestVerbs Verb;
		const TCHAR* DefaultBody;
	};

	const FRouteSpec Routes[] = {
		{ TEXT("/api/health"), EHttpServerRequestVerbs::VERB_GET, TEXT("{\"ok\":true,\"units\":0,\"editorConnected\":false}") },
		{ TEXT("/api/push"), EHttpServerRequestVerbs::VERB_POST, TEXT("{\"added\":0,\"changed\":0,\"cosmetic\":0,\"tombstoned\":0,\"revived\":0,\"humanEdits\":0}") },
		{ TEXT("/api/reconcile"), EHttpServerRequestVerbs::VERB_POST, TEXT("{\"humanEdits\":0}") },
		{ TEXT("/api/export"), EHttpServerRequestVerbs::VERB_GET, TEXT("{\"culture\":\"ru\",\"policy\":\"validated\",\"entries\":[]}") },
		{ TEXT("/api/export/ack"), EHttpServerRequestVerbs::VERB_POST, TEXT("{\"ok\":true}") },
		{ TEXT("/api/inbox"), EHttpServerRequestVerbs::VERB_GET, TEXT("{\"rows\":[]}") },
		{ TEXT("/api/inbox/applied"), EHttpServerRequestVerbs::VERB_POST, TEXT("{\"applied\":0}") },
	};

	/** Pid the default /api/health body reports; overridden per test through SetHealth when a specific value matters. */
	constexpr uint32 DefaultHealthPid = 4321;

	/** /api/health body: identified, and -- when InProjectDir matches the caller's FConfig::ProjectDir -- accepted
	 *  by FLocHubServiceProcess out of the box (fix E / I2, I3). */
	FString BuildHealthBody(const uint32 InPid, const FString& InProjectDir, const bool bInStale)
	{
		FString EscapedDir = InProjectDir;
		EscapedDir.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
		return FString::Printf(TEXT("{\"ok\":true,\"units\":0,\"editorConnected\":false,\"pid\":%u,\"projectDir\":\"%s\",\"stale\":%s}"),
			InPid, *EscapedDir, bInStale ? TEXT("true") : TEXT("false"));
	}
}

FLocHubFakeService::FLocHubFakeService(const int32 InPort, const FString& InProjectDir)
	: Port(InPort)
{
	FHttpServerModule& HttpServer = FHttpServerModule::Get();
	Router = HttpServer.GetHttpRouter(static_cast<uint32>(Port));
	bBound = Router.IsValid();
	for (const LocHubFakeServicePrivate::FRouteSpec& Spec : LocHubFakeServicePrivate::Routes)
	{
		FCannedResponse& Response = Responses.Add(Spec.Path);
		Response.Body = Spec.DefaultBody;
		if (!Router.IsValid())
		{
			continue;
		}
		const FHttpRouteHandle Handle = Router->BindRoute(FHttpPath(FString(Spec.Path)), Spec.Verb,
			FHttpRequestHandler::CreateRaw(this, &FLocHubFakeService::HandleRequest, FString(Spec.Path)));
		bBound &= Handle.IsValid();
		if (Handle.IsValid())
		{
			Routes.Add(Handle);
		}
	}
	Responses.FindChecked(TEXT("/api/health")).Body = LocHubFakeServicePrivate::BuildHealthBody(LocHubFakeServicePrivate::DefaultHealthPid, InProjectDir, false);
	HttpServer.StartAllListeners();
}

FLocHubFakeService::~FLocHubFakeService()
{
	if (Router.IsValid())
	{
		for (const FHttpRouteHandle& Handle : Routes)
		{
			Router->UnbindRoute(Handle);
		}
	}
}

bool FLocHubFakeService::IsBound() const
{
	return bBound;
}

FString FLocHubFakeService::GetBaseUrl() const
{
	return FString::Printf(TEXT("http://127.0.0.1:%d"), Port);
}

void FLocHubFakeService::SetResponse(const FString& InPath, const int32 InCode, const FString& InBody)
{
	FCannedResponse& Response = Responses.FindOrAdd(InPath);
	Response.Code = InCode;
	Response.Body = InBody;
}

void FLocHubFakeService::SetHealth(const uint32 InPid, const FString& InProjectDir, const bool bInStale)
{
	SetResponse(TEXT("/api/health"), 200, LocHubFakeServicePrivate::BuildHealthBody(InPid, InProjectDir, bInStale));
}

TArray<FLocHubFakeService::FRecordedRequest> FLocHubFakeService::GetRequests(const FString& InPath) const
{
	TArray<FRecordedRequest> Result;
	for (const FRecordedRequest& Request : Requests)
	{
		if (Request.Path.Equals(InPath, ESearchCase::CaseSensitive))
		{
			Result.Add(Request);
		}
	}
	return Result;
}

bool FLocHubFakeService::HandleRequest(const FHttpServerRequest& InRequest, const FHttpResultCallback& InOnComplete, FString InPath)
{
	FRecordedRequest& Recorded = Requests.AddDefaulted_GetRef();
	Recorded.Index = Requests.Num() - 1;
	Recorded.Path = InPath;
	Recorded.QueryParams = InRequest.QueryParams;
	Recorded.Body = FString::ConstructFromPtrSize(reinterpret_cast<const UTF8CHAR*>(InRequest.Body.GetData()), InRequest.Body.Num());
	// FString map keys compare case-insensitively, so any spelling of the header name is found.
	const TArray<FString>* ContentTypes = InRequest.Headers.Find(TEXT("Content-Type"));
	if (ContentTypes != nullptr && !ContentTypes->IsEmpty())
	{
		Recorded.ContentType = (*ContentTypes)[0];
	}

	const FCannedResponse* Canned = Responses.Find(InPath);
	TUniquePtr<FHttpServerResponse> Response = FHttpServerResponse::Create(Canned != nullptr ? Canned->Body : FString(), TEXT("application/json"));
	Response->Code = static_cast<EHttpServerResponseCodes>(Canned != nullptr ? Canned->Code : 404);
	InOnComplete(MoveTemp(Response));
	return true;
}

#endif
