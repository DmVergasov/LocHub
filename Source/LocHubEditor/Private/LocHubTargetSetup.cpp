// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubTargetSetup.h"

#include "Features/IModularFeatures.h"
#include "HAL/PlatformFileManager.h"
#include "ILocalizationServiceModule.h"
#include "ILocalizationServiceProvider.h"
#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "LocHubEnvironment.h"
#include "LocHubSettings.h"
#include "LocHubTargetPaths.h"
#include "LocHubTypes.h"
#include "LocalizationConfigurationScript.h"
#include "LocalizationSettings.h"
#include "LocalizationTargetTypes.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/ConfigContext.h"
#include "Misc/Paths.h"

namespace LocHubTargetSetupPrivate
{
	int32 FindCulture(const FLocalizationTargetSettings& InSettings, const FString& InCulture)
	{
		for (int32 Index = 0; Index < InSettings.SupportedCulturesStatistics.Num(); ++Index)
		{
			if (InSettings.SupportedCulturesStatistics[Index].CultureName.Equals(InCulture, ESearchCase::IgnoreCase))
			{
				return Index;
			}
		}
		return INDEX_NONE;
	}

	void EnsureCultures(FLocalizationTargetSettings& InOutSettings, const FString& InNativeCulture, const TArray<FString>& InForeignCultures, TFunctionRef<bool(const FString& InName, FString& OutCanonicalName)> InIsKnownCulture, TArray<FString>& OutChanges)
	{
		// Only a target without a valid native culture gets the configured one; a native culture a person chose is kept.
		if (!InOutSettings.SupportedCulturesStatistics.IsValidIndex(InOutSettings.NativeCultureIndex))
		{
			FString Native = LocHubTargetSetup::DefaultNativeCulture;
			const FString Requested = InNativeCulture.TrimStartAndEnd();
			FString Canonical;
			if (!Requested.IsEmpty() && InIsKnownCulture(Requested, Canonical))
			{
				Native = Canonical;
			}
			else if (!Requested.IsEmpty())
			{
				OutChanges.Add(FString::Printf(TEXT("Unknown native culture \"%s\": used %s."), *Requested, LocHubTargetSetup::DefaultNativeCulture));
			}

			int32 NativeIndex = FindCulture(InOutSettings, Native);
			if (NativeIndex == INDEX_NONE)
			{
				NativeIndex = InOutSettings.SupportedCulturesStatistics.Add(FCultureStatistics(Native));
			}
			InOutSettings.NativeCultureIndex = NativeIndex;
			OutChanges.Add(FString::Printf(TEXT("Native culture: %s."), *Native));
		}
		else
		{
			// Said every time the two differ: a person who changed the setting after the first Set Up would otherwise
			// read "already set up" and believe LocHub now translates from the new culture.
			const FString& Existing = InOutSettings.SupportedCulturesStatistics[InOutSettings.NativeCultureIndex].CultureName;
			const FString Requested = InNativeCulture.TrimStartAndEnd();
			FString Canonical;
			if (!Requested.IsEmpty() && InIsKnownCulture(Requested, Canonical) && !Canonical.Equals(Existing, ESearchCase::IgnoreCase))
			{
				OutChanges.Add(FString::Printf(TEXT("Native culture %s kept: Setup Native Culture (%s) applies only to a target without one; change an existing target's native culture in the Localization Dashboard."), *Existing, *Canonical));
			}
		}

		// Free-text entries the engine cannot resolve to a real culture (a typo like "dee" or "zz") are not
		// silently turned into a "culture" of the target -- they are skipped and named together, once, so the
		// operator can fix Setup Foreign Cultures instead of getting a false "Added culture" success line.
		TArray<FString> SkippedNames;
		for (const FString& Raw : InForeignCultures)
		{
			const FString Trimmed = Raw.TrimStartAndEnd();
			if (Trimmed.IsEmpty())
			{
				continue;
			}

			FString Canonical;
			if (!InIsKnownCulture(Trimmed, Canonical))
			{
				SkippedNames.Add(Trimmed);
				continue;
			}

			if (FindCulture(InOutSettings, Canonical) != INDEX_NONE)
			{
				continue;
			}
			InOutSettings.SupportedCulturesStatistics.Add(FCultureStatistics(Canonical));
			OutChanges.Add(FString::Printf(TEXT("Added culture %s."), *Canonical));
		}
		if (!SkippedNames.IsEmpty())
		{
			OutChanges.Add(FString::Printf(TEXT("Skipped unknown culture names: %s."), *FString::Join(SkippedNames, TEXT(", "))));
		}
	}

	bool HasSearchDirectory(const FGatherTextFromTextFilesConfiguration& InConfig, const FString& InPath)
	{
		for (const FGatherTextSearchDirectory& Directory : InConfig.SearchDirectories)
		{
			if (Directory.Path.Equals(InPath, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	bool HasIncludePath(const FGatherTextFromPackagesConfiguration& InConfig, const FString& InPattern)
	{
		for (const FGatherTextIncludePath& Include : InConfig.IncludePathWildcards)
		{
			if (Include.Pattern.Equals(InPattern, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	void EnsureTextFileGather(FGatherTextFromTextFilesConfiguration& InOutConfig, const bool bNewTarget, const TArray<FString>& InSourceDirs, TArray<FString>& OutChanges)
	{
		if (!InOutConfig.IsEnabled)
		{
			InOutConfig.IsEnabled = true;
			OutChanges.Add(TEXT("Gather from text files is on."));
		}
		for (const FString& Dir : InSourceDirs)
		{
			if (!HasSearchDirectory(InOutConfig, Dir))
			{
				InOutConfig.SearchDirectories.AddDefaulted_GetRef().Path = Dir;
				OutChanges.Add(FString::Printf(TEXT("Gathers C++ text from %s."), *Dir));
			}
		}
		if (bNewTarget)
		{
			InOutConfig.ExcludePathWildcards.AddDefaulted_GetRef().Pattern = TEXT("Source/*Editor/*");
			OutChanges.Add(TEXT("Skips editor modules (Source/*Editor/*)."));
		}
	}

	void EnsurePackageGather(FGatherTextFromPackagesConfiguration& InOutConfig, const TArray<FString>& InContentDirs, TArray<FString>& OutChanges)
	{
		if (!InOutConfig.IsEnabled)
		{
			InOutConfig.IsEnabled = true;
			OutChanges.Add(TEXT("Gather from packages is on."));
		}
		for (const FString& Dir : InContentDirs)
		{
			const FString Pattern = Dir + TEXT("/*");
			if (!HasIncludePath(InOutConfig, Pattern))
			{
				InOutConfig.IncludePathWildcards.AddDefaulted_GetRef().Pattern = Pattern;
				OutChanges.Add(FString::Printf(TEXT("Gathers asset text from %s."), *Pattern));
			}
		}
	}

	/** Same steps as the Dashboard's "Game" loading policy (LocalizationTargetDetailCustomization.cpp:614-716, UE 5.8). */
	bool EnsureGameLoadingPath(const ULocalizationTarget& InTarget)
	{
		const FString DataDirectory = LocalizationConfigurationScript::GetDataDirectory(&InTarget);
		TArray<FString> LocalizationPaths;
		GConfig->GetArray(TEXT("Internationalization"), TEXT("LocalizationPaths"), LocalizationPaths, GGameIni);
		if (LocalizationPaths.Contains(DataDirectory))
		{
			return false;
		}

		const FString DefaultGameIni = FPaths::SourceConfigDir() + TEXT("DefaultGame.ini");
		FConfigFile IniFile;
		FConfigCacheIni::LoadLocalIniFile(IniFile, TEXT("DefaultGame"), false);
		IniFile.AddToSection(TEXT("Internationalization"), TEXT("+LocalizationPaths"), FConfigValue::CollapseValue(DataDirectory));

		IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
		if (PlatformFile.FileExists(*DefaultGameIni) && PlatformFile.IsReadOnly(*DefaultGameIni))
		{
			PlatformFile.SetReadOnly(*DefaultGameIni, false);
		}
		IniFile.Dirty = true;
		IniFile.UpdateSections(*DefaultGameIni);
		FConfigContext::ForceReloadIntoGConfig().Load(TEXT("Game"));
		return true;
	}

	bool SelectLocHubProvider()
	{
		const FName LocHubName(LocHub::ProviderName);
		ILocalizationServiceModule& LocalizationService = ILocalizationServiceModule::Get();
		if (LocalizationService.GetProvider().GetName() == LocHubName)
		{
			return false;
		}
		// SetProvider with a name nobody registered is fatal (LocalizationServiceModule.cpp:161-175).
		const TArray<ILocalizationServiceProvider*> Providers = IModularFeatures::Get().GetModularFeatureImplementations<ILocalizationServiceProvider>(TEXT("LocalizationService"));
		for (const ILocalizationServiceProvider* Provider : Providers)
		{
			if (Provider != nullptr && Provider->GetName() == LocHubName)
			{
				LocalizationService.SetProvider(LocHubName);
				return true;
			}
		}
		return false;
	}
}

bool LocHubTargetSetup::IsKnownCulture(const FString& InName, FString& OutCanonicalName)
{
	const FCulturePtr Culture = FInternationalization::Get().GetCulture(InName);
	if (!Culture.IsValid())
	{
		return false;
	}
	OutCanonicalName = Culture->GetName();
	return true;
}

TArray<FString> LocHubTargetSetup::ConfigureTarget(FLocalizationTargetSettings& InOutSettings, const bool bNewTarget, const TArray<FString>& InSourceDirs, const TArray<FString>& InContentDirs, const FString& InNativeCulture, const TArray<FString>& InForeignCultures, TFunctionRef<bool(const FString& InName, FString& OutCanonicalName)> InIsKnownCulture)
{
	TArray<FString> Changes;
	if (InOutSettings.Name.IsEmpty())
	{
		InOutSettings.Name = TargetName;
		Changes.Add(FString::Printf(TEXT("Target name: %s."), TargetName));
	}
	LocHubTargetSetupPrivate::EnsureCultures(InOutSettings, InNativeCulture, InForeignCultures, InIsKnownCulture, Changes);
	LocHubTargetSetupPrivate::EnsureTextFileGather(InOutSettings.GatherFromTextFiles, bNewTarget, InSourceDirs, Changes);
	LocHubTargetSetupPrivate::EnsurePackageGather(InOutSettings.GatherFromPackages, InContentDirs, Changes);
	if (bNewTarget)
	{
		InOutSettings.CompileSettings.ValidateFormatPatterns = true;
		InOutSettings.CompileSettings.ValidateRichTextTags = true;
		Changes.Add(TEXT("Compile Text validates format patterns and rich text tags."));
	}
	return Changes;
}

FString LocHubTargetSetup::DescribeMissingForeignCultures(const FLocalizationTargetSettings& InSettings)
{
	if (InSettings.SupportedCulturesStatistics.Num() <= 1)
	{
		return TEXT("The target has no culture to translate into: list cultures in Project Settings > Plugins > LocHub > Setup Foreign Cultures, then run Set Up again, or add them in the Localization Dashboard.");
	}
	return FString();
}

bool LocHubTargetSetup::ApplyToProject(FString& OutSummary)
{
	ULocalizationTargetSet* TargetSet = ULocalizationSettings::GetGameTargetSet();
	if (!IsValid(TargetSet))
	{
		OutSummary = TEXT("LocHub setup failed: the project has no game localization target set.");
		return false;
	}

	ULocalizationTarget* Target = FLocHubTargetPaths::FindGameTarget(TargetName);
	const bool bNewTarget = !IsValid(Target);
	if (bNewTarget)
	{
		Target = NewObject<ULocalizationTarget>(TargetSet);
		TargetSet->TargetObjects.Add(Target);
	}

	const FString ProjectDir = LocHubEnvironment::GetProjectDir();
	const ULocHubSettings* Settings = GetDefault<ULocHubSettings>();
	TArray<FString> Changes = ConfigureTarget(Target->Settings, bNewTarget, LocHubEnvironment::GetGameSourceDirs(ProjectDir), LocHubEnvironment::GetGameContentDirs(ProjectDir), Settings->SetupNativeCulture, Settings->SetupForeignCultures, &IsKnownCulture);

	// Copies the target settings into ULocalizationSettings and writes them to the default config file.
	TargetSet->PostEditChange();
	LocalizationConfigurationScript::GenerateAllConfigFiles(Target);
	if (LocHubTargetSetupPrivate::EnsureGameLoadingPath(*Target))
	{
		Changes.Add(TEXT("The game loads this target (DefaultGame.ini, [Internationalization] LocalizationPaths)."));
	}
	if (LocHubTargetSetupPrivate::SelectLocHubProvider())
	{
		Changes.Add(TEXT("LocHub is the localization service of the Localization Dashboard."));
	}

	OutSummary = Changes.IsEmpty()
		? FString::Printf(TEXT("Localization target %s is already set up for LocHub."), TargetName)
		: FString::Printf(TEXT("Localization target %s set up: %s"), TargetName, *FString::Join(Changes, TEXT(" ")));

	const FString MissingForeignCulturesHint = DescribeMissingForeignCultures(Target->Settings);
	if (!MissingForeignCulturesHint.IsEmpty())
	{
		OutSummary += TEXT("\n") + MissingForeignCulturesHint;
	}
	return true;
}
