// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocHubCoverageFinding;

/** Player-visible strings that bypass localization. */
namespace LocHubCoverage
{
	/** FText::FromString with a string literal that has a letter; InFile is stored as the finding's file. */
	void ScanCpp(const FString& InFile, const FString& InContent, TArray<FLocHubCoverageFinding>& OutFindings);
	/** Visible text of an RmlUi document that has a letter (comments, head/style/script and {{bindings}} skipped). */
	void ScanRml(const FString& InFile, const FString& InContent, TArray<FLocHubCoverageFinding>& OutFindings);
	/** True if the project-relative path matches any wildcard. */
	bool IsExcluded(const FString& InRelativePath, const TArray<FString>& InExcludePatterns);
	/** *.cpp and *.h under the source roots, *.rml under the content roots; roots are absolute, findings project-relative. */
	void ScanRoots(const FString& InProjectDir, const TArray<FString>& InSourceRoots, const TArray<FString>& InContentRoots, const TArray<FString>& InExcludePatterns, TArray<FLocHubCoverageFinding>& OutFindings);
}
