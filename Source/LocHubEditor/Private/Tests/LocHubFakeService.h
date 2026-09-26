// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HttpResultCallback.h"
#include "HttpRouteHandle.h"

class IHttpRouter;
struct FHttpServerRequest;

namespace LocHubTests
{
	/** Result of one asynchronous call, filled by a callback and read by a latent command. */
	struct FAsyncOutcome
	{
		bool bDone = false;
		bool bOk = false;
		FString Error;
	};
}

/** In-process stand-in for "lochub serve": canned JSON answers on the service's routes, every request recorded. */
class FLocHubFakeService
{
public:
	struct FRecordedRequest
	{
		FString Path;
		TMap<FString, FString> QueryParams;
		FString Body;
		/** First Content-Type header value, empty when the request had none. */
		FString ContentType;
		/** Position among every request this fake has received, any path -- lets a test compare call order across routes. */
		int32 Index = 0;
	};

	/** InProjectDir is reported as "projectDir" in the default /api/health body (fix E / I2, I3 identity checks);
	 *  empty (the default) makes the default answer look like an old, unidentified build. */
	explicit FLocHubFakeService(int32 InPort, const FString& InProjectDir = FString());
	~FLocHubFakeService();

	FLocHubFakeService(const FLocHubFakeService&) = delete;
	FLocHubFakeService& operator=(const FLocHubFakeService&) = delete;

	/** False when a route could not be bound (the port is taken by something else). */
	bool IsBound() const;
	FString GetBaseUrl() const;
	void SetResponse(const FString& InPath, int32 InCode, const FString& InBody);
	/** Overrides pid/projectDir/stale in the default /api/health body. Adoption tests need a
	 *  pid the caller controls, typically the test process's own pid so FPlatformProcess::OpenProcess succeeds
	 *  without a real second process. */
	void SetHealth(uint32 InPid, const FString& InProjectDir, bool bInStale);
	TArray<FRecordedRequest> GetRequests(const FString& InPath) const;

private:
	struct FCannedResponse
	{
		int32 Code = 200;
		FString Body;
	};

	bool HandleRequest(const FHttpServerRequest& InRequest, const FHttpResultCallback& InOnComplete, FString InPath);

	int32 Port = 0;
	bool bBound = false;
	TSharedPtr<IHttpRouter> Router;
	TArray<FHttpRouteHandle> Routes;
	TMap<FString, FCannedResponse> Responses;
	TArray<FRecordedRequest> Requests;
};

#endif
