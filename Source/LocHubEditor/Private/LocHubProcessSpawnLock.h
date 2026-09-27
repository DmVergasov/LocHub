// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Misc/ScopeLock.h"

/**
 * One process-wide lock shared by every FPlatformProcess::CreateProc call this plugin makes that either changes
 * the editor's own environment for the duration of the spawn (FLocHubServiceProcess::StartNode, which sets
 * LOCHUB_API_KEY around it) or could in principle run concurrently with that window
 * (LocHubEnvironment::RunBoundedProcess -- CheckNode's own "node --version" launch and the Mac/Linux login-shell
 * node lookup). Two problems without this lock:
 *  - Windows: CreateProcess snapshots the caller's environment at the moment it is called, so a RunBoundedProcess
 *    launch from a pool thread while StartNode's window is open would silently inherit LOCHUB_API_KEY.
 *  - Mac/Linux: FPlatformMisc::SetEnvironmentVar (setenv/unsetenv) racing a concurrent posix_spawn on another
 *    thread is a data race in the C library's environment storage, not just a logical ordering problem.
 * Every holder acquires it around "set the env var, CreateProc, restore the env var" as one section -- never
 * around anything that can block for long (no HTTP call, no bounded wait): the whole point is a short,
 * uncontended critical section around one spawn.
 *
 * Residual (M-5, accepted): this lock only serializes spawns this plugin's own code makes. It does not serialize
 * spawns made by engine-owned threads during the env-var window -- ShaderCompileWorker launches from the
 * shader-compiling thread (ShaderCompiler.cpp), and source-control, Zen and UBT launches are the same shape. On
 * Windows such a child inherits the key; that child is a local process of the same user, and the key is already
 * plaintext in DefaultEditor.ini, so no new trust boundary is crossed. On Mac/Linux, setenv/unsetenv on the game
 * thread races those threads' reads of environ (a real data race in the C library, not just a logical one), but
 * the window is microseconds, once per service start. The only alternatives that close this gap would bypass
 * FPlatformProcess entirely (an explicit env block to CreateProcessW) or change the handover contract (stdin) --
 * out of scope for this fix.
 */
namespace LocHubProcessSpawnLock
{
	inline FCriticalSection& Get()
	{
		static FCriticalSection Lock;
		return Lock;
	}
}
