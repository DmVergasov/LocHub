// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Bridge/LocHubSseParser.h"
#include "Containers/Ticker.h"
#include "HttpFwd.h"

struct FLocHubSseInbox;

/**
 * Keeps an outgoing SSE connection to the service (GET /api/bridge/stream) and runs every relayed "command" event
 * through LocHubBridge::ExecuteCommandJson on the game thread. This is how a browser outside the editor reaches the
 * editor. Reconnects with backoff while the service is down or restarting. Every (re)connect first
 * checks GET /api/health so this editor never relays another project's commands. Create with
 * MakeShared.
 */
class FLocHubBridgeClient : public TSharedFromThis<FLocHubBridgeClient>
{
public:
	void Start(const FString& InBaseUrl);
	void Stop();
	bool IsConnected() const { return bConnected; }
	/** The URL Start() last pointed the client at; a Service Port change follows up with another Start() here
	 *  instead of waiting for an editor restart. */
	const FString& GetBaseUrl() const { return BaseUrl; }

	/** Seconds before reconnect attempt InAttemptIndex (0-based): 1, 2, 4, 8, 16, then 30 for every later attempt. */
	static double GetReconnectDelaySeconds(int32 InAttemptIndex);
	/** Activity timeout of the SSE request: 45 s (three missed service heartbeats), except that with Apple's HTTP
	 *  backend it is at most InConnectionTimeout -- NSURLSession uses HttpConnectionTimeout as its own idle timeout
	 *  and the engine warns on every request whose activity timeout is longer (AppleHttp.cpp). */
	static float EffectiveSseActivityTimeout(bool bAppleHttp, float InConnectionTimeout);
	/** True when EffectiveSseActivityTimeout's Apple clamp would land at or under the service's 15 s heartbeat --
	 *  worth a one-time Warning naming the [HTTP] HttpConnectionTimeout setting responsible, since a stream that
	 *  keeps reconnecting for this reason otherwise gives a Mac user nothing to act on. */
	static bool ShouldWarnAboutHttpConnectionTimeout(bool bAppleHttp, float InConnectionTimeout);

	/** Test seam: OnTick skips its own reconnect while GIsAutomationTesting is set (a client left over from an
	 *  unrelated test must not spam a warning mid-suite); a test that wants one real, expected attempt calls this. */
	void ConnectNowForTests() { Connect(); }
	/** Test seam: bumped only when the client actually issues the SSE request; a health answer identifying another
	 *  project must leave this at 0. */
	int32 GetStreamOpenAttempts() const { return StreamOpenAttempts; }
	/** Test seam: true from ConnectNowForTests()/the ticker's Connect() until the GET /api/health answer for that
	 *  attempt has been fully handled, so a test can wait for the exact moment the outcome is decided. */
	bool IsHealthCheckPending() const { return bHealthCheckPending; }

private:
	/** GET /api/health first; opens the SSE stream (OpenStream) only for this project's service, else backs off. */
	void Connect();
	void OpenStream();
	bool OnTick(float InDeltaTime);
	void OnStreamComplete(FHttpRequestPtr InRequest, FHttpResponsePtr InResponse, bool bInConnectedSuccessfully);
	void ScheduleReconnect();

	FString BaseUrl;
	FHttpRequestPtr Request;
	TSharedPtr<FLocHubSseInbox, ESPMode::ThreadSafe> Inbox;
	FLocHubSseParser Parser;
	FTSTicker::FDelegateHandle TickerHandle;
	double ReconnectAtSeconds = 0.0;
	int32 ReconnectAttempt = 0;
	/** Bumped by Start()/Stop(): a GET /api/health answer for a superseded attempt must not open a stream. */
	uint32 ConnectGeneration = 0;
	bool bConnected = false;
	bool bRunning = false;
	/** True while a GET /api/health answer for the current attempt is in flight, so OnTick does not start a second
	 *  attempt on top of it. */
	bool bHealthCheckPending = false;
	/** True once the current BaseUrl's project mismatch has been logged, so a retry loop logs it only once. */
	bool bLoggedProjectMismatch = false;
	/** Test seam: see GetStreamOpenAttempts(). */
	int32 StreamOpenAttempts = 0;
};
