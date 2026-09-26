// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubStyle.h"

#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Styling/ISlateStyle.h"
#include "Styling/SlateBrush.h"
#include "Styling/SlateStyleRegistry.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubStyleIconTest,
	"LocHub.Style.Icon",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubStyleIconTest::RunTest(const FString& Parameters)
{
	// FLocHubEditorModule::StartupModule calls FLocHubStyle::Initialize() before this test ever runs (the editor
	// module is already loaded), so the style set must already be registered under its own name.
	const ISlateStyle* Style = FSlateStyleRegistry::FindSlateStyle(FLocHubStyle::GetStyleSetName());
	if (!TestNotNull(TEXT("LocHubStyle is registered"), Style))
	{
		return false;
	}

	const FSlateBrush* IconBrush = Style->GetBrush(TEXT("LocHub.Icon"));
	// TestNotEqual's templated pointer overload cannot deduce ValueType across differing const-ness
	// (GetDefaultBrush() returns a non-const FSlateBrush*), so this compares the pointers directly.
	TestTrue(TEXT("LocHub.Icon is not the style's default/missing brush"), IconBrush != Style->GetDefaultBrush());

	const FString IconFile = IconBrush->GetResourceName().ToString();
	TestTrue(FString::Printf(TEXT("Icon file exists on disk: %s"), *IconFile), IFileManager::Get().FileExists(*IconFile));
	return true;
}

#endif
