// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Bridge/LocHubBrowserBridge.h"

#include "Bridge/LocHubBridgeCommands.h"
#include "Containers/Ticker.h"
#include "DesktopPlatformModule.h"
#include "Dom/JsonValue.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "LocHubEditorModule.h"
#include "LocHubLog.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace LocHubBrowserBridgePrivate
{
	bool Report(const TCHAR* InCommand, const bool bInApplied, const FString& InError)
	{
		if (!bInApplied)
		{
			UE_LOG(LogLocHub, Warning, TEXT("LocHub bridge rejected %s from the editor tab: %s"), InCommand, *InError);
		}
		return bInApplied;
	}

	// Applies to both a picked file's bytes and a saved file's character count.
	constexpr int64 MaxFileSize = 10 * 1024 * 1024;
}

bool ULocHubBrowserBridge::OpenOrigin(const FString& Origin)
{
	FString Error;
	const bool bApplied = LocHubBridge::OpenOrigin(Origin, Error);
	return LocHubBrowserBridgePrivate::Report(TEXT("OpenOrigin"), bApplied, Error);
}

bool ULocHubBrowserBridge::SetPreviewCulture(const FString& Culture)
{
	FString Error;
	const bool bApplied = LocHubBridge::SetPreviewCulture(Culture, Error);
	return LocHubBrowserBridgePrivate::Report(TEXT("SetPreviewCulture"), bApplied, Error);
}

bool ULocHubBrowserBridge::ApplyLive(const FString& Culture, const FString& EntriesJson)
{
	FString Error;
	bool bApplied = false;
	TArray<TSharedPtr<FJsonValue>> Values;
	TArray<FLocHubLiveEntry> Entries;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(EntriesJson);
	if (!FJsonSerializer::Deserialize(Reader, Values))
	{
		Error = TEXT("the entries are not a JSON array");
	}
	else if (LocHubBridge::ParseLiveEntries(Values, Entries, Error))
	{
		bApplied = LocHubBridge::ApplyLive(Culture, Entries, Error);
	}
	return LocHubBrowserBridgePrivate::Report(TEXT("ApplyLive"), bApplied, Error);
}

void ULocHubBrowserBridge::Sync(const FString& Action, FWebJSResponse Response)
{
	ELocHubSyncAction SyncAction = ELocHubSyncAction::PushDryRun;
	if (!LocHubBridge::ParseSyncAction(Action, SyncAction))
	{
		const FString Error = FString::Printf(TEXT("unknown sync action '%s'"), *Action);
		LocHubBrowserBridgePrivate::Report(TEXT("Sync"), false, Error);
		Response.Failure(Error);
		return;
	}
	// Response holds the page weakly: a tab closed mid-Push just drops the answer (FWebJSCallbackBase::Invoke).
	FLocHubEditorModule::Get().SyncGameTarget(SyncAction, [Response](const FLocHubSyncResult& InResult)
	{
		Response.Success(LocHubBridge::SyncResultToJson(InResult));
	});
}

void ULocHubBrowserBridge::PickTextFile(const FString& Title, const FString& FileTypes, FWebJSResponse Response)
{
	// A dialog opened synchronously here would re-enter CEF from inside its own IPC dispatch; run it next tick instead.
	FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
		[Title, FileTypes, Response](float) -> bool
		{
			const void* ParentWindow = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
			TArray<FString> PickedFiles;
			const bool bPicked = FDesktopPlatformModule::Get()->OpenFileDialog(
				ParentWindow, Title, FString(), FString(), FileTypes, EFileDialogFlags::None, PickedFiles);
			if (!bPicked || PickedFiles.IsEmpty())
			{
				Response.Success(LocHubBridge::CancelledJson());
				return false;
			}

			const FString& Path = PickedFiles[0];
			// Checked before reading: a multi-GB file picked by mistake must not be loaded on the game thread first.
			if (IFileManager::Get().FileSize(*Path) > LocHubBrowserBridgePrivate::MaxFileSize)
			{
				Response.Failure(TEXT("The file is larger than 10 MB."));
				return false;
			}
			TArray<uint8> Bytes;
			const bool bRead = FFileHelper::LoadFileToArray(Bytes, *Path);
			if (bRead && Bytes.Num() > LocHubBrowserBridgePrivate::MaxFileSize)
			{
				Response.Failure(TEXT("The file is larger than 10 MB."));
			}
			else if (!bRead)
			{
				Response.Failure(FString::Printf(TEXT("Could not read %s."), *Path));
			}
			else
			{
				Response.Success(LocHubBridge::PickedFileToJson(FPaths::GetCleanFilename(Path), Bytes));
			}
			return false;
		}), 0.0f);
}

void ULocHubBrowserBridge::SaveTextFile(const FString& Title, const FString& DefaultFileName, const FString& FileTypes, const FString& Text, FWebJSResponse Response)
{
	if (!LocHubBridge::IsBareFileName(DefaultFileName))
	{
		const FString Error = TEXT("invalid file name");
		LocHubBrowserBridgePrivate::Report(TEXT("SaveTextFile"), false, Error);
		Response.Failure(Error);
		return;
	}

	if (Text.Len() > LocHubBrowserBridgePrivate::MaxFileSize)
	{
		const FString Error = TEXT("The text is larger than 10 MB.");
		LocHubBrowserBridgePrivate::Report(TEXT("SaveTextFile"), false, Error);
		Response.Failure(Error);
		return;
	}

	// A dialog opened synchronously here would re-enter CEF from inside its own IPC dispatch; run it next tick instead.
	FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
		[Title, DefaultFileName, FileTypes, Text, Response](float) -> bool
		{
			const void* ParentWindow = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
			TArray<FString> SavedFiles;
			const bool bChosen = FDesktopPlatformModule::Get()->SaveFileDialog(
				ParentWindow, Title, FPaths::ProjectDir(), DefaultFileName, FileTypes, EFileDialogFlags::None, SavedFiles);
			if (!bChosen || SavedFiles.IsEmpty())
			{
				Response.Success(LocHubBridge::CancelledJson());
				return false;
			}

			const FString Path = FPaths::ConvertRelativePathToFull(SavedFiles[0]);
			if (FFileHelper::SaveStringToFile(Text, *Path, FFileHelper::EEncodingOptions::ForceUTF8))
			{
				Response.Success(LocHubBridge::SavedFileToJson(Path));
			}
			else
			{
				Response.Failure(FString::Printf(TEXT("Could not write %s."), *Path));
			}
			return false;
		}), 0.0f);
}
