// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSnapshot.h"

#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "Internationalization/InternationalizationArchive.h"
#include "Internationalization/InternationalizationManifest.h"
#include "Internationalization/InternationalizationMetadata.h"
#include "LocHubTargetPaths.h"
#include "LocHubTypes.h"
#include "LocTextHelper.h"
#include "Misc/EngineVersionComparison.h"

namespace LocHubSnapshotPrivate
{
	using FUnitKey = TPair<FLocKey, FLocKey>;

	void AddEntries(const FManifestEntry& InEntry, const TArray<FString>& InUiSourcePatterns, TSet<FUnitKey>& InOutSeen, TArray<FLocHubSnapshotEntry>& OutEntries)
	{
		for (const FManifestContext& Context : InEntry.Contexts)
		{
			// Several contexts can carry one key (platform splits); the service identifies a unit by (namespace, key).
			bool bAlreadySeen = false;
			InOutSeen.Add(FUnitKey(InEntry.Namespace, Context.Key), &bAlreadySeen);
			if (bAlreadySeen)
			{
				continue;
			}

			FLocHubSnapshotEntry& Entry = OutEntries.AddDefaulted_GetRef();
			Entry.Namespace = InEntry.Namespace.GetString();
			Entry.Key = Context.Key.GetString();
			Entry.Source = InEntry.Source.Text;
			Entry.Origin = Context.SourceLocation.Replace(TEXT("\\"), TEXT("/"));
			// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
			Entry.DevNotes = Context.DevNotes;
#endif
			if (Context.InfoMetadataObj.IsValid())
			{
				for (const TPair<FString, TSharedPtr<FLocMetadataValue>>& Pair : Context.InfoMetadataObj->Values)
				{
					if (Pair.Value.IsValid())
					{
						Entry.Metadata.Add(Pair.Key, Pair.Value->ToString());
					}
				}
			}
			Entry.Metadata.Add(LocHub::KindMetadataKey, LocHubSnapshot::KindFor(Entry.Origin, InUiSourcePatterns));
			Entry.GroupKey = LocHubSnapshot::GroupKeyFor(Entry.Origin, Entry.Namespace);
		}
	}

	void AddArchiveEntry(const FArchiveEntry& InEntry, TArray<FLocHubArchiveEntry>& OutArchive)
	{
		if (InEntry.Translation.Text.IsEmpty())
		{
			return;
		}
		FLocHubArchiveEntry& Entry = OutArchive.AddDefaulted_GetRef();
		Entry.Namespace = InEntry.Namespace.GetString();
		Entry.Key = InEntry.Key.GetString();
		// The source the translation was made for; UE keeps stale foreign entries, the service compares this with the current source.
		Entry.Source = InEntry.Source.Text;
		Entry.Translation = InEntry.Translation.Text;
	}
}

bool LocHubSnapshot::Build(const FLocHubTargetPaths& InPaths, const TArray<FString>& InUiSourcePatterns, FLocHubSnapshot& OutSnapshot, FString& OutError)
{
	FText LoadError;
	const TSharedPtr<FLocTextHelper> Helper = InPaths.LoadHelper(LoadError);
	if (!Helper.IsValid())
	{
		OutError = FString::Printf(TEXT("Cannot read localization target %s: %s Run Gather Text in the Localization Dashboard first."), *InPaths.TargetName, *LoadError.ToString());
		return false;
	}

	OutSnapshot.Target = InPaths.TargetName;
	OutSnapshot.NativeCulture = InPaths.NativeCulture;
	OutSnapshot.Cultures = InPaths.GetAllCultures();
	OutSnapshot.Entries.Reset();
	OutSnapshot.Archives.Reset();

	TSet<LocHubSnapshotPrivate::FUnitKey> Seen;
	TArray<FLocHubSnapshotEntry>& Entries = OutSnapshot.Entries;
	Helper->EnumerateSourceTexts([&InUiSourcePatterns, &Seen, &Entries](TSharedRef<FManifestEntry> InEntry) -> bool
	{
		LocHubSnapshotPrivate::AddEntries(*InEntry, InUiSourcePatterns, Seen, Entries);
		return true;
	}, true);

	for (const FString& Culture : InPaths.ForeignCultures)
	{
		TArray<FLocHubArchiveEntry>& Archive = OutSnapshot.Archives.FindOrAdd(Culture);
		Helper->EnumerateTranslations(Culture, [&Archive](TSharedRef<FArchiveEntry> InEntry) -> bool
		{
			LocHubSnapshotPrivate::AddArchiveEntry(*InEntry, Archive);
			return true;
		}, true);
	}

	OutSnapshot.PluralForms.Reset();
	for (const FString& Culture : OutSnapshot.Cultures)
	{
		FLocHubPluralForms Forms;
		if (GetEnginePluralForms(Culture, Forms))
		{
			OutSnapshot.PluralForms.Add(Culture, MoveTemp(Forms));
		}
	}
	return true;
}

FString LocHubSnapshot::PluralFormName(const ETextPluralForm InForm)
{
	switch (InForm)
	{
	case ETextPluralForm::Zero:
		return TEXT("zero");
	case ETextPluralForm::One:
		return TEXT("one");
	case ETextPluralForm::Two:
		return TEXT("two");
	case ETextPluralForm::Few:
		return TEXT("few");
	case ETextPluralForm::Many:
		return TEXT("many");
	default:
		return TEXT("other");
	}
}

bool LocHubSnapshot::GetEnginePluralForms(const FString& InCulture, FLocHubPluralForms& OutForms)
{
	const FCulturePtr Culture = FInternationalization::Get().GetCulture(InCulture);
	if (!Culture.IsValid())
	{
		return false;
	}
	OutForms.Cardinal.Reset();
	OutForms.Ordinal.Reset();
	for (const ETextPluralForm Form : Culture->GetValidPluralForms(ETextPluralType::Cardinal))
	{
		OutForms.Cardinal.Add(PluralFormName(Form));
	}
	for (const ETextPluralForm Form : Culture->GetValidPluralForms(ETextPluralType::Ordinal))
	{
		OutForms.Ordinal.Add(PluralFormName(Form));
	}
	return true;
}

FString LocHubSnapshot::GroupKeyFor(const FString& InOrigin, const FString& InNamespace)
{
	const FString Origin = InOrigin.Replace(TEXT("\\"), TEXT("/"));
	if (Origin.IsEmpty())
	{
		return InNamespace;
	}
	if (Origin.StartsWith(TEXT("/"), ESearchCase::CaseSensitive))
	{
		// "/Game/UI/WBP_Pause.WBP_Pause_C:WidgetTree..." -> "/Game/UI/WBP_Pause"; package names cannot contain dots.
		int32 DotIndex = INDEX_NONE;
		return Origin.FindChar(TEXT('.'), DotIndex) ? Origin.Left(DotIndex) : Origin;
	}
	const int32 ParenIndex = Origin.Find(TEXT("("), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
	if (ParenIndex != INDEX_NONE && Origin.EndsWith(TEXT(")"), ESearchCase::CaseSensitive))
	{
		return Origin.Left(ParenIndex);
	}
	return Origin;
}

FString LocHubSnapshot::KindFor(const FString& InOrigin, const TArray<FString>& InUiSourcePatterns)
{
	for (const FString& Pattern : InUiSourcePatterns)
	{
		if (InOrigin.MatchesWildcard(Pattern))
		{
			return LocHub::KindUi;
		}
	}
	return LocHub::KindText;
}
