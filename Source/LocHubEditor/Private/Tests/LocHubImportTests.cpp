// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Internationalization/InternationalizationArchive.h"
#include "Internationalization/TextKey.h"
#include "Internationalization/TextLocalizationResource.h"
#include "LocHubImport.h"
#include "LocHubTypes.h"
#include "LocTextHelper.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubImportTestsPrivate
{
	FString ArchiveText(const FLocTextHelper& InHelper, const TCHAR* InKey)
	{
		const TSharedPtr<FArchiveEntry> Entry = InHelper.FindTranslation(TEXT("ru"), LocHubTests::Namespace, InKey, nullptr);
		return Entry.IsValid() ? Entry->Translation.Text : FString();
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubImportAndCompileTest,
	"LocHub.Import.ImportAndCompile",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubImportAndCompileTest::RunTest(const FString& Parameters)
{
	using namespace LocHubImportTestsPrivate;

	const FString TempDir = LocHubTests::MakeTempDir();
	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Data"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("/Game/UI/WBP_Pause.WBP_Pause_C:WidgetTree.Title.Text"), FString(), FString() },
		{ TEXT("Bales"), TEXT("{Count} bales"), TEXT("Source/Game/Hud.cpp(20)"), FString(), TEXT("old {Count}") },
		{ TEXT("Load"), TEXT("Load"), TEXT("Source/Game/Jobs/Loader.cpp(12)"), FString(), FString() },
	});

	FText LoadError;
	const TSharedPtr<FLocTextHelper> Helper = Paths.LoadHelper(LoadError);
	if (!TestTrue(TEXT("Helper loads"), Helper.IsValid()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}

	const TArray<FLocHubExportEntry> Entries = {
		{ TEXT("u1"), LocHubTests::Namespace, TEXT("Pause"), TEXT("Pause"), TEXT("Pause RU") },
		// Uses an argument the source does not have: the check rejects it and the old translation stays.
		{ TEXT("u2"), LocHubTests::Namespace, TEXT("Bales"), TEXT("{Count} bales"), TEXT("{Count} {Broken} RU") },
		// Translated against an older English text than the gathered manifest has.
		{ TEXT("u3"), LocHubTests::Namespace, TEXT("Load"), TEXT("Load the truck"), TEXT("Load RU") },
		{ TEXT("u4"), LocHubTests::Namespace, TEXT("Gone"), TEXT("Gone"), TEXT("Gone RU") },
	};
	const FLocHubImportResult Result = LocHubImport::Import(*Helper, TEXT("ru"), Entries, nullptr);

	if (TestEqual(TEXT("One written"), Result.Written.Num(), 1))
	{
		TestEqual(TEXT("Written unit"), Result.Written[0].UnitId, TEXT("u1"));
		TestEqual(TEXT("Written translation"), Result.Written[0].Translation, TEXT("Pause RU"));
	}
	if (TestEqual(TEXT("One rejected"), Result.Rejected.Num(), 1))
	{
		TestEqual(TEXT("Rejected unit"), Result.Rejected[0].UnitId, TEXT("u2"));
		// Namespace/key are carried so the runner can log a readable rejection line.
		TestEqual(TEXT("Rejection carries the namespace"), Result.Rejected[0].Namespace, FString(LocHubTests::Namespace));
		TestEqual(TEXT("Rejection carries the key"), Result.Rejected[0].Key, TEXT("Bales"));
		TestEqual(TEXT("Rejection carries the rejected text"), Result.Rejected[0].Translation, TEXT("{Count} {Broken} RU"));
		TestTrue(TEXT("Rejection says why"), Result.Rejected[0].Errors.Num() > 0);
	}
	TestEqual(TEXT("Stale skipped"), Result.SkippedStale, 1);
	TestEqual(TEXT("Unknown skipped"), Result.SkippedUnknown, 1);
	TestTrue(TEXT("Archive changed"), Result.bArchiveChanged);

	FString SaveError;
	TestTrue(TEXT("Archive saves"), LocHubImport::SaveArchive(*Helper, TEXT("ru"), SaveError));

	FText ReloadError;
	const TSharedPtr<FLocTextHelper> Reloaded = Paths.LoadHelper(ReloadError);
	if (!TestTrue(TEXT("Helper reloads"), Reloaded.IsValid()))
	{
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}
	TestEqual(TEXT("Accepted translation is in the archive"), ArchiveText(*Reloaded, TEXT("Pause")), TEXT("Pause RU"));
	TestEqual(TEXT("Rejected translation left the old one"), ArchiveText(*Reloaded, TEXT("Bales")), TEXT("old {Count}"));
	TestTrue(TEXT("Stale translation is not written"), ArchiveText(*Reloaded, TEXT("Load")).IsEmpty());

	const FLocHubImportResult Again = LocHubImport::Import(*Reloaded, TEXT("ru"), { Entries[0] }, nullptr);
	TestEqual(TEXT("Unchanged translation is still acknowledged"), Again.Written.Num(), 1);
	TestFalse(TEXT("Unchanged translation does not touch the archive"), Again.bArchiveChanged);

	FString CompileError;
	if (!TestTrue(TEXT("LocRes compiles"), LocHubImport::CompileLocRes(*Reloaded, Paths, CompileError)))
	{
		AddError(CompileError);
	}
	TestTrue(TEXT("LocMeta"), FPaths::FileExists(Paths.DataDir / Paths.LocMetaName));
	TestTrue(TEXT("Native LocRes"), FPaths::FileExists(Paths.DataDir / TEXT("en") / Paths.LocResName));

	const FString RuLocResPath = Paths.DataDir / TEXT("ru") / Paths.LocResName;
	FTextLocalizationResource RuLocRes;
	if (TestTrue(TEXT("ru LocRes loads"), RuLocRes.LoadFromFile(RuLocResPath, 0)))
	{
		const FTextLocalizationResource::FEntry* Entry = RuLocRes.Entries.Find(FTextId(FTextKey(LocHubTests::Namespace), FTextKey(TEXT("Pause"))));
		if (TestNotNull(TEXT("Translated entry is compiled"), Entry) && TestTrue(TEXT("Entry has text"), Entry->LocalizedString.IsValid()))
		{
			TestEqual(TEXT("Compiled translation"), *Entry->LocalizedString, TEXT("Pause RU"));
		}
	}

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

#endif
