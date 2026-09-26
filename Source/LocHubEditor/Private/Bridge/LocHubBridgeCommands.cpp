// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Bridge/LocHubBridgeCommands.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "Internationalization/TextLocalizationManager.h"
#include "Internationalization/TextLocalizationResource.h"
#include "LocHubEditorModule.h"
#include "LocHubSettings.h"
#include "LocHubSyncRunner.h"
#include "Misc/Base64.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "SourceCodeNavigation.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UObject/SoftObjectPath.h"

namespace LocHubBridgePrivate
{
	// The extensions parseOrigin() in Web/src/origin.ts treats as files even when the path starts with '/'.
	const TCHAR* const SourceFileExtensions[] = {
		TEXT("c"), TEXT("cc"), TEXT("cpp"), TEXT("cs"), TEXT("csv"), TEXT("h"), TEXT("hpp"),
		TEXT("inl"), TEXT("ini"), TEXT("json"), TEXT("py"), TEXT("rml"), TEXT("txt")
	};

	constexpr int32 MaxCultureCodeLength = 32;

	bool IsAllDigits(const FString& InText)
	{
		if (InText.IsEmpty())
		{
			return false;
		}

		for (const TCHAR Character : InText)
		{
			if (!FChar::IsDigit(Character))
			{
				return false;
			}
		}
		return true;
	}

	bool IsSourceFileExtension(const FString& InExtension)
	{
		for (const TCHAR* Extension : SourceFileExtensions)
		{
			if (InExtension.Equals(Extension, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	// "File.cpp(42)" and "File.cpp:42" carry a line. A suffix that starts at index 0 or 1 is not one: "D:" is a drive.
	void SplitLineSuffix(FString& InOutPath, int32& OutLine)
	{
		OutLine = 0;
		int32 SuffixStart = INDEX_NONE;
		FString Digits;
		if (InOutPath.EndsWith(TEXT(")")))
		{
			if (InOutPath.FindLastChar(TEXT('('), SuffixStart))
			{
				Digits = InOutPath.Mid(SuffixStart + 1, InOutPath.Len() - SuffixStart - 2);
			}
		}
		else if (InOutPath.FindLastChar(TEXT(':'), SuffixStart))
		{
			Digits = InOutPath.Mid(SuffixStart + 1);
		}

		if (SuffixStart <= 1 || !IsAllDigits(Digits))
		{
			return;
		}

		OutLine = static_cast<int32>(FMath::Min<int64>(FCString::Atoi64(*Digits), MAX_int32));
		InOutPath.LeftInline(SuffixStart);
	}

	// Culture codes are letters, digits, '-' and '_' ("pt-BR", "zh-Hans"); anything else is refused before ICU sees it.
	bool IsCultureCodeShape(const FString& InCulture)
	{
		if (InCulture.IsEmpty() || InCulture.Len() > MaxCultureCodeLength)
		{
			return false;
		}

		for (const TCHAR Character : InCulture)
		{
			const bool bAllowed = FChar::IsAlnum(Character) || Character == TEXT('-') || Character == TEXT('_');
			if (!bAllowed)
			{
				return false;
			}
		}
		return true;
	}

	bool IsKnownCulture(const FString& InCulture)
	{
		return IsCultureCodeShape(InCulture) && FInternationalization::Get().GetCulture(InCulture).IsValid();
	}

	FString SerializeJsonObject(const TSharedRef<FJsonObject>& InObject)
	{
		FString Json;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
		FJsonSerializer::Serialize(InObject, Writer);
		return Json;
	}
}

FString LocHubBridge::GetServiceBaseUrl()
{
	return FString::Printf(TEXT("http://127.0.0.1:%d"), GetDefault<ULocHubSettings>()->ServicePort);
}

bool LocHubBridge::IsServiceUrl(const FString& InUrl, const FString& InBaseUrl)
{
	if (InBaseUrl.IsEmpty() || !InUrl.StartsWith(InBaseUrl, ESearchCase::IgnoreCase))
	{
		return false;
	}
	// "http://127.0.0.1:47810" must not accept "http://127.0.0.1:478100" or "http://127.0.0.1:47810.evil".
	const FString Rest = InUrl.RightChop(InBaseUrl.Len());
	return Rest.IsEmpty() || Rest[0] == TEXT('/') || Rest[0] == TEXT('?') || Rest[0] == TEXT('#');
}

FLocHubOrigin LocHubBridge::ParseOrigin(const FString& InOrigin)
{
	FString Path = InOrigin.TrimStartAndEnd().Replace(TEXT("\\"), TEXT("/"));
	int32 Line = 0;
	LocHubBridgePrivate::SplitLineSuffix(Path, Line);

	FLocHubOrigin Result;
	if (Path.IsEmpty())
	{
		return Result;
	}

	const bool bLooksLikeObjectPath = Path.StartsWith(TEXT("/")) && !LocHubBridgePrivate::IsSourceFileExtension(FPaths::GetExtension(Path));
	if (bLooksLikeObjectPath)
	{
		if (Path.StartsWith(TEXT("/Script/"), ESearchCase::CaseSensitive))
		{
			// A native class: there is no asset to open.
			Result.Path = Path;
			return Result;
		}

		int32 DotIndex = INDEX_NONE;
		Result.Kind = ELocHubOriginKind::Asset;
		Result.Path = Path.FindChar(TEXT('.'), DotIndex) ? Path.Left(DotIndex) : Path;
		return Result;
	}

	while (Path.StartsWith(TEXT("/")))
	{
		Path.RightChopInline(1);
	}

	Result.Kind = ELocHubOriginKind::SourceFile;
	Result.Path = Path;
	Result.Line = Line;
	return Result;
}

bool LocHubBridge::ResolveProjectFile(const FString& InRelativePath, const FString& InProjectDir, FString& OutAbsolutePath)
{
	if (InRelativePath.IsEmpty() || !FPaths::IsRelative(InRelativePath))
	{
		return false;
	}

	const FString ProjectRoot = FPaths::ConvertRelativePathToFull(InProjectDir);
	const FString Candidate = FPaths::ConvertRelativePathToFull(ProjectRoot, InRelativePath);
	if (!FPaths::IsUnderDirectory(Candidate, ProjectRoot))
	{
		return false;
	}

	OutAbsolutePath = Candidate;
	return true;
}

bool LocHubBridge::OpenOrigin(const FString& InOrigin, FString& OutError)
{
	const FLocHubOrigin Origin = ParseOrigin(InOrigin);
	if (Origin.Kind == ELocHubOriginKind::Asset)
	{
		const bool bExistingPackage = FPackageName::IsValidLongPackageName(Origin.Path, true) && FPackageName::DoesPackageExist(Origin.Path);
		if (!bExistingPackage)
		{
			OutError = FString::Printf(TEXT("no such package: %s"), *Origin.Path);
			return false;
		}

		UAssetEditorSubsystem* AssetEditors = IsValid(GEditor) ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
		if (!IsValid(AssetEditors))
		{
			OutError = TEXT("the asset editor subsystem is not available");
			return false;
		}

		// The main asset of a package carries the package's short name: /Game/UI/WBP_Pause -> /Game/UI/WBP_Pause.WBP_Pause.
		AssetEditors->OpenEditorForAsset(FSoftObjectPath(Origin.Path + TEXT(".") + FPackageName::GetShortName(Origin.Path)));
		return true;
	}

	if (Origin.Kind == ELocHubOriginKind::SourceFile)
	{
		FString AbsolutePath;
		const bool bExistingProjectFile = ResolveProjectFile(Origin.Path, FPaths::ProjectDir(), AbsolutePath) && FPaths::FileExists(AbsolutePath);
		if (!bExistingProjectFile)
		{
			OutError = FString::Printf(TEXT("no such file in the project: %s"), *Origin.Path);
			return false;
		}

		if (!FSourceCodeNavigation::OpenSourceFile(AbsolutePath, FMath::Max(Origin.Line, 1)))
		{
			OutError = FString::Printf(TEXT("no source code accessor opened %s"), *AbsolutePath);
			return false;
		}
		return true;
	}

	OutError = FString::Printf(TEXT("nothing to open for origin '%s'"), *InOrigin);
	return false;
}

bool LocHubBridge::SetPreviewCulture(const FString& InCulture, FString& OutError)
{
	FTextLocalizationManager& Manager = FTextLocalizationManager::Get();
	if (InCulture.IsEmpty())
	{
		Manager.ConfigureGameLocalizationPreviewLanguage(FString());
		Manager.DisableGameLocalizationPreview();
		return true;
	}

	if (!LocHubBridgePrivate::IsKnownCulture(InCulture))
	{
		OutError = FString::Printf(TEXT("unknown culture '%s'"), *InCulture);
		return false;
	}

	// The same pair of calls as the UMG designer's preview-language menu (SDesignerToolBar::SetLocalizationPreviewLanguage).
	Manager.ConfigureGameLocalizationPreviewLanguage(InCulture);
	Manager.EnableGameLocalizationPreview();
	return true;
}

bool LocHubBridge::ParseLiveEntries(const TArray<TSharedPtr<FJsonValue>>& InValues, TArray<FLocHubLiveEntry>& OutEntries, FString& OutError)
{
	OutEntries.Reset();
	for (int32 Index = 0; Index < InValues.Num(); ++Index)
	{
		const TSharedPtr<FJsonObject>* Object = nullptr;
		FLocHubLiveEntry Entry;
		const bool bHasFields = InValues[Index].IsValid()
			&& InValues[Index]->TryGetObject(Object)
			&& (*Object)->TryGetStringField(TEXT("namespace"), Entry.Namespace)
			&& (*Object)->TryGetStringField(TEXT("key"), Entry.Key)
			&& (*Object)->TryGetStringField(TEXT("source"), Entry.Source)
			&& (*Object)->TryGetStringField(TEXT("translation"), Entry.Translation);
		const bool bHasText = !Entry.Key.IsEmpty() && !Entry.Source.IsEmpty() && !Entry.Translation.IsEmpty();
		if (!bHasFields || !bHasText)
		{
			OutError = FString::Printf(TEXT("entry %d needs namespace, key, source and translation"), Index);
			OutEntries.Reset();
			return false;
		}

		OutEntries.Add(MoveTemp(Entry));
	}

	if (OutEntries.IsEmpty())
	{
		OutError = TEXT("no entries to apply");
		return false;
	}
	return true;
}

void LocHubBridge::ApplyLiveEntries(const TArray<FLocHubLiveEntry>& InEntries)
{
	FTextLocalizationResource Resource;
	for (const FLocHubLiveEntry& Entry : InEntries)
	{
		Resource.AddEntry(Entry.Namespace, Entry.Key, Entry.Source, Entry.Translation, 0);
	}
	FTextLocalizationManager::Get().UpdateFromLocalizationResource(Resource);
}

bool LocHubBridge::ApplyLive(const FString& InCulture, const TArray<FLocHubLiveEntry>& InEntries, FString& OutError)
{
	if (!LocHubBridgePrivate::IsKnownCulture(InCulture))
	{
		OutError = FString::Printf(TEXT("unknown culture '%s'"), *InCulture);
		return false;
	}

	if (InEntries.IsEmpty())
	{
		OutError = TEXT("no entries to apply");
		return false;
	}

	FTextLocalizationManager& Manager = FTextLocalizationManager::Get();
	const bool bAlreadyPreviewing = Manager.IsGameLocalizationPreviewEnabled() && Manager.GetConfiguredGameLocalizationPreviewLanguage() == InCulture;
	if (!bAlreadyPreviewing && !SetPreviewCulture(InCulture, OutError))
	{
		return false;
	}
	// The preview reloads LocRes on a task (TextLocalizationManager.cpp:1890-1894); a reload that lands after
	// UpdateFromLocalizationResource would overwrite the live entries. Wait even when the culture is already being
	// previewed: an earlier SetPreviewCulture command may have started that reload moments ago. No-op when idle
	// (TextLocalizationManager.cpp:1216-1229).
	Manager.WaitForAsyncTasks();

	ApplyLiveEntries(InEntries);
	return true;
}

bool LocHubBridge::ExecuteCommandJson(const FString& InJson, FString& OutError)
{
	TSharedPtr<FJsonObject> Command;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(InJson);
	if (!FJsonSerializer::Deserialize(Reader, Command) || !Command.IsValid())
	{
		OutError = TEXT("the command is not a JSON object");
		return false;
	}

	FString Name;
	const TSharedPtr<FJsonObject>* Args = nullptr;
	if (!Command->TryGetStringField(TEXT("name"), Name) || !Command->TryGetObjectField(TEXT("args"), Args))
	{
		OutError = TEXT("the command needs a string 'name' and an object 'args'");
		return false;
	}

	// Case-sensitive, spelled exactly as BRIDGE_COMMANDS in Service/src/contract.ts.
	if (Name.Equals(TEXT("OpenOrigin"), ESearchCase::CaseSensitive))
	{
		FString Origin;
		if (!(*Args)->TryGetStringField(TEXT("origin"), Origin))
		{
			OutError = TEXT("OpenOrigin needs a string 'origin'");
			return false;
		}
		return OpenOrigin(Origin, OutError);
	}

	if (Name.Equals(TEXT("SetPreviewCulture"), ESearchCase::CaseSensitive))
	{
		FString Culture;
		if (!(*Args)->TryGetStringField(TEXT("culture"), Culture))
		{
			OutError = TEXT("SetPreviewCulture needs a string 'culture'");
			return false;
		}
		return SetPreviewCulture(Culture, OutError);
	}

	if (Name.Equals(TEXT("ApplyLive"), ESearchCase::CaseSensitive))
	{
		FString Culture;
		const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
		const bool bHasArgs = (*Args)->TryGetStringField(TEXT("culture"), Culture) && (*Args)->TryGetArrayField(TEXT("entries"), Values);
		if (!bHasArgs)
		{
			OutError = TEXT("ApplyLive needs a string 'culture' and an array 'entries'");
			return false;
		}

		TArray<FLocHubLiveEntry> Entries;
		if (!ParseLiveEntries(*Values, Entries, OutError))
		{
			return false;
		}
		return ApplyLive(Culture, Entries, OutError);
	}

	OutError = FString::Printf(TEXT("unknown command '%s'"), *Name);
	return false;
}

bool LocHubBridge::ParseSyncAction(const FString& InAction, ELocHubSyncAction& OutAction)
{
	if (InAction.Equals(TEXT("push"), ESearchCase::CaseSensitive))
	{
		OutAction = ELocHubSyncAction::Push;
		return true;
	}
	if (InAction.Equals(TEXT("dryrun"), ESearchCase::CaseSensitive))
	{
		OutAction = ELocHubSyncAction::PushDryRun;
		return true;
	}
	if (InAction.Equals(TEXT("pull"), ESearchCase::CaseSensitive))
	{
		OutAction = ELocHubSyncAction::Pull;
		return true;
	}
	return false;
}

FString LocHubBridge::SyncResultToJson(const FLocHubSyncResult& InResult)
{
	TArray<TSharedPtr<FJsonValue>> Details;
	Details.Reserve(InResult.Details.Num());
	for (const FString& Line : InResult.Details)
	{
		Details.Add(MakeShared<FJsonValueString>(Line));
	}
	const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetBoolField(TEXT("success"), InResult.bSuccess);
	Object->SetBoolField(TEXT("cancelled"), InResult.bCancelled);
	Object->SetStringField(TEXT("summary"), InResult.Summary);
	Object->SetArrayField(TEXT("details"), Details);

	FString Json;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
	FJsonSerializer::Serialize(Object, Writer);
	return Json;
}

bool LocHubBridge::IsBareFileName(const FString& InName)
{
	if (InName.IsEmpty() || InName == TEXT(".") || InName == TEXT(".."))
	{
		return false;
	}
	return !InName.Contains(TEXT("/")) && !InName.Contains(TEXT("\\")) && !InName.Contains(TEXT(":"));
}

FString LocHubBridge::PickedFileToJson(const FString& InName, const TArray<uint8>& InBytes)
{
	const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetBoolField(TEXT("cancelled"), false);
	Object->SetStringField(TEXT("name"), InName);
	Object->SetStringField(TEXT("base64"), FBase64::Encode(InBytes));
	return LocHubBridgePrivate::SerializeJsonObject(Object);
}

FString LocHubBridge::SavedFileToJson(const FString& InPath)
{
	const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetBoolField(TEXT("cancelled"), false);
	Object->SetStringField(TEXT("path"), InPath);
	return LocHubBridgePrivate::SerializeJsonObject(Object);
}

FString LocHubBridge::CancelledJson()
{
	const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetBoolField(TEXT("cancelled"), true);
	return LocHubBridgePrivate::SerializeJsonObject(Object);
}
