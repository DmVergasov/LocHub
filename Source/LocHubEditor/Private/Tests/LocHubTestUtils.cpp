// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "LocTextHelper.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"

FString LocHubTests::MakeTempDir()
{
	const FString Root = FPaths::ConvertRelativePathToFull(FPlatformProcess::UserTempDir());
	const FString Dir = Root / TEXT("LocHubTests") / FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT("/");
	IFileManager::Get().MakeDirectory(*Dir, true);
	return Dir;
}

void LocHubTests::DeleteTempDir(const FString& InDir)
{
	IFileManager::Get().DeleteDirectory(*InDir, false, true);
}

FLocHubTargetPaths LocHubTests::WriteTarget(const FString& InDataDir, const TArray<FTestUnit>& InUnits)
{
	FLocHubTargetPaths Paths;
	Paths.TargetName = TEXT("Test");
	Paths.DataDir = InDataDir;
	Paths.ManifestName = TEXT("Test.manifest");
	Paths.ArchiveName = TEXT("Test.archive");
	Paths.LocResName = TEXT("Test.locres");
	Paths.LocMetaName = TEXT("Test.locmeta");
	Paths.NativeCulture = TEXT("en");
	Paths.ForeignCultures = { TEXT("ru") };
	Paths.CompileFlags = EGenerateLocResFlags::ValidateFormatPatterns;

	FLocTextHelper Helper(Paths.DataDir, Paths.ManifestName, Paths.ArchiveName, Paths.NativeCulture, Paths.ForeignCultures, nullptr);
	Helper.LoadAll(ELocTextHelperLoadFlags::Create);
	for (const FTestUnit& Unit : InUnits)
	{
		FManifestContext Context;
		Context.Key = Unit.Key;
		Context.SourceLocation = Unit.Origin;
		// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
		Context.DevNotes = Unit.DevNotes;
#endif
		Helper.AddSourceText(Namespace, FLocItem(Unit.Source), Context);
		Helper.AddTranslation(Paths.NativeCulture, Namespace, Unit.Key, nullptr, FLocItem(Unit.Source), FLocItem(Unit.Source), false);
		if (!Unit.RuTranslation.IsEmpty())
		{
			Helper.AddTranslation(TEXT("ru"), Namespace, Unit.Key, nullptr, FLocItem(Unit.Source), FLocItem(Unit.RuTranslation), false);
		}
	}
	Helper.SaveAll();
	return Paths;
}

bool LocHubTests::WriteTextFile(const FString& InPath, const FString& InText)
{
	return FFileHelper::SaveStringToFile(InText, *InPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}

#endif
