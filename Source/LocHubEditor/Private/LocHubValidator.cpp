// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubValidator.h"

#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "Internationalization/Text.h"
#include "LocHubGlyphChecker.h"

namespace LocHubValidatorPrivate
{
	/** FString::operator== ignores case, while the engine matches format arguments case-sensitively. */
	bool ContainsCaseSensitive(const TArray<FString>& InNames, const FString& InName)
	{
		for (const FString& Name : InNames)
		{
			if (Name.Equals(InName, ESearchCase::CaseSensitive))
			{
				return true;
			}
		}
		return false;
	}

	void CheckFormatPattern(const FCulturePtr& InCulture, const FString& InSource, const FString& InTranslation, TArray<FString>& OutErrors)
	{
		const FTextFormat SourcePattern = FTextFormat::FromString(InSource);
		const FTextFormat::EExpressionType SourceType = SourcePattern.GetExpressionType();
		if (SourceType == FTextFormat::EExpressionType::Invalid)
		{
			// No translation of a source that does not compile can match it; the engine already reports the source itself.
			return;
		}

		const bool bSourceIsPattern = SourceType == FTextFormat::EExpressionType::Complex;
		if (!bSourceIsPattern && !InTranslation.Contains(TEXT("{"), ESearchCase::CaseSensitive))
		{
			return;
		}

		const FTextFormat TranslationPattern = FTextFormat::FromString(InTranslation);
		TArray<FString> PatternErrors;
		if (!TranslationPattern.ValidatePattern(InCulture, PatternErrors))
		{
			for (const FString& PatternError : PatternErrors)
			{
				OutErrors.Add(TEXT("Format pattern: ") + PatternError);
			}
			if (PatternErrors.IsEmpty())
			{
				OutErrors.Add(TEXT("Format pattern: the translation does not compile."));
			}
		}
		if (!bSourceIsPattern)
		{
			return;
		}

		// Only arguments the source does not have: the game never passes them, so FText::Format prints "{Name}" as is.
		// A source argument the translation leaves out is fine for Unreal (a count the phrase does not need, a gender
		// the language does not have); the service asks a human to confirm it instead of refusing it here.
		TArray<FString> SourceArguments;
		SourcePattern.GetFormatArgumentNames(SourceArguments);
		TArray<FString> TranslationArguments;
		TranslationPattern.GetFormatArgumentNames(TranslationArguments);
		for (const FString& Argument : TranslationArguments)
		{
			if (!ContainsCaseSensitive(SourceArguments, Argument))
			{
				OutErrors.Add(FString::Printf(TEXT("Argument {%s} is not in the source."), *Argument));
			}
		}
	}

	/** CountRichTextTags from TextLocalizationResourceGenerator.cpp:22-67 (UE 5.8), unchanged in behaviour. */
	void CountRichTextTags(const FString& InText, int32& OutOpeningCount, int32& OutClosingCount)
	{
		bool bTagOpen = false;
		int32 TagLength = 0;
		for (int32 Index = 0; Index < InText.Len(); ++Index)
		{
			const TCHAR Char = InText[Index];
			if (Char == TEXT('<'))
			{
				bTagOpen = true;
				TagLength = 0;
			}
			else if (bTagOpen)
			{
				if (Char == TEXT('>'))
				{
					if (InText[Index - 1] == TEXT('/'))
					{
						if (TagLength == 1)
						{
							++OutClosingCount;
						}
					}
					else
					{
						// "<br>" is self-closing for historic reasons, exactly as in the engine.
						const bool bIsBrTag = TagLength == 2 && InText[Index - 2] == TEXT('b') && InText[Index - 1] == TEXT('r');
						if (!bIsBrTag)
						{
							++OutOpeningCount;
						}
					}
					bTagOpen = false;
				}
				++TagLength;
			}
		}
	}
}

bool LocHubValidator::Validate(const FString& InCulture, const FString& InSource, const FString& InTranslation, const FLocHubGlyphChecker* InGlyphChecker, TArray<FString>& OutErrors)
{
	const int32 ErrorsBefore = OutErrors.Num();
	if (InTranslation.IsEmpty())
	{
		OutErrors.Add(TEXT("The translation is empty."));
		return false;
	}

	const FCulturePtr Culture = FInternationalization::Get().GetCulture(InCulture);
	if (!Culture.IsValid())
	{
		OutErrors.Add(FString::Printf(TEXT("Unknown culture '%s'."), *InCulture));
		return false;
	}

	LocHubValidatorPrivate::CheckFormatPattern(Culture, InSource, InTranslation, OutErrors);

	if (!AreRichTextTagsBalanced(InSource, InTranslation))
	{
		OutErrors.Add(TEXT("Rich text tags are not balanced: every <Tag> needs a closing </>, as in the source."));
	}

	if (InGlyphChecker != nullptr)
	{
		InGlyphChecker->Check(InTranslation, OutErrors);
	}
	return OutErrors.Num() == ErrorsBefore;
}

bool LocHubValidator::AreRichTextTagsBalanced(const FString& InSource, const FString& InTranslation)
{
	int32 TranslationOpening = 0;
	int32 TranslationClosing = 0;
	LocHubValidatorPrivate::CountRichTextTags(InTranslation, TranslationOpening, TranslationClosing);
	if (TranslationOpening == TranslationClosing)
	{
		return true;
	}

	// The engine tolerates the imbalance when the source has exactly the same one (deliberate, e.g. for concatenation).
	int32 SourceOpening = 0;
	int32 SourceClosing = 0;
	LocHubValidatorPrivate::CountRichTextTags(InSource, SourceOpening, SourceClosing);
	return SourceOpening == TranslationOpening && SourceClosing == TranslationClosing;
}
