// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "ILocalizationServiceProvider.h"

/** LocHub as the localization service of the Localization Dashboard: Push, Pull and Open on the target toolbar. */
class FLocHubProvider : public ILocalizationServiceProvider
{
public:
	FLocHubProvider();

	// The overrides below would hide the non-virtual convenience overloads of the interface.
	using ILocalizationServiceProvider::Execute;
	using ILocalizationServiceProvider::GetState;

	virtual void Init(bool bForceConnection = true) override;
	virtual void Close() override;
	virtual const FName& GetName() const override;
	virtual const FText GetDisplayName() const override;
	virtual FText GetStatusText() const override;
	virtual bool IsEnabled() const override;
	virtual bool IsAvailable() const override;
	virtual ELocalizationServiceOperationCommandResult::Type GetState(const TArray<FLocalizationServiceTranslationIdentifier>& InTranslationIds, TArray<TSharedRef<ILocalizationServiceState, ESPMode::ThreadSafe>>& OutState, ELocalizationServiceCacheUsage::Type InStateCacheUsage) override;
	virtual ELocalizationServiceOperationCommandResult::Type Execute(const TSharedRef<ILocalizationServiceOperation, ESPMode::ThreadSafe>& InOperation, const TArray<FLocalizationServiceTranslationIdentifier>& InTranslationIds, ELocalizationServiceOperationConcurrency::Type InConcurrency = ELocalizationServiceOperationConcurrency::Synchronous, const FLocalizationServiceOperationComplete& InOperationCompleteDelegate = FLocalizationServiceOperationComplete()) override;
	virtual bool CanCancelOperation(const TSharedRef<ILocalizationServiceOperation, ESPMode::ThreadSafe>& InOperation) const override;
	virtual void CancelOperation(const TSharedRef<ILocalizationServiceOperation, ESPMode::ThreadSafe>& InOperation) override;
	virtual void Tick() override;
	virtual void CustomizeSettingsDetails(IDetailCategoryBuilder& DetailCategoryBuilder) const override;
	virtual void CustomizeTargetDetails(IDetailCategoryBuilder& DetailCategoryBuilder, TWeakObjectPtr<ULocalizationTarget> LocalizationTarget) const override;
	virtual void CustomizeTargetToolbar(TSharedRef<FExtender>& MenuExtender, TWeakObjectPtr<ULocalizationTarget> LocalizationTarget) const override;
	virtual void CustomizeTargetSetToolbar(TSharedRef<FExtender>& MenuExtender, TWeakObjectPtr<ULocalizationTargetSet> LocalizationTargetSet) const override;

private:
	FName ProviderName;
};
