// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubImport.h"

#include "Internationalization/InternationalizationArchive.h"
#include "Internationalization/InternationalizationManifest.h"
#include "Internationalization/TextKey.h"
#include "Internationalization/TextLocalizationResource.h"
#include "LocHubTargetPaths.h"
#include "LocHubValidator.h"
#include "LocTextHelper.h"
#include "Misc/Paths.h"
#include "TextLocalizationResourceGenerator.h"

namespace LocHubImportPrivate
{
	void AddRejected(FLocHubImportResult& InOutResult, const FLocHubExportEntry& InEntry, TArray<FString>&& InErrors)
	{
		FLocHubAckRejected& Rejected = InOutResult.Rejected.AddDefaulted_GetRef();
		Rejected.UnitId = InEntry.UnitId;
		Rejected.Namespace = InEntry.Namespace;
		Rejected.Key = InEntry.Key;
		// The service drops a rejection when the cell text changed since the export (contract: ExportAck.rejected).
		Rejected.Translation = InEntry.Translation;
		Rejected.Errors = MoveTemp(InErrors);
	}
}

FLocHubImportResult LocHubImport::Import(FLocTextHelper& InOutHelper, const FString& InCulture, const TArray<FLocHubExportEntry>& InEntries, const FLocHubGlyphChecker* InGlyphChecker)
{
	FLocHubImportResult Result;
	for (const FLocHubExportEntry& Entry : InEntries)
	{
		const TSharedPtr<FManifestEntry> ManifestEntry = InOutHelper.FindSourceText(Entry.Namespace, Entry.Key);
		const FManifestContext* Context = ManifestEntry.IsValid() ? ManifestEntry->FindContextByKey(Entry.Key) : nullptr;
		if (Context == nullptr)
		{
			++Result.SkippedUnknown;
			continue;
		}
		if (!ManifestEntry->Source.Text.Equals(Entry.Source, ESearchCase::CaseSensitive))
		{
			++Result.SkippedStale;
			continue;
		}

		TArray<FString> Errors;
		if (!LocHubValidator::Validate(InCulture, Entry.Source, Entry.Translation, InGlyphChecker, Errors))
		{
			LocHubImportPrivate::AddRejected(Result, Entry, MoveTemp(Errors));
			continue;
		}

		// Same calls and comparisons as the PO import (PortableObjectPipeline.cpp:285-310, UE 5.8).
		FLocItem ExportedSource;
		FLocItem ExportedTranslation;
		InOutHelper.GetExportText(InCulture, Entry.Namespace, Entry.Key, Context->KeyMetadataObj, ELocTextExportSourceMethod::NativeText, ManifestEntry->Source, ExportedSource, ExportedTranslation);
		const TSharedPtr<FArchiveEntry> Existing = InOutHelper.FindTranslation(InCulture, Entry.Namespace, Entry.Key, Context->KeyMetadataObj);
		const bool bUnchanged = Existing.IsValid()
			&& Existing->Source.Text.Equals(ExportedSource.Text, ESearchCase::CaseSensitive)
			&& Existing->Translation.Text.Equals(Entry.Translation, ESearchCase::CaseSensitive);
		if (!bUnchanged)
		{
			if (!InOutHelper.ImportTranslation(InCulture, Entry.Namespace, Entry.Key, Context->KeyMetadataObj, FLocItem(ExportedSource.Text), FLocItem(Entry.Translation), Context->bIsOptional))
			{
				LocHubImportPrivate::AddRejected(Result, Entry, { TEXT("The engine did not accept the translation into the archive.") });
				continue;
			}
			Result.bArchiveChanged = true;
		}

		FLocHubAckWritten& Written = Result.Written.AddDefaulted_GetRef();
		Written.UnitId = Entry.UnitId;
		Written.Translation = Entry.Translation;
	}
	return Result;
}

bool LocHubImport::SaveArchive(FLocTextHelper& InOutHelper, const FString& InCulture, FString& OutError)
{
	InOutHelper.TrimArchive(InCulture);
	FText SaveError;
	if (!InOutHelper.SaveArchive(InCulture, &SaveError))
	{
		OutError = SaveError.ToString();
		return false;
	}
	return true;
}

bool LocHubImport::CompileLocRes(const FLocTextHelper& InHelper, const FLocHubTargetPaths& InPaths, FString& OutError)
{
	// File layout and ids follow GenerateTextLocalizationResourceCommandlet.cpp:180-259 (UE 5.8).
	const FString LocMetaPath = InPaths.DataDir / InPaths.LocMetaName;
	FTextLocalizationMetaDataResource LocMeta;
	if (!FTextLocalizationResourceGenerator::GenerateLocMeta(InHelper, InPaths.LocResName, LocMeta) || !LocMeta.SaveToFile(LocMetaPath))
	{
		OutError = FString::Printf(TEXT("Could not write %s."), *LocMetaPath);
		return false;
	}

	for (const FString& Culture : InPaths.GetAllCultures())
	{
		const FString LocResPath = InPaths.DataDir / Culture / InPaths.LocResName;
		FTextLocalizationResource PlatformAgnosticLocRes;
		TMap<FName, TSharedRef<FTextLocalizationResource>> PerPlatformLocRes;
		if (!FTextLocalizationResourceGenerator::GenerateLocRes(InHelper, Culture, InPaths.CompileFlags, FTextKey(LocResPath), PlatformAgnosticLocRes, PerPlatformLocRes))
		{
			OutError = FString::Printf(TEXT("Could not compile %s."), *LocResPath);
			return false;
		}
		if (!PlatformAgnosticLocRes.SaveToFile(LocResPath))
		{
			OutError = FString::Printf(TEXT("Could not write %s."), *LocResPath);
			return false;
		}
		for (const TPair<FName, TSharedRef<FTextLocalizationResource>>& Pair : PerPlatformLocRes)
		{
			const FString PlatformPath = InPaths.DataDir / FPaths::GetPlatformLocalizationFolderName() / Pair.Key.ToString() / Culture / InPaths.LocResName;
			if (!Pair.Value->SaveToFile(PlatformPath))
			{
				OutError = FString::Printf(TEXT("Could not write %s."), *PlatformPath);
				return false;
			}
		}
	}
	return true;
}
