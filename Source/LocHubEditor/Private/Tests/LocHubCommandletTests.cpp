// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSyncCommandlet.h"
#include "LocHubTargetSetup.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCommandletParseArgsTest,
	"LocHub.Commandlet.ParseArgs",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCommandletParseArgsTest::RunTest(const FString& Parameters)
{
	FLocHubSyncCommandletArgs Args;
	FString Error;

	TestTrue(TEXT("-push parses"), FLocHubSyncCommandletArgs::Parse(TEXT("-push"), Args, Error));
	TestTrue(TEXT("-push is a push"), Args.bPush && !Args.bPull && !Args.bDryRun);
	TestEqual(TEXT("Default target"), Args.Target, FString(LocHubTargetSetup::TargetName));

	TestTrue(TEXT("-pull with a target parses"), FLocHubSyncCommandletArgs::Parse(TEXT("-pull -target=Other"), Args, Error));
	TestTrue(TEXT("-pull is a pull"), Args.bPull && !Args.bPush);
	TestEqual(TEXT("Target from the command line"), Args.Target, TEXT("Other"));

	TestTrue(TEXT("-push -dryrun parses"), FLocHubSyncCommandletArgs::Parse(TEXT("-push -dryrun"), Args, Error));
	TestTrue(TEXT("Dry run is on"), Args.bDryRun);

	TestTrue(TEXT("Switches ignore case"), FLocHubSyncCommandletArgs::Parse(TEXT("-PUSH"), Args, Error) && Args.bPush);
	TestTrue(TEXT("Engine switches are ignored"), FLocHubSyncCommandletArgs::Parse(TEXT("-push -unattended -nosplash"), Args, Error));

	Error.Reset();
	TestFalse(TEXT("-dryrun needs -push"), FLocHubSyncCommandletArgs::Parse(TEXT("-pull -dryrun"), Args, Error));
	TestFalse(TEXT("A refusal says why"), Error.IsEmpty());
	TestFalse(TEXT("Push and pull together"), FLocHubSyncCommandletArgs::Parse(TEXT("-push -pull"), Args, Error));
	TestFalse(TEXT("No operation"), FLocHubSyncCommandletArgs::Parse(FString(), Args, Error));
	TestFalse(TEXT("Empty target"), FLocHubSyncCommandletArgs::Parse(TEXT("-push -target="), Args, Error));
	return true;
}

#endif
