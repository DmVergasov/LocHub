// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Tab/SLocHubTab.h"

#include "Bridge/LocHubBridgeCommands.h"
#include "Bridge/LocHubBrowserBridge.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "IWebBrowserSingleton.h"
#include "IWebBrowserWindow.h"
#include "LocHubEditorModule.h"
#include "LocHubLog.h"
#include "LocHubServiceProcess.h"
#include "LocHubStyle.h"
#include "SWebBrowser.h"
#include "Textures/SlateIcon.h"
#include "WebBrowserModule.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SWidgetSwitcher.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "LocHubTab"

const FName SLocHubTab::TabId(TEXT("LocHub"));
TWeakPtr<SLocHubTab> SLocHubTab::LiveInstance;

namespace LocHubTabPrivate
{
	// --bg of the web app's dark theme (Web/src/styles.css), so the tab does not flash white while the page loads.
	const FColor PageBackground(21, 21, 21);
	// CEF renders off-screen at 24 fps by default (IWebBrowserSingleton.h:60); scrolling a 10k-row grid needs more.
	constexpr int32 BrowserFrameRate = 60;
	constexpr int32 BrowserSlotIndex = 0;
	constexpr int32 MessageSlotIndex = 1;

	FAutoConsoleCommand OpenTabCommand(
		TEXT("LocHub.OpenTab"),
		TEXT("Opens the LocHub tab: the web app of the LocHub localization service."),
		FConsoleCommandDelegate::CreateStatic(&SLocHubTab::Open));
}

SLocHubTab::~SLocHubTab() = default;

void SLocHubTab::Construct(const FArguments& InArgs)
{
	BaseUrl = InArgs._BaseUrl;
	LiveInstance = SharedThis(this);

	IWebBrowserModule& WebBrowserModule = IWebBrowserModule::Get();
	IWebBrowserSingleton* Singleton = WebBrowserModule.IsWebModuleAvailable() ? WebBrowserModule.GetSingleton() : nullptr;
	if (Singleton != nullptr)
	{
		FCreateBrowserWindowSettings Settings;
		Settings.InitialURL = MakePageUrl(BaseUrl);
		Settings.BackgroundColor = LocHubTabPrivate::PageBackground;
		Settings.BrowserFrameRate = LocHubTabPrivate::BrowserFrameRate;
		// The native message below replaces CEF's own error page.
		Settings.bShowErrorMessage = false;
		BrowserWindow = Singleton->CreateBrowserWindow(Settings);
	}

	TSharedRef<SWidget> Page = SNew(STextBlock)
		.AutoWrapText(true)
		.Text(LOCTEXT("NoBrowser", "The embedded browser is not available in this editor. Use Open in Browser."));
	if (BrowserWindow.IsValid())
	{
		// Keys the page does not handle must not fall through to editor shortcuts (FabBrowser.cpp:742-743).
		BrowserWindow->OnUnhandledKeyDown().BindLambda([](const FKeyEvent&) { return true; });
		BrowserWindow->OnUnhandledKeyUp().BindLambda([](const FKeyEvent&) { return true; });
		SAssignNew(Browser, SWebBrowser, BrowserWindow)
			.ShowControls(false)
			.ShowAddressBar(false)
			.OnLoadStarted(this, &SLocHubTab::OnLoadStarted)
			.OnLoadCompleted(this, &SLocHubTab::OnLoadCompleted)
			.OnLoadError(this, &SLocHubTab::OnLoadError)
			.OnBeforeNavigation(this, &SLocHubTab::OnBeforeNavigation);
		Page = Browser.ToSharedRef();
	}

	ChildSlot
	[
		SNew(SVerticalBox)
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(4.0f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.AutoWidth()
			[
				SNew(SButton)
				.Text(LOCTEXT("Reload", "Reload"))
				.ToolTipText(LOCTEXT("ReloadTooltip", "Load the LocHub page again, for example after starting the service."))
				.OnClicked(this, &SLocHubTab::OnReloadClicked)
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(4.0f, 0.0f)
			[
				SNew(SButton)
				.Text(LOCTEXT("OpenInBrowser", "Open in Browser"))
				.ToolTipText(LOCTEXT("OpenInBrowserTooltip", "Open LocHub in the system browser. Its commands still reach this editor through the service."))
				.OnClicked(this, &SLocHubTab::OnOpenInBrowserClicked)
			]
		]
		+ SVerticalBox::Slot()
		.FillHeight(1.0f)
		[
			SAssignNew(Switcher, SWidgetSwitcher)
			+ SWidgetSwitcher::Slot()
			[
				Page
			]
			+ SWidgetSwitcher::Slot()
			.HAlign(HAlign_Center)
			.VAlign(VAlign_Center)
			[
				SNew(STextBlock)
				.AutoWrapText(true)
				.Text_Lambda([this]() { return ServiceMessage; })
			]
		]
	];

	if (Browser.IsValid())
	{
		Bridge.Reset(NewObject<ULocHubBrowserBridge>());
		// Bind, then load, so the page sees window.ue.lochub from its first script (FabBrowser.cpp:619-620).
		Browser->BindUObject(TEXT("lochub"), Bridge.Get(), true);
		StartServiceThenLoad();
	}
}

void SLocHubTab::RegisterTabSpawner()
{
	if (!FSlateApplication::IsInitialized())
	{
		return;
	}

	FGlobalTabmanager::Get()->RegisterNomadTabSpawner(TabId, FOnSpawnTab::CreateStatic(&SLocHubTab::SpawnTab))
		.SetDisplayName(LOCTEXT("TabTitle", "LocHub"))
		.SetTooltipText(LOCTEXT("TabTooltip", "Review and translate the game's text with the LocHub service."))
		.SetIcon(FSlateIcon(FLocHubStyle::GetStyleSetName(), "LocHub.Icon"))
		// Opened from the Localization Dashboard or with LocHub.OpenTab, like Fab's tab (FabBrowser.cpp:498).
		.SetMenuType(ETabSpawnerMenuType::Hidden);
}

void SLocHubTab::UnregisterTabSpawner()
{
	if (FSlateApplication::IsInitialized())
	{
		FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TabId);
	}
}

void SLocHubTab::Open()
{
	// A tab already open and stuck on "the service is not answering" (e.g. restored from the saved layout before
	// the service was started) must reload, not just come to the front -- TryInvokeTab below only focuses it.
	const TSharedPtr<SLocHubTab> Existing = LiveInstance.Pin();
	if (Existing.IsValid() && Existing->bLoadFailed)
	{
		Existing->StartServiceThenLoad();
	}
	FGlobalTabmanager::Get()->TryInvokeTab(FTabId(TabId));
}

FString SLocHubTab::MakePageUrl(const FString& InBaseUrl)
{
	return InBaseUrl + TEXT("/?host=editor#/grid");
}

TSharedRef<SDockTab> SLocHubTab::SpawnTab(const FSpawnTabArgs& InSpawnArgs)
{
	return SNew(SDockTab)
		.TabRole(ETabRole::NomadTab)
		[
			SNew(SLocHubTab)
			.BaseUrl(LocHubBridge::GetServiceBaseUrl())
		];
}

FReply SLocHubTab::OnReloadClicked()
{
	StartServiceThenLoad();
	return FReply::Handled();
}

FReply SLocHubTab::OnOpenInBrowserClicked()
{
	const FString Url = BaseUrl + TEXT("/#/grid");
	FString Error;
	FPlatformProcess::LaunchURL(*Url, nullptr, &Error);
	if (!Error.IsEmpty())
	{
		const FString Message = FString::Printf(TEXT("Could not open %s in the system browser."), *Url);
		UE_LOG(LogLocHub, Warning, TEXT("%s"), *Message);
		FLocHubEditorModule::Notify(Message, false);
	}
	return FReply::Handled();
}

void SLocHubTab::ReloadPage()
{
	if (Browser.IsValid())
	{
		Browser->LoadURL(MakePageUrl(BaseUrl));
	}
}

void SLocHubTab::StartServiceThenLoad()
{
	FLocHubEditorModule& Module = FLocHubEditorModule::Get();
	const TSharedPtr<FLocHubServiceProcess> Service = Module.GetServiceProcess();
	if (!Service.IsValid())
	{
		ReloadPage();
		return;
	}
	Module.SyncServiceConfig();
	// The port this tab loads and the OnBeforeNavigation allow-list both follow BaseUrl: a Service Port change must
	// move it here, before the message below names it and before EnsureRunning starts (or finds) the service on the
	// new port, or Reload would load the old port's page instead of the one it just started.
	BaseUrl = Service->GetBaseUrl();
	ServiceMessage = FText::Format(LOCTEXT("ServiceStarting", "Starting the LocHub service at {0}..."), FText::FromString(BaseUrl));
	const TWeakPtr<SLocHubTab> WeakTab = SharedThis(this);
	Service->EnsureRunning([WeakTab](const bool bOk, const FString& InError)
	{
		const TSharedPtr<SLocHubTab> Tab = WeakTab.Pin();
		if (!Tab.IsValid())
		{
			return;
		}
		if (bOk)
		{
			// OnLoadError no longer composes its own text: this is what the tab is left showing if the
			// page load ReloadPage() starts now still fails.
			Tab->ServiceMessage = FText::Format(LOCTEXT("LoadError", "LocHub service is not answering at {0}. Press Reload to try again."), FText::FromString(Tab->BaseUrl));
			Tab->ReloadPage();
			return;
		}
		UE_LOG(LogLocHub, Warning, TEXT("%s"), *InError);
		Tab->ServiceMessage = FText::Format(LOCTEXT("ServiceDown", "The LocHub service is not answering at {0}: {1} Fix that, then press Reload."),
			FText::FromString(Tab->BaseUrl), FText::FromString(InError));
		Tab->bLoadFailed = true;
		if (Tab->Switcher.IsValid())
		{
			Tab->Switcher->SetActiveWidgetIndex(LocHubTabPrivate::MessageSlotIndex);
		}
	});
}

void SLocHubTab::OnLoadStarted()
{
	bLoadFailed = false;
}

void SLocHubTab::OnLoadCompleted()
{
	// CEF may report "completed" after an error as well; only a load that did not fail shows the page.
	if (!bLoadFailed && Switcher.IsValid())
	{
		Switcher->SetActiveWidgetIndex(LocHubTabPrivate::BrowserSlotIndex);
	}
}

void SLocHubTab::OnLoadError()
{
	bLoadFailed = true;
	// Does not compose its own text: a cold start's own CEF load (Construct's InitialURL, fired before
	// StartServiceThenLoad's EnsureRunning above even answers) can fail while node is still starting, and would
	// otherwise overwrite the correct "Starting..." message for the whole 1-20 s start.
	if (Switcher.IsValid())
	{
		Switcher->SetActiveWidgetIndex(LocHubTabPrivate::MessageSlotIndex);
	}
}

bool SLocHubTab::OnBeforeNavigation(const FString& InUrl, const FWebNavigationRequest& InRequest)
{
	if (LocHubBridge::IsServiceUrl(InUrl, BaseUrl))
	{
		return false;
	}
	// Returning true cancels it (FCEFWebBrowserWindow::OnBeforeBrowse); CEF reports the abort as no load error.
	UE_LOG(LogLocHub, Warning, TEXT("LocHub tab refused to navigate to %s: only the LocHub service may use this tab."), *InUrl);
	return true;
}

#undef LOCTEXT_NAMESPACE
