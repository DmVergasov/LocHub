// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "LocHubSyncCommandlet.generated.h"

/** Parsed switches of -run=LocHubSync. */
struct FLocHubSyncCommandletArgs
{
	bool bPush = false;
	bool bPull = false;
	bool bDryRun = false;
	FString Target;

	/** False with a reason when the switches do not name exactly one operation. */
	static bool Parse(const FString& InParams, FLocHubSyncCommandletArgs& OutArgs, FString& OutError);
};

/**
 * CI entry point for LocHub:
 *   <editor binary> <Project>.uproject -run=LocHubSync -push [-dryrun] [-target=Game]
 *   <editor binary> <Project>.uproject -run=LocHubSync -pull [-target=Game]
 * <editor binary>: UnrealEditor-Cmd.exe on Windows, UnrealEditor-Cmd on Linux, UnrealEditor.app/Contents/MacOS/UnrealEditor on Mac.
 * Gather Text stays the stock GatherText commandlet; run it before -push.
 */
UCLASS()
class ULocHubSyncCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	ULocHubSyncCommandlet();

	virtual int32 Main(const FString& Params) override;
};
