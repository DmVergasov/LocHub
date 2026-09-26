// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "LocHubTargetPaths.h"

namespace LocHubTests
{
	/** Local ports of the in-process fake service, the real service of the live test and a port nothing listens on. */
	inline constexpr int32 FakeServicePort = 47851;
	inline constexpr int32 LiveServicePort = 47852;
	inline constexpr int32 DeadServicePort = 47853;

	/** Namespace of every fixture unit written by WriteTarget. */
	inline constexpr const TCHAR* Namespace = TEXT("LocHubTest");

	struct FTestUnit
	{
		FString Key;
		FString Source;
		FString Origin;
		FString DevNotes;
		/** Existing "ru" archive translation; empty means none. */
		FString RuTranslation;
	};

	/** Fresh absolute folder under the user temp folder, with a trailing slash. */
	FString MakeTempDir();
	void DeleteTempDir(const FString& InDir);
	/** Writes manifest and archives of a target "Test" (native "en", foreign "ru") into InDataDir. */
	FLocHubTargetPaths WriteTarget(const FString& InDataDir, const TArray<FTestUnit>& InUnits);
	/** Writes UTF-8 text without BOM and creates the folders. */
	bool WriteTextFile(const FString& InPath, const FString& InText);
}

#endif
