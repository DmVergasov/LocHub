// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "HAL/PlatformProcess.h"

/** How LocHubChildProcess::Terminate asks a process to end on Mac and Linux; Windows ends it the same way for both. */
enum class ELocHubStopMode : uint8
{
	Graceful,	// SIGTERM to the process group; SIGKILL only when it is still running after the grace period
	Immediate,	// SIGKILL to the process group at once, for a hung tool whose clean exit nobody needs
};

/** Ending the processes LocHub starts and reading their output, the same way on Windows, Mac and Linux. */
namespace LocHubChildProcess
{
	/**
	 * Ends the process behind InHandle (pid InPid) and waits on the calling thread until it is gone or the bounded
	 * wait runs out (at most 3 s); true only when it is no longer running. Never closes InHandle: the caller's
	 * CloseProc comes after, and on Linux (and Mac 5.6) CloseProc of a child that still runs blocks until that child exits.
	 * Windows: FPlatformProcess::TerminateProc of the whole process tree, as before, then the wait.
	 * Mac/Linux: RunStopSequence with LocHubPosix::SignalProcessGroup. FPlatformProcess::TerminateProc is not used
	 * there: it does nothing for a handle from OpenProcess (Mac; Linux before 5.8), does not reach the whole tree
	 * (Mac: direct children only; Linux before 5.8: nothing below the process) and only sends SIGTERM, which a process
	 * may ignore.
	 */
	bool Terminate(FProcHandle& InHandle, uint32 InPid, ELocHubStopMode InMode);

	/**
	 * The Mac/Linux stop order behind Terminate, with the platform calls passed in so it runs on any platform:
	 * Graceful sends InSignal(false) (SIGTERM) and waits up to 2 s for the exit, then InSignal(true) (SIGKILL) and waits
	 * up to 1 s more; Immediate starts at SIGKILL. A signal InSignal reports as not delivered is not waited for -- a
	 * zero-second InWaitForExit still tells whether the process is gone. Returns the last InWaitForExit answer.
	 */
	bool RunStopSequence(ELocHubStopMode InMode, TFunctionRef<bool(bool bForce)> InSignal, TFunctionRef<bool(double InTimeoutSeconds)> InWaitForExit);

	/** Appends what InReadPipe holds right now to InOutBytes without waiting for more; about 1 MiB per call (checked
	 *  before each read, so one call can return that plus one more chunk), so a child that writes without pause
	 *  cannot keep the caller reading forever (the rest stays for the next call). */
	void ReadAvailableBytes(void* InReadPipe, TArray<uint8>& InOutBytes);

	/** Length of the longest prefix of InBytes that does not end inside a UTF-8 multi-byte sequence: an incomplete
	 *  sequence at the end (1-3 bytes of a 2-4 byte character) is left out. Bytes that are not valid UTF-8 are never
	 *  held back -- the decoder replaces them -- so a broken stream cannot stall. */
	int32 CompleteUtf8PrefixLength(TConstArrayView<uint8> InBytes);

	/** Decodes and removes the complete UTF-8 prefix of InOutBytes (CompleteUtf8PrefixLength), leaving an incomplete
	 *  trailing sequence in InOutBytes for the next chunk to complete. */
	FString ConsumeCompleteUtf8(TArray<uint8>& InOutBytes);
}
