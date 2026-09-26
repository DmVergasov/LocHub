// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubCoverage.h"
#include "LocHubTypes.h"
#include "Misc/AutomationTest.h"
#include "Tests/LocHubTestUtils.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCoverageScanCppTest,
	"LocHub.Coverage.ScanCpp",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCoverageScanCppTest::RunTest(const FString& Parameters)
{
	const TArray<FString> Lines = {
		TEXT("// FText::FromString(TEXT(\"Commented out\"))"),
		TEXT("const FText Speed = FText::FromString(TEXT(\"SPEED\"));"),
		TEXT("const FText Number = FText::FromString(TEXT(\"42\"));"),
		TEXT("const FText Plain = FText::FromString(\"Plain literal\");"),
		TEXT("const FText Dynamic = FText::FromString(Name);"),
		TEXT(" * FText::FromString(TEXT(\"Doc comment\"))"),
		TEXT("const FText Quote = FText::FromString( TEXT( \"Say \\\"hi\\\"\" ) );"),
	};
	TArray<FLocHubCoverageFinding> Findings;
	LocHubCoverage::ScanCpp(TEXT("Source/Game/Hud.cpp"), FString::Join(Lines, TEXT("\n")), Findings);

	if (!TestEqual(TEXT("Three literals with letters"), Findings.Num(), 3))
	{
		return false;
	}
	TestEqual(TEXT("Kind"), Findings[0].Kind, FString(LocHub::CoverageKindFromString));
	TestEqual(TEXT("File"), Findings[0].File, TEXT("Source/Game/Hud.cpp"));
	TestEqual(TEXT("TEXT() literal"), Findings[0].Text, TEXT("SPEED"));
	TestEqual(TEXT("TEXT() literal line"), Findings[0].Line, 2);
	TestEqual(TEXT("Plain literal"), Findings[1].Text, TEXT("Plain literal"));
	TestEqual(TEXT("Plain literal line"), Findings[1].Line, 4);
	TestEqual(TEXT("Escaped quotes are unescaped"), Findings[2].Text, TEXT("Say \"hi\""));
	TestEqual(TEXT("Escaped literal line"), Findings[2].Line, 7);

	TArray<FLocHubCoverageFinding> None;
	LocHubCoverage::ScanCpp(TEXT("Source/Game/Other.cpp"), TEXT("int32 Value = 0;"), None);
	TestEqual(TEXT("No call, no findings"), None.Num(), 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCoverageScanRmlTest,
	"LocHub.Coverage.ScanRml",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCoverageScanRmlTest::RunTest(const FString& Parameters)
{
	const TArray<FString> Lines = {
		TEXT("<rml>"),
		TEXT("<head><title>Hud</title><style>p { color: red; }</style></head>"),
		TEXT("<body>"),
		TEXT("  <!-- <div>Commented out</div> -->"),
		TEXT("  <div class=\"title\">SETTINGS</div>"),
		TEXT("  <div data-if=\"visible\">{{ speed }}</div>"),
		TEXT("  <p>ELAPSED: {{ time }}</p>"),
		TEXT("  <span title=\"a > b\">42</span>"),
		TEXT("  <p>"),
		TEXT("    Press &amp; hold"),
		TEXT("  </p>"),
		TEXT("</body>"),
		TEXT("</rml>"),
	};
	TArray<FLocHubCoverageFinding> Findings;
	LocHubCoverage::ScanRml(TEXT("Content/UI/hud.rml"), FString::Join(Lines, TEXT("\n")), Findings);

	if (!TestEqual(TEXT("Three visible texts"), Findings.Num(), 3))
	{
		return false;
	}
	TestEqual(TEXT("Kind"), Findings[0].Kind, FString(LocHub::CoverageKindRmlLiteral));
	TestEqual(TEXT("Element text"), Findings[0].Text, TEXT("SETTINGS"));
	TestEqual(TEXT("Element text line"), Findings[0].Line, 5);
	TestEqual(TEXT("Binding is stripped"), Findings[1].Text, TEXT("ELAPSED:"));
	TestEqual(TEXT("Binding text line"), Findings[1].Line, 7);
	TestEqual(TEXT("Entities decoded, whitespace collapsed"), Findings[2].Text, TEXT("Press & hold"));
	TestEqual(TEXT("Line of the first visible character"), Findings[2].Line, 10);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubCoverageScanRootsTest,
	"LocHub.Coverage.ScanRoots",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubCoverageScanRootsTest::RunTest(const FString& Parameters)
{
	const TArray<FString> Excludes = { TEXT("Source/*Editor/*"), TEXT("*/Tests/*") };
	TestTrue(TEXT("Editor module is excluded"), LocHubCoverage::IsExcluded(TEXT("Source/GameEditor/Tool.cpp"), Excludes));
	TestTrue(TEXT("Tests are excluded"), LocHubCoverage::IsExcluded(TEXT("Source/Game/Tests/HudTests.cpp"), Excludes));
	TestFalse(TEXT("Game code is scanned"), LocHubCoverage::IsExcluded(TEXT("Source/Game/Hud.cpp"), Excludes));

	const FString TempDir = LocHubTests::MakeTempDir();
	LocHubTests::WriteTextFile(TempDir / TEXT("Source/Game/Hud.cpp"), TEXT("Label = FText::FromString(TEXT(\"PAUSED\"));"));
	LocHubTests::WriteTextFile(TempDir / TEXT("Source/GameEditor/Tool.cpp"), TEXT("Label = FText::FromString(TEXT(\"Editor only\"));"));
	LocHubTests::WriteTextFile(TempDir / TEXT("Content/UI/hud.rml"), TEXT("<rml><body><div>PAUSED</div></body></rml>"));

	TArray<FLocHubCoverageFinding> Findings;
	LocHubCoverage::ScanRoots(TempDir, { TempDir / TEXT("Source") }, { TempDir / TEXT("Content") }, Excludes, Findings);
	if (TestEqual(TEXT("One C++ finding and one RML finding"), Findings.Num(), 2))
	{
		TestEqual(TEXT("C++ path is project-relative"), Findings[0].File, TEXT("Source/Game/Hud.cpp"));
		TestEqual(TEXT("C++ kind"), Findings[0].Kind, FString(LocHub::CoverageKindFromString));
		TestEqual(TEXT("RML path is project-relative"), Findings[1].File, TEXT("Content/UI/hud.rml"));
		TestEqual(TEXT("RML kind"), Findings[1].Kind, FString(LocHub::CoverageKindRmlLiteral));
	}

	LocHubTests::DeleteTempDir(TempDir);
	return true;
}

#endif
