// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/** The only place LocHub makes POSIX system calls itself; everything else goes through FPlatformProcess. */
namespace LocHubPosix
{
	/**
	 * Mac/Linux: sends SIGTERM (bForce false) or SIGKILL (bForce true) to the process group InPid leads, so the
	 * signal also reaches the processes it started -- every process FPlatformProcess::CreateProc starts leads its own
	 * group (it spawns with POSIX_SPAWN_SETPGROUP) -- or, when no group with that id exists, to InPid alone.
	 * True when a signal was delivered or the process is already gone; false when it may not be signalled, and always
	 * for pid 0 or 1, this editor's own pid or the leader of this editor's process group, where the signal would reach
	 * this editor itself or every process the user owns.
	 * Windows: always false; LocHubChildProcess::Terminate does not call it there.
	 */
	bool SignalProcessGroup(uint32 InPid, bool bForce);
}
