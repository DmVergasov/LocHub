// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubPosix.h"

#if PLATFORM_MAC || PLATFORM_UNIX
#include <errno.h>
#include <signal.h>
#include <sys/types.h>
#include <unistd.h>
#endif

bool LocHubPosix::SignalProcessGroup(const uint32 InPid, const bool bForce)
{
#if PLATFORM_MAC || PLATFORM_UNIX
	// kill(-1) signals every process the user owns and kill(0) the caller's own process group; a pid too large for
	// pid_t wraps negative and would land in the same place. This editor's own pid, or the leader of the group it
	// runs in, would take the editor down with the signal.
	const pid_t Pid = static_cast<pid_t>(InPid);
	if (Pid <= 1 || Pid == getpid() || Pid == getpgrp())
	{
		return false;
	}

	const int32 SignalNumber = bForce ? SIGKILL : SIGTERM;
	if (kill(-Pid, SignalNumber) == 0)
	{
		return true;
	}
	if (errno != ESRCH)
	{
		// EPERM: the group exists, but none of its processes may be signalled by this user.
		return false;
	}
	// No group led by Pid: a process that was not started as a group leader, or one that is already gone.
	return kill(Pid, SignalNumber) == 0 || errno == ESRCH;
#else
	return false;
#endif
}
