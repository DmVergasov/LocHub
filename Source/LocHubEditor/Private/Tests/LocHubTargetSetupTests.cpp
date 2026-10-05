// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubTargetSetup.h"
#include "LocalizationTargetTypes.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubTargetSetupTestsPrivate
{
	bool HasCulture(const FLocalizationTargetSettings& InSettings, const TCHAR* InCulture)
	{
		for (const FCultureStatistics& Culture : InSettings.SupportedCulturesStatistics)
		{
			if (Culture.CultureName.Equals(InCulture, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	bool HasSearchDirectory(const FLocalizationTargetSettings& InSettings, const TCHAR* InPath)
	{
		for (const FGatherTextSearchDirectory& Directory : InSettings.GatherFromTextFiles.SearchDirectories)
		{
			if (Directory.Path == InPath)
			{
				return true;
			}
		}
		return false;
	}

	bool HasIncludePath(const FLocalizationTargetSettings& InSettings, const TCHAR* InPattern)
	{
		for (const FGatherTextIncludePath& Include : InSettings.GatherFromPackages.IncludePathWildcards)
		{
			if (Include.Pattern == InPattern)
			{
				return true;
			}
		}
		return false;
	}

	bool HasTextFileExclude(const FLocalizationTargetSettings& InSettings, const TCHAR* InPattern)
	{
		for (const FGatherTextExcludePath& Exclude : InSettings.GatherFromTextFiles.ExcludePathWildcards)
		{
			if (Exclude.Pattern == InPattern)
			{
				return true;
			}
		}
		return false;
	}

	/** Fake known-culture check for ConfigureTarget tests: a small fixed set instead of the real engine, so these
	 *  tests do not depend on ICU/engine culture data. FLocHubKnownCultureEngineRuleTest below proves the real
	 *  engine rule (LocHubTargetSetup::IsKnownCulture) against the same names. */
	bool FakeIsKnownCulture(const FString& InName, FString& OutCanonicalName)
	{
		static const TArray<FString> Known = { TEXT("en"), TEXT("de"), TEXT("ja"), TEXT("it"), TEXT("pl"), TEXT("pt-BR"), TEXT("zh-Hans") };
		for (const FString& Name : Known)
		{
			if (Name.Equals(InName, ESearchCase::IgnoreCase))
			{
				OutCanonicalName = Name;
				return true;
			}
		}
		return false;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSetupConfigureTargetTest,
	"LocHub.Setup.ConfigureTarget",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSetupConfigureTargetTest::RunTest(const FString& Parameters)
{
	using namespace LocHubTargetSetupTestsPrivate;

	const TArray<FString> SourceDirs = { TEXT("Source"), TEXT("Plugins/Tool/Source/ToolRuntime") };
	const TArray<FString> ContentDirs = { TEXT("Content"), TEXT("Plugins/Tool/Content") };
	const TArray<FString> Foreign = { TEXT("de"), TEXT("ja") };

	FLocalizationTargetSettings Fresh;
	const TArray<FString> Changes = LocHubTargetSetup::ConfigureTarget(Fresh, true, SourceDirs, ContentDirs, LocHubTargetSetup::DefaultNativeCulture, Foreign, FakeIsKnownCulture);
	TestTrue(TEXT("A new target is changed"), Changes.Num() > 0);
	TestEqual(TEXT("Name"), Fresh.Name, FString(LocHubTargetSetup::TargetName));
	if (TestTrue(TEXT("Native culture index is valid"), Fresh.SupportedCulturesStatistics.IsValidIndex(Fresh.NativeCultureIndex)))
	{
		TestEqual(TEXT("Native culture"), Fresh.SupportedCulturesStatistics[Fresh.NativeCultureIndex].CultureName, FString(LocHubTargetSetup::DefaultNativeCulture));
	}
	TestTrue(TEXT("Foreign culture de"), HasCulture(Fresh, TEXT("de")));
	TestTrue(TEXT("Foreign culture ja"), HasCulture(Fresh, TEXT("ja")));
	TestTrue(TEXT("Project source"), HasSearchDirectory(Fresh, TEXT("Source")));
	TestTrue(TEXT("Plugin source"), HasSearchDirectory(Fresh, TEXT("Plugins/Tool/Source/ToolRuntime")));
	TestTrue(TEXT("Project content"), HasIncludePath(Fresh, TEXT("Content/*")));
	TestTrue(TEXT("Plugin content"), HasIncludePath(Fresh, TEXT("Plugins/Tool/Content/*")));
	TestTrue(TEXT("Editor modules are skipped"), HasTextFileExclude(Fresh, TEXT("Source/*Editor/*")));
	TestTrue(TEXT("Format patterns are validated"), Fresh.CompileSettings.ValidateFormatPatterns);
	TestTrue(TEXT("Rich text tags are validated"), Fresh.CompileSettings.ValidateRichTextTags);

	const int32 SearchDirectoryCount = Fresh.GatherFromTextFiles.SearchDirectories.Num();
	const int32 CultureCount = Fresh.SupportedCulturesStatistics.Num();
	TestEqual(TEXT("Second run changes nothing"), LocHubTargetSetup::ConfigureTarget(Fresh, false, SourceDirs, ContentDirs, LocHubTargetSetup::DefaultNativeCulture, Foreign, FakeIsKnownCulture).Num(), 0);
	TestEqual(TEXT("No duplicate search directories"), Fresh.GatherFromTextFiles.SearchDirectories.Num(), SearchDirectoryCount);
	TestEqual(TEXT("No duplicate cultures"), Fresh.SupportedCulturesStatistics.Num(), CultureCount);

	// A target a person already set up: native "de", a custom folder, format validation deliberately off.
	FLocalizationTargetSettings Existing;
	Existing.Name = LocHubTargetSetup::TargetName;
	Existing.SupportedCulturesStatistics.Add(FCultureStatistics(TEXT("de")));
	Existing.NativeCultureIndex = 0;
	Existing.GatherFromTextFiles.SearchDirectories.AddDefaulted_GetRef().Path = TEXT("Source/Custom");
	Existing.CompileSettings.ValidateFormatPatterns = false;
	LocHubTargetSetup::ConfigureTarget(Existing, false, SourceDirs, ContentDirs, LocHubTargetSetup::DefaultNativeCulture, Foreign, FakeIsKnownCulture);
	TestEqual(TEXT("Native culture is kept"), Existing.SupportedCulturesStatistics[Existing.NativeCultureIndex].CultureName, FString(TEXT("de")));
	TestTrue(TEXT("Foreign culture is added"), HasCulture(Existing, TEXT("ja")));
	TestTrue(TEXT("Custom folder is kept"), HasSearchDirectory(Existing, TEXT("Source/Custom")));
	TestTrue(TEXT("Game source is added"), HasSearchDirectory(Existing, TEXT("Source")));
	TestFalse(TEXT("Compile flags of an existing target are kept"), Existing.CompileSettings.ValidateFormatPatterns);
	TestFalse(TEXT("No exclusion is forced on an existing target"), HasTextFileExclude(Existing, TEXT("Source/*Editor/*")));

	// A person's native culture other than en is kept, a culture already there in another case is not added twice,
	// blank entries are skipped, nothing is ever removed, and names the engine does not recognize as a culture
	// (a typo like "dee" or "zz") are skipped and reported together instead of being added as fake cultures.
	FLocalizationTargetSettings Mixed;
	Mixed.SupportedCulturesStatistics.Add(FCultureStatistics(TEXT("pl")));
	Mixed.SupportedCulturesStatistics.Add(FCultureStatistics(TEXT("DE")));
	Mixed.SupportedCulturesStatistics.Add(FCultureStatistics(TEXT("it")));
	Mixed.NativeCultureIndex = 0;
	const TArray<FString> MixedChanges = LocHubTargetSetup::ConfigureTarget(Mixed, false, SourceDirs, ContentDirs, LocHubTargetSetup::DefaultNativeCulture,
		{ TEXT(" de "), TEXT(""), TEXT("ja"), TEXT("pt-BR"), TEXT("zh-Hans"), TEXT("dee"), TEXT("zz") }, FakeIsKnownCulture);
	TestEqual(TEXT("Native culture pl is kept"), Mixed.SupportedCulturesStatistics[Mixed.NativeCultureIndex].CultureName, FString(TEXT("pl")));
	TestEqual(TEXT("de is not added twice, ja/pt-BR/zh-Hans are added, it stays, dee/zz are rejected"), Mixed.SupportedCulturesStatistics.Num(), 6);
	TestTrue(TEXT("ja added"), HasCulture(Mixed, TEXT("ja")));
	TestTrue(TEXT("it kept"), HasCulture(Mixed, TEXT("it")));
	TestTrue(TEXT("pt-BR added"), HasCulture(Mixed, TEXT("pt-BR")));
	TestTrue(TEXT("zh-Hans added"), HasCulture(Mixed, TEXT("zh-Hans")));
	TestFalse(TEXT("dee is not added"), HasCulture(Mixed, TEXT("dee")));
	TestFalse(TEXT("zz is not added"), HasCulture(Mixed, TEXT("zz")));
	TestTrue(TEXT("Unknown culture names are reported together"), MixedChanges.Contains(TEXT("Skipped unknown culture names: dee, zz.")));

	// An empty list adds no foreign culture, and Set Up says what to do next.
	FLocalizationTargetSettings NativeOnly;
	LocHubTargetSetup::ConfigureTarget(NativeOnly, true, SourceDirs, ContentDirs, LocHubTargetSetup::DefaultNativeCulture, {}, FakeIsKnownCulture);
	TestEqual(TEXT("Only the native culture"), NativeOnly.SupportedCulturesStatistics.Num(), 1);
	TestTrue(TEXT("Hint names the setting"), LocHubTargetSetup::DescribeMissingForeignCultures(NativeOnly).Contains(TEXT("Setup Foreign Cultures")));
	TestTrue(TEXT("No hint once a foreign culture exists"), LocHubTargetSetup::DescribeMissingForeignCultures(Mixed).IsEmpty());

	// A target whose only listed foreign culture is one the engine does not recognize gets no new culture at all --
	// and still gets the missing-foreign-culture hint, instead of that hint being silently defeated by the typo.
	FLocalizationTargetSettings OnlyUnknown;
	LocHubTargetSetup::ConfigureTarget(OnlyUnknown, true, SourceDirs, ContentDirs, LocHubTargetSetup::DefaultNativeCulture, { TEXT("zz") }, FakeIsKnownCulture);
	TestEqual(TEXT("Only the native culture (zz is not a real culture)"), OnlyUnknown.SupportedCulturesStatistics.Num(), 1);
	TestTrue(TEXT("Hint still fires when the only foreign entry was unknown"), LocHubTargetSetup::DescribeMissingForeignCultures(OnlyUnknown).Contains(TEXT("Setup Foreign Cultures")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSetupNativeCultureTest,
	"LocHub.Setup.NativeCulture",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSetupNativeCultureTest::RunTest(const FString& Parameters)
{
	using namespace LocHubTargetSetupTestsPrivate;

	const TArray<FString> SourceDirs = { TEXT("Source") };
	const TArray<FString> ContentDirs = { TEXT("Content") };

	// A new target gets the configured native culture (Setup Native Culture) in the engine's canonical spelling, and
	// English can then be one of its foreign cultures: a Chinese-source project translated into English and Japanese.
	FLocalizationTargetSettings Chinese;
	const TArray<FString> Changes = LocHubTargetSetup::ConfigureTarget(Chinese, true, SourceDirs, ContentDirs, TEXT(" ZH-hans "), { TEXT("en"), TEXT("ja") }, FakeIsKnownCulture);
	if (TestTrue(TEXT("Native culture index is valid"), Chinese.SupportedCulturesStatistics.IsValidIndex(Chinese.NativeCultureIndex)))
	{
		TestEqual(TEXT("Native culture is the configured one, canonical"), Chinese.SupportedCulturesStatistics[Chinese.NativeCultureIndex].CultureName, FString(TEXT("zh-Hans")));
	}
	TestTrue(TEXT("The change names the native culture"), Changes.Contains(TEXT("Native culture: zh-Hans.")));
	TestTrue(TEXT("English is a foreign culture"), HasCulture(Chinese, TEXT("en")));
	TestTrue(TEXT("Japanese is a foreign culture"), HasCulture(Chinese, TEXT("ja")));
	TestEqual(TEXT("Native plus two foreign cultures"), Chinese.SupportedCulturesStatistics.Num(), 3);

	// A target that already has a native culture keeps it: the setting only applies to a target that has none.
	FLocalizationTargetSettings English;
	English.SupportedCulturesStatistics.Add(FCultureStatistics(TEXT("en")));
	English.NativeCultureIndex = 0;
	LocHubTargetSetup::ConfigureTarget(English, false, SourceDirs, ContentDirs, TEXT("zh-Hans"), { TEXT("ja") }, FakeIsKnownCulture);
	TestEqual(TEXT("Existing native culture is kept"), English.SupportedCulturesStatistics[English.NativeCultureIndex].CultureName, FString(TEXT("en")));
	TestFalse(TEXT("The setting's culture is not added"), HasCulture(English, TEXT("zh-Hans")));

	// A setting the engine does not recognize falls back to en, and Set Up says so.
	FLocalizationTargetSettings Typo;
	const TArray<FString> TypoChanges = LocHubTargetSetup::ConfigureTarget(Typo, true, SourceDirs, ContentDirs, TEXT("zh-Hanz"), {}, FakeIsKnownCulture);
	TestEqual(TEXT("Unknown setting falls back to en"), Typo.SupportedCulturesStatistics[Typo.NativeCultureIndex].CultureName, FString(TEXT("en")));
	TestTrue(TEXT("The fallback is reported"), TypoChanges.Contains(TEXT("Unknown native culture \"zh-Hanz\": used en.")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubKnownCultureEngineRuleTest,
	"LocHub.Setup.KnownCulture",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubKnownCultureEngineRuleTest::RunTest(const FString& Parameters)
{
	// Proves the real engine rule LocHubTargetSetup::IsKnownCulture uses (FInternationalization::GetCulture,
	// same as the Localization Dashboard's culture picker) against the exact names the brief calls out: a
	// syntactically plausible but unreal tag is rejected, and a real one is accepted case-insensitively with
	// its canonical spelling stored.
	FString Canonical;
	TestFalse(TEXT("dee is not a culture the engine knows"), LocHubTargetSetup::IsKnownCulture(TEXT("dee"), Canonical));
	TestFalse(TEXT("zz is not a culture the engine knows"), LocHubTargetSetup::IsKnownCulture(TEXT("zz"), Canonical));

	if (TestTrue(TEXT("de resolves"), LocHubTargetSetup::IsKnownCulture(TEXT("de"), Canonical)))
	{
		TestEqual(TEXT("de canonical spelling"), Canonical, FString(TEXT("de")));
	}
	if (TestTrue(TEXT("pt-br resolves case-insensitively"), LocHubTargetSetup::IsKnownCulture(TEXT("pt-br"), Canonical)))
	{
		TestEqual(TEXT("pt-BR canonical spelling"), Canonical, FString(TEXT("pt-BR")));
	}
	if (TestTrue(TEXT("ZH-HANS resolves case-insensitively"), LocHubTargetSetup::IsKnownCulture(TEXT("ZH-HANS"), Canonical)))
	{
		TestEqual(TEXT("zh-Hans canonical spelling"), Canonical, FString(TEXT("zh-Hans")));
	}
	if (TestTrue(TEXT("es-419 resolves"), LocHubTargetSetup::IsKnownCulture(TEXT("es-419"), Canonical)))
	{
		TestEqual(TEXT("es-419 canonical spelling"), Canonical, FString(TEXT("es-419")));
	}
	return true;
}

#endif
