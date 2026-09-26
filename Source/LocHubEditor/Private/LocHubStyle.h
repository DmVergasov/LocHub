// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class ISlateStyle;
class FSlateStyleSet;

/**
 * The LocHub plugin icon as a Slate style set: one brush, "LocHub.Icon", built from Resources/LocHubIcon.svg
 * (a copy of Tools/media/icon.svg, since Resources ships in the packaged plugin). Used by the LocHub dock tab
 * (SLocHubTab::RegisterTabSpawner) and by the "Open LocHub" entry in Tools > LocHub
 * (FLocHubEditorModule::RegisterMenus).
 */
class FLocHubStyle
{
public:
	static void Initialize();
	static void Shutdown();

	static const ISlateStyle& Get();
	static FName GetStyleSetName();

private:
	static TSharedPtr<FSlateStyleSet> StyleSet;
};
