// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

class FLocHubBridgeClient;
class FLocHubProvider;
class FLocHubServiceProcess;
class FLocHubSyncRunner;
class UObject;
class ULocalizationTarget;
struct FLocHubPushReport;
struct FLocHubSyncResult;
struct FPropertyChangedEvent;

/** What SyncGameTarget runs: the three sync commands of Tools > LocHub. */
enum class ELocHubSyncAction : uint8
{
	Push,		// Dry run, confirm retirements, then the real Push
	PushDryRun,	// Report what a Push would change without changing anything
	Pull		// Write released translations into the archives and compile .locres
};

/** Owns the LocHub service process, the Push/Pull runner and the Localization Dashboard provider. */
class FLocHubEditorModule : public IModuleInterface
{
public:
	/**
	 * Receives a finished Push or Pull after the editor notification (the web tab answers its page with it). Called
	 * exactly once, except when the module shuts down mid-run: the runner is destroyed and the callback with it.
	 */
	using FOnSyncFinished = TFunction<void(const FLocHubSyncResult&)>;

	FLocHubEditorModule();
	virtual ~FLocHubEditorModule() override;

	static FLocHubEditorModule& Get();

	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

	TSharedPtr<FLocHubServiceProcess> GetServiceProcess() const;
	TSharedPtr<FLocHubSyncRunner> GetSyncRunner() const;
	/** Copies ULocHubSettings into the service configuration; a running own process keeps its port until Restart. */
	void SyncServiceConfig();
	/** Dry run first; asks before retiring strings. InOnFinished, when set, gets the result (see FOnSyncFinished). */
	void PushTarget(const ULocalizationTarget& InTarget, bool bDryRunOnly, FOnSyncFinished InOnFinished = nullptr);
	/** InOnFinished, when set, gets the result (see FOnSyncFinished). */
	void PullTarget(const ULocalizationTarget& InTarget, FOnSyncFinished InOnFinished = nullptr);
	/** Runs InAction on the Game target as Tools > LocHub does; InOnFinished gets a result also without a Game target. */
	void SyncGameTarget(ELocHubSyncAction InAction, FOnSyncFinished InOnFinished = nullptr);
	/** Starts the service when needed, then opens the LocHub editor tab (SLocHubTab). */
	void OpenWebApp();
	void RestartService();
	void RunTargetSetup();
	/** Editor toast notification; also used by SLocHubTab for its Open in Browser failure message. */
	static void Notify(const FString& InText, bool bSuccess);

private:
	void RegisterMenus();
	void OnPushGameTarget();
	void OnPushDryRunGameTarget();
	void OnPullGameTarget();
	static bool ConfirmTombstones(const FLocHubPushReport& InReport);
	static void ReportResult(const FLocHubSyncResult& InResult);
	/** The editor notification first, then InOnFinished. */
	static FOnSyncFinished ReportThen(FOnSyncFinished InOnFinished);
	/** ULocHubSettings::OnSettingChanged(): re-syncs the running service's config and probes it (never starting one)
	 *  so an AI provider change reaches an owned service, or an orphan not yet adopted, without waiting for the
	 *  next Push/Pull/Open. */
	void OnSettingsChanged(UObject* InObject, FPropertyChangedEvent& InEvent);

	TSharedPtr<FLocHubServiceProcess> ServiceProcess;
	TSharedPtr<FLocHubSyncRunner> SyncRunner;
	TUniquePtr<FLocHubProvider> Provider;
	/** Outgoing SSE stream that runs web-app commands relayed by the service; null in commandlets and unattended runs. */
	TSharedPtr<FLocHubBridgeClient> BridgeClient;
	/** ULocHubSettings::OnSettingChanged(); removed in ShutdownModule. */
	FDelegateHandle SettingsChangedHandle;
};
