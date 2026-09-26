// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocHubPluralForms;
struct FLocHubSnapshot;
struct FLocHubTargetPaths;

/** The body of POST /api/push built from the gathered manifest and archives. */
namespace LocHubSnapshot
{
	/** Fills target, cultures, entries, foreign archives and the engine's plural forms; coverage is the caller's. */
	bool Build(const FLocHubTargetPaths& InPaths, const TArray<FString>& InUiSourcePatterns, FLocHubSnapshot& OutSnapshot, FString& OutError);
	/** CLDR name of a plural form, spelled as plural modifiers spell it: "zero", "one", "two", "few", "many" or "other". */
	FString PluralFormName(ETextPluralForm InForm);
	/**
	 * The plural forms the engine validates InCulture's plural modifiers against (FCulture::GetValidPluralForms). Its ICU data
	 * can differ from the service's (Node), and the engine has the last word on Pull. False when the engine cannot resolve the culture.
	 */
	bool GetEnginePluralForms(const FString& InCulture, FLocHubPluralForms& OutForms);
	/** Package path for an asset origin, the file for "File(Line)", the namespace when there is no origin. */
	FString GroupKeyFor(const FString& InOrigin, const FString& InNamespace);
	/** LocHub::KindUi when the origin matches any wildcard, LocHub::KindText otherwise. */
	FString KindFor(const FString& InOrigin, const TArray<FString>& InUiSourcePatterns);
}
