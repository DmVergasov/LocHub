// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubTargetPaths.h"

#include "LocTextHelper.h"
#include "LocalizationConfigurationScript.h"
#include "LocalizationSettings.h"
#include "LocalizationTargetTypes.h"
#include "Misc/Paths.h"

FLocHubTargetPaths FLocHubTargetPaths::FromTarget(const ULocalizationTarget& InTarget)
{
	const FLocalizationTargetSettings& Settings = InTarget.Settings;

	FLocHubTargetPaths Paths;
	Paths.TargetName = Settings.Name;
	Paths.DataDir = FPaths::ConvertRelativePathToFull(LocalizationConfigurationScript::GetDataDirectory(&InTarget));
	Paths.ManifestName = LocalizationConfigurationScript::GetManifestFileName(&InTarget);
	Paths.ArchiveName = LocalizationConfigurationScript::GetArchiveFileName(&InTarget);
	Paths.LocResName = LocalizationConfigurationScript::GetLocResFileName(&InTarget);
	Paths.LocMetaName = LocalizationConfigurationScript::GetLocMetaFileName(&InTarget);
	for (int32 Index = 0; Index < Settings.SupportedCulturesStatistics.Num(); ++Index)
	{
		const FString& Culture = Settings.SupportedCulturesStatistics[Index].CultureName;
		if (Index == Settings.NativeCultureIndex)
		{
			Paths.NativeCulture = Culture;
		}
		else
		{
			Paths.ForeignCultures.Add(Culture);
		}
	}

	// Same flag mapping as GenerateTextLocalizationResourceCommandlet.cpp:138-166 (UE 5.8).
	const FLocalizationCompilationSettings& Compile = Settings.CompileSettings;
	if (Compile.SkipSourceCheck)
	{
		Paths.CompileFlags |= EGenerateLocResFlags::AllowStaleTranslations;
	}
	if (Compile.ValidateFormatPatterns)
	{
		Paths.CompileFlags |= EGenerateLocResFlags::ValidateFormatPatterns;
	}
	if (Compile.ValidateSafeWhitespace)
	{
		Paths.CompileFlags |= EGenerateLocResFlags::ValidateSafeWhitespace;
	}
	if (Compile.ValidateRichTextTags)
	{
		Paths.CompileFlags |= EGenerateLocResFlags::ValidateRichTextTags;
	}
	return Paths;
}

ULocalizationTarget* FLocHubTargetPaths::FindGameTarget(const FString& InName)
{
	const ULocalizationTargetSet* TargetSet = ULocalizationSettings::GetGameTargetSet();
	if (!IsValid(TargetSet))
	{
		return nullptr;
	}
	for (ULocalizationTarget* Target : TargetSet->TargetObjects)
	{
		if (IsValid(Target) && Target->Settings.Name == InName)
		{
			return Target;
		}
	}
	return nullptr;
}

TSharedPtr<FLocTextHelper> FLocHubTargetPaths::LoadHelper(FText& OutError) const
{
	const TSharedPtr<FLocTextHelper> Helper = MakeShared<FLocTextHelper>(DataDir, ManifestName, ArchiveName, NativeCulture, ForeignCultures, nullptr);
	if (!Helper->LoadManifest(ELocTextHelperLoadFlags::Load, &OutError))
	{
		return nullptr;
	}
	if (!Helper->LoadAllArchives(ELocTextHelperLoadFlags::LoadOrCreate, &OutError))
	{
		return nullptr;
	}
	return Helper;
}

TArray<FString> FLocHubTargetPaths::GetAllCultures() const
{
	TArray<FString> Cultures;
	if (!NativeCulture.IsEmpty())
	{
		Cultures.Add(NativeCulture);
	}
	Cultures.Append(ForeignCultures);
	return Cultures;
}
