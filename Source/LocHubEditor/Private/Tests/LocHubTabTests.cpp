// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Bridge/LocHubBridgeCommands.h"
#include "Tab/SLocHubTab.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubTabPageUrlTest,
	"LocHub.Bridge.Tab.PageUrl",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubTabPageUrlTest::RunTest(const FString& Parameters)
{
	// "?host=editor" is what Web/src/main.tsx reads to switch to the dark theme; "#/grid" is the grid route.
	TestEqual(TEXT("the tab asks the web app for the editor theme and opens on the grid"),
		SLocHubTab::MakePageUrl(TEXT("http://127.0.0.1:47810")), FString(TEXT("http://127.0.0.1:47810/?host=editor#/grid")));
	TestTrue(TEXT("the editor reaches the service on loopback"), LocHubBridge::GetServiceBaseUrl().StartsWith(TEXT("http://127.0.0.1:")));
	TestEqual(TEXT("the tab is registered under a stable id"), SLocHubTab::TabId, FName(TEXT("LocHub")));
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
