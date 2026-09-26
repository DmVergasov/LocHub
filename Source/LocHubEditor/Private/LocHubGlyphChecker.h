// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Fonts/CompositeFont.h"
#include "UObject/StrongObjectPtr.h"

class UFont;
class ULocHubSettings;

/** Tells whether every configured font can draw every character of a translation (FSlateFontCache::CanLoadCodepoint). */
class FLocHubGlyphChecker
{
public:
	/** Checker for the fonts in the settings; nullptr (with a line in OutNotes) when no font is usable or there is no Slate renderer. */
	static TSharedPtr<FLocHubGlyphChecker> FromSettings(const ULocHubSettings& InSettings, const FString& InProjectDir, TArray<FString>& OutNotes);
	/** The font cache lives in the Slate renderer; a commandlet has none. */
	static bool IsAvailable();

	/** Adds the default typeface and every sub-font of the font as one set: a character passes if any face of the set has it. */
	bool AddFont(UFont& InFont);
	/** Adds a TTF/OTF file (for example an RmlUi font) as a set of its own. */
	void AddFontFile(const FString& InAbsolutePath);
	bool HasFonts() const;
	/** Appends one error per font set that misses characters of InText; true when nothing is missing. */
	bool Check(const FString& InText, TArray<FString>& OutErrors) const;

private:
	struct FFontSet
	{
		FString Label;
		TArray<FFontData> Faces;
	};

	TArray<FFontSet> FontSets;

	/** Keeps the loaded UFont assets, and the font faces they reference, alive while the checker exists. */
	TArray<TStrongObjectPtr<UObject>> KeptFonts;
};
