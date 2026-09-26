// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubJson.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "LocHubTypes.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace LocHubJsonPrivate
{
	TArray<TSharedPtr<FJsonValue>> ToJsonStrings(const TArray<FString>& InValues)
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		Values.Reserve(InValues.Num());
		for (const FString& Value : InValues)
		{
			Values.Add(MakeShared<FJsonValueString>(Value));
		}
		return Values;
	}

	FString GetString(const FJsonObject& InObject, const TCHAR* InFieldName)
	{
		FString Value;
		InObject.TryGetStringField(InFieldName, Value);
		return Value;
	}

	/** Objects of an array field; false when the field is missing or an element is not an object. */
	bool GetObjectArray(const FJsonObject& InObject, const TCHAR* InFieldName, TArray<TSharedPtr<FJsonObject>>& OutObjects)
	{
		const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
		if (!InObject.TryGetArrayField(InFieldName, Values))
		{
			return false;
		}
		for (const TSharedPtr<FJsonValue>& Value : *Values)
		{
			const TSharedPtr<FJsonObject>* Object = nullptr;
			if (!Value.IsValid() || !Value->TryGetObject(Object) || !Object->IsValid())
			{
				return false;
			}
			OutObjects.Add(*Object);
		}
		return true;
	}

	TSharedRef<FJsonObject> EntryToJson(const FLocHubSnapshotEntry& InEntry)
	{
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		Object->SetStringField(TEXT("namespace"), InEntry.Namespace);
		Object->SetStringField(TEXT("key"), InEntry.Key);
		Object->SetStringField(TEXT("source"), InEntry.Source);
		Object->SetStringField(TEXT("origin"), InEntry.Origin);
		Object->SetStringField(TEXT("devNotes"), InEntry.DevNotes);
		const TSharedRef<FJsonObject> Metadata = MakeShared<FJsonObject>();
		for (const TPair<FString, FString>& Pair : InEntry.Metadata)
		{
			Metadata->SetStringField(Pair.Key, Pair.Value);
		}
		Object->SetObjectField(TEXT("metadata"), Metadata);
		Object->SetStringField(TEXT("groupKey"), InEntry.GroupKey);
		return Object;
	}

	/** Shared by SnapshotToJson and ArchivesToJson, so Push and Pull's reconcile send the same shape. */
	TSharedRef<FJsonObject> ArchivesToJsonObject(const TMap<FString, TArray<FLocHubArchiveEntry>>& InArchives)
	{
		const TSharedRef<FJsonObject> Archives = MakeShared<FJsonObject>();
		for (const TPair<FString, TArray<FLocHubArchiveEntry>>& Culture : InArchives)
		{
			TArray<TSharedPtr<FJsonValue>> CultureEntries;
			CultureEntries.Reserve(Culture.Value.Num());
			for (const FLocHubArchiveEntry& Entry : Culture.Value)
			{
				const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
				Object->SetStringField(TEXT("namespace"), Entry.Namespace);
				Object->SetStringField(TEXT("key"), Entry.Key);
				Object->SetStringField(TEXT("source"), Entry.Source);
				Object->SetStringField(TEXT("translation"), Entry.Translation);
				CultureEntries.Add(MakeShared<FJsonValueObject>(Object));
			}
			Archives->SetArrayField(Culture.Key, CultureEntries);
		}
		return Archives;
	}
}

FString LocHubJson::SnapshotToJson(const FLocHubSnapshot& InSnapshot)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("target"), InSnapshot.Target);
	Root->SetStringField(TEXT("nativeCulture"), InSnapshot.NativeCulture);
	Root->SetArrayField(TEXT("cultures"), LocHubJsonPrivate::ToJsonStrings(InSnapshot.Cultures));

	TArray<TSharedPtr<FJsonValue>> Entries;
	Entries.Reserve(InSnapshot.Entries.Num());
	for (const FLocHubSnapshotEntry& Entry : InSnapshot.Entries)
	{
		Entries.Add(MakeShared<FJsonValueObject>(LocHubJsonPrivate::EntryToJson(Entry)));
	}
	Root->SetArrayField(TEXT("entries"), Entries);

	Root->SetObjectField(TEXT("archives"), LocHubJsonPrivate::ArchivesToJsonObject(InSnapshot.Archives));

	if (InSnapshot.bHasCoverage)
	{
		TArray<TSharedPtr<FJsonValue>> Coverage;
		Coverage.Reserve(InSnapshot.Coverage.Num());
		for (const FLocHubCoverageFinding& Finding : InSnapshot.Coverage)
		{
			const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
			Object->SetStringField(TEXT("kind"), Finding.Kind);
			Object->SetStringField(TEXT("file"), Finding.File);
			Object->SetNumberField(TEXT("line"), Finding.Line);
			Object->SetStringField(TEXT("text"), Finding.Text);
			Coverage.Add(MakeShared<FJsonValueObject>(Object));
		}
		Root->SetArrayField(TEXT("coverage"), Coverage);
	}

	const TSharedRef<FJsonObject> PluralForms = MakeShared<FJsonObject>();
	for (const TPair<FString, FLocHubPluralForms>& Culture : InSnapshot.PluralForms)
	{
		const TSharedRef<FJsonObject> Forms = MakeShared<FJsonObject>();
		Forms->SetArrayField(TEXT("cardinal"), LocHubJsonPrivate::ToJsonStrings(Culture.Value.Cardinal));
		Forms->SetArrayField(TEXT("ordinal"), LocHubJsonPrivate::ToJsonStrings(Culture.Value.Ordinal));
		PluralForms->SetObjectField(Culture.Key, Forms);
	}
	Root->SetObjectField(TEXT("pluralForms"), PluralForms);
	return ObjectToString(Root);
}

FString LocHubJson::ArchivesToJson(const TMap<FString, TArray<FLocHubArchiveEntry>>& InArchives)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("archives"), LocHubJsonPrivate::ArchivesToJsonObject(InArchives));
	return ObjectToString(Root);
}

FString LocHubJson::ExportAckToJson(const FLocHubExportAck& InAck)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("culture"), InAck.Culture);

	TArray<TSharedPtr<FJsonValue>> Written;
	for (const FLocHubAckWritten& Entry : InAck.Written)
	{
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		Object->SetStringField(TEXT("unitId"), Entry.UnitId);
		Object->SetStringField(TEXT("translation"), Entry.Translation);
		Written.Add(MakeShared<FJsonValueObject>(Object));
	}
	Root->SetArrayField(TEXT("written"), Written);

	TArray<TSharedPtr<FJsonValue>> Rejected;
	for (const FLocHubAckRejected& Entry : InAck.Rejected)
	{
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		Object->SetStringField(TEXT("unitId"), Entry.UnitId);
		Object->SetStringField(TEXT("translation"), Entry.Translation);
		Object->SetArrayField(TEXT("errors"), LocHubJsonPrivate::ToJsonStrings(Entry.Errors));
		Rejected.Add(MakeShared<FJsonValueObject>(Object));
	}
	Root->SetArrayField(TEXT("rejected"), Rejected);
	return ObjectToString(Root);
}

FString LocHubJson::InboxAppliedToJson(const TArray<FString>& InIds)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetArrayField(TEXT("ids"), LocHubJsonPrivate::ToJsonStrings(InIds));
	return ObjectToString(Root);
}

bool LocHubJson::ParseHealth(const FString& InJson, bool& bOutOk)
{
	bOutOk = false;
	const TSharedPtr<FJsonObject> Root = ParseObject(InJson);
	return Root.IsValid() && Root->TryGetBoolField(TEXT("ok"), bOutOk);
}

bool LocHubJson::ParsePushReport(const FString& InJson, FLocHubPushReport& OutReport)
{
	const TSharedPtr<FJsonObject> Root = ParseObject(InJson);
	if (!Root.IsValid())
	{
		return false;
	}
	FLocHubPushReport Report;
	const bool bParsed = Root->TryGetNumberField(TEXT("added"), Report.Added)
		&& Root->TryGetNumberField(TEXT("changed"), Report.Changed)
		&& Root->TryGetNumberField(TEXT("cosmetic"), Report.Cosmetic)
		&& Root->TryGetNumberField(TEXT("tombstoned"), Report.Tombstoned)
		&& Root->TryGetNumberField(TEXT("revived"), Report.Revived)
		&& Root->TryGetNumberField(TEXT("humanEdits"), Report.HumanEdits);
	if (bParsed)
	{
		OutReport = Report;
	}
	return bParsed;
}

bool LocHubJson::ParseReconcileReport(const FString& InJson, int32& OutHumanEdits)
{
	const TSharedPtr<FJsonObject> Root = ParseObject(InJson);
	int32 HumanEdits = 0;
	if (!Root.IsValid() || !Root->TryGetNumberField(TEXT("humanEdits"), HumanEdits))
	{
		return false;
	}
	OutHumanEdits = HumanEdits;
	return true;
}

bool LocHubJson::ParseExport(const FString& InJson, FLocHubExport& OutExport)
{
	const TSharedPtr<FJsonObject> Root = ParseObject(InJson);
	TArray<TSharedPtr<FJsonObject>> Entries;
	if (!Root.IsValid() || !LocHubJsonPrivate::GetObjectArray(*Root, TEXT("entries"), Entries))
	{
		return false;
	}
	FLocHubExport Export;
	Export.Culture = LocHubJsonPrivate::GetString(*Root, TEXT("culture"));
	Export.Policy = LocHubJsonPrivate::GetString(*Root, TEXT("policy"));
	for (const TSharedPtr<FJsonObject>& EntryObject : Entries)
	{
		FLocHubExportEntry& Entry = Export.Entries.AddDefaulted_GetRef();
		Entry.UnitId = LocHubJsonPrivate::GetString(*EntryObject, TEXT("unitId"));
		Entry.Namespace = LocHubJsonPrivate::GetString(*EntryObject, TEXT("namespace"));
		Entry.Key = LocHubJsonPrivate::GetString(*EntryObject, TEXT("key"));
		Entry.Source = LocHubJsonPrivate::GetString(*EntryObject, TEXT("source"));
		Entry.Translation = LocHubJsonPrivate::GetString(*EntryObject, TEXT("translation"));
	}
	OutExport = MoveTemp(Export);
	return true;
}

bool LocHubJson::ParseInbox(const FString& InJson, TArray<FLocHubInboxRow>& OutRows)
{
	const TSharedPtr<FJsonObject> Root = ParseObject(InJson);
	TArray<TSharedPtr<FJsonObject>> Rows;
	if (!Root.IsValid() || !LocHubJsonPrivate::GetObjectArray(*Root, TEXT("rows"), Rows))
	{
		return false;
	}
	OutRows.Reset();
	for (const TSharedPtr<FJsonObject>& RowObject : Rows)
	{
		const TSharedPtr<FJsonObject>* Item = nullptr;
		const TSharedPtr<FJsonObject>* Unit = nullptr;
		const bool bHasItem = RowObject->TryGetObjectField(TEXT("item"), Item) && Item->IsValid();
		const bool bHasUnit = RowObject->TryGetObjectField(TEXT("unit"), Unit) && Unit->IsValid();
		if (!bHasItem || !bHasUnit)
		{
			continue;
		}
		FLocHubInboxRow& Row = OutRows.AddDefaulted_GetRef();
		Row.Id = LocHubJsonPrivate::GetString(**Item, TEXT("id"));
		Row.UnitId = LocHubJsonPrivate::GetString(**Item, TEXT("unitId"));
		Row.Culture = LocHubJsonPrivate::GetString(**Item, TEXT("culture"));
		Row.Question = LocHubJsonPrivate::GetString(**Item, TEXT("question"));
		Row.Answer = LocHubJsonPrivate::GetString(**Item, TEXT("answer"));
		Row.Namespace = LocHubJsonPrivate::GetString(**Unit, TEXT("namespace"));
		Row.Key = LocHubJsonPrivate::GetString(**Unit, TEXT("key"));
		Row.Source = LocHubJsonPrivate::GetString(**Unit, TEXT("source"));
		Row.Origin = LocHubJsonPrivate::GetString(**Unit, TEXT("origin"));
		Row.DevNotes = LocHubJsonPrivate::GetString(**Unit, TEXT("devNotes"));
	}
	return true;
}

TSharedPtr<FJsonObject> LocHubJson::ParseObject(const FString& InJson)
{
	TSharedPtr<FJsonObject> Object;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(InJson);
	if (!FJsonSerializer::Deserialize(Reader, Object) || !Object.IsValid())
	{
		return nullptr;
	}
	return Object;
}

FString LocHubJson::ObjectToString(const TSharedRef<FJsonObject>& InObject)
{
	FString Out;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
	FJsonSerializer::Serialize(InObject, Writer);
	return Out;
}
