// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Bridge/LocHubBridgeCommands.h"
#include "Bridge/LocHubSseParser.h"
#include "Dom/JsonValue.h"
#include "Dom/JsonObject.h"
#include "Internationalization/TextLocalizationManager.h"
#include "LocHubEditorModule.h"
#include "LocHubSyncRunner.h"
#include "Misc/Base64.h"
#include "Misc/Guid.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace LocHubBridgeTests
{
	TArray<uint8> ToUtf8Bytes(const FString& InText)
	{
		const auto Converted = StringCast<UTF8CHAR>(*InText);
		return TArray<uint8>(reinterpret_cast<const uint8*>(Converted.Get()), Converted.Length());
	}

	// Cyrillic "PAUSE", spelled with escapes so the source file stays ASCII.
	const TCHAR* const CyrillicPause = TEXT("\u041F\u0410\u0423\u0417\u0410");
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeOriginParseTest,
	"LocHub.Bridge.Origin.Parse",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeOriginParseTest::RunTest(const FString& Parameters)
{
	const FLocHubOrigin Source = LocHubBridge::ParseOrigin(TEXT("Source/MyGame/Private/MyHud.cpp(42)"));
	TestTrue(TEXT("gather's File(Line) is a source file"), Source.Kind == ELocHubOriginKind::SourceFile);
	TestEqual(TEXT("the line suffix is cut off the path"), Source.Path, FString(TEXT("Source/MyGame/Private/MyHud.cpp")));
	TestEqual(TEXT("the line is read"), Source.Line, 42);

	const FLocHubOrigin Colon = LocHubBridge::ParseOrigin(TEXT("Source\\MyGame\\MyHud.h:7"));
	TestTrue(TEXT("File:Line with backslashes is a source file"), Colon.Kind == ELocHubOriginKind::SourceFile);
	TestEqual(TEXT("backslashes become slashes"), Colon.Path, FString(TEXT("Source/MyGame/MyHud.h")));
	TestEqual(TEXT("the colon line is read"), Colon.Line, 7);

	const FLocHubOrigin Rooted = LocHubBridge::ParseOrigin(TEXT("/Source/MyGame/MyHud.cpp(3)"));
	TestTrue(TEXT("a leading slash with a source extension is still a file"), Rooted.Kind == ELocHubOriginKind::SourceFile);
	TestEqual(TEXT("the leading slash is dropped"), Rooted.Path, FString(TEXT("Source/MyGame/MyHud.cpp")));

	const FLocHubOrigin Drive = LocHubBridge::ParseOrigin(TEXT("D:/Work/MyHud.cpp"));
	TestEqual(TEXT("a drive letter is not a line"), Drive.Line, 0);
	TestEqual(TEXT("a drive path stays whole"), Drive.Path, FString(TEXT("D:/Work/MyHud.cpp")));

	const FLocHubOrigin Asset = LocHubBridge::ParseOrigin(TEXT("/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.TextBlock_0.Text"));
	TestTrue(TEXT("an object path is an asset"), Asset.Kind == ELocHubOriginKind::Asset);
	TestEqual(TEXT("the asset is named by its package"), Asset.Path, FString(TEXT("/Game/UI/WBP_Pause")));

	TestTrue(TEXT("a native /Script/ object has nothing to open"), LocHubBridge::ParseOrigin(TEXT("/Script/Engine.Actor")).Kind == ELocHubOriginKind::Unknown);
	TestTrue(TEXT("a blank origin has nothing to open"), LocHubBridge::ParseOrigin(TEXT("  ")).Kind == ELocHubOriginKind::Unknown);

	// A synthetic root: ResolveProjectFile is string arithmetic and never touches the disk.
	const FString Root = TEXT("D:/LocHubTestProject/");
	FString Resolved;
	TestTrue(TEXT("a relative path inside the project resolves"), LocHubBridge::ResolveProjectFile(TEXT("Source/MyHud.cpp"), Root, Resolved));
	TestEqual(TEXT("the resolved path is absolute"), Resolved, FString(TEXT("D:/LocHubTestProject/Source/MyHud.cpp")));
	TestFalse(TEXT("climbing out with .. is refused"), LocHubBridge::ResolveProjectFile(TEXT("Source/../../Windows/win.ini"), Root, Resolved));
	TestFalse(TEXT("a sibling that shares the prefix is refused"), LocHubBridge::ResolveProjectFile(TEXT("../LocHubTestProjectOther/a.cpp"), Root, Resolved));
	TestFalse(TEXT("an absolute path is refused"), LocHubBridge::ResolveProjectFile(TEXT("C:/Windows/win.ini"), Root, Resolved));
	TestFalse(TEXT("an empty path is refused"), LocHubBridge::ResolveProjectFile(FString(), Root, Resolved));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeSseParseTest,
	"LocHub.Bridge.Sse.Parse",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeSseParseTest::RunTest(const FString& Parameters)
{
	const FString Payload = FString::Printf(
		TEXT("{\"name\":\"ApplyLive\",\"args\":{\"culture\":\"ru\",\"entries\":[{\"translation\":\"%s\"}]}}"),
		LocHubBridgeTests::CyrillicPause);
	const TArray<uint8> Bytes = LocHubBridgeTests::ToUtf8Bytes(TEXT(": connected\n\nevent: command\r\ndata: ") + Payload + TEXT("\r\n\r\n"));

	// Cut the stream inside the first two-byte Cyrillic sequence (lead byte 0xD0), as a TCP read may.
	const int32 Split = Bytes.IndexOfByKey(static_cast<uint8>(0xD0)) + 1;
	TestTrue(TEXT("the payload carries a Cyrillic lead byte"), Split > 0);

	FLocHubSseParser Parser;
	TArray<FLocHubSseEvent> Events;
	Parser.Feed(TConstArrayView<uint8>(Bytes.GetData(), Split), Events);
	TestEqual(TEXT("nothing is dispatched before the blank line"), Events.Num(), 0);
	Parser.Feed(TConstArrayView<uint8>(Bytes.GetData() + Split, Bytes.Num() - Split), Events);
	TestEqual(TEXT("one event after the blank line"), Events.Num(), 1);
	if (Events.Num() == 1)
	{
		TestEqual(TEXT("the event name survives CRLF"), Events[0].Event, FString(TEXT("command")));
		TestEqual(TEXT("the UTF-8 split does not corrupt the payload"), Events[0].Data, Payload);
	}
	TestEqual(TEXT("the greeting comment is counted"), Parser.GetNumComments(), 1);

	Events.Reset();
	Parser.Feed(LocHubBridgeTests::ToUtf8Bytes(TEXT("data: first\ndata: second\n\n: ping\n\n")), Events);
	TestEqual(TEXT("multi-line data is one event"), Events.Num(), 1);
	if (Events.Num() == 1)
	{
		TestEqual(TEXT("an unnamed event is a message"), Events[0].Event, FString(TEXT("message")));
		TestEqual(TEXT("data lines join with a newline"), Events[0].Data, FString(TEXT("first\nsecond")));
	}
	TestEqual(TEXT("the heartbeat is a comment, not an event"), Parser.GetNumComments(), 2);

	Parser.Reset();
	TestEqual(TEXT("reset forgets the comments"), Parser.GetNumComments(), 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeRejectInvalidTest,
	"LocHub.Bridge.Commands.RejectInvalid",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeRejectInvalidTest::RunTest(const FString& Parameters)
{
	struct FRejectedCommand
	{
		const TCHAR* Why;
		const TCHAR* Json;
	};

	// Every case is refused before it can touch the editor: no asset opens, no preview changes, nothing is logged.
	const FRejectedCommand Cases[] = {
		{ TEXT("text that is not JSON"), TEXT("not json") },
		{ TEXT("a JSON array"), TEXT("[1]") },
		{ TEXT("an unknown command"), TEXT("{\"name\":\"DeleteEverything\",\"args\":{}}") },
		{ TEXT("a name in the wrong case"), TEXT("{\"name\":\"openorigin\",\"args\":{\"origin\":\"Source/A.cpp(1)\"}}") },
		{ TEXT("a command without args"), TEXT("{\"name\":\"OpenOrigin\"}") },
		{ TEXT("ApplyLive without entries"), TEXT("{\"name\":\"ApplyLive\",\"args\":{\"culture\":\"ru\",\"entries\":[]}}") },
		{ TEXT("ApplyLive with an incomplete entry"), TEXT("{\"name\":\"ApplyLive\",\"args\":{\"culture\":\"ru\",\"entries\":[{\"namespace\":\"HW\"}]}}") },
		{ TEXT("ApplyLive for a malformed culture"), TEXT("{\"name\":\"ApplyLive\",\"args\":{\"culture\":\"../ru\",\"entries\":[{\"namespace\":\"HW\",\"key\":\"K\",\"source\":\"S\",\"translation\":\"T\"}]}}") },
		{ TEXT("SetPreviewCulture for a malformed culture"), TEXT("{\"name\":\"SetPreviewCulture\",\"args\":{\"culture\":\"../ru\"}}") },
		{ TEXT("a package that does not exist"), TEXT("{\"name\":\"OpenOrigin\",\"args\":{\"origin\":\"/Game/LocHubDoesNotExist/WBP_Nothing.WBP_Nothing\"}}") },
		{ TEXT("a native class"), TEXT("{\"name\":\"OpenOrigin\",\"args\":{\"origin\":\"/Script/Engine.Actor\"}}") },
		{ TEXT("a file outside the project"), TEXT("{\"name\":\"OpenOrigin\",\"args\":{\"origin\":\"Source/../../../Windows/win.ini(1)\"}}") },
		{ TEXT("a project file that does not exist"), TEXT("{\"name\":\"OpenOrigin\",\"args\":{\"origin\":\"Source/LocHubDoesNotExist.cpp(3)\"}}") },
	};

	for (const FRejectedCommand& Case : Cases)
	{
		FString Error;
		TestFalse(FString::Printf(TEXT("refuses %s"), Case.Why), LocHubBridge::ExecuteCommandJson(Case.Json, Error));
		TestFalse(FString::Printf(TEXT("says why it refused %s"), Case.Why), Error.IsEmpty());
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeLiveApplyTest,
	"LocHub.Bridge.LiveApply.UpdatesLiveTable",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeLiveApplyTest::RunTest(const FString& Parameters)
{
	const FString Json = TEXT("[{\"namespace\":\"HW\",\"key\":\"Pause\",\"source\":\"PAUSED\",\"translation\":\"P\"}]");
	TArray<TSharedPtr<FJsonValue>> Values;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
	TestTrue(TEXT("the wire entries are a JSON array"), FJsonSerializer::Deserialize(Reader, Values));
	TArray<FLocHubLiveEntry> Parsed;
	FString Error;
	TestTrue(TEXT("a complete entry parses"), LocHubBridge::ParseLiveEntries(Values, Parsed, Error));
	TestEqual(TEXT("one entry per array item"), Parsed.Num(), 1);
	if (Parsed.Num() == 1)
	{
		TestEqual(TEXT("the source travels with the entry"), Parsed[0].Source, FString(TEXT("PAUSED")));
	}

	// A namespace no real text uses, so the entry cannot collide with the project's strings.
	FLocHubLiveEntry Entry;
	Entry.Namespace = FString::Printf(TEXT("LocHubAutomation_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
	Entry.Key = TEXT("Pause");
	Entry.Source = TEXT("PAUSED");
	Entry.Translation = LocHubBridgeTests::CyrillicPause;
	TArray<FLocHubLiveEntry> Entries;
	Entries.Add(Entry);
	LocHubBridge::ApplyLiveEntries(Entries);

	const FTextLocalizationManager& Manager = FTextLocalizationManager::Get();
	const FTextConstDisplayStringPtr Shown = Manager.FindDisplayString(Entry.Namespace, Entry.Key, &Entry.Source);
	TestTrue(TEXT("the live table holds the entry"), Shown.IsValid());
	if (Shown.IsValid())
	{
		TestEqual(TEXT("the entry shows the translation"), *Shown, Entry.Translation);
	}

	const FString EditedSource = TEXT("PAUSED!");
	TestFalse(TEXT("a changed English source hides the stale translation"), Manager.FindDisplayString(Entry.Namespace, Entry.Key, &EditedSource).IsValid());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeSyncActionTest,
	"LocHub.Bridge.Sync.ActionsAndResult",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeSyncActionTest::RunTest(const FString& Parameters)
{
	// The names Web/src/bridge.ts passes to window.ue.lochub.sync().
	ELocHubSyncAction Action = ELocHubSyncAction::Pull;
	TestTrue(TEXT("push is known"), LocHubBridge::ParseSyncAction(TEXT("push"), Action) && Action == ELocHubSyncAction::Push);
	TestTrue(TEXT("dryrun is known"), LocHubBridge::ParseSyncAction(TEXT("dryrun"), Action) && Action == ELocHubSyncAction::PushDryRun);
	TestTrue(TEXT("pull is known"), LocHubBridge::ParseSyncAction(TEXT("pull"), Action) && Action == ELocHubSyncAction::Pull);
	TestFalse(TEXT("names are case-sensitive"), LocHubBridge::ParseSyncAction(TEXT("Push"), Action));
	TestFalse(TEXT("an empty name is refused"), LocHubBridge::ParseSyncAction(FString(), Action));
	TestFalse(TEXT("anything else is refused"), LocHubBridge::ParseSyncAction(TEXT("gather"), Action));

	// Field names are the SyncOutcome type in Web/src/bridge.ts.
	FLocHubSyncResult Result;
	Result.bSuccess = true;
	Result.Summary = FString(TEXT("Push: ")) + LocHubBridgeTests::CyrillicPause;
	Result.Details = { TEXT("added 3"), TEXT("retired \"old\"") };
	TSharedPtr<FJsonObject> Object;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(LocHubBridge::SyncResultToJson(Result));
	if (!TestTrue(TEXT("the result is a JSON object"), FJsonSerializer::Deserialize(Reader, Object) && Object.IsValid()))
	{
		return false;
	}
	TestTrue(TEXT("success"), Object->GetBoolField(TEXT("success")));
	TestFalse(TEXT("cancelled"), Object->GetBoolField(TEXT("cancelled")));
	TestEqual(TEXT("summary survives non-ASCII text"), Object->GetStringField(TEXT("summary")), Result.Summary);
	TArray<FString> Details;
	TestTrue(TEXT("details is a string array"), Object->TryGetStringArrayField(TEXT("details"), Details));
	TestEqual(TEXT("details keeps every line, quotes included"), Details, Result.Details);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeFilesHelpersTest,
	"LocHub.Bridge.Files.Helpers",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeFilesHelpersTest::RunTest(const FString& Parameters)
{
	TestTrue(TEXT("a bare file name is accepted"), LocHubBridge::IsBareFileName(TEXT("glossary-ru.csv")));
	TestFalse(TEXT("a forward-slash path is refused"), LocHubBridge::IsBareFileName(TEXT("a/b.csv")));
	TestFalse(TEXT("a backslash path is refused"), LocHubBridge::IsBareFileName(TEXT("a\\b.csv")));
	TestFalse(TEXT("a drive-qualified name is refused"), LocHubBridge::IsBareFileName(TEXT("C:x.csv")));
	TestFalse(TEXT("the parent directory is refused"), LocHubBridge::IsBareFileName(TEXT("..")));
	TestFalse(TEXT("the current directory is refused"), LocHubBridge::IsBareFileName(TEXT(".")));
	TestFalse(TEXT("an empty name is refused"), LocHubBridge::IsBareFileName(FString()));

	// A UTF-8 BOM followed by Cyrillic text: PickedFileToJson must round-trip the raw bytes with no decoding of its own.
	TArray<uint8> Bytes = { 0xEF, 0xBB, 0xBF };
	Bytes.Append(LocHubBridgeTests::ToUtf8Bytes(LocHubBridgeTests::CyrillicPause));

	TSharedPtr<FJsonObject> Picked;
	const TSharedRef<TJsonReader<>> PickedReader = TJsonReaderFactory<>::Create(LocHubBridge::PickedFileToJson(TEXT("glossary-ru.csv"), Bytes));
	if (TestTrue(TEXT("the picked file answer is a JSON object"), FJsonSerializer::Deserialize(PickedReader, Picked) && Picked.IsValid()))
	{
		TestFalse(TEXT("a picked file is not cancelled"), Picked->GetBoolField(TEXT("cancelled")));
		TestEqual(TEXT("the picked file keeps its name"), Picked->GetStringField(TEXT("name")), FString(TEXT("glossary-ru.csv")));

		FString Base64;
		if (TestTrue(TEXT("the picked file has a base64 field"), Picked->TryGetStringField(TEXT("base64"), Base64)))
		{
			TArray<uint8> Decoded;
			TestTrue(TEXT("the base64 field decodes"), FBase64::Decode(Base64, Decoded));
			TestEqual(TEXT("the decoded bytes match the original file, BOM included"), Decoded, Bytes);
		}
	}

	TSharedPtr<FJsonObject> Cancelled;
	const TSharedRef<TJsonReader<>> CancelledReader = TJsonReaderFactory<>::Create(LocHubBridge::CancelledJson());
	if (TestTrue(TEXT("the cancelled answer is a JSON object"), FJsonSerializer::Deserialize(CancelledReader, Cancelled) && Cancelled.IsValid()))
	{
		TestTrue(TEXT("cancelled is true"), Cancelled->GetBoolField(TEXT("cancelled")));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubBridgeServiceUrlTest,
	"LocHub.Bridge.ServiceUrl.StaysOnService",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubBridgeServiceUrlTest::RunTest(const FString& Parameters)
{
	// SLocHubTab cancels every navigation this refuses: the page it would load gets window.ue.lochub.
	const FString Base = TEXT("http://127.0.0.1:47810");
	TestTrue(TEXT("the base itself"), LocHubBridge::IsServiceUrl(Base, Base));
	TestTrue(TEXT("the tab's page"), LocHubBridge::IsServiceUrl(TEXT("http://127.0.0.1:47810/?host=editor#/grid"), Base));
	TestTrue(TEXT("a hash route"), LocHubBridge::IsServiceUrl(TEXT("http://127.0.0.1:47810#/card/ru/1"), Base));
	TestFalse(TEXT("a longer port"), LocHubBridge::IsServiceUrl(TEXT("http://127.0.0.1:478100/"), Base));
	TestFalse(TEXT("a host that only starts like the service"), LocHubBridge::IsServiceUrl(TEXT("http://127.0.0.1:47810.example.com/"), Base));
	TestFalse(TEXT("another site"), LocHubBridge::IsServiceUrl(TEXT("https://example.com/"), Base));
	TestFalse(TEXT("another scheme"), LocHubBridge::IsServiceUrl(TEXT("file:///C:/evil.html"), Base));
	TestFalse(TEXT("an empty base accepts nothing"), LocHubBridge::IsServiceUrl(Base, FString()));
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
