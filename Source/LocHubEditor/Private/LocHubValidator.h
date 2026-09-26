// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class FLocHubGlyphChecker;

/** The checks a translation must pass before Pull writes it into an archive: only what breaks the text in Unreal. */
namespace LocHubValidator
{
	/**
	 * Empty text and unknown culture; format pattern (ValidatePattern on the target culture, and no argument the source
	 * does not have, case-sensitive; a source argument left out is allowed); rich-text tags; glyphs when InGlyphChecker is set.
	 * Appends human-readable errors; true when there are none.
	 */
	bool Validate(const FString& InCulture, const FString& InSource, const FString& InTranslation, const FLocHubGlyphChecker* InGlyphChecker, TArray<FString>& OutErrors);

	/** Port of the private rule in TextLocalizationResourceGenerator.cpp:21-91 (UE 5.8). */
	bool AreRichTextTagsBalanced(const FString& InSource, const FString& InTranslation);
}
