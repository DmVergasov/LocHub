// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "LocHubTypes.h"

class FLocHubGlyphChecker;
class FLocTextHelper;
struct FLocHubTargetPaths;

/** What happened to the entries of one export. */
struct FLocHubImportResult
{
	/** Passed the engine checks and are in the archive now (changed or not). */
	TArray<FLocHubAckWritten> Written;
	/** Failed the engine checks; the archive keeps what it had. */
	TArray<FLocHubAckRejected> Rejected;
	/** The manifest has a different English text; the service re-translates after the next Push. */
	int32 SkippedStale = 0;
	/** The key is not in the manifest any more. */
	int32 SkippedUnknown = 0;
	bool bArchiveChanged = false;
};

namespace LocHubImport
{
	/** Validates every entry and imports the good ones into the culture's archive in memory. */
	FLocHubImportResult Import(FLocTextHelper& InOutHelper, const FString& InCulture, const TArray<FLocHubExportEntry>& InEntries, const FLocHubGlyphChecker* InGlyphChecker);
	/** Drops archive entries that left the manifest and writes the culture's archive file. */
	bool SaveArchive(FLocTextHelper& InOutHelper, const FString& InCulture, FString& OutError);
	/** Writes the .locmeta and a .locres per culture (and per platform split), like the Compile Text step of the Dashboard. */
	bool CompileLocRes(const FLocTextHelper& InHelper, const FLocHubTargetPaths& InPaths, FString& OutError);
}
