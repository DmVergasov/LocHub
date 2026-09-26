// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubGlyphChecker.h"

#include "Engine/Font.h"
#include "Fonts/FontCache.h"
#include "Framework/Application/SlateApplication.h"
#include "LocHubSettings.h"
#include "Misc/Paths.h"
#include "Rendering/SlateRenderer.h"

namespace LocHubGlyphCheckerPrivate
{
	/** UTF-16 to code points; a lone surrogate is kept as is (it has no glyph and gets reported). */
	TArray<uint32> DecodeCodepoints(const FString& InText)
	{
		TArray<uint32> Codepoints;
		Codepoints.Reserve(InText.Len());
		for (int32 Index = 0; Index < InText.Len(); ++Index)
		{
			const uint32 Unit = static_cast<uint32>(InText[Index]);
			const bool bHighSurrogate = Unit >= 0xD800u && Unit <= 0xDBFFu;
			if (bHighSurrogate && Index + 1 < InText.Len())
			{
				const uint32 Low = static_cast<uint32>(InText[Index + 1]);
				if (Low >= 0xDC00u && Low <= 0xDFFFu)
				{
					Codepoints.Add(0x10000u + ((Unit - 0xD800u) << 10) + (Low - 0xDC00u));
					++Index;
					continue;
				}
			}
			Codepoints.Add(Unit);
		}
		return Codepoints;
	}

	/** Controls, spaces and zero-width marks draw no glyph, so a font does not need them. */
	bool IsInvisible(const uint32 InCodepoint)
	{
		if (InCodepoint < 0x20u || (InCodepoint >= 0x7Fu && InCodepoint <= 0x9Fu))
		{
			return true;
		}
		if (InCodepoint == 0x20u || InCodepoint == 0xA0u)
		{
			return true;
		}
		if (InCodepoint >= 0x2000u && InCodepoint <= 0x200Fu)
		{
			return true;
		}
		return InCodepoint == 0x2028u || InCodepoint == 0x2029u || InCodepoint == 0x202Fu || InCodepoint == 0x205Fu
			|| InCodepoint == 0x3000u || InCodepoint == 0xFEFFu;
	}

	bool AnyFaceHasGlyph(const FSlateFontCache& InFontCache, const TArray<FFontData>& InFaces, const uint32 InCodepoint)
	{
		for (const FFontData& Face : InFaces)
		{
			if (InFontCache.CanLoadCodepoint(Face, static_cast<UTF32CHAR>(InCodepoint)))
			{
				return true;
			}
		}
		return false;
	}
}

TSharedPtr<FLocHubGlyphChecker> FLocHubGlyphChecker::FromSettings(const ULocHubSettings& InSettings, const FString& InProjectDir, TArray<FString>& OutNotes)
{
	if (InSettings.GlyphCheckFonts.IsEmpty() && InSettings.GlyphCheckFontFiles.IsEmpty())
	{
		OutNotes.Add(TEXT("Glyph check is off: no fonts in Project Settings > Plugins > LocHub > Glyph Check Fonts."));
		return nullptr;
	}
	if (!IsAvailable())
	{
		OutNotes.Add(TEXT("Glyph check skipped: this process has no Slate renderer (commandlet)."));
		return nullptr;
	}

	const TSharedRef<FLocHubGlyphChecker> Checker = MakeShared<FLocHubGlyphChecker>();
	for (const TSoftObjectPtr<UFont>& FontPtr : InSettings.GlyphCheckFonts)
	{
		// WHY: Pull validates on the game thread in one pass and runs rarely; the few configured font assets are small.
		UFont* Font = FontPtr.LoadSynchronous();
		if (!IsValid(Font) || !Checker->AddFont(*Font))
		{
			OutNotes.Add(FString::Printf(TEXT("Glyph check font %s could not be loaded or has no runtime font; it is skipped."), *FontPtr.ToString()));
		}
	}
	for (const FFilePath& FontFile : InSettings.GlyphCheckFontFiles)
	{
		if (FontFile.FilePath.IsEmpty())
		{
			continue;
		}
		const FString AbsolutePath = FPaths::IsRelative(FontFile.FilePath)
			? FPaths::ConvertRelativePathToFull(InProjectDir, FontFile.FilePath)
			: FontFile.FilePath;
		if (!FPaths::FileExists(AbsolutePath))
		{
			OutNotes.Add(FString::Printf(TEXT("Glyph check font file %s does not exist; it is skipped."), *AbsolutePath));
			continue;
		}
		Checker->AddFontFile(AbsolutePath);
	}

	if (!Checker->HasFonts())
	{
		OutNotes.Add(TEXT("Glyph check is off: none of the configured fonts could be used."));
		return nullptr;
	}
	return Checker;
}

bool FLocHubGlyphChecker::IsAvailable()
{
	return FSlateApplication::IsInitialized() && FSlateApplication::Get().GetRenderer() != nullptr;
}

bool FLocHubGlyphChecker::AddFont(UFont& InFont)
{
	const FCompositeFont* CompositeFont = InFont.GetCompositeFont();
	if (CompositeFont == nullptr)
	{
		return false;
	}

	FFontSet FontSet;
	FontSet.Label = InFont.GetPathName();
	for (const FTypefaceEntry& Entry : CompositeFont->DefaultTypeface.Fonts)
	{
		FontSet.Faces.Add(Entry.Font);
	}
	for (const FCompositeSubFont& SubFont : CompositeFont->SubTypefaces)
	{
		for (const FTypefaceEntry& Entry : SubFont.Typeface.Fonts)
		{
			FontSet.Faces.Add(Entry.Font);
		}
	}
	if (FontSet.Faces.IsEmpty())
	{
		return false;
	}

	FontSets.Add(MoveTemp(FontSet));
	KeptFonts.Emplace(&InFont);
	return true;
}

void FLocHubGlyphChecker::AddFontFile(const FString& InAbsolutePath)
{
	FFontSet FontSet;
	FontSet.Label = FPaths::GetCleanFilename(InAbsolutePath);
	FontSet.Faces.Emplace(InAbsolutePath, EFontHinting::Default, EFontLoadingPolicy::LazyLoad);
	FontSets.Add(MoveTemp(FontSet));
}

bool FLocHubGlyphChecker::HasFonts() const
{
	return !FontSets.IsEmpty();
}

bool FLocHubGlyphChecker::Check(const FString& InText, TArray<FString>& OutErrors) const
{
	if (FontSets.IsEmpty() || !IsAvailable())
	{
		return true;
	}

	const TSharedRef<FSlateFontCache> FontCache = FSlateApplication::Get().GetRenderer()->GetFontCache();
	const TArray<uint32> Codepoints = LocHubGlyphCheckerPrivate::DecodeCodepoints(InText);
	bool bAllDrawable = true;
	for (const FFontSet& FontSet : FontSets)
	{
		TArray<FString> Missing;
		for (const uint32 Codepoint : Codepoints)
		{
			if (LocHubGlyphCheckerPrivate::IsInvisible(Codepoint))
			{
				continue;
			}
			if (!LocHubGlyphCheckerPrivate::AnyFaceHasGlyph(*FontCache, FontSet.Faces, Codepoint))
			{
				Missing.AddUnique(FString::Printf(TEXT("U+%04X"), Codepoint));
			}
		}
		if (!Missing.IsEmpty())
		{
			bAllDrawable = false;
			OutErrors.Add(FString::Printf(TEXT("Font %s has no glyph for %s."), *FontSet.Label, *FString::Join(Missing, TEXT(", "))));
		}
	}
	return bAllDrawable;
}
