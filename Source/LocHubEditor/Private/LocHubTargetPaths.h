// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "TextLocalizationResourceGenerator.h"

class FLocTextHelper;
class ULocalizationTarget;

/** File layout of one localization target; built from a ULocalizationTarget in the editor or by hand in tests. */
struct FLocHubTargetPaths
{
	static FLocHubTargetPaths FromTarget(const ULocalizationTarget& InTarget);
	/** Target with this name in the project's game target set, or nullptr. */
	static ULocalizationTarget* FindGameTarget(const FString& InName);
	/** The manifest must exist; a missing culture archive is created in memory (a culture that was never translated has none). */
	TSharedPtr<FLocTextHelper> LoadHelper(FText& OutError) const;
	TArray<FString> GetAllCultures() const;

	FString TargetName;
	FString DataDir;
	FString ManifestName;
	FString ArchiveName;
	FString LocResName;
	FString LocMetaName;
	FString NativeCulture;
	TArray<FString> ForeignCultures;
	EGenerateLocResFlags CompileFlags = EGenerateLocResFlags::None;
};
