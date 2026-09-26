// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "LocHubJson.h"
#include "LocHubTypes.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubJsonSnapshotTest,
	"LocHub.Json.Snapshot",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubJsonSnapshotTest::RunTest(const FString& Parameters)
{
	FLocHubSnapshot Snapshot;
	Snapshot.Target = TEXT("Test");
	Snapshot.NativeCulture = TEXT("en");
	Snapshot.Cultures = { TEXT("en"), TEXT("ru") };

	FLocHubSnapshotEntry& Entry = Snapshot.Entries.AddDefaulted_GetRef();
	Entry.Namespace = TEXT("Ns");
	Entry.Key = TEXT("Key");
	Entry.Source = TEXT("Pause");
	Entry.Origin = TEXT("/Game/UI/WBP_Pause.WBP_Pause:Text");
	Entry.DevNotes = TEXT("Menu title");
	Entry.Metadata.Add(LocHub::KindMetadataKey, LocHub::KindUi);
	Entry.GroupKey = TEXT("/Game/UI/WBP_Pause");

	FLocHubArchiveEntry& Archive = Snapshot.Archives.FindOrAdd(TEXT("ru")).AddDefaulted_GetRef();
	Archive.Namespace = TEXT("Ns");
	Archive.Key = TEXT("Key");
	Archive.Source = TEXT("Pause old");
	Archive.Translation = TEXT("\u041F\u0430\u0443\u0437\u0430");

	FLocHubPluralForms& RuForms = Snapshot.PluralForms.Add(TEXT("ru"));
	RuForms.Cardinal = { TEXT("one"), TEXT("few"), TEXT("many"), TEXT("other") };
	RuForms.Ordinal = { TEXT("other") };

	const TSharedPtr<FJsonObject> WithoutCoverage = LocHubJson::ParseObject(LocHubJson::SnapshotToJson(Snapshot));
	if (!TestTrue(TEXT("Snapshot JSON parses"), WithoutCoverage.IsValid()))
	{
		return false;
	}
	TestFalse(TEXT("No coverage field unless the snapshot carries coverage"), WithoutCoverage->HasField(TEXT("coverage")));

	Snapshot.bHasCoverage = true;
	FLocHubCoverageFinding& Finding = Snapshot.Coverage.AddDefaulted_GetRef();
	Finding.Kind = LocHub::CoverageKindFromString;
	Finding.File = TEXT("Source/Game/Hud.cpp");
	Finding.Line = 42;
	Finding.Text = TEXT("SPEED");

	const TSharedPtr<FJsonObject> Root = LocHubJson::ParseObject(LocHubJson::SnapshotToJson(Snapshot));
	if (!TestTrue(TEXT("Snapshot JSON with coverage parses"), Root.IsValid()))
	{
		return false;
	}

	TestEqual(TEXT("target"), Root->GetStringField(TEXT("target")), TEXT("Test"));
	TestEqual(TEXT("nativeCulture"), Root->GetStringField(TEXT("nativeCulture")), TEXT("en"));
	TestEqual(TEXT("cultures"), Root->GetArrayField(TEXT("cultures")).Num(), 2);
	TestFalse(TEXT("No headSha field"), Root->HasField(TEXT("headSha")));
	TestFalse(TEXT("No dirty field"), Root->HasField(TEXT("dirty")));

	const TArray<TSharedPtr<FJsonValue>>& Entries = Root->GetArrayField(TEXT("entries"));
	if (!TestEqual(TEXT("entries"), Entries.Num(), 1))
	{
		return false;
	}
	const TSharedPtr<FJsonObject> EntryObject = Entries[0]->AsObject();
	TestEqual(TEXT("namespace"), EntryObject->GetStringField(TEXT("namespace")), TEXT("Ns"));
	TestEqual(TEXT("key"), EntryObject->GetStringField(TEXT("key")), TEXT("Key"));
	TestEqual(TEXT("source"), EntryObject->GetStringField(TEXT("source")), TEXT("Pause"));
	TestEqual(TEXT("origin"), EntryObject->GetStringField(TEXT("origin")), TEXT("/Game/UI/WBP_Pause.WBP_Pause:Text"));
	TestEqual(TEXT("devNotes"), EntryObject->GetStringField(TEXT("devNotes")), TEXT("Menu title"));
	TestEqual(TEXT("groupKey"), EntryObject->GetStringField(TEXT("groupKey")), TEXT("/Game/UI/WBP_Pause"));
	TestEqual(TEXT("metadata kind"), EntryObject->GetObjectField(TEXT("metadata"))->GetStringField(LocHub::KindMetadataKey), LocHub::KindUi);

	const TArray<TSharedPtr<FJsonValue>>& RuArchive = Root->GetObjectField(TEXT("archives"))->GetArrayField(TEXT("ru"));
	if (TestEqual(TEXT("archives.ru"), RuArchive.Num(), 1))
	{
		const TSharedPtr<FJsonObject> ArchiveObject = RuArchive[0]->AsObject();
		TestEqual(TEXT("archive namespace"), ArchiveObject->GetStringField(TEXT("namespace")), TEXT("Ns"));
		TestEqual(TEXT("archive key"), ArchiveObject->GetStringField(TEXT("key")), TEXT("Key"));
		TestEqual(TEXT("archive source is the archive's own source"), ArchiveObject->GetStringField(TEXT("source")), TEXT("Pause old"));
		TestEqual(TEXT("archive translation"), ArchiveObject->GetStringField(TEXT("translation")), TEXT("\u041F\u0430\u0443\u0437\u0430"));
	}

	const TArray<TSharedPtr<FJsonValue>>& Coverage = Root->GetArrayField(TEXT("coverage"));
	if (TestEqual(TEXT("coverage"), Coverage.Num(), 1))
	{
		const TSharedPtr<FJsonObject> FindingObject = Coverage[0]->AsObject();
		TestEqual(TEXT("coverage kind"), FindingObject->GetStringField(TEXT("kind")), LocHub::CoverageKindFromString);
		TestEqual(TEXT("coverage file"), FindingObject->GetStringField(TEXT("file")), TEXT("Source/Game/Hud.cpp"));
		TestEqual(TEXT("coverage line"), FindingObject->GetIntegerField(TEXT("line")), 42);
		TestEqual(TEXT("coverage text"), FindingObject->GetStringField(TEXT("text")), TEXT("SPEED"));
	}

	// The engine's plural forms per culture, so the service checks plural modifiers against what the engine validates.
	const TSharedPtr<FJsonObject>* PluralForms = nullptr;
	const TSharedPtr<FJsonObject>* RuPluralForms = nullptr;
	if (TestTrue(TEXT("pluralForms"), Root->TryGetObjectField(TEXT("pluralForms"), PluralForms))
		&& TestTrue(TEXT("pluralForms.ru"), (*PluralForms)->TryGetObjectField(TEXT("ru"), RuPluralForms)))
	{
		TArray<FString> Cardinal;
		TArray<FString> Ordinal;
		TestTrue(TEXT("pluralForms.ru.cardinal"), (*RuPluralForms)->TryGetStringArrayField(TEXT("cardinal"), Cardinal));
		TestTrue(TEXT("pluralForms.ru.ordinal"), (*RuPluralForms)->TryGetStringArrayField(TEXT("ordinal"), Ordinal));
		TestEqual(TEXT("cardinal forms"), FString::Join(Cardinal, TEXT(",")), TEXT("one,few,many,other"));
		TestEqual(TEXT("ordinal forms"), FString::Join(Ordinal, TEXT(",")), TEXT("other"));
		TestEqual(TEXT("Only the snapshot's cultures"), (*PluralForms)->Values.Num(), 1);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubJsonResponsesTest,
	"LocHub.Json.Responses",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubJsonResponsesTest::RunTest(const FString& Parameters)
{
	bool bHealthy = false;
	TestTrue(TEXT("Health parses"), LocHubJson::ParseHealth(TEXT("{\"ok\":true,\"units\":3,\"editorConnected\":false}"), bHealthy));
	TestTrue(TEXT("Health ok"), bHealthy);
	TestFalse(TEXT("Broken JSON is not health"), LocHubJson::ParseHealth(TEXT("<html>"), bHealthy));

	FLocHubPushReport Report;
	TestTrue(TEXT("Push report parses"), LocHubJson::ParsePushReport(TEXT("{\"added\":1,\"changed\":2,\"cosmetic\":3,\"tombstoned\":4,\"revived\":5,\"humanEdits\":6}"), Report));
	TestEqual(TEXT("added"), Report.Added, 1);
	TestEqual(TEXT("changed"), Report.Changed, 2);
	TestEqual(TEXT("cosmetic"), Report.Cosmetic, 3);
	TestEqual(TEXT("tombstoned"), Report.Tombstoned, 4);
	TestEqual(TEXT("revived"), Report.Revived, 5);
	TestEqual(TEXT("humanEdits"), Report.HumanEdits, 6);
	TestFalse(TEXT("Report without fields is rejected"), LocHubJson::ParsePushReport(TEXT("{\"error\":\"bad\"}"), Report));

	FLocHubExport Export;
	const bool bExportParsed = LocHubJson::ParseExport(
		TEXT("{\"culture\":\"ru\",\"policy\":\"validated\",\"entries\":[{\"unitId\":\"u1\",\"namespace\":\"Ns\",\"key\":\"K\",\"source\":\"Pause\",\"translation\":\"\\u041F\\u0430\\u0443\\u0437\\u0430\"}]}"),
		Export);
	TestTrue(TEXT("Export parses"), bExportParsed);
	TestEqual(TEXT("export culture"), Export.Culture, TEXT("ru"));
	TestEqual(TEXT("export policy"), Export.Policy, TEXT("validated"));
	if (TestEqual(TEXT("export entries"), Export.Entries.Num(), 1))
	{
		TestEqual(TEXT("unitId"), Export.Entries[0].UnitId, TEXT("u1"));
		TestEqual(TEXT("namespace"), Export.Entries[0].Namespace, TEXT("Ns"));
		TestEqual(TEXT("key"), Export.Entries[0].Key, TEXT("K"));
		TestEqual(TEXT("source"), Export.Entries[0].Source, TEXT("Pause"));
		TestEqual(TEXT("translation (JSON unicode escapes)"), Export.Entries[0].Translation, TEXT("\u041F\u0430\u0443\u0437\u0430"));
	}

	TArray<FLocHubInboxRow> Rows;
	const bool bInboxParsed = LocHubJson::ParseInbox(
		TEXT("{\"rows\":[")
		TEXT("{\"item\":{\"id\":\"q1\",\"unitId\":\"u1\",\"culture\":\"ru\",\"question\":\"Verb?\",\"answer\":\"Yes\"},")
		TEXT("\"unit\":{\"namespace\":\"Ns\",\"key\":\"K\",\"source\":\"Load\",\"origin\":\"Source/A.cpp(3)\",\"devNotes\":\"\"}},")
		TEXT("{\"item\":{\"id\":\"q2\",\"unitId\":\"gone\",\"culture\":\"ru\",\"question\":\"?\",\"answer\":\"!\"},\"unit\":null}")
		TEXT("]}"),
		Rows);
	TestTrue(TEXT("Inbox parses"), bInboxParsed);
	if (TestEqual(TEXT("Rows without a unit are skipped"), Rows.Num(), 1))
	{
		TestEqual(TEXT("id"), Rows[0].Id, TEXT("q1"));
		TestEqual(TEXT("question"), Rows[0].Question, TEXT("Verb?"));
		TestEqual(TEXT("answer"), Rows[0].Answer, TEXT("Yes"));
		TestEqual(TEXT("unit key"), Rows[0].Key, TEXT("K"));
		TestEqual(TEXT("unit origin"), Rows[0].Origin, TEXT("Source/A.cpp(3)"));
	}

	FLocHubExportAck Ack;
	Ack.Culture = TEXT("ru");
	FLocHubAckWritten& Written = Ack.Written.AddDefaulted_GetRef();
	Written.UnitId = TEXT("u1");
	Written.Translation = TEXT("T");
	FLocHubAckRejected& Rejected = Ack.Rejected.AddDefaulted_GetRef();
	Rejected.UnitId = TEXT("u2");
	Rejected.Translation = TEXT("Bad {X}");
	Rejected.Errors = { TEXT("E1"), TEXT("E2") };
	const TSharedPtr<FJsonObject> AckObject = LocHubJson::ParseObject(LocHubJson::ExportAckToJson(Ack));
	if (TestTrue(TEXT("Ack JSON parses"), AckObject.IsValid()))
	{
		TestEqual(TEXT("ack culture"), AckObject->GetStringField(TEXT("culture")), TEXT("ru"));
		TestEqual(TEXT("ack written"), AckObject->GetArrayField(TEXT("written")).Num(), 1);
		const TArray<TSharedPtr<FJsonValue>>& RejectedValues = AckObject->GetArrayField(TEXT("rejected"));
		if (TestEqual(TEXT("ack rejected"), RejectedValues.Num(), 1))
		{
			const TSharedPtr<FJsonObject> RejectedObject = RejectedValues[0]->AsObject();
			TestEqual(TEXT("ack rejected unitId"), RejectedObject->GetStringField(TEXT("unitId")), TEXT("u2"));
			TestEqual(TEXT("ack rejected translation"), RejectedObject->GetStringField(TEXT("translation")), TEXT("Bad {X}"));
			TestEqual(TEXT("ack rejected errors"), RejectedObject->GetArrayField(TEXT("errors")).Num(), 2);
		}
	}

	const TSharedPtr<FJsonObject> Applied = LocHubJson::ParseObject(LocHubJson::InboxAppliedToJson({ TEXT("q1"), TEXT("q3") }));
	if (TestTrue(TEXT("Applied JSON parses"), Applied.IsValid()))
	{
		TestEqual(TEXT("applied ids"), Applied->GetArrayField(TEXT("ids")).Num(), 2);
	}
	return true;
}

#endif
