// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

namespace LocHub
{
	/** Metadata key the service reads to tell widget text from prose (Service/CONTRACT.md). */
	inline constexpr const TCHAR* KindMetadataKey = TEXT("LocHub.Kind");
	inline constexpr const TCHAR* KindUi = TEXT("ui");
	inline constexpr const TCHAR* KindText = TEXT("text");

	inline constexpr const TCHAR* CoverageKindFromString = TEXT("FromString");
	inline constexpr const TCHAR* CoverageKindRmlLiteral = TEXT("RmlLiteral");

	/** Name of the localization service provider; ILocalizationServiceModule::SetProvider selects it by this name. */
	inline constexpr const TCHAR* ProviderName = TEXT("LocHub");
}

/** One manifest context as the service sees it (Service/CONTRACT.md). */
struct FLocHubSnapshotEntry
{
	FString Namespace;
	FString Key;
	FString Source;
	FString Origin;
	FString DevNotes;
	TMap<FString, FString> Metadata;
	FString GroupKey;
};

/** Current archive translation of one unit (Service/CONTRACT.md, ArchiveEntry). */
struct FLocHubArchiveEntry
{
	FString Namespace;
	FString Key;
	/** The source text the translation was made for, as stored in the foreign archive; the service ignores the entry when it is not the current source. */
	FString Source;
	FString Translation;
};

/** A player-visible string that bypasses localization (Service/CONTRACT.md, CoverageFinding). */
struct FLocHubCoverageFinding
{
	FString Kind;
	FString File;
	int32 Line = 0;
	FString Text;
};

/** CLDR names of the plural forms the engine validates one culture's plural modifiers against (Service/CONTRACT.md, PluralForms). */
struct FLocHubPluralForms
{
	TArray<FString> Cardinal;
	TArray<FString> Ordinal;
};

/** Body of POST /api/push (Service/CONTRACT.md, Snapshot). */
struct FLocHubSnapshot
{
	FString Target;
	FString NativeCulture;
	TArray<FString> Cultures;
	TArray<FLocHubSnapshotEntry> Entries;
	TMap<FString, TArray<FLocHubArchiveEntry>> Archives;
	/** False: the "coverage" field is left out and the service keeps the previous report. */
	bool bHasCoverage = false;
	TArray<FLocHubCoverageFinding> Coverage;
	/** Per culture of the snapshot the engine resolves; the service uses its own ICU data for any culture left out. */
	TMap<FString, FLocHubPluralForms> PluralForms;
};

/** Response of POST /api/push (Service/CONTRACT.md, PushReport). */
struct FLocHubPushReport
{
	int32 Added = 0;
	int32 Changed = 0;
	int32 Cosmetic = 0;
	int32 Tombstoned = 0;
	int32 Revived = 0;
	int32 HumanEdits = 0;
};

/** One releasable translation from GET /api/export (Service/CONTRACT.md, ExportEntry). */
struct FLocHubExportEntry
{
	FString UnitId;
	FString Namespace;
	FString Key;
	FString Source;
	FString Translation;
};

/** Response of GET /api/export. */
struct FLocHubExport
{
	FString Culture;
	FString Policy;
	TArray<FLocHubExportEntry> Entries;
};

struct FLocHubAckWritten
{
	FString UnitId;
	FString Translation;
};

struct FLocHubAckRejected
{
	FString UnitId;
	/** Carried only for the Output Log line; not part of the wire body. */
	FString Namespace;
	FString Key;
	/** Exactly the text the engine rejected; the service ignores a rejection of a text the cell no longer holds. */
	FString Translation;
	TArray<FString> Errors;
};

/** Body of POST /api/export/ack (Service/CONTRACT.md). */
struct FLocHubExportAck
{
	FString Culture;
	TArray<FLocHubAckWritten> Written;
	TArray<FLocHubAckRejected> Rejected;
};

/** An answered translator question from GET /api/inbox, with the unit it belongs to. */
struct FLocHubInboxRow
{
	FString Id;
	FString UnitId;
	FString Culture;
	FString Question;
	FString Answer;
	FString Namespace;
	FString Key;
	FString Source;
	FString Origin;
	FString DevNotes;
};
