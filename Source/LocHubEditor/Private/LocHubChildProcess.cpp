// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubChildProcess.h"

#include "HAL/PlatformTime.h"
#include "LocHubLog.h"
#include "LocHubPosix.h"

namespace LocHubChildProcessPrivate
{
	constexpr double GraceSeconds = 2.0;
	constexpr double KillWaitSeconds = 1.0;
	constexpr float ExitPollIntervalSeconds = 0.05f;
	constexpr int32 MaxBytesPerRead = 1024 * 1024;

	/** Polls InHandle until the process is gone or InTimeoutSeconds pass; zero checks once. IsProcRunning, not
	 *  IsApplicationRunning(pid): on Mac/Linux the latter (getpriority) still sees a child of this process that has
	 *  exited but was not reaped yet, while IsProcRunning notices the zombie and reaps it. */
	bool WaitForExit(FProcHandle& InHandle, const double InTimeoutSeconds)
	{
		const double Deadline = FPlatformTime::Seconds() + InTimeoutSeconds;
		while (FPlatformProcess::IsProcRunning(InHandle))
		{
			if (FPlatformTime::Seconds() >= Deadline)
			{
				return false;
			}
			FPlatformProcess::Sleep(ExitPollIntervalSeconds);
		}
		return true;
	}
}

bool LocHubChildProcess::Terminate(FProcHandle& InHandle, const uint32 InPid, const ELocHubStopMode InMode)
{
	using namespace LocHubChildProcessPrivate;

#if PLATFORM_MAC || PLATFORM_UNIX
	const bool bEnded = RunStopSequence(InMode,
		[InPid](const bool bForce) { return LocHubPosix::SignalProcessGroup(InPid, bForce); },
		[&InHandle](const double InTimeoutSeconds) { return WaitForExit(InHandle, InTimeoutSeconds); });
#else
	FPlatformProcess::TerminateProc(InHandle, true);
	// TerminateProcess only starts the termination; wait for it so "ended" means ended here too.
	const bool bEnded = WaitForExit(InHandle, KillWaitSeconds);
#endif
	if (!bEnded)
	{
		UE_LOG(LogLocHub, Warning, TEXT("The process (pid %u) that LocHub started is still running after it was told to end."), InPid);
	}
	return bEnded;
}

bool LocHubChildProcess::RunStopSequence(const ELocHubStopMode InMode, const TFunctionRef<bool(bool bForce)> InSignal, const TFunctionRef<bool(double InTimeoutSeconds)> InWaitForExit)
{
	using namespace LocHubChildProcessPrivate;

	if (InMode == ELocHubStopMode::Graceful)
	{
		const bool bTermDelivered = InSignal(false);
		if (bTermDelivered && InWaitForExit(GraceSeconds))
		{
			return true;
		}
	}
	const bool bKillDelivered = InSignal(true);
	return InWaitForExit(bKillDelivered ? KillWaitSeconds : 0.0);
}

void LocHubChildProcess::ReadAvailableBytes(void* InReadPipe, TArray<uint8>& InOutBytes)
{
	using namespace LocHubChildProcessPrivate;

	// One ReadPipeToArray call returns only part of what may be waiting (Mac: up to 32 KB; Linux and Windows: what the
	// pipe held at that instant), so read until it has nothing.
	TArray<uint8> Chunk;
	int32 BytesRead = 0;
	while (BytesRead < MaxBytesPerRead && FPlatformProcess::ReadPipeToArray(InReadPipe, Chunk) && Chunk.Num() > 0)
	{
		InOutBytes.Append(Chunk);
		BytesRead += Chunk.Num();
	}
}

int32 LocHubChildProcess::CompleteUtf8PrefixLength(const TConstArrayView<uint8> InBytes)
{
	const int32 Num = InBytes.Num();
	// A sequence is at most 4 bytes long, so only a lead byte among the last 3 can start one that is cut off.
	for (int32 Index = Num - 1; Index >= 0 && Index >= Num - 3; --Index)
	{
		const uint8 Byte = InBytes[Index];
		if ((Byte & 0xC0) == 0x80)
		{
			// A continuation byte: its lead byte is further back.
			continue;
		}

		int32 SequenceLength = 1;
		if ((Byte & 0xE0) == 0xC0)
		{
			SequenceLength = 2;
		}
		else if ((Byte & 0xF0) == 0xE0)
		{
			SequenceLength = 3;
		}
		else if ((Byte & 0xF8) == 0xF0)
		{
			SequenceLength = 4;
		}
		return Index + SequenceLength > Num ? Index : Num;
	}
	return Num;
}

FString LocHubChildProcess::ConsumeCompleteUtf8(TArray<uint8>& InOutBytes)
{
	const int32 CompleteLength = CompleteUtf8PrefixLength(InOutBytes);
	if (CompleteLength == 0)
	{
		return FString();
	}
	FString Text = FString::ConstructFromPtrSize(reinterpret_cast<const UTF8CHAR*>(InOutBytes.GetData()), CompleteLength);
	InOutBytes.RemoveAt(0, CompleteLength);
	return Text;
}
