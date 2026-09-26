// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class FJsonObject;
struct FLocHubArchiveEntry;
struct FLocHubExport;
struct FLocHubExportAck;
struct FLocHubInboxRow;
struct FLocHubPushReport;
struct FLocHubSnapshot;

/** JSON of the service's wire contract (Plugins/LocHub/Service/CONTRACT.md). */
namespace LocHubJson
{
	FString SnapshotToJson(const FLocHubSnapshot& InSnapshot);
	/** `{ "archives": {...} }` -- exactly the archives object of a Push snapshot, for POST /api/reconcile. */
	FString ArchivesToJson(const TMap<FString, TArray<FLocHubArchiveEntry>>& InArchives);
	FString ExportAckToJson(const FLocHubExportAck& InAck);
	FString InboxAppliedToJson(const TArray<FString>& InIds);
	bool ParseHealth(const FString& InJson, bool& bOutOk);
	/** False unless all six counters are present. */
	bool ParsePushReport(const FString& InJson, FLocHubPushReport& OutReport);
	/** False unless "humanEdits" is present (POST /api/reconcile response). */
	bool ParseReconcileReport(const FString& InJson, int32& OutHumanEdits);
	bool ParseExport(const FString& InJson, FLocHubExport& OutExport);
	/** Rows whose unit is null (deleted since the question was asked) are skipped. */
	bool ParseInbox(const FString& InJson, TArray<FLocHubInboxRow>& OutRows);
	TSharedPtr<FJsonObject> ParseObject(const FString& InJson);
	FString ObjectToString(const TSharedRef<FJsonObject>& InObject);
}
