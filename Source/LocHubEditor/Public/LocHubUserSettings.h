// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "UObject/SoftObjectPath.h"
#include "LocHubUserSettings.generated.h"

/**
 * Per-user LocHub settings. Stored in this project's Saved folder, so they are not shared with your team. Point
 * this at your Node.js executable when LocHub cannot find it on its own, for example when Node comes from a
 * version manager whose shims your editor's launch environment does not see.
 */
UCLASS(config = EditorPerProjectUserSettings, meta = (DisplayName = "LocHub"))
class LOCHUBEDITOR_API ULocHubUserSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	virtual FName GetCategoryName() const override;
	virtual FName GetSectionName() const override;

	/** Full path to the node executable. Leave empty to search PATH and the usual install locations. Set it when
	 *  Node.js comes from a version manager the editor cannot see. */
	UPROPERTY(EditAnywhere, config, Category = "Node.js", meta = (DisplayName = "Node.js Executable"))
	FFilePath NodeExecutable;
};
