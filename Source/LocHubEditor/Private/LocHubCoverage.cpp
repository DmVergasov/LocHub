// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubCoverage.h"

#include "HAL/FileManager.h"
#include "Internationalization/Regex.h"
#include "LocHubTypes.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Stats/Stats.h"

namespace LocHubCoveragePrivate
{
	/** Line numbers for increasing offsets of one text; counting resumes where the previous call stopped. */
	struct FLineCounter
	{
		explicit FLineCounter(const FString& InContent)
			: Content(InContent)
		{
		}

		int32 LineAt(const int32 InIndex)
		{
			while (Cursor < InIndex && Cursor < Content.Len())
			{
				if (Content[Cursor] == TEXT('\n'))
				{
					++Line;
				}
				++Cursor;
			}
			return Line;
		}

		const FString& Content;
		int32 Cursor = 0;
		int32 Line = 1;
	};

	bool HasLetter(const FString& InText)
	{
		for (const TCHAR Char : InText)
		{
			if (FChar::IsAlpha(Char))
			{
				return true;
			}
		}
		return false;
	}

	/** A match behind "//" on its line, or on a line that continues a block comment, is not code. */
	bool IsInComment(const FString& InContent, const int32 InIndex)
	{
		int32 LineStart = InIndex;
		while (LineStart > 0 && InContent[LineStart - 1] != TEXT('\n'))
		{
			--LineStart;
		}
		const FString Prefix = InContent.Mid(LineStart, InIndex - LineStart);
		if (Prefix.Contains(TEXT("//"), ESearchCase::CaseSensitive))
		{
			return true;
		}
		const FString Trimmed = Prefix.TrimStart();
		return Trimmed.StartsWith(TEXT("*"), ESearchCase::CaseSensitive) || Trimmed.StartsWith(TEXT("/*"), ESearchCase::CaseSensitive);
	}

	FString UnescapeCppLiteral(const FString& InText)
	{
		FString Result;
		Result.Reserve(InText.Len());
		for (int32 Index = 0; Index < InText.Len(); ++Index)
		{
			const TCHAR Char = InText[Index];
			if (Char != TEXT('\\') || Index + 1 >= InText.Len())
			{
				Result.AppendChar(Char);
				continue;
			}
			++Index;
			const TCHAR Escaped = InText[Index];
			if (Escaped == TEXT('n'))
			{
				Result.AppendChar(TEXT('\n'));
			}
			else if (Escaped == TEXT('t'))
			{
				Result.AppendChar(TEXT('\t'));
			}
			else
			{
				Result.AppendChar(Escaped);
			}
		}
		return Result;
	}

	/** Index just past the '>' that closes the tag starting at InStart ('<'); quoted attribute values may contain '>'. */
	int32 FindTagEnd(const FString& InContent, const int32 InStart)
	{
		TCHAR Quote = 0;
		for (int32 Index = InStart + 1; Index < InContent.Len(); ++Index)
		{
			const TCHAR Char = InContent[Index];
			if (Quote != 0)
			{
				if (Char == Quote)
				{
					Quote = 0;
				}
			}
			else if (Char == TEXT('"') || Char == TEXT('\''))
			{
				Quote = Char;
			}
			else if (Char == TEXT('>'))
			{
				return Index + 1;
			}
		}
		return InContent.Len();
	}

	FString ReadTagName(const FString& InContent, const int32 InStart)
	{
		FString Name;
		for (int32 Index = InStart + 1; Index < InContent.Len(); ++Index)
		{
			const TCHAR Char = InContent[Index];
			if (FChar::IsAlnum(Char) || Char == TEXT('-') || Char == TEXT('_'))
			{
				Name.AppendChar(FChar::ToLower(Char));
			}
			else
			{
				break;
			}
		}
		return Name;
	}

	/** InStart points at '<'; returns the index after the comment, tag, or whole head/style/script element. */
	int32 SkipMarkup(const FString& InContent, const int32 InStart)
	{
		if (InContent.Mid(InStart, 4) == TEXT("<!--"))
		{
			const int32 CommentEnd = InContent.Find(TEXT("-->"), ESearchCase::CaseSensitive, ESearchDir::FromStart, InStart + 4);
			return CommentEnd == INDEX_NONE ? InContent.Len() : CommentEnd + 3;
		}

		const int32 TagEnd = FindTagEnd(InContent, InStart);
		const FString Name = ReadTagName(InContent, InStart);
		const bool bSelfClosing = TagEnd >= 2 && InContent[TagEnd - 2] == TEXT('/');
		const bool bSkipsBody = Name == TEXT("head") || Name == TEXT("style") || Name == TEXT("script");
		if (!bSkipsBody || bSelfClosing)
		{
			return TagEnd;
		}

		const int32 CloseStart = InContent.Find(TEXT("</") + Name, ESearchCase::IgnoreCase, ESearchDir::FromStart, TagEnd);
		return CloseStart == INDEX_NONE ? InContent.Len() : FindTagEnd(InContent, CloseStart);
	}

	/** Removes RmlUi data bindings "{{ ... }}"; an unclosed binding removes the rest of the text. */
	FString StripBindings(const FString& InText)
	{
		FString Result;
		int32 Index = 0;
		while (Index < InText.Len())
		{
			const int32 Open = InText.Find(TEXT("{{"), ESearchCase::CaseSensitive, ESearchDir::FromStart, Index);
			if (Open == INDEX_NONE)
			{
				Result += InText.Mid(Index);
				break;
			}
			Result += InText.Mid(Index, Open - Index);
			Result += TEXT(" ");
			const int32 Close = InText.Find(TEXT("}}"), ESearchCase::CaseSensitive, ESearchDir::FromStart, Open + 2);
			if (Close == INDEX_NONE)
			{
				break;
			}
			Index = Close + 2;
		}
		return Result;
	}

	FString DecodeEntities(const FString& InText)
	{
		FString Result = InText;
		Result.ReplaceInline(TEXT("&nbsp;"), TEXT(" "), ESearchCase::CaseSensitive);
		Result.ReplaceInline(TEXT("&lt;"), TEXT("<"), ESearchCase::CaseSensitive);
		Result.ReplaceInline(TEXT("&gt;"), TEXT(">"), ESearchCase::CaseSensitive);
		Result.ReplaceInline(TEXT("&quot;"), TEXT("\""), ESearchCase::CaseSensitive);
		Result.ReplaceInline(TEXT("&apos;"), TEXT("'"), ESearchCase::CaseSensitive);
		// Last, so that "&amp;lt;" becomes "&lt;" and not "<".
		Result.ReplaceInline(TEXT("&amp;"), TEXT("&"), ESearchCase::CaseSensitive);
		return Result;
	}

	FString CollapseWhitespace(const FString& InText)
	{
		TArray<FString> Words;
		InText.ParseIntoArrayWS(Words);
		return FString::Join(Words, TEXT(" "));
	}

	void AddRmlText(const FString& InFile, const FString& InContent, const int32 InBegin, const int32 InEnd, FLineCounter& InOutLines, TArray<FLocHubCoverageFinding>& OutFindings)
	{
		if (InEnd <= InBegin)
		{
			return;
		}
		const FString Text = CollapseWhitespace(DecodeEntities(StripBindings(InContent.Mid(InBegin, InEnd - InBegin))));
		if (!HasLetter(Text))
		{
			return;
		}
		int32 FirstVisible = InBegin;
		while (FirstVisible < InEnd && FChar::IsWhitespace(InContent[FirstVisible]))
		{
			++FirstVisible;
		}
		FLocHubCoverageFinding& Finding = OutFindings.AddDefaulted_GetRef();
		Finding.Kind = LocHub::CoverageKindRmlLiteral;
		Finding.File = InFile;
		Finding.Line = InOutLines.LineAt(FirstVisible);
		Finding.Text = Text;
	}

	void ScanTree(const FString& InProjectDir, const FString& InRoot, const TCHAR* InMask, const bool bRml, const TArray<FString>& InExcludePatterns, TArray<FLocHubCoverageFinding>& OutFindings)
	{
		TArray<FString> Files;
		IFileManager::Get().FindFilesRecursive(Files, *InRoot, InMask, true, false);
		Files.Sort();
		for (const FString& AbsoluteFile : Files)
		{
			FString RelativeFile = AbsoluteFile;
			FPaths::MakePathRelativeTo(RelativeFile, *InProjectDir);
			if (LocHubCoverage::IsExcluded(RelativeFile, InExcludePatterns))
			{
				continue;
			}
			FString Content;
			if (!FFileHelper::LoadFileToString(Content, *AbsoluteFile))
			{
				continue;
			}
			if (bRml)
			{
				LocHubCoverage::ScanRml(RelativeFile, Content, OutFindings);
			}
			else
			{
				LocHubCoverage::ScanCpp(RelativeFile, Content, OutFindings);
			}
		}
	}
}

void LocHubCoverage::ScanCpp(const FString& InFile, const FString& InContent, TArray<FLocHubCoverageFinding>& OutFindings)
{
	if (!InContent.Contains(TEXT("FText::FromString"), ESearchCase::CaseSensitive))
	{
		return;
	}

	// FText::FromString( "..." ) or FText::FromString( TEXT( "..." ) ); group 1 is the literal body with escapes.
	const FRegexPattern Pattern(TEXT("FText::FromString\\s*\\(\\s*(?:TEXT\\s*\\(\\s*)?\"((?:[^\"\\\\]|\\\\.)*)\""));
	FRegexMatcher Matcher(Pattern, InContent);
	LocHubCoveragePrivate::FLineCounter Lines(InContent);
	while (Matcher.FindNext())
	{
		const int32 MatchStart = Matcher.GetMatchBeginning();
		const int32 Line = Lines.LineAt(MatchStart);
		if (LocHubCoveragePrivate::IsInComment(InContent, MatchStart))
		{
			continue;
		}
		const FString Text = LocHubCoveragePrivate::UnescapeCppLiteral(Matcher.GetCaptureGroup(1));
		if (!LocHubCoveragePrivate::HasLetter(Text))
		{
			continue;
		}
		FLocHubCoverageFinding& Finding = OutFindings.AddDefaulted_GetRef();
		Finding.Kind = LocHub::CoverageKindFromString;
		Finding.File = InFile;
		Finding.Line = Line;
		Finding.Text = Text;
	}
}

void LocHubCoverage::ScanRml(const FString& InFile, const FString& InContent, TArray<FLocHubCoverageFinding>& OutFindings)
{
	LocHubCoveragePrivate::FLineCounter Lines(InContent);
	int32 Index = 0;
	int32 TextStart = 0;
	while (Index < InContent.Len())
	{
		if (InContent[Index] != TEXT('<'))
		{
			++Index;
			continue;
		}
		LocHubCoveragePrivate::AddRmlText(InFile, InContent, TextStart, Index, Lines, OutFindings);
		Index = LocHubCoveragePrivate::SkipMarkup(InContent, Index);
		TextStart = Index;
	}
	LocHubCoveragePrivate::AddRmlText(InFile, InContent, TextStart, InContent.Len(), Lines, OutFindings);
}

bool LocHubCoverage::IsExcluded(const FString& InRelativePath, const TArray<FString>& InExcludePatterns)
{
	for (const FString& Pattern : InExcludePatterns)
	{
		if (InRelativePath.MatchesWildcard(Pattern))
		{
			return true;
		}
	}
	return false;
}

void LocHubCoverage::ScanRoots(const FString& InProjectDir, const TArray<FString>& InSourceRoots, const TArray<FString>& InContentRoots, const TArray<FString>& InExcludePatterns, TArray<FLocHubCoverageFinding>& OutFindings)
{
	QUICK_SCOPE_CYCLE_COUNTER(STAT_LocHubCoverage_ScanRoots);
	for (const FString& Root : InSourceRoots)
	{
		LocHubCoveragePrivate::ScanTree(InProjectDir, Root, TEXT("*.cpp"), false, InExcludePatterns, OutFindings);
		LocHubCoveragePrivate::ScanTree(InProjectDir, Root, TEXT("*.h"), false, InExcludePatterns, OutFindings);
	}
	for (const FString& Root : InContentRoots)
	{
		LocHubCoveragePrivate::ScanTree(InProjectDir, Root, TEXT("*.rml"), true, InExcludePatterns, OutFindings);
	}
}
