// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSnapshot.h"
#include "LocHubTypes.h"
#include "Misc/AutomationTest.h"
#include "Misc/EngineVersionComparison.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubSnapshotTestsPrivate
{
	const FLocHubSnapshotEntry* FindEntry(const FLocHubSnapshot& InSnapshot, const TCHAR* InKey)
	{
		for (const FLocHubSnapshotEntry& Entry : InSnapshot.Entries)
		{
			if (Entry.Key.Equals(InKey, ESearchCase::CaseSensitive))
			{
				return &Entry;
			}
		}
		return nullptr;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSnapshotBuildTest,
	"LocHub.Snapshot.Build",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSnapshotBuildTest::RunTest(const FString& Parameters)
{
	const FString TempDir = LocHubTests::MakeTempDir();
	const FLocHubTargetPaths Paths = LocHubTests::WriteTarget(TempDir / TEXT("Data"), {
		{ TEXT("Pause"), TEXT("Pause"), TEXT("/Game/UI/WBP_Pause.WBP_Pause_C:WidgetTree.Title.Text"), TEXT("Title of the pause menu"), TEXT("Pause RU") },
		{ TEXT("Load"), TEXT("Load"), TEXT("Source/Game/Jobs/Loader.cpp(12)"), FString(), FString() },
	});

	FLocHubSnapshot Snapshot;
	FString Error;
	if (!TestTrue(TEXT("Snapshot builds"), LocHubSnapshot::Build(Paths, { TEXT("*/UI/*") }, Snapshot, Error)))
	{
		AddError(Error);
		LocHubTests::DeleteTempDir(TempDir);
		return false;
	}

	TestEqual(TEXT("Target"), Snapshot.Target, TEXT("Test"));
	TestEqual(TEXT("Native culture"), Snapshot.NativeCulture, TEXT("en"));
	TestEqual(TEXT("Cultures"), Snapshot.Cultures.Num(), 2);
	TestEqual(TEXT("Entries"), Snapshot.Entries.Num(), 2);
	TestFalse(TEXT("Coverage is the caller's job"), Snapshot.bHasCoverage);

	const FLocHubSnapshotEntry* Pause = LocHubSnapshotTestsPrivate::FindEntry(Snapshot, TEXT("Pause"));
	if (TestNotNull(TEXT("Pause entry"), Pause))
	{
		TestEqual(TEXT("Namespace"), Pause->Namespace, FString(LocHubTests::Namespace));
		TestEqual(TEXT("Source"), Pause->Source, TEXT("Pause"));
// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
		TestEqual(TEXT("DevNotes"), Pause->DevNotes, TEXT("Title of the pause menu"));
#else
		TestTrue(TEXT("No developer notes before UE 5.8"), Pause->DevNotes.IsEmpty());
#endif
		TestEqual(TEXT("Asset group"), Pause->GroupKey, TEXT("/Game/UI/WBP_Pause"));
		const FString* Kind = Pause->Metadata.Find(LocHub::KindMetadataKey);
		if (TestNotNull(TEXT("Kind metadata"), Kind))
		{
			TestEqual(TEXT("Widget text"), *Kind, FString(LocHub::KindUi));
		}
	}

	const FLocHubSnapshotEntry* Load = LocHubSnapshotTestsPrivate::FindEntry(Snapshot, TEXT("Load"));
	if (TestNotNull(TEXT("Load entry"), Load))
	{
		TestEqual(TEXT("File group"), Load->GroupKey, TEXT("Source/Game/Jobs/Loader.cpp"));
		const FString* Kind = Load->Metadata.Find(LocHub::KindMetadataKey);
		if (TestNotNull(TEXT("Kind metadata"), Kind))
		{
			TestEqual(TEXT("Prose"), *Kind, FString(LocHub::KindText));
		}
	}

	const TArray<FLocHubArchiveEntry>* Ru = Snapshot.Archives.Find(TEXT("ru"));
	if (TestNotNull(TEXT("ru archive"), Ru) && TestEqual(TEXT("Only translated units"), Ru->Num(), 1))
	{
		TestEqual(TEXT("Archive key"), (*Ru)[0].Key, TEXT("Pause"));
		TestEqual(TEXT("Archive source is the source stored with the translation"), (*Ru)[0].Source, TEXT("Pause"));
		TestEqual(TEXT("Archive translation"), (*Ru)[0].Translation, TEXT("Pause RU"));
	}
	TestNull(TEXT("No archive for the native culture"), Snapshot.Archives.Find(TEXT("en")));

	// The engine's plural forms travel for the native culture and every target culture.
	TestEqual(TEXT("Plural forms for every culture"), Snapshot.PluralForms.Num(), Snapshot.Cultures.Num());
	for (const FString& Culture : Snapshot.Cultures)
	{
		const FLocHubPluralForms* Forms = Snapshot.PluralForms.Find(Culture);
		if (TestNotNull(*FString::Printf(TEXT("Plural forms of %s"), *Culture), Forms))
		{
			TestTrue(*FString::Printf(TEXT("%s cardinal has 'other'"), *Culture), Forms->Cardinal.Contains(TEXT("other")));
			TestTrue(*FString::Printf(TEXT("%s ordinal has 'other'"), *Culture), Forms->Ordinal.Contains(TEXT("other")));
		}
	}

	FLocHubTargetPaths Missing = Paths;
	Missing.DataDir = TempDir / TEXT("NoSuchData");
	FLocHubSnapshot MissingSnapshot;
	FString MissingError;
	TestFalse(TEXT("No manifest, no snapshot"), LocHubSnapshot::Build(Missing, {}, MissingSnapshot, MissingError));
	TestFalse(TEXT("The error says why"), MissingError.IsEmpty());

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubSnapshotRulesTest,
	"LocHub.Snapshot.Rules",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubSnapshotRulesTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("Asset origin groups by package"), LocHubSnapshot::GroupKeyFor(TEXT("/Game/UI/WBP_Pause.WBP_Pause_C:WidgetTree.Title.Text"), TEXT("Ns")), TEXT("/Game/UI/WBP_Pause"));
	TestEqual(TEXT("Source origin groups by file"), LocHubSnapshot::GroupKeyFor(TEXT("Source/Game/Hud.cpp(10)"), TEXT("Ns")), TEXT("Source/Game/Hud.cpp"));
	TestEqual(TEXT("Backslashes become slashes"), LocHubSnapshot::GroupKeyFor(TEXT("Source\\Game\\Hud.cpp(10)"), TEXT("Ns")), TEXT("Source/Game/Hud.cpp"));
	TestEqual(TEXT("No origin groups by namespace"), LocHubSnapshot::GroupKeyFor(FString(), TEXT("Ns")), TEXT("Ns"));

	TestEqual(TEXT("UI pattern"), LocHubSnapshot::KindFor(TEXT("/Game/UI/WBP_Pause.WBP_Pause_C"), { TEXT("*/UI/*") }), FString(LocHub::KindUi));
	TestEqual(TEXT("Other origin"), LocHubSnapshot::KindFor(TEXT("Source/Game/Jobs/Loader.cpp(12)"), { TEXT("*/UI/*") }), FString(LocHub::KindText));
	TestEqual(TEXT("No patterns"), LocHubSnapshot::KindFor(TEXT("/Game/UI/WBP_Pause"), {}), FString(LocHub::KindText));
	return true;
}

#endif
