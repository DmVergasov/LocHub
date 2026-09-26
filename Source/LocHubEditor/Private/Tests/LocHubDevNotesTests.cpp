// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Components/TextRenderComponent.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/Text.h"
#include "LocHubDevNotes.h"
#include "Misc/AutomationTest.h"
#include "Misc/EngineVersionComparison.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubDevNotesAnswersTest,
	"LocHub.DevNotes.Answers",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubDevNotesAnswersTest::RunTest(const FString& Parameters)
{
	using LocHubDevNotes::FQuestionAndAnswer;
	const TArray<FQuestionAndAnswer> Answers = { FQuestionAndAnswer(TEXT("Q1"), TEXT("A1")) };

	TestEqual(TEXT("Answer line"), LocHubDevNotes::FormatAnswer(TEXT(" Q1 "), TEXT("A1\n")), TEXT("Q: Q1 A: A1"));
	const FString Merged = LocHubDevNotes::MergeDevNotes(TEXT("Existing"), Answers);
	TestEqual(TEXT("Appended on a new line"), Merged, TEXT("Existing\nQ: Q1 A: A1"));
	TestEqual(TEXT("Merging twice changes nothing"), LocHubDevNotes::MergeDevNotes(Merged, Answers), Merged);
	TestEqual(TEXT("Empty notes"), LocHubDevNotes::MergeDevNotes(FString(), Answers), TEXT("Q: Q1 A: A1"));
	TestTrue(TEXT("Answer is found"), LocHubDevNotes::IsAnswerInDevNotes(Merged, TEXT("Q: Q1 A: A1")));
	TestFalse(TEXT("Other answer is not"), LocHubDevNotes::IsAnswerInDevNotes(Merged, TEXT("Q: Q2 A: A2")));
	TestFalse(TEXT("Empty line never counts"), LocHubDevNotes::IsAnswerInDevNotes(Merged, FString()));

	// A substring match must not find "A: Verb" inside a longer line "A: Verbs"; only a whole line counts.
	TestFalse(TEXT("A shorter line is not a substring match of a longer one"), LocHubDevNotes::IsAnswerInDevNotes(TEXT("Q: Verb or noun? A: Verbs"), TEXT("Q: Verb or noun? A: Verb")));
	TestTrue(TEXT("An exact line is still found"), LocHubDevNotes::IsAnswerInDevNotes(TEXT("Q: Verb or noun? A: Verb"), TEXT("Q: Verb or noun? A: Verb")));

	TestEqual(TEXT("Widget origin"), LocHubDevNotes::PackageNameFromOrigin(TEXT("/Game/UI/WBP_Pause.WBP_Pause_C:WidgetTree.Title.Text")), TEXT("/Game/UI/WBP_Pause"));
	TestEqual(TEXT("String table origin"), LocHubDevNotes::PackageNameFromOrigin(TEXT("/Game/Loc/ST_Hud.ST_Hud")), TEXT("/Game/Loc/ST_Hud"));
	TestTrue(TEXT("Source origin"), LocHubDevNotes::PackageNameFromOrigin(TEXT("Source/Game/Hud.cpp(10)")).IsEmpty());
	TestTrue(TEXT("No origin"), LocHubDevNotes::PackageNameFromOrigin(FString()).IsEmpty());

	// Refusals.
	FString Error;
	TestFalse(TEXT("Source origin is not an asset"), LocHubDevNotes::WriteToAsset(TEXT("Source/Game/Hud.cpp(10)"), TEXT("Ns"), TEXT("Key"), Answers, Error));
	TestFalse(TEXT("Refusal says why"), Error.IsEmpty());
	Error.Reset();
	TestFalse(TEXT("Missing asset"), LocHubDevNotes::WriteToAsset(TEXT("/Game/LocHubTests/NoSuchAsset.NoSuchAsset"), TEXT("Ns"), TEXT("Key"), Answers, Error));
	TestFalse(TEXT("Missing asset says why"), Error.IsEmpty());

	UPackage* DirtyPackage = CreatePackage(TEXT("/Temp/LocHubTests/DirtyAsset"));
	DirtyPackage->SetFlags(RF_Transient);
	DirtyPackage->SetDirtyFlag(true);
	Error.Reset();
	TestFalse(TEXT("Asset with unsaved changes is not touched"), LocHubDevNotes::WriteToAsset(TEXT("/Temp/LocHubTests/DirtyAsset.DirtyAsset:Text"), TEXT("Ns"), TEXT("Key"), Answers, Error));
	TestTrue(TEXT("Refusal names unsaved changes"), Error.Contains(TEXT("unsaved")));
	DirtyPackage->SetDirtyFlag(false);

	// Proposals file.
	TestTrue(TEXT("No proposals, no file text"), LocHubDevNotes::BuildProposalMarkdown({}).IsEmpty());
	FLocHubDevNotesProposal Proposal;
	Proposal.Namespace = TEXT("Ns");
	Proposal.Key = TEXT("Key");
	Proposal.Origin = TEXT("Source/Game/Hud.cpp(10)");
	Proposal.Source = TEXT("Pause");
	Proposal.ProposedDevNotes = TEXT("Q: Verb or noun? A: Verb");
	Proposal.Reason = TEXT("The origin is not an asset.");
	const FString Markdown = LocHubDevNotes::BuildProposalMarkdown({ Proposal });
	TestTrue(TEXT("Heading names the unit"), Markdown.Contains(TEXT("Ns, Key")));
	TestTrue(TEXT("Origin is listed"), Markdown.Contains(TEXT("Source/Game/Hud.cpp(10)")));
	TestTrue(TEXT("Proposed notes are listed"), Markdown.Contains(TEXT("Q: Verb or noun? A: Verb")));
	TestTrue(TEXT("C++ macro is named"), Markdown.Contains(TEXT("NOTELOCTEXT")));
	return true;
}

// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubDevNotesWriterTest,
	"LocHub.DevNotes.Writer",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubDevNotesWriterTest::RunTest(const FString& Parameters)
{
	using LocHubDevNotes::FQuestionAndAnswer;
	const TArray<FQuestionAndAnswer> Answers = { FQuestionAndAnswer(TEXT("Q1"), TEXT("A1")) };

	// An FText property of an object.
	UTextRenderComponent* TextRender = NewObject<UTextRenderComponent>(GetTransientPackage());
	TextRender->Text = FText::AsLocalizable_Advanced(TEXT("LocHubTestNs"), TEXT("LocHubTestKey"), TEXT("Pause"));
	bool bChanged = false;
	TestTrue(TEXT("Text property is found"), LocHubDevNotes::WriteToObject(*TextRender, TEXT("LocHubTestNs"), TEXT("LocHubTestKey"), Answers, bChanged));
	TestTrue(TEXT("Text property changed"), bChanged);
	TestTrue(TEXT("DevNotes written"), TextRender->Text.GetDevNotes().Contains(TEXT("Q: Q1 A: A1")));
	TestEqual(TEXT("Key kept"), FTextInspector::GetKey(TextRender->Text).Get(FString()), TEXT("LocHubTestKey"));
	const FString* SourceString = FTextInspector::GetSourceString(TextRender->Text);
	if (TestNotNull(TEXT("Source kept"), SourceString))
	{
		TestEqual(TEXT("Source text"), *SourceString, TEXT("Pause"));
	}
	TestTrue(TEXT("Second write finds the text"), LocHubDevNotes::WriteToObject(*TextRender, TEXT("LocHubTestNs"), TEXT("LocHubTestKey"), Answers, bChanged));
	TestFalse(TEXT("Second write changes nothing"), bChanged);
	TestFalse(TEXT("Other key is not found"), LocHubDevNotes::WriteToObject(*TextRender, TEXT("LocHubTestNs"), TEXT("OtherKey"), Answers, bChanged));

	// A String Table entry.
	UStringTable* Table = NewObject<UStringTable>(GetTransientPackage());
	Table->GetMutableStringTable()->SetNamespace(TEXT("LocHubTestTable"));
	Table->GetMutableStringTable()->SetSourceString(TEXT("Hello"), TEXT("Hello"), FString());
	TestTrue(TEXT("Table entry is found"), LocHubDevNotes::WriteToObject(*Table, TEXT("LocHubTestTable"), TEXT("Hello"), Answers, bChanged));
	TestTrue(TEXT("Table entry changed"), bChanged);
	const FStringTableEntryConstPtr Entry = Table->GetStringTable()->FindEntry(TEXT("Hello"));
	if (TestTrue(TEXT("Entry still exists"), Entry.IsValid()))
	{
		TestTrue(TEXT("Table DevNotes written"), Entry->GetDevNotes().Contains(TEXT("Q: Q1 A: A1")));
		TestEqual(TEXT("Table source kept"), Entry->GetSourceString(), TEXT("Hello"));
	}
	TestFalse(TEXT("Other table namespace"), LocHubDevNotes::WriteToObject(*Table, TEXT("OtherTable"), TEXT("Hello"), Answers, bChanged));
	return true;
}

#endif

#endif
