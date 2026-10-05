// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocalizationTargetSettings;

/** Tools > LocHub > Set Up Localization Target: adds what the game target needs and never removes anything. */
namespace LocHubTargetSetup
{
	inline constexpr const TCHAR* TargetName = TEXT("Game");
	/** Native culture Set Up gives a target that has none, when Setup Native Culture is empty or not a culture. */
	inline constexpr const TCHAR* DefaultNativeCulture = TEXT("en");

	/** Whether the engine's Internationalization system recognizes InName as a real culture; on success,
	 *  OutCanonicalName gets the engine's canonical spelling. Same rule the Localization Dashboard's culture
	 *  picker uses to enumerate cultures (SCulturePicker.cpp BuildStockEntries -> FInternationalization::GetCulture,
	 *  UE 5.8): a name ICU can only resolve through its root/default-locale fallback is rejected, not accepted. */
	bool IsKnownCulture(const FString& InName, FString& OutCanonicalName);

	/** Adds the missing pieces to the settings; one line per change, empty when nothing was missing.
	 *  InNativeCulture is used only by a target without a native culture; one that already has one keeps it.
	 *  InIsKnownCulture (see IsKnownCulture) decides which names are real cultures: an unknown native culture
	 *  falls back to DefaultNativeCulture, unknown entries of InForeignCultures are skipped, and each is named
	 *  in a change line. */
	TArray<FString> ConfigureTarget(FLocalizationTargetSettings& InOutSettings, bool bNewTarget, const TArray<FString>& InSourceDirs, const TArray<FString>& InContentDirs, const FString& InNativeCulture, const TArray<FString>& InForeignCultures, TFunctionRef<bool(const FString& InName, FString& OutCanonicalName)> InIsKnownCulture);

	/** Next step for a target that has no culture besides the native one; empty otherwise. */
	FString DescribeMissingForeignCultures(const FLocalizationTargetSettings& InSettings);

	/**
	 * Finds or creates the target in the game target set, configures it, saves DefaultEditor.ini, writes
	 * Config/Localization/<Target>_*.ini, makes the game load it (DefaultGame.ini) and selects LocHub as the provider.
	 */
	bool ApplyToProject(FString& OutSummary);
}
