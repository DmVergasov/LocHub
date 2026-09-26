// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "UObject/StrongObjectPtr.h"
#include "Widgets/SCompoundWidget.h"

class FSpawnTabArgs;
class IWebBrowserWindow;
struct FWebNavigationRequest;
class SDockTab;
class SWebBrowser;
class SWidgetSwitcher;
class ULocHubBrowserBridge;

/**
 * The LocHub web app inside the editor: SWebBrowser on the service's page, with window.ue.lochub bound to
 * ULocHubBrowserBridge. A native bar (Reload / Open in Browser) and a native message cover a service that is not
 * running and CEF focus or IME trouble: the external browser works through the SSE relay.
 */
class SLocHubTab : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SLocHubTab) {}
		SLATE_ARGUMENT(FString, BaseUrl)
	SLATE_END_ARGS()

	virtual ~SLocHubTab() override;

	void Construct(const FArguments& InArgs);

	static void RegisterTabSpawner();
	static void UnregisterTabSpawner();
	static void Open();
	/** The page the tab loads: "?host=editor" switches the web app to the editor's dark theme. */
	static FString MakePageUrl(const FString& InBaseUrl);

private:
	static TSharedRef<SDockTab> SpawnTab(const FSpawnTabArgs& InSpawnArgs);
	FReply OnReloadClicked();
	FReply OnOpenInBrowserClicked();
	/** Loads the page again (the service must already answer). */
	void ReloadPage();
	/**
	 * Starts the service when nothing answers (as Open LocHub does), then loads the page; on failure shows why. Used by
	 * Construct, the Reload button and Open(): a tab restored from the saved layout at editor start is spawned without
	 * Open LocHub, so it has to start the service itself.
	 */
	void StartServiceThenLoad();
	void OnLoadStarted();
	void OnLoadCompleted();
	void OnLoadError();
	/**
	 * Cancels every navigation away from the service, subframes included: window.ue.lochub can write archives (sync
	 * "pull"), and whether CEF exposes the binding to subframes is decided in the prebuilt CEF subprocess, not in UE
	 * source. The web app embeds no frames, so nothing legitimate is refused.
	 */
	bool OnBeforeNavigation(const FString& InUrl, const FWebNavigationRequest& InRequest);

public:
	static const FName TabId;

private:
	FString BaseUrl;
	TSharedPtr<IWebBrowserWindow> BrowserWindow;
	TSharedPtr<SWebBrowser> Browser;
	TSharedPtr<SWidgetSwitcher> Switcher;
	TStrongObjectPtr<ULocHubBrowserBridge> Bridge;
	bool bLoadFailed = false;
	/** Shown instead of the page while it cannot load: starting, or why the service did not start. */
	FText ServiceMessage;

	/** The most recently constructed tab, so Open() can reload one already showing the "not answering" message
	 *  instead of only focusing it. Weak: the tab may have been closed and not exist at all. */
	static TWeakPtr<SLocHubTab> LiveInstance;
};
