// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "WebJSFunction.h"
#include "LocHubBrowserBridge.generated.h"

/**
 * Bound into the LocHub editor tab as window.ue.lochub (SWebBrowser::BindUObject). CEF lower-cases every name and
 * passes arguments by position, so each method takes strings only; ApplyLive gets its entries as a JSON array string.
 * Every bool method returns false when LocHubBridge refuses the command, and logs why.
 */
UCLASS(Transient)
class ULocHubBrowserBridge : public UObject
{
	GENERATED_BODY()

public:
	UFUNCTION()
	bool OpenOrigin(const FString& Origin);

	UFUNCTION()
	bool SetPreviewCulture(const FString& Culture);

	UFUNCTION()
	bool ApplyLive(const FString& Culture, const FString& EntriesJson);

	/**
	 * Runs Action ("push", "dryrun" or "pull") on the Game target exactly as the Tools > LocHub menu does, and resolves
	 * the page's promise with LocHubBridge::SyncResultToJson once it finishes. An unknown action rejects the promise.
	 * Response is supplied by the browser: the page calls sync(action) with the action only.
	 */
	UFUNCTION()
	void Sync(const FString& Action, FWebJSResponse Response);

	/**
	 * Opens IDesktopPlatform::OpenFileDialog for a single file and resolves the page's promise with the picked file's
	 * name and base64 content (LocHubBridge::PickedFileToJson), or {"cancelled":true} if the dialog was dismissed.
	 * The dialog runs on the next tick, not inside this call, so a modal dialog cannot re-enter the CEF IPC dispatch.
	 */
	UFUNCTION()
	void PickTextFile(const FString& Title, const FString& FileTypes, FWebJSResponse Response);

	/**
	 * Opens IDesktopPlatform::SaveFileDialog under FPaths::ProjectDir() and writes Text to the chosen path as UTF-8
	 * with a BOM. DefaultFileName must be a bare file name (LocHubBridge::IsBareFileName); the dialog runs on the
	 * next tick like PickTextFile.
	 */
	UFUNCTION()
	void SaveTextFile(const FString& Title, const FString& DefaultFileName, const FString& FileTypes, const FString& Text, FWebJSResponse Response);
};
