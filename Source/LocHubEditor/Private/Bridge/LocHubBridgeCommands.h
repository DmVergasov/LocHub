// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class FJsonValue;
enum class ELocHubSyncAction : uint8;
struct FLocHubSyncResult;

enum class ELocHubOriginKind : uint8
{
	Unknown,	// Nothing the editor can open: empty, or a native /Script/ object
	Asset,		// A long package name, e.g. /Game/UI/WBP_Pause
	SourceFile	// A path relative to the project directory
};

struct FLocHubOrigin
{
	ELocHubOriginKind Kind = ELocHubOriginKind::Unknown;
	FString Path;
	int32 Line = 0;
};

struct FLocHubLiveEntry
{
	FString Namespace;
	FString Key;
	FString Source;
	FString Translation;
};

/**
 * The whitelist of editor commands the LocHub web app may run, either directly from the editor tab
 * (ULocHubBrowserBridge) or relayed by the service over SSE (FLocHubBridgeClient). Every function validates its input
 * and returns false with a reason in OutError instead of acting; none of them logs, the callers do. Game thread only.
 */
namespace LocHubBridge
{
	/** http://127.0.0.1:<ULocHubSettings::ServicePort>: the service listens on loopback only. */
	FString GetServiceBaseUrl();

	/** True for InBaseUrl itself or anything under it ("/", "?" or "#" after the port); the editor tab stays on these. */
	bool IsServiceUrl(const FString& InUrl, const FString& InBaseUrl);

	/** Mirrors parseOrigin() in Web/src/origin.ts: "File.cpp(42)", "File.cpp:42" or an object path of an asset. */
	FLocHubOrigin ParseOrigin(const FString& InOrigin);

	/** Fails for absolute paths and for paths that climb out of InProjectDir; never touches the disk. */
	bool ResolveProjectFile(const FString& InRelativePath, const FString& InProjectDir, FString& OutAbsolutePath);

	/** Opens an existing asset in its editor, or an existing project file in the IDE at its line. */
	bool OpenOrigin(const FString& InOrigin, FString& OutError);

	/** Switches the game-localization preview the way the UMG designer does; an empty culture turns it off. */
	bool SetPreviewCulture(const FString& InCulture, FString& OutError);

	/** Reads [{namespace, key, source, translation}] with a non-empty key, source and translation in every item. */
	bool ParseLiveEntries(const TArray<TSharedPtr<FJsonValue>>& InValues, TArray<FLocHubLiveEntry>& OutEntries, FString& OutError);

	/** Writes the entries into the live text table; a translation shows only while its source text still matches. */
	void ApplyLiveEntries(const TArray<FLocHubLiveEntry>& InEntries);

	/** Previews InCulture, waits for its LocRes to finish loading (so the reload cannot overwrite them), applies the entries. */
	bool ApplyLive(const FString& InCulture, const TArray<FLocHubLiveEntry>& InEntries, FString& OutError);

	/** Runs one relayed command: {"name": "OpenOrigin" | "SetPreviewCulture" | "ApplyLive", "args": {...}}. */
	bool ExecuteCommandJson(const FString& InJson, FString& OutError);

	/** Case-sensitive, as Web/src/bridge.ts sends them: "push", "dryrun" or "pull". */
	bool ParseSyncAction(const FString& InAction, ELocHubSyncAction& OutAction);

	/** {"success", "cancelled", "summary", "details"}: the answer ULocHubBrowserBridge::Sync gives the page. */
	FString SyncResultToJson(const FLocHubSyncResult& InResult);

	/** No '/', '\', ':', and not empty, "." or "..": a name IDesktopPlatform::SaveFileDialog could pick as one file. */
	bool IsBareFileName(const FString& InName);

	/** {"cancelled":false,"name":InName,"base64":FBase64::Encode(InBytes)}: raw bytes, no decoding on the C++ side. */
	FString PickedFileToJson(const FString& InName, const TArray<uint8>& InBytes);

	/** {"cancelled":false,"path":InPath}: the answer for a chosen save location. */
	FString SavedFileToJson(const FString& InPath);

	/** {"cancelled":true}: the answer for a dismissed file dialog. */
	FString CancelledJson();
}
