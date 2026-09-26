// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocHubNodeCheck;

/**
 * Non-modal window shown once at editor startup when LocHubEnvironment::CheckNode (LocHubEditorModule's startup
 * hook) finds anything but Ok: names the problem and links to the Node.js download page.
 */
class SLocHubNodeMissingWindow
{
public:
	/** Builds and shows the window describing InCheck. Parented to the editor's root window when there is one. */
	static void Open(const FLocHubNodeCheck& InCheck);
};
