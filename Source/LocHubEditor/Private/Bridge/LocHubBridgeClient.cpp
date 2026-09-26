// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Bridge/LocHubBridgeClient.h"

#include "Bridge/LocHubBridgeCommands.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformTime.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "LocHubEnvironment.h"
#include "LocHubLog.h"
#include "LocHubServiceClient.h"
#include "Misc/ScopeLock.h"
#include "Stats/Stats.h"

// Bytes written by the HTTP thread wait here until the game-thread ticker drains them.
struct FLocHubSseInbox
{
	FCriticalSection Lock;
	TArray<uint8> Bytes;
};

namespace LocHubBridgeClientPrivate
{
	// The service pings every 15 s (Service/src/bridge.ts, HEARTBEAT_MS); silence for three pings means the link is dead.
	// The HTTP module's default of 30 s (HttpModule.cpp:98) is too close to the heartbeat.
	constexpr float StreamActivityTimeoutSeconds = 45.0f;
	constexpr float ServiceHeartbeatSeconds = 15.0f;
	constexpr float TickIntervalSeconds = 0.1f;
	constexpr int32 LastDoublingAttempt = 4;
	constexpr double MaxReconnectDelaySeconds = 30.0;

	// A stopped service refuses every reconnect, and each refusal logs a LogHttp warning by default
	// (GenericPlatform/HttpRequestCommon.cpp:330-334, LogFailure); listing the stream URL here silences just that one.
	void SuppressFailedLogForUrl(const FString& InUrlPattern)
	{
		IConsoleVariable* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("http.UrlPatternsToDisableFailedLog"));
		if (!CVar)
		{
			return;
		}

		const FString Current = CVar->GetString();
		TArray<FString> Patterns;
		Current.ParseIntoArrayWS(Patterns);
		if (Patterns.Contains(InUrlPattern))
		{
			return;
		}

		CVar->Set(*(Current.IsEmpty() ? InUrlPattern : Current + TEXT(" ") + InUrlPattern), ECVF_SetByCode);
	}
}

void FLocHubBridgeClient::Start(const FString& InBaseUrl)
{
	Stop();
	BaseUrl = InBaseUrl;
	bRunning = true;
	ReconnectAttempt = 0;
	bLoggedProjectMismatch = false;

	// Registered once per Start(), before the first connect: the pattern is the URL http.UrlPatternsToDisableFailedLog
	// matches against with FString::Contains, so the "http://" scheme prefix is not part of it.
	FString StreamUrlPattern = BaseUrl + TEXT("/api/bridge/stream");
	StreamUrlPattern.RemoveFromStart(TEXT("http://"), ESearchCase::CaseSensitive);
	LocHubBridgeClientPrivate::SuppressFailedLogForUrl(StreamUrlPattern);

	// Every (re)connect now asks this first: a service that never answers must not warn on
	// every retry either.
	FString HealthUrlPattern = BaseUrl + TEXT("/api/health");
	HealthUrlPattern.RemoveFromStart(TEXT("http://"), ESearchCase::CaseSensitive);
	LocHubBridgeClientPrivate::SuppressFailedLogForUrl(HealthUrlPattern);

	// Once per Start(), not per reconnect attempt (OpenStream reads the same setting on every retry): a Mac user
	// whose ini clamps the stream below the service's heartbeat gets one actionable line instead of a silent,
	// endlessly reconnecting bridge.
	const float ConnectionTimeout = FHttpModule::Get().GetHttpConnectionTimeout();
	if (ShouldWarnAboutHttpConnectionTimeout(PLATFORM_APPLE != 0, ConnectionTimeout))
	{
		UE_LOG(LogLocHub, Warning, TEXT("[HTTP] HttpConnectionTimeout is %.0f s (DefaultEngine.ini); on Mac this can drop the LocHub bridge's event stream before the service's %.0f s heartbeat arrives. Raise it above %.0f if the bridge keeps reconnecting."),
			ConnectionTimeout, LocHubBridgeClientPrivate::ServiceHeartbeatSeconds, LocHubBridgeClientPrivate::ServiceHeartbeatSeconds);
	}

	// The first connection is made from the ticker, once the editor has finished starting up.
	ReconnectAtSeconds = FPlatformTime::Seconds();
	TickerHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateSP(this, &FLocHubBridgeClient::OnTick), LocHubBridgeClientPrivate::TickIntervalSeconds);
}

void FLocHubBridgeClient::Stop()
{
	bRunning = false;
	bHealthCheckPending = false;
	// A GET /api/health answer already in flight must find itself superseded when it comes back (see Connect()).
	++ConnectGeneration;
	FTSTicker::RemoveTicker(TickerHandle);
	TickerHandle.Reset();

	if (Request.IsValid())
	{
		// Clear the member before cancelling, so OnStreamComplete sees the cancelled request as stale.
		const FHttpRequestPtr Cancelled = Request;
		Request.Reset();
		Cancelled->CancelRequest();
	}

	Inbox.Reset();
	Parser.Reset();
	bConnected = false;
}

double FLocHubBridgeClient::GetReconnectDelaySeconds(int32 InAttemptIndex)
{
	if (InAttemptIndex > LocHubBridgeClientPrivate::LastDoublingAttempt)
	{
		return LocHubBridgeClientPrivate::MaxReconnectDelaySeconds;
	}
	return static_cast<double>(1 << FMath::Max(InAttemptIndex, 0));
}

float FLocHubBridgeClient::EffectiveSseActivityTimeout(const bool bAppleHttp, const float InConnectionTimeout)
{
	return bAppleHttp
		? FMath::Min(LocHubBridgeClientPrivate::StreamActivityTimeoutSeconds, InConnectionTimeout)
		: LocHubBridgeClientPrivate::StreamActivityTimeoutSeconds;
}

bool FLocHubBridgeClient::ShouldWarnAboutHttpConnectionTimeout(const bool bAppleHttp, const float InConnectionTimeout)
{
	return bAppleHttp && InConnectionTimeout <= LocHubBridgeClientPrivate::ServiceHeartbeatSeconds;
}

void FLocHubBridgeClient::Connect()
{
	++ConnectGeneration;
	const uint32 Generation = ConnectGeneration;
	const FString RequestBaseUrl = BaseUrl;
	bHealthCheckPending = true;

	// Reused rather than copied: FLocHubServiceClient already builds the same GET request
	// FLocHubServiceProcess::ProbeHealth uses, and ParseHealth is its public parser for the same body.
	const TWeakPtr<FLocHubBridgeClient> WeakSelf = AsWeak();
	FLocHubServiceClient(RequestBaseUrl).GetHealth([WeakSelf, Generation, RequestBaseUrl](const FLocHubHttpResult& InResult)
	{
		const TSharedPtr<FLocHubBridgeClient> This = WeakSelf.Pin();
		if (!This.IsValid() || !This->bRunning || Generation != This->ConnectGeneration)
		{
			// Stopped, or a newer Start()/Connect() moved on before this answer came back.
			return;
		}
		This->bHealthCheckPending = false;

		if (!InResult.IsOk())
		{
			// No answer, or not 2xx: the service is down or restarting, same silent backoff as before this fix.
			This->ScheduleReconnect();
			return;
		}

		FLocHubHealth Health;
		const bool bParsed = FLocHubServiceClient::ParseHealth(InResult.Body, Health);
		const bool bIdentified = bParsed && Health.bOk && !Health.ProjectDir.IsEmpty();
		const bool bSameProject = bIdentified
			&& FLocHubServiceClient::IsSameProjectDir(Health.ProjectDir, LocHubEnvironment::GetProjectDir());
		if (!bSameProject)
		{
			if (!This->bLoggedProjectMismatch)
			{
				This->bLoggedProjectMismatch = true;
				UE_LOG(LogLocHub, Warning, TEXT("LocHub bridge: the service on %s belongs to %s; not relaying its commands."),
					*RequestBaseUrl, bIdentified ? *Health.ProjectDir : TEXT("an unidentified project"));
			}
			This->ScheduleReconnect();
			return;
		}

		This->bLoggedProjectMismatch = false;
		This->OpenStream();
	});
}

void FLocHubBridgeClient::OpenStream()
{
	++StreamOpenAttempts;
	Parser.Reset();
	bConnected = false;
	Inbox = MakeShared<FLocHubSseInbox, ESPMode::ThreadSafe>();

	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> NewRequest = FHttpModule::Get().CreateRequest();
	// libcurl derives "Host: 127.0.0.1:<port>" from this URL; the service answers 403 to any other Host (CONTRACT.md).
	NewRequest->SetURL(BaseUrl + TEXT("/api/bridge/stream"));
	NewRequest->SetVerb(TEXT("GET"));
	NewRequest->SetHeader(TEXT("Accept"), TEXT("text/event-stream"));
	// The stream never ends on its own: no total timeout (0 disables it), only the activity timeout.
	NewRequest->SetTimeout(0.0f);
	NewRequest->SetActivityTimeout(EffectiveSseActivityTimeout(PLATFORM_APPLE != 0, FHttpModule::Get().GetHttpConnectionTimeout()));

	// Runs on the HTTP thread. Captures only the inbox, so a chunk that arrives after Stop() lands in a buffer nobody reads.
	const TSharedPtr<FLocHubSseInbox, ESPMode::ThreadSafe> TargetInbox = Inbox;
	NewRequest->SetResponseBodyReceiveStreamDelegateV2(FHttpRequestStreamDelegateV2::CreateLambda(
		[TargetInbox](void* InData, int64& InOutLength)
		{
			FScopeLock ScopeLock(&TargetInbox->Lock);
			TargetInbox->Bytes.Append(static_cast<const uint8*>(InData), static_cast<int32>(InOutLength));
		}));
	NewRequest->OnProcessRequestComplete().BindSP(this, &FLocHubBridgeClient::OnStreamComplete);

	Request = NewRequest;
	const bool bStarted = NewRequest->ProcessRequest();
	const bool bStillCurrent = Request.Get() == &NewRequest.Get();
	if (!bStarted && bStillCurrent)
	{
		Request.Reset();
		ScheduleReconnect();
	}
}

bool FLocHubBridgeClient::OnTick(float InDeltaTime)
{
	QUICK_SCOPE_CYCLE_COUNTER(STAT_LocHubBridgeClient_Tick);

	if (!bRunning)
	{
		return false;
	}

	TArray<uint8> Chunk;
	if (Inbox.IsValid())
	{
		FScopeLock ScopeLock(&Inbox->Lock);
		Swap(Chunk, Inbox->Bytes);
	}

	if (Chunk.Num() > 0)
	{
		TArray<FLocHubSseEvent> Events;
		Parser.Feed(Chunk, Events);
		if (!bConnected && Parser.GetNumComments() > 0)
		{
			// The service opens every stream with ": connected"; an error page never starts with a comment line.
			bConnected = true;
			ReconnectAttempt = 0;
			UE_LOG(LogLocHub, Log, TEXT("LocHub bridge connected to %s"), *BaseUrl);
		}

		for (const FLocHubSseEvent& Event : Events)
		{
			if (!Event.Event.Equals(TEXT("command"), ESearchCase::CaseSensitive))
			{
				continue;
			}

			FString Error;
			if (!LocHubBridge::ExecuteCommandJson(Event.Data, Error))
			{
				UE_LOG(LogLocHub, Warning, TEXT("LocHub bridge rejected a relayed command: %s"), *Error);
			}
		}
	}

	// The inbox is drained above before a reconnect replaces it, so a command sent right before a drop is not lost.
	// No attempts while an Automation test runs: a refused connection logs a LogHttp warning, and 5.8 turns log
	// warnings into test errors (AutomationControllerSettings.cpp:14). Tests that want one real, expected attempt
	// call ConnectNowForTests() instead.
	const bool bReconnectDue = !Request.IsValid() && !bHealthCheckPending && FPlatformTime::Seconds() >= ReconnectAtSeconds;
	if (bReconnectDue && !GIsAutomationTesting)
	{
		Connect();
	}
	return true;
}

void FLocHubBridgeClient::OnStreamComplete(FHttpRequestPtr InRequest, FHttpResponsePtr InResponse, bool bInConnectedSuccessfully)
{
	if (!Request.IsValid() || InRequest != Request)
	{
		// Cancelled by Stop(), or replaced by a newer connection.
		return;
	}

	Request.Reset();
	if (bConnected)
	{
		UE_LOG(LogLocHub, Log, TEXT("LocHub bridge lost the service at %s, reconnecting"), *BaseUrl);
	}
	bConnected = false;
	ScheduleReconnect();
}

void FLocHubBridgeClient::ScheduleReconnect()
{
	ReconnectAtSeconds = FPlatformTime::Seconds() + GetReconnectDelaySeconds(ReconnectAttempt);
	ReconnectAttempt = FMath::Min(ReconnectAttempt + 1, LocHubBridgeClientPrivate::LastDoublingAttempt + 1);
}
