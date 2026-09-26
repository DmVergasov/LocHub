// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubChildProcess.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubChildProcessTestsPrivate
{
	/** A process RunStopSequence is asked to stop, described by how it reacts, plus a log of what was done to it. */
	struct FFakeStoppedProcess
	{
		bool bSignalsDelivered = true;
		bool bEndsOnTerm = false;
		bool bEndsOnKill = true;

		bool bRunning = true;
		TArray<FString> Steps;
		TArray<double> WaitTimeouts;
	};

	bool StopFake(const ELocHubStopMode InMode, FFakeStoppedProcess& InOutProcess)
	{
		return LocHubChildProcess::RunStopSequence(InMode,
			[&InOutProcess](const bool bForce)
			{
				InOutProcess.Steps.Add(bForce ? TEXT("KILL") : TEXT("TERM"));
				if (!InOutProcess.bSignalsDelivered)
				{
					return false;
				}
				if (bForce ? InOutProcess.bEndsOnKill : InOutProcess.bEndsOnTerm)
				{
					InOutProcess.bRunning = false;
				}
				return true;
			},
			[&InOutProcess](const double InTimeoutSeconds)
			{
				InOutProcess.Steps.Add(TEXT("WAIT"));
				InOutProcess.WaitTimeouts.Add(InTimeoutSeconds);
				return !InOutProcess.bRunning;
			});
	}

	TArray<uint8> ToUtf8Bytes(const FString& InText)
	{
		const auto Utf8 = StringCast<UTF8CHAR>(*InText, InText.Len());
		return TArray<uint8>(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length());
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubChildProcessStopSequenceTest,
	"LocHub.ChildProcess.StopSequence",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubChildProcessStopSequenceTest::RunTest(const FString& Parameters)
{
	using namespace LocHubChildProcessTestsPrivate;

	{
		FFakeStoppedProcess Process;
		Process.bEndsOnTerm = true;
		TestTrue(TEXT("a process that ends on SIGTERM counts as ended"), StopFake(ELocHubStopMode::Graceful, Process));
		TestEqual(TEXT("SIGTERM, then a wait -- never SIGKILL"), FString::Join(Process.Steps, TEXT(",")), TEXT("TERM,WAIT"));
		TestTrue(TEXT("the grace wait is not zero"), Process.WaitTimeouts.Num() == 1 && Process.WaitTimeouts[0] > 0.0);
	}
	{
		FFakeStoppedProcess Process;
		TestTrue(TEXT("a process that ignores SIGTERM still ends"), StopFake(ELocHubStopMode::Graceful, Process));
		TestEqual(TEXT("SIGTERM, grace wait, then SIGKILL and a second wait"), FString::Join(Process.Steps, TEXT(",")), TEXT("TERM,WAIT,KILL,WAIT"));
		TestTrue(TEXT("both waits are bounded and not zero"), Process.WaitTimeouts.Num() == 2 && Process.WaitTimeouts[0] > 0.0 && Process.WaitTimeouts[1] > 0.0);
	}
	{
		FFakeStoppedProcess Process;
		Process.bEndsOnKill = false;
		TestFalse(TEXT("a process that survives SIGKILL's wait is not reported as ended"), StopFake(ELocHubStopMode::Graceful, Process));
		TestEqual(TEXT("it still got both signals"), FString::Join(Process.Steps, TEXT(",")), TEXT("TERM,WAIT,KILL,WAIT"));
	}
	{
		FFakeStoppedProcess Process;
		TestTrue(TEXT("an immediate stop ends the process"), StopFake(ELocHubStopMode::Immediate, Process));
		TestEqual(TEXT("an immediate stop starts at SIGKILL"), FString::Join(Process.Steps, TEXT(",")), TEXT("KILL,WAIT"));
	}
	{
		FFakeStoppedProcess Process;
		Process.bSignalsDelivered = false;
		TestFalse(TEXT("a process no signal reaches is not reported as ended"), StopFake(ELocHubStopMode::Graceful, Process));
		TestEqual(TEXT("a refused SIGTERM goes straight to SIGKILL"), FString::Join(Process.Steps, TEXT(",")), TEXT("TERM,KILL,WAIT"));
		TestTrue(TEXT("a refused signal is not waited for"), Process.WaitTimeouts.Num() == 1 && Process.WaitTimeouts[0] == 0.0);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubChildProcessUtf8SplitTest,
	"LocHub.ChildProcess.Utf8Split",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubChildProcessUtf8SplitTest::RunTest(const FString& Parameters)
{
	using namespace LocHubChildProcessTestsPrivate;

	TestEqual(TEXT("nothing is complete in nothing"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>()), 0);
	TestEqual(TEXT("ASCII is always complete"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 'a', 'b', 'c' })), 3);
	TestEqual(TEXT("a whole two-byte character is complete"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 'a', 0xD0, 0x96 })), 3);
	TestEqual(TEXT("a two-byte character's lead byte alone is held back"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 'a', 0xD0 })), 1);
	TestEqual(TEXT("two of a three-byte character's bytes are held back"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 'a', 0xE2, 0x82 })), 1);
	TestEqual(TEXT("three of a four-byte character's bytes are held back"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 0xF0, 0x9F, 0x98 })), 0);
	TestEqual(TEXT("a whole four-byte character is complete"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 0xF0, 0x9F, 0x98, 0x80 })), 4);
	TestEqual(TEXT("stray continuation bytes are never held back forever"), LocHubChildProcess::CompleteUtf8PrefixLength(TArray<uint8>({ 0x80, 0x80, 0x80, 0x80 })), 4);

	// Cyrillic, a Euro sign and an emoji: two-, three- and four-byte UTF-8 sequences between ASCII.
	const FString Original = TEXT("a\u0416 \u20AC \U0001F600 z");
	const TArray<uint8> Bytes = ToUtf8Bytes(Original);
	for (int32 SplitAt = 0; SplitAt <= Bytes.Num(); ++SplitAt)
	{
		TArray<uint8> Pending(Bytes.GetData(), SplitAt);
		const FString FirstChunkText = LocHubChildProcess::ConsumeCompleteUtf8(Pending);
		Pending.Append(Bytes.GetData() + SplitAt, Bytes.Num() - SplitAt);
		const FString SecondChunkText = LocHubChildProcess::ConsumeCompleteUtf8(Pending);

		TestEqual(FString::Printf(TEXT("split at byte %d: both chunks decode to the original text"), SplitAt), FirstChunkText + SecondChunkText, Original);
		TestTrue(FString::Printf(TEXT("split at byte %d: nothing is left over"), SplitAt), Pending.IsEmpty());
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubChildProcessTerminateTest,
	"LocHub.ChildProcess.Terminate",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubChildProcessTerminateTest::RunTest(const FString& Parameters)
{
	// A child that would otherwise run for half a minute and has a child of its own. On Mac and Linux the shell and
	// its sleep also ignore SIGTERM, so only the escalation to SIGKILL on the whole process group ends them.
#if PLATFORM_WINDOWS
	const TCHAR* Executable = TEXT("cmd.exe");
	const TCHAR* Arguments = TEXT("/c ping -n 30 127.0.0.1 >nul");
#else
	const TCHAR* Executable = TEXT("/bin/sh");
	const TCHAR* Arguments = TEXT("-c \"trap '' TERM; sleep 30\"");
#endif
	uint32 ProcessId = 0;
	FProcHandle Handle = FPlatformProcess::CreateProc(Executable, Arguments, false, true, true, &ProcessId, 0, nullptr, nullptr, nullptr);
	if (!TestTrue(TEXT("the long-running child starts"), Handle.IsValid()))
	{
		return false;
	}

	const double StartSeconds = FPlatformTime::Seconds();
	const bool bEnded = LocHubChildProcess::Terminate(Handle, ProcessId, ELocHubStopMode::Graceful);
	const double ElapsedSeconds = FPlatformTime::Seconds() - StartSeconds;

	TestTrue(TEXT("Terminate reports the child as ended"), bEnded);
	TestFalse(TEXT("the child is no longer running once Terminate returns"), FPlatformProcess::IsProcRunning(Handle));
	TestTrue(TEXT("Terminate returns well before the child would have exited on its own"), ElapsedSeconds < 10.0);
	FPlatformProcess::CloseProc(Handle);
	return true;
}

#endif
