// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocHubNodeCheck;

/**
 * Non-modal window shown when a LocHub tool launch fails because LocHubEnvironment::CheckNode (run from
 * FLocHubServiceProcess::StartNode, via its OnNodeProblemFn) finds anything but Ok: names the problem and links
 * to the Node.js download page.
 */
class SLocHubNodeMissingWindow
{
public:
	/** Builds and shows the window describing InCheck, unless one from an earlier failed launch is already open
	 *  (brought to front instead). Parented to the editor's root window when there is one. */
	static void Open(const FLocHubNodeCheck& InCheck);
};
