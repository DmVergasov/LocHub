// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSyncCommandlet.h"

#include "Containers/Ticker.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "LocHubLog.h"
#include "LocHubServiceProcess.h"
#include "LocHubSyncRunner.h"
#include "LocHubTargetPaths.h"
#include "LocHubTargetSetup.h"
#include "LocHubTypes.h"
#include "LocalizationTargetTypes.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(LocHubSyncCommandlet)

namespace LocHubSyncCommandletPrivate
{
	/** Longest a whole Push or Pull may take, service start included. */
	constexpr double TimeoutSeconds = 900.0;
	constexpr float PumpIntervalSeconds = 0.01f;

	struct FOutcome
	{
		bool bDone = false;
		FLocHubSyncResult Result;
	};

	FLocHubSyncRunner::FOnFinished RecordOutcome(const TSharedRef<FOutcome>& InOutcome)
	{
		return [InOutcome](const FLocHubSyncResult& InResult)
		{
			InOutcome->Result = InResult;
			InOutcome->bDone = true;
		};
	}

	/** A commandlet has no engine loop: HTTP completions and the service health probe run on the core ticker. */
	bool PumpUntilDone(const FOutcome& InOutcome)
	{
		const double Deadline = FPlatformTime::Seconds() + TimeoutSeconds;
		double LastTime = FPlatformTime::Seconds();
		while (!InOutcome.bDone && FPlatformTime::Seconds() < Deadline)
		{
			const double Now = FPlatformTime::Seconds();
			FTSTicker::GetCoreTicker().Tick(static_cast<float>(Now - LastTime));
			LastTime = Now;
			FPlatformProcess::Sleep(PumpIntervalSeconds);
		}
		return InOutcome.bDone;
	}
}

bool FLocHubSyncCommandletArgs::Parse(const FString& InParams, FLocHubSyncCommandletArgs& OutArgs, FString& OutError)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> Params;
	UCommandlet::ParseCommandLine(*InParams, Tokens, Switches, Params);

	OutArgs = FLocHubSyncCommandletArgs();
	OutArgs.bPush = Switches.Contains(TEXT("push"));
	OutArgs.bPull = Switches.Contains(TEXT("pull"));
	OutArgs.bDryRun = Switches.Contains(TEXT("dryrun"));
	const FString* TargetParam = Params.Find(TEXT("target"));
	OutArgs.Target = TargetParam != nullptr ? *TargetParam : FString(LocHubTargetSetup::TargetName);

	if (OutArgs.bPush == OutArgs.bPull)
	{
		OutError = TEXT("Pass exactly one of -push or -pull.");
		return false;
	}
	if (OutArgs.bDryRun && !OutArgs.bPush)
	{
		OutError = TEXT("-dryrun works only with -push.");
		return false;
	}
	if (OutArgs.Target.IsEmpty())
	{
		OutError = TEXT("-target= needs a localization target name.");
		return false;
	}
	return true;
}

ULocHubSyncCommandlet::ULocHubSyncCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 ULocHubSyncCommandlet::Main(const FString& Params)
{
	using namespace LocHubSyncCommandletPrivate;

	FLocHubSyncCommandletArgs Args;
	FString ArgsError;
	if (!FLocHubSyncCommandletArgs::Parse(Params, Args, ArgsError))
	{
		UE_LOG(LogLocHub, Error, TEXT("%s Usage: -run=LocHubSync -push [-dryrun] [-target=Game] or -run=LocHubSync -pull [-target=Game]"), *ArgsError);
		return 1;
	}

	const ULocalizationTarget* Target = FLocHubTargetPaths::FindGameTarget(Args.Target);
	if (!IsValid(Target))
	{
		UE_LOG(LogLocHub, Error, TEXT("No game localization target named %s. Run Tools > LocHub > Set Up Localization Target in the editor first."), *Args.Target);
		return 1;
	}

	const TSharedRef<FLocHubServiceProcess> Service = MakeShared<FLocHubServiceProcess>(FLocHubServiceProcess::MakeDefaultConfig());
	const TSharedRef<FLocHubSyncRunner> Runner = MakeShared<FLocHubSyncRunner>(Service);
	// Glyph fonts are asked for only on Pull; without a Slate renderer the checker adds a "skipped" note to the report.
	FLocHubSyncContext Context = FLocHubSyncContext::MakeForTarget(*Target, Args.bPull);
	Context.bRefreshLiveText = false;

	const TSharedRef<FOutcome> Outcome = MakeShared<FOutcome>();
	if (Args.bPush)
	{
		// No ConfirmTombstones: CI gathers from a clean checkout, so the retirements it reports are real.
		FLocHubPushOptions Options;
		Options.bDryRunOnly = Args.bDryRun;
		Runner->Push(MoveTemp(Context), MoveTemp(Options), RecordOutcome(Outcome));
	}
	else
	{
		Runner->Pull(MoveTemp(Context), RecordOutcome(Outcome));
	}

	const bool bFinished = PumpUntilDone(*Outcome);
	// Stops a process this commandlet started, or one left running by a host of this project that is no longer
	// alive; a service still owned by a live host (e.g. an open editor) is left running untouched.
	Service->Stop();

	for (const FString& Line : Outcome->Result.Details)
	{
		UE_LOG(LogLocHub, Display, TEXT("%s"), *Line);
	}
	if (!bFinished)
	{
		UE_LOG(LogLocHub, Error, TEXT("LocHub %s did not finish within %.0f seconds."), Args.bPush ? TEXT("Push") : TEXT("Pull"), TimeoutSeconds);
		return 1;
	}
	if (!Outcome->Result.bSuccess)
	{
		UE_LOG(LogLocHub, Error, TEXT("%s"), *Outcome->Result.Summary);
		return 1;
	}
	UE_LOG(LogLocHub, Display, TEXT("%s"), *Outcome->Result.Summary);
	return 0;
}
