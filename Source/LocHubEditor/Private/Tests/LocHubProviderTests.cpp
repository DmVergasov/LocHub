// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "ILocalizationServiceProvider.h"
#include "LocHubProvider.h"
#include "LocHubTypes.h"
#include "LocalizationServiceOperations.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubProviderExecuteTest,
	"LocHub.Provider.Execute",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubProviderExecuteTest::RunTest(const FString& Parameters)
{
	FLocHubProvider Provider;
	ILocalizationServiceProvider& AsProvider = Provider;
	TestEqual(TEXT("Name"), AsProvider.GetName(), FName(LocHub::ProviderName));
	TestTrue(TEXT("Enabled, so the Dashboard shows its toolbar section"), AsProvider.IsEnabled());

	const TSharedRef<int32> DelegateCalls = MakeShared<int32>(0);
	const FLocalizationServiceOperationComplete OnComplete = FLocalizationServiceOperationComplete::CreateLambda(
		[DelegateCalls](const FLocalizationServiceOperationRef& InOperation, ELocalizationServiceOperationCommandResult::Type InResult)
		{
			++(*DelegateCalls);
		});

	const TSharedRef<FConnectToProvider, ESPMode::ThreadSafe> Connect = ILocalizationServiceOperation::Create<FConnectToProvider>();
	const ELocalizationServiceOperationCommandResult::Type ConnectResult = AsProvider.Execute(Connect, ELocalizationServiceOperationConcurrency::Synchronous, OnComplete);
	TestTrue(TEXT("Connect succeeds"), ConnectResult == ELocalizationServiceOperationCommandResult::Succeeded);

	const TSharedRef<FDownloadLocalizationTargetFile, ESPMode::ThreadSafe> Download = ILocalizationServiceOperation::Create<FDownloadLocalizationTargetFile>();
	const ELocalizationServiceOperationCommandResult::Type DownloadResult = AsProvider.Execute(Download, ELocalizationServiceOperationConcurrency::Synchronous, OnComplete);
	TestTrue(TEXT("File download is not supported"), DownloadResult == ELocalizationServiceOperationCommandResult::Failed);
	TestFalse(TEXT("The refusal says what to use instead"), Download->GetOutErrorText().IsEmpty());

	TestEqual(TEXT("The completion delegate runs for every operation"), *DelegateCalls, 2);
	return true;
}

#endif
