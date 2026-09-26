// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class UObject;

/** An answer Pull could not write into an asset; it goes to Saved/LocHub/DevNotesProposals.md. */
struct FLocHubDevNotesProposal
{
	FString Namespace;
	FString Key;
	FString Origin;
	FString Source;
	FString CurrentDevNotes;
	FString ProposedDevNotes;
	FString Reason;
};

/** Translator answers become developer notes of the text they are about. */
namespace LocHubDevNotes
{
	/** Question first, answer second. */
	using FQuestionAndAnswer = TPair<FString, FString>;

	/** "Q: <question> A: <answer>" on one line: the format the service puts into the translation prompt. */
	FString FormatAnswer(const FString& InQuestion, const FString& InAnswer);
	bool IsAnswerInDevNotes(const FString& InDevNotes, const FString& InAnswerLine);
	/** Appends every answer line that is not in the notes yet, one per line. */
	FString MergeDevNotes(const FString& InDevNotes, const TArray<FQuestionAndAnswer>& InQuestionsAndAnswers);
	/** "/Game/UI/WBP_Pause" for "/Game/UI/WBP_Pause.WBP_Pause_C:..."; empty for a non-asset origin. */
	FString PackageNameFromOrigin(const FString& InOrigin);
	/** Writes into matching FText properties or the String Table entry; true if a text with this key was found. */
	bool WriteToObject(UObject& InObject, const FString& InNamespace, const FString& InKey, const TArray<FQuestionAndAnswer>& InQuestionsAndAnswers, bool& bOutChanged);
	/** Loads the asset of the origin, writes the notes and saves it; false with a reason when it cannot. */
	bool WriteToAsset(const FString& InOrigin, const FString& InNamespace, const FString& InKey, const TArray<FQuestionAndAnswer>& InQuestionsAndAnswers, FString& OutError);
	/** Markdown for Saved/LocHub/DevNotesProposals.md; empty for no proposals. */
	FString BuildProposalMarkdown(const TArray<FLocHubDevNotesProposal>& InProposals);
}
