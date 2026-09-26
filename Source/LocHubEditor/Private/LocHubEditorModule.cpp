// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubEditorModule.h"

#include "Async/Async.h"
#include "Bridge/LocHubBridgeClient.h"
#include "Bridge/LocHubBridgeCommands.h"
#include "Features/IModularFeatures.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "Framework/Notifications/NotificationManager.h"
#include "ILocalizationServiceModule.h"
#include "LocHubEnvironment.h"
#include "LocHubLog.h"
#include "LocHubProvider.h"
#include "LocHubServiceProcess.h"
#include "LocHubSettings.h"
#include "LocHubStyle.h"
#include "LocHubSyncRunner.h"
#include "LocHubTargetPaths.h"
#include "LocHubTargetSetup.h"
#include "LocHubTypes.h"
#include "LocHubUserSettings.h"
#include "LocalizationTargetTypes.h"
#include "Misc/App.h"
#include "Misc/CoreDelegates.h"
#include "Misc/MessageDialog.h"
#include "Modules/ModuleManager.h"
#include "Tab/SLocHubNodeMissingWindow.h"
#include "Tab/SLocHubTab.h"
#include "Textures/SlateIcon.h"
#include "ToolMenus.h"
#include "UObject/UnrealType.h"
#include "UObject/UObjectGlobals.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Notifications/SNotificationList.h"

#define LOCTEXT_NAMESPACE "LocHubEditor"

DEFINE_LOG_CATEGORY(LogLocHub);

FLocHubEditorModule::FLocHubEditorModule() = default;

FLocHubEditorModule::~FLocHubEditorModule() = default;

FLocHubEditorModule& FLocHubEditorModule::Get()
{
	return FModuleManager::GetModuleChecked<FLocHubEditorModule>(TEXT("LocHubEditor"));
}

void FLocHubEditorModule::StartupModule()
{
	// Before the tab spawner and the menus below: both reference FLocHubStyle::GetStyleSetName()/"LocHub.Icon".
	FLocHubStyle::Initialize();

	ServiceProcess = MakeShared<FLocHubServiceProcess>(FLocHubServiceProcess::MakeDefaultConfig());
	SyncRunner = MakeShared<FLocHubSyncRunner>(ServiceProcess.ToSharedRef());
	// The pending AI-restart ticker must not stop the owned process while a Push or Pull is talking to it directly,
	// past EnsureRunning.
	ServiceProcess->IsServiceInUseFn = [WeakRunner = TWeakPtr<FLocHubSyncRunner>(SyncRunner)]()
	{
		const TSharedPtr<FLocHubSyncRunner> Runner = WeakRunner.Pin();
		return Runner.IsValid() && Runner->IsBusy();
	};
	Provider = MakeUnique<FLocHubProvider>();

	// Loaded first so it hears the registration and re-selects the provider saved in its settings (LocalizationServiceModule.cpp:223-229).
	ILocalizationServiceModule::Get();
	IModularFeatures::Get().RegisterModularFeature(TEXT("LocalizationService"), Provider.Get());

	if (!IsRunningCommandlet())
	{
		UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FLocHubEditorModule::RegisterMenus));
	}

	SLocHubTab::RegisterTabSpawner();

	// Commandlets (gather, resave) and unattended runs (CI, Automation) must not hold a stream to the service.
	if (!IsRunningCommandlet() && !FApp::IsUnattended())
	{
		BridgeClient = MakeShared<FLocHubBridgeClient>();
		BridgeClient->Start(LocHubBridge::GetServiceBaseUrl());
	}

	// Same exclusions as the bridge above, plus automation: a test run must not pop a window over the check it is
	// itself exercising (LocHub.Environment.NodeCheck.Classify runs the pure functions directly, not this hook).
	if (!IsRunningCommandlet() && !FApp::IsUnattended() && !GIsAutomationTesting)
	{
		EngineLoopInitCompleteHandle = FCoreDelegates::OnFEngineLoopInitComplete.AddRaw(this, &FLocHubEditorModule::OnEngineLoopInitComplete);
	}

	// So an AI provider (or any other) change in Project Settings reaches an already-running service without
	// waiting for the next Push/Pull/Open/Restart to call SyncServiceConfig().
	SettingsChangedHandle = GetMutableDefault<ULocHubSettings>()->OnSettingChanged().AddRaw(this, &FLocHubEditorModule::OnSettingsChanged);
}

void FLocHubEditorModule::ShutdownModule()
{
	if (EngineLoopInitCompleteHandle.IsValid())
	{
		FCoreDelegates::OnFEngineLoopInitComplete.Remove(EngineLoopInitCompleteHandle);
		EngineLoopInitCompleteHandle.Reset();
	}

	if (SettingsChangedHandle.IsValid() && UObjectInitialized())
	{
		ULocHubSettings* Settings = GetMutableDefault<ULocHubSettings>();
		if (IsValid(Settings))
		{
			Settings->OnSettingChanged().Remove(SettingsChangedHandle);
		}
		SettingsChangedHandle.Reset();
	}

	if (BridgeClient.IsValid())
	{
		BridgeClient->Stop();
		BridgeClient.Reset();
	}

	// SDockTab caches the tab icon's FSlateBrush* at spawn time (TabManager.cpp, ProvideDefaultIcon) and
	// FLocHubStyle::Shutdown() below deletes that brush; close a live tab first so it cannot keep painting through
	// a freed pointer after the module unloads.
	if (FSlateApplication::IsInitialized())
	{
		const TSharedPtr<SDockTab> LiveTab = FGlobalTabmanager::Get()->FindExistingLiveTab(FTabId(SLocHubTab::TabId));
		if (LiveTab.IsValid())
		{
			LiveTab->RequestCloseTab();
		}
	}

	SLocHubTab::UnregisterTabSpawner();

	if (UToolMenus::IsToolMenuUIEnabled())
	{
		UToolMenus::UnRegisterStartupCallback(this);
		UToolMenus::UnregisterOwner(this);
	}

	// After the tab spawner and the menus above are gone: nothing references FLocHubStyle by then.
	FLocHubStyle::Shutdown();

	if (Provider.IsValid())
	{
		IModularFeatures::Get().UnregisterModularFeature(TEXT("LocalizationService"), Provider.Get());
		Provider.Reset();
	}
	SyncRunner.Reset();
	// The destructor stops the own node process without calling anybody back.
	ServiceProcess.Reset();
}

TSharedPtr<FLocHubServiceProcess> FLocHubEditorModule::GetServiceProcess() const
{
	return ServiceProcess;
}

TSharedPtr<FLocHubSyncRunner> FLocHubEditorModule::GetSyncRunner() const
{
	return SyncRunner;
}

void FLocHubEditorModule::SyncServiceConfig()
{
	if (!ServiceProcess.IsValid())
	{
		return;
	}
	if (SyncRunner.IsValid() && SyncRunner->IsBusy())
	{
		// A port change mid-Push/Pull would move GetBaseUrl() under the running acks/start wait.
		UE_LOG(LogLocHub, Display, TEXT("LocHub settings changed during a sync; they apply to the next run."));
		return;
	}
	ServiceProcess->SetConfig(FLocHubServiceProcess::MakeDefaultConfig());

	// The bridge is started once at module startup and otherwise only followed an explicit Restart Service; a
	// Service Port change applied here (Push, Pull, Open LocHub, Restart Service all call SyncServiceConfig first)
	// must move it too, or it keeps relaying another service's commands until the editor restarts.
	const FString NewBaseUrl = ServiceProcess->GetBaseUrl();
	if (BridgeClient.IsValid() && BridgeClient->GetBaseUrl() != NewBaseUrl)
	{
		BridgeClient->Start(NewBaseUrl);
	}
}

void FLocHubEditorModule::PushTarget(const ULocalizationTarget& InTarget, const bool bDryRunOnly, FOnSyncFinished InOnFinished /*= nullptr*/)
{
	if (!SyncRunner.IsValid())
	{
		FLocHubSyncResult NotRunning;
		NotRunning.Summary = TEXT("LocHub Push skipped: the LocHub module is shutting down.");
		ReportThen(MoveTemp(InOnFinished))(NotRunning);
		return;
	}
	if (SyncRunner->IsBusy())
	{
		// Begin() would refuse it as well, but only after SyncServiceConfig() logged a settings change nobody made.
		FLocHubSyncResult Busy;
		Busy.Summary = TEXT("LocHub Push skipped: another Push or Pull is running.");
		ReportThen(MoveTemp(InOnFinished))(Busy);
		return;
	}
	SyncServiceConfig();
	FLocHubPushOptions Options;
	Options.bDryRunOnly = bDryRunOnly;
	Options.ConfirmTombstones = &FLocHubEditorModule::ConfirmTombstones;
	SyncRunner->Push(FLocHubSyncContext::MakeForTarget(InTarget, false), MoveTemp(Options), ReportThen(MoveTemp(InOnFinished)));
}

void FLocHubEditorModule::PullTarget(const ULocalizationTarget& InTarget, FOnSyncFinished InOnFinished /*= nullptr*/)
{
	if (!SyncRunner.IsValid())
	{
		FLocHubSyncResult NotRunning;
		NotRunning.Summary = TEXT("LocHub Pull skipped: the LocHub module is shutting down.");
		ReportThen(MoveTemp(InOnFinished))(NotRunning);
		return;
	}
	if (SyncRunner->IsBusy())
	{
		// MakeForTarget below loads glyph-check fonts synchronously; do not pay for that just to be
		// told the runner is busy -- ask first, with the same message Begin() would have given.
		FLocHubSyncResult Busy;
		Busy.Summary = TEXT("LocHub Pull skipped: another Push or Pull is running.");
		ReportThen(MoveTemp(InOnFinished))(Busy);
		return;
	}
	SyncServiceConfig();
	SyncRunner->Pull(FLocHubSyncContext::MakeForTarget(InTarget, true), ReportThen(MoveTemp(InOnFinished)));
}

void FLocHubEditorModule::SyncGameTarget(const ELocHubSyncAction InAction, FOnSyncFinished InOnFinished /*= nullptr*/)
{
	const ULocalizationTarget* Target = FLocHubTargetPaths::FindGameTarget(LocHubTargetSetup::TargetName);
	if (!IsValid(Target))
	{
		FLocHubSyncResult Missing;
		Missing.Summary = FString::Printf(TEXT("LocHub: no localization target %s. Use Tools > LocHub > Set Up Localization Target."), LocHubTargetSetup::TargetName);
		ReportThen(MoveTemp(InOnFinished))(Missing);
		return;
	}
	switch (InAction)
	{
	case ELocHubSyncAction::Push:
		PushTarget(*Target, false, MoveTemp(InOnFinished));
		return;
	case ELocHubSyncAction::PushDryRun:
		PushTarget(*Target, true, MoveTemp(InOnFinished));
		return;
	case ELocHubSyncAction::Pull:
		PullTarget(*Target, MoveTemp(InOnFinished));
		return;
	}
	// A new action nobody handled above must still answer the page (MSVC does not warn about the missing case).
	checkNoEntry();
	FLocHubSyncResult Unknown;
	Unknown.Summary = TEXT("LocHub: unknown sync action.");
	ReportThen(MoveTemp(InOnFinished))(Unknown);
}

void FLocHubEditorModule::OpenWebApp()
{
	if (!ServiceProcess.IsValid())
	{
		return;
	}
	SyncServiceConfig();
	const TWeakPtr<FLocHubServiceProcess> WeakService = ServiceProcess;
	ServiceProcess->EnsureRunning([WeakService](const bool bOk, const FString& InError)
	{
		const TSharedPtr<FLocHubServiceProcess> Service = WeakService.Pin();
		if (!Service.IsValid())
		{
			return;
		}
		if (!bOk)
		{
			UE_LOG(LogLocHub, Warning, TEXT("%s"), *InError);
			Notify(TEXT("LocHub: ") + InError, false);
			return;
		}
		// The tab loads LocHubBridge::GetServiceBaseUrl(): the same address SyncServiceConfig() gave the service above.
		SLocHubTab::Open();
	});
}

void FLocHubEditorModule::RestartService()
{
	if (!ServiceProcess.IsValid())
	{
		return;
	}
	// A changed port takes effect here: SyncServiceConfig() below already moves the bridge to it, so Restart
	// Service does not need its own copy of that logic.
	SyncServiceConfig();
	ServiceProcess->Restart([](const bool bOk, const FString& InError)
	{
		const FString Text = bOk ? FString(TEXT("LocHub service restarted.")) : TEXT("LocHub: ") + InError;
		UE_LOG(LogLocHub, Display, TEXT("%s"), *Text);
		Notify(Text, bOk);
	});
}

void FLocHubEditorModule::RunTargetSetup()
{
	FString Summary;
	const bool bOk = LocHubTargetSetup::ApplyToProject(Summary);
	UE_LOG(LogLocHub, Display, TEXT("%s"), *Summary);
	Notify(Summary, bOk);
}

void FLocHubEditorModule::RegisterMenus()
{
	FToolMenuOwnerScoped OwnerScoped(this);
	UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
	if (!IsValid(Menu))
	{
		return;
	}
	FToolMenuSection& Section = Menu->FindOrAddSection(TEXT("LocHub"), LOCTEXT("LocHubSection", "LocHub"));
	Section.AddMenuEntry(TEXT("LocHub.Push"), LOCTEXT("PushLabel", "Push"),
		LOCTEXT("PushTooltip", "Send the gathered strings of the Game target to the LocHub service (a dry run comes first)."),
		FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FLocHubEditorModule::OnPushGameTarget)));
	Section.AddMenuEntry(TEXT("LocHub.PushDryRun"), LOCTEXT("PushDryRunLabel", "Push (Dry Run)"),
		LOCTEXT("PushDryRunTooltip", "Show what a Push would add, change and retire without changing anything."),
		FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FLocHubEditorModule::OnPushDryRunGameTarget)));
	Section.AddMenuEntry(TEXT("LocHub.Pull"), LOCTEXT("PullLabel", "Pull"),
		LOCTEXT("PullTooltip", "Write the released translations into the archives, compile .locres and apply answered questions."),
		FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FLocHubEditorModule::OnPullGameTarget)));
	Section.AddMenuEntry(TEXT("LocHub.Open"), LOCTEXT("OpenLabel", "Open LocHub"),
		LOCTEXT("OpenTooltip", "Open the LocHub web app."),
		FSlateIcon(FLocHubStyle::GetStyleSetName(), "LocHub.Icon"), FUIAction(FExecuteAction::CreateRaw(this, &FLocHubEditorModule::OpenWebApp)));
	Section.AddMenuEntry(TEXT("LocHub.Restart"), LOCTEXT("RestartLabel", "Restart Service"),
		LOCTEXT("RestartTooltip", "Stop the LocHub service this editor started and start it with the current settings."),
		FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FLocHubEditorModule::RestartService)));
	Section.AddMenuEntry(TEXT("LocHub.Setup"), LOCTEXT("SetupLabel", "Set Up Localization Target"),
		LOCTEXT("SetupTooltip", "Create or complete the Game localization target: source and content paths, the native culture, the cultures listed in Setup Foreign Cultures, compile checks. Never removes anything."),
		FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FLocHubEditorModule::RunTargetSetup)));
}

void FLocHubEditorModule::OnPushGameTarget()
{
	SyncGameTarget(ELocHubSyncAction::Push);
}

void FLocHubEditorModule::OnPushDryRunGameTarget()
{
	SyncGameTarget(ELocHubSyncAction::PushDryRun);
}

void FLocHubEditorModule::OnPullGameTarget()
{
	SyncGameTarget(ELocHubSyncAction::Pull);
}

bool FLocHubEditorModule::ConfirmTombstones(const FLocHubPushReport& InReport)
{
	const FText Message = FText::Format(
		LOCTEXT("ConfirmTombstones", "This Push retires {0} strings that are no longer in the manifest.\n\nIf the last Gather Text covered only part of the project, answer No and gather everything first.\n\nRetire {0} strings?"),
		FText::AsNumber(InReport.Tombstoned));
	return FMessageDialog::Open(EAppMsgType::YesNo, Message, LOCTEXT("ConfirmTombstonesTitle", "LocHub Push")) == EAppReturnType::Yes;
}

void FLocHubEditorModule::ReportResult(const FLocHubSyncResult& InResult)
{
	for (const FString& Line : InResult.Details)
	{
		UE_LOG(LogLocHub, Display, TEXT("%s"), *Line);
	}
	const bool bFine = InResult.bSuccess || InResult.bCancelled;
	if (bFine)
	{
		UE_LOG(LogLocHub, Display, TEXT("%s"), *InResult.Summary);
	}
	else
	{
		UE_LOG(LogLocHub, Warning, TEXT("%s"), *InResult.Summary);
	}
	Notify(InResult.Summary, bFine);
}

FLocHubEditorModule::FOnSyncFinished FLocHubEditorModule::ReportThen(FOnSyncFinished InOnFinished)
{
	return [OnFinished = MoveTemp(InOnFinished)](const FLocHubSyncResult& InResult)
	{
		ReportResult(InResult);
		if (OnFinished)
		{
			OnFinished(InResult);
		}
	};
}

void FLocHubEditorModule::OnEngineLoopInitComplete()
{
	// GetDefault<ULocHubUserSettings>() touches UObject/CDO state, which belongs to the game thread; read it here
	// and hand CheckNode the value directly instead of letting it read the setting from the pool thread below.
	// LocHubEnvironment::CheckNode() bounds a stuck node.exe to its own poll deadline, but it still runs off the
	// game thread here so even that bound cannot be felt as a startup stall. The lambdas below must not capture
	// the module (no "this") so nothing here depends on it surviving until the thread pool gets to the work.
	const FString ConfiguredNodePath = GetDefault<ULocHubUserSettings>()->NodeExecutable.FilePath;
	Async(EAsyncExecution::ThreadPool, [ConfiguredNodePath]()
	{
		const FLocHubNodeCheck NodeCheck = LocHubEnvironment::CheckNode(ConfiguredNodePath);
		AsyncTask(ENamedThreads::GameThread, [NodeCheck]()
		{
			if (NodeCheck.Status == ELocHubNodeStatus::Ok)
			{
				return;
			}
			const FString Problem = LocHubEnvironment::DescribeNodeProblem(NodeCheck);
			UE_LOG(LogLocHub, Warning, TEXT("%s"), *Problem);
			if (FSlateApplication::IsInitialized() && !IsEngineExitRequested())
			{
				SLocHubNodeMissingWindow::Open(NodeCheck);
			}
		});
	});
}

void FLocHubEditorModule::OnSettingsChanged(UObject* InObject, FPropertyChangedEvent& InEvent)
{
	// A slider drag fires Interactive repeatedly while dragging; only the final ValueSet is worth a probe.
	if (InEvent.ChangeType == EPropertyChangeType::Interactive)
	{
		return;
	}
	if (!ServiceProcess.IsValid())
	{
		return;
	}
	SyncServiceConfig();
	// ProbeOnly, not EnsureRunning: a settings change must never start a service that was not already running,
	// whether it is ours, an orphan left by a previous editor session not yet adopted, or another host's. When the
	// process is ours, this still reaches OnHealthProbed's AI-mismatch check right away.
	ServiceProcess->ProbeOnly([](const bool bOk, const FString& InError)
	{
		if (!bOk)
		{
			UE_LOG(LogLocHub, Warning, TEXT("%s"), *InError);
			FLocHubEditorModule::Notify(TEXT("LocHub: ") + InError, false);
		}
	});
}

void FLocHubEditorModule::Notify(const FString& InText, const bool bSuccess)
{
	if (IsRunningCommandlet() || !FSlateApplication::IsInitialized())
	{
		return;
	}
	FNotificationInfo Info(FText::FromString(InText));
	Info.ExpireDuration = bSuccess ? 5.0f : 10.0f;
	Info.bFireAndForget = true;
	const TSharedPtr<SNotificationItem> Item = FSlateNotificationManager::Get().AddNotification(Info);
	if (Item.IsValid())
	{
		Item->SetCompletionState(bSuccess ? SNotificationItem::CS_Success : SNotificationItem::CS_Fail);
	}
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FLocHubEditorModule, LocHubEditor)
