// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubStyle.h"

#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Styling/SlateStyle.h"
#include "Styling/SlateStyleMacros.h"
#include "Styling/SlateStyleRegistry.h"

// Follows the plugin style pattern of Engine/Plugins/VirtualProduction/SequencerPlaylists/Source/SequencerPlaylists/
// Private/SequencerPlaylistsStyle.h/.cpp: IMAGE_BRUSH_SVG expects a RootToContentDir in scope, so it is aliased to
// the style set's own member for the duration of Initialize().
#define RootToContentDir StyleSet->RootToContentDir

TSharedPtr<FSlateStyleSet> FLocHubStyle::StyleSet;

void FLocHubStyle::Initialize()
{
	if (StyleSet.IsValid())
	{
		return;
	}

	StyleSet = MakeShared<FSlateStyleSet>(GetStyleSetName());
	StyleSet->SetContentRoot(IPluginManager::Get().FindPlugin(TEXT("LocHub"))->GetBaseDir() / TEXT("Resources"));

	const FVector2D Icon16x16(16.0f, 16.0f);
	StyleSet->Set("LocHub.Icon", new IMAGE_BRUSH_SVG("LocHubIcon", Icon16x16));

	FSlateStyleRegistry::RegisterSlateStyle(*StyleSet);
}

#undef RootToContentDir

void FLocHubStyle::Shutdown()
{
	if (StyleSet.IsValid())
	{
		FSlateStyleRegistry::UnRegisterSlateStyle(*StyleSet);
		ensure(StyleSet.IsUnique());
		StyleSet.Reset();
	}
}

const ISlateStyle& FLocHubStyle::Get()
{
	return *StyleSet;
}

FName FLocHubStyle::GetStyleSetName()
{
	static const FName StyleSetName(TEXT("LocHubStyle"));
	return StyleSetName;
}
