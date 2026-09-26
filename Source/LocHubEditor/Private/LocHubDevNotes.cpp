// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubDevNotes.h"

#include "FileHelpers.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/Text.h"
#include "Internationalization/TextNamespaceUtil.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/TextProperty.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UObjectHash.h"
#include "UObject/UnrealType.h"

namespace LocHubDevNotesPrivate
{
	FString SingleLine(const FString& InText)
	{
		FString Result = InText.Replace(TEXT("\r\n"), TEXT(" ")).Replace(TEXT("\n"), TEXT(" ")).Replace(TEXT("\r"), TEXT(" "));
		Result.TrimStartAndEndInline();
		return Result;
	}

	bool IsTextWithKey(const FText& InText, const FString& InNamespace, const FString& InKey)
	{
		if (InText.IsFromStringTable() || !InText.ShouldGatherForLocalization())
		{
			return false;
		}
		const TOptional<FString> Namespace = FTextInspector::GetNamespace(InText);
		const TOptional<FString> Key = FTextInspector::GetKey(InText);
		if (!Namespace.IsSet() || !Key.IsSet())
		{
			return false;
		}
		return Key.GetValue().Equals(InKey, ESearchCase::CaseSensitive)
			&& TextNamespaceUtil::StripPackageNamespace(Namespace.GetValue()).Equals(InNamespace, ESearchCase::CaseSensitive);
	}

	// Developer notes on texts (FText::GetDevNotes, FStringTableEntry::GetDevNotes, FManifestContext::DevNotes) exist from UE 5.8 on.
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	bool WriteToStringTable(UStringTable& InTable, const FString& InNamespace, const FString& InKey, const TArray<LocHubDevNotes::FQuestionAndAnswer>& InQuestionsAndAnswers, bool& bOutChanged)
	{
		const FStringTableRef Table = InTable.GetMutableStringTable();
		if (!Table->GetNamespace().Equals(InNamespace, ESearchCase::CaseSensitive))
		{
			return false;
		}
		const FStringTableEntryConstPtr Entry = Table->FindEntry(InKey);
		if (!Entry.IsValid())
		{
			return false;
		}

		const FString SourceString = Entry->GetSourceString();
		const FString CurrentNotes = Entry->GetDevNotes();
		const FString NewNotes = LocHubDevNotes::MergeDevNotes(CurrentNotes, InQuestionsAndAnswers);
		if (NewNotes.Equals(CurrentNotes, ESearchCase::CaseSensitive))
		{
			return true;
		}
		InTable.Modify();
		Table->SetSourceString(InKey, SourceString, NewNotes);
		bOutChanged = true;
		return true;
	}
#endif
}

FString LocHubDevNotes::FormatAnswer(const FString& InQuestion, const FString& InAnswer)
{
	return FString::Printf(TEXT("Q: %s A: %s"), *LocHubDevNotesPrivate::SingleLine(InQuestion), *LocHubDevNotesPrivate::SingleLine(InAnswer));
}

bool LocHubDevNotes::IsAnswerInDevNotes(const FString& InDevNotes, const FString& InAnswerLine)
{
	const FString Line = InAnswerLine.TrimStartAndEnd();
	if (Line.IsEmpty())
	{
		return false;
	}
	// A substring match would find "Q: X A: Verb" inside "Q: X A: Verbs"; compare whole trimmed lines instead.
	TArray<FString> Lines;
	InDevNotes.ParseIntoArrayLines(Lines, false);
	for (const FString& NotesLine : Lines)
	{
		if (NotesLine.TrimStartAndEnd().Equals(Line, ESearchCase::CaseSensitive))
		{
			return true;
		}
	}
	return false;
}

FString LocHubDevNotes::MergeDevNotes(const FString& InDevNotes, const TArray<FQuestionAndAnswer>& InQuestionsAndAnswers)
{
	FString Result = InDevNotes;
	for (const FQuestionAndAnswer& QuestionAndAnswer : InQuestionsAndAnswers)
	{
		const FString Line = FormatAnswer(QuestionAndAnswer.Key, QuestionAndAnswer.Value);
		if (IsAnswerInDevNotes(Result, Line))
		{
			continue;
		}
		if (!Result.IsEmpty())
		{
			Result += TEXT("\n");
		}
		Result += Line;
	}
	return Result;
}

FString LocHubDevNotes::PackageNameFromOrigin(const FString& InOrigin)
{
	if (!InOrigin.StartsWith(TEXT("/"), ESearchCase::CaseSensitive))
	{
		return FString();
	}
	int32 DotIndex = INDEX_NONE;
	return InOrigin.FindChar(TEXT('.'), DotIndex) ? InOrigin.Left(DotIndex) : InOrigin;
}

bool LocHubDevNotes::WriteToObject(UObject& InObject, const FString& InNamespace, const FString& InKey, const TArray<FQuestionAndAnswer>& InQuestionsAndAnswers, bool& bOutChanged)
{
	bOutChanged = false;
#if UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
	if (UStringTable* StringTable = Cast<UStringTable>(&InObject))
	{
		return LocHubDevNotesPrivate::WriteToStringTable(*StringTable, InNamespace, InKey, InQuestionsAndAnswers, bOutChanged);
	}

	bool bFound = false;
	bool bModifyCalled = false;
	for (TPropertyValueIterator<FTextProperty> It(InObject.GetClass(), &InObject); It; ++It)
	{
		// WHY: the iterator hands out const addresses only; the object is ours to edit and Modify() runs before the first write.
		FText* Text = const_cast<FText*>(static_cast<const FText*>(It.Value()));
		if (!LocHubDevNotesPrivate::IsTextWithKey(*Text, InNamespace, InKey))
		{
			continue;
		}
		bFound = true;

		const FString CurrentNotes = Text->GetDevNotes();
		const FString NewNotes = MergeDevNotes(CurrentNotes, InQuestionsAndAnswers);
		if (NewNotes.Equals(CurrentNotes, ESearchCase::CaseSensitive))
		{
			continue;
		}
		if (!bModifyCalled)
		{
			InObject.Modify();
			bModifyCalled = true;
		}
		// The full namespace keeps the package suffix the editor adds to asset texts.
		const FString FullNamespace = FTextInspector::GetNamespace(*Text).Get(FString());
		*Text = FText::ChangeKey(FullNamespace, InKey, *Text, NewNotes);
		bOutChanged = true;
	}
	return bFound;
#else
	// Pull stops before any write on these engines (FLocHubSyncRunner::PullOnInbox): texts have no notes to write.
	return false;
#endif
}

bool LocHubDevNotes::WriteToAsset(const FString& InOrigin, const FString& InNamespace, const FString& InKey, const TArray<FQuestionAndAnswer>& InQuestionsAndAnswers, FString& OutError)
{
	const FString PackageName = PackageNameFromOrigin(InOrigin);
	if (PackageName.IsEmpty())
	{
		OutError = TEXT("The text is not in an asset (C++ or no origin).");
		return false;
	}
	if (const UPackage* Loaded = FindPackage(nullptr, *PackageName))
	{
		if (Loaded->IsDirty())
		{
			OutError = FString::Printf(TEXT("%s has unsaved changes; save it and Pull again."), *PackageName);
			return false;
		}
	}
	if (!FPackageName::DoesPackageExist(PackageName))
	{
		OutError = FString::Printf(TEXT("Asset %s does not exist."), *PackageName);
		return false;
	}
	UPackage* Package = LoadPackage(nullptr, *PackageName, LOAD_None);
	if (!IsValid(Package))
	{
		OutError = FString::Printf(TEXT("Asset %s could not be loaded."), *PackageName);
		return false;
	}

	bool bFound = false;
	bool bChanged = false;
	ForEachObjectWithPackage(Package, [&InNamespace, &InKey, &InQuestionsAndAnswers, &bFound, &bChanged](UObject* InObject) -> bool
	{
		bool bObjectChanged = false;
		bFound |= LocHubDevNotes::WriteToObject(*InObject, InNamespace, InKey, InQuestionsAndAnswers, bObjectChanged);
		bChanged |= bObjectChanged;
		return true;
	});

	if (!bFound)
	{
		OutError = FString::Printf(TEXT("No text with this key is stored in %s as a property (for example a Blueprint graph literal)."), *PackageName);
		return false;
	}
	if (bChanged && !UEditorLoadingAndSavingUtils::SavePackages({ Package }, true))
	{
		OutError = FString::Printf(TEXT("%s could not be saved (read-only file?)."), *PackageName);
		return false;
	}
	return true;
}

FString LocHubDevNotes::BuildProposalMarkdown(const TArray<FLocHubDevNotesProposal>& InProposals)
{
	if (InProposals.IsEmpty())
	{
		return FString();
	}

	FString Markdown;
	Markdown += TEXT("# LocHub: developer notes to add by hand\n\n");
	Markdown += TEXT("Pull could not write these translator answers into the texts. Add each proposed note where the text is defined, ");
	Markdown += TEXT("run Gather Text and Pull again; the question closes once the manifest has the note.\n\n");
	Markdown += TEXT("- C++: replace LOCTEXT(Key, Text) with NOTELOCTEXT(Key, Text, Notes) and NSLOCTEXT(Namespace, Key, Text) with NSNOTELOCTEXT(Namespace, Key, Text, Notes).\n");
	Markdown += TEXT("- Asset: save its pending changes and Pull again, or edit the text's developer notes in the asset.\n");
	for (const FLocHubDevNotesProposal& Proposal : InProposals)
	{
		Markdown += FString::Printf(TEXT("\n## %s, %s\n\n"), *Proposal.Namespace, *Proposal.Key);
		Markdown += FString::Printf(TEXT("- Origin: `%s`\n"), *Proposal.Origin);
		Markdown += FString::Printf(TEXT("- Source: %s\n"), *LocHubDevNotesPrivate::SingleLine(Proposal.Source));
		Markdown += FString::Printf(TEXT("- Not written because: %s\n"), *Proposal.Reason);
		Markdown += TEXT("- Proposed notes:\n\n");
		TArray<FString> Lines;
		Proposal.ProposedDevNotes.ParseIntoArrayLines(Lines, false);
		for (const FString& Line : Lines)
		{
			Markdown += TEXT("        ") + Line + TEXT("\n");
		}
	}
	return Markdown;
}
