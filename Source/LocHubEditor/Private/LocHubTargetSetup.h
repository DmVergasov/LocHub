// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocalizationTargetSettings;

/** Tools > LocHub > Set Up Localization Target: adds what the game target needs and never removes anything. */
namespace LocHubTargetSetup
{
	inline constexpr const TCHAR* TargetName = TEXT("Game");
	inline constexpr const TCHAR* NativeCulture = TEXT("en");

	/** Whether the engine's Internationalization system recognizes InName as a real culture; on success,
	 *  OutCanonicalName gets the engine's canonical spelling. Same rule the Localization Dashboard's culture
	 *  picker uses to enumerate cultures (SCulturePicker.cpp BuildStockEntries -> FInternationalization::GetCulture,
	 *  UE 5.8): a name ICU can only resolve through its root/default-locale fallback is rejected, not accepted. */
	bool IsKnownCulture(const FString& InName, FString& OutCanonicalName);

	/** Adds the missing pieces to the settings; one line per change, empty when nothing was missing.
	 *  InIsKnownCulture (see IsKnownCulture) decides which entries of InForeignCultures are real cultures;
	 *  the others are skipped and named together in one change line. */
	TArray<FString> ConfigureTarget(FLocalizationTargetSettings& InOutSettings, bool bNewTarget, const TArray<FString>& InSourceDirs, const TArray<FString>& InContentDirs, const TArray<FString>& InForeignCultures, TFunctionRef<bool(const FString& InName, FString& OutCanonicalName)> InIsKnownCulture);

	/** Next step for a target that has no culture besides the native one; empty otherwise. */
	FString DescribeMissingForeignCultures(const FLocalizationTargetSettings& InSettings);

	/**
	 * Finds or creates the target in the game target set, configures it, saves DefaultEditor.ini, writes
	 * Config/Localization/<Target>_*.ini, makes the game load it (DefaultGame.ini) and selects LocHub as the provider.
	 */
	bool ApplyToProject(FString& OutSummary);
}
