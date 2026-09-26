// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubProvider.h"

#include "DetailCategoryBuilder.h"
#include "DetailWidgetRow.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Framework/MultiBox/MultiBoxExtender.h"
#include "LocHubEditorModule.h"
#include "LocHubServiceProcess.h"
#include "LocHubTypes.h"
#include "LocalizationServiceOperations.h"
#include "LocalizationTargetTypes.h"
#include "Styling/AppStyle.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "LocHubProvider"

namespace LocHubProviderPrivate
{
	void PushTarget(TWeakObjectPtr<ULocalizationTarget> InTarget)
	{
		const ULocalizationTarget* Target = InTarget.Get();
		if (IsValid(Target))
		{
			FLocHubEditorModule::Get().PushTarget(*Target, false);
		}
	}

	void PullTarget(TWeakObjectPtr<ULocalizationTarget> InTarget)
	{
		const ULocalizationTarget* Target = InTarget.Get();
		if (IsValid(Target))
		{
			FLocHubEditorModule::Get().PullTarget(*Target);
		}
	}

	void OpenWebApp()
	{
		FLocHubEditorModule::Get().OpenWebApp();
	}

	void AddTargetToolbarButtons(FToolBarBuilder& InBuilder, TWeakObjectPtr<ULocalizationTarget> InTarget)
	{
		InBuilder.AddToolBarButton(
			FUIAction(FExecuteAction::CreateStatic(&PushTarget, InTarget)),
			NAME_None,
			LOCTEXT("PushLabel", "Push"),
			LOCTEXT("PushTooltip", "Send the gathered strings of this target to the LocHub service (a dry run comes first)."),
			FSlateIcon(FAppStyle::GetAppStyleSetName(), "LocalizationTargetEditor.ExportTextAllCultures"));
		InBuilder.AddToolBarButton(
			FUIAction(FExecuteAction::CreateStatic(&PullTarget, InTarget)),
			NAME_None,
			LOCTEXT("PullLabel", "Pull"),
			LOCTEXT("PullTooltip", "Write the released translations into the archives, compile .locres and apply answered questions."),
			FSlateIcon(FAppStyle::GetAppStyleSetName(), "LocalizationTargetEditor.ImportTextAllCultures"));
		InBuilder.AddToolBarButton(
			FUIAction(FExecuteAction::CreateStatic(&OpenWebApp)),
			NAME_None,
			LOCTEXT("OpenLabel", "Open LocHub"),
			LOCTEXT("OpenTooltip", "Open the LocHub web app."),
			FSlateIcon(FAppStyle::GetAppStyleSetName(), "LocalizationDashboard.MenuIcon"));
	}
}

FLocHubProvider::FLocHubProvider()
	: ProviderName(LocHub::ProviderName)
{
}

void FLocHubProvider::Init(bool bForceConnection)
{
	// Nothing to connect to up front: every Push, Pull and Open checks the service itself.
}

void FLocHubProvider::Close()
{
	// The service process belongs to FLocHubEditorModule, not to the provider.
}

const FName& FLocHubProvider::GetName() const
{
	return ProviderName;
}

const FText FLocHubProvider::GetDisplayName() const
{
	return LOCTEXT("DisplayName", "LocHub");
}

FText FLocHubProvider::GetStatusText() const
{
	const TSharedPtr<FLocHubServiceProcess> Service = FLocHubEditorModule::Get().GetServiceProcess();
	if (!Service.IsValid())
	{
		return LOCTEXT("StatusNoService", "LocHub service is not configured.");
	}
	const FText Owner = Service->IsOwnedProcessRunning()
		? LOCTEXT("StatusOwned", "started by this editor")
		: LOCTEXT("StatusOnDemand", "started on demand");
	return FText::Format(LOCTEXT("Status", "LocHub service {0} ({1})"), FText::FromString(Service->GetBaseUrl()), Owner);
}

bool FLocHubProvider::IsEnabled() const
{
	return true;
}

bool FLocHubProvider::IsAvailable() const
{
	return true;
}

ELocalizationServiceOperationCommandResult::Type FLocHubProvider::GetState(const TArray<FLocalizationServiceTranslationIdentifier>& InTranslationIds, TArray<TSharedRef<ILocalizationServiceState, ESPMode::ThreadSafe>>& OutState, ELocalizationServiceCacheUsage::Type InStateCacheUsage)
{
	// Per-string state lives in the LocHub web app, not in the Dashboard.
	return ELocalizationServiceOperationCommandResult::Failed;
}

ELocalizationServiceOperationCommandResult::Type FLocHubProvider::Execute(const TSharedRef<ILocalizationServiceOperation, ESPMode::ThreadSafe>& InOperation, const TArray<FLocalizationServiceTranslationIdentifier>& InTranslationIds, ELocalizationServiceOperationConcurrency::Type InConcurrency /*= ELocalizationServiceOperationConcurrency::Synchronous*/, const FLocalizationServiceOperationComplete& InOperationCompleteDelegate /*= FLocalizationServiceOperationComplete()*/)
{
	const FName OperationName = InOperation->GetName();
	const FName ConnectName(TEXT("Connect"));
	const FName DownloadName(TEXT("DownloadLocalizationTargetFile"));
	const FName UploadName(TEXT("UploadLocalizationTargetFile"));

	ELocalizationServiceOperationCommandResult::Type Result = ELocalizationServiceOperationCommandResult::Failed;
	if (OperationName == ConnectName)
	{
		Result = ELocalizationServiceOperationCommandResult::Succeeded;
	}
	else if (OperationName == DownloadName)
	{
		StaticCastSharedRef<FDownloadLocalizationTargetFile>(InOperation)->SetOutErrorText(
			LOCTEXT("NoFileDownload", "LocHub does not exchange translation files. Use Pull on the target toolbar or Tools > LocHub > Pull."));
	}
	else if (OperationName == UploadName)
	{
		StaticCastSharedRef<FUploadLocalizationTargetFile>(InOperation)->SetOutErrorText(
			LOCTEXT("NoFileUpload", "LocHub does not exchange translation files. Use Push on the target toolbar or Tools > LocHub > Push."));
	}

	// Callers written for other providers wait for this delegate; LocHub answers every operation at once.
	InOperationCompleteDelegate.ExecuteIfBound(InOperation, Result);
	return Result;
}

bool FLocHubProvider::CanCancelOperation(const TSharedRef<ILocalizationServiceOperation, ESPMode::ThreadSafe>& InOperation) const
{
	return false;
}

void FLocHubProvider::CancelOperation(const TSharedRef<ILocalizationServiceOperation, ESPMode::ThreadSafe>& InOperation)
{
	// Operations finish inside Execute, so there is never one to cancel.
}

void FLocHubProvider::Tick()
{
	// No queued operations: HTTP completion runs on the core ticker.
}

void FLocHubProvider::CustomizeSettingsDetails(IDetailCategoryBuilder& DetailCategoryBuilder) const
{
	DetailCategoryBuilder.AddCustomRow(LOCTEXT("SettingsFilter", "LocHub"))
		.WholeRowContent()
		[
			SNew(STextBlock)
			.Text(LOCTEXT("SettingsHint", "LocHub settings live in Project Settings > Plugins > LocHub."))
		];
}

void FLocHubProvider::CustomizeTargetDetails(IDetailCategoryBuilder& DetailCategoryBuilder, TWeakObjectPtr<ULocalizationTarget> LocalizationTarget) const
{
	// Target details stay stock; LocHub only adds toolbar buttons.
}

void FLocHubProvider::CustomizeTargetToolbar(TSharedRef<FExtender>& MenuExtender, TWeakObjectPtr<ULocalizationTarget> LocalizationTarget) const
{
	MenuExtender->AddToolBarExtension(TEXT("LocalizationService"), EExtensionHook::First, nullptr,
		FToolBarExtensionDelegate::CreateStatic(&LocHubProviderPrivate::AddTargetToolbarButtons, LocalizationTarget));
}

void FLocHubProvider::CustomizeTargetSetToolbar(TSharedRef<FExtender>& MenuExtender, TWeakObjectPtr<ULocalizationTargetSet> LocalizationTargetSet) const
{
	// Push and Pull act on one target; for the whole set use Tools > LocHub.
}

#undef LOCTEXT_NAMESPACE
