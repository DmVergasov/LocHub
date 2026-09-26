// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubSyncLock.h"

#include "GenericPlatform/GenericPlatformFile.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/DateTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

FLocHubSyncLock::~FLocHubSyncLock()
{
	Release();
}

FString FLocHubSyncLock::GetDefaultPath(const FString& InProjectDir)
{
	return InProjectDir / TEXT("Saved/LocHub/sync.lock");
}

bool FLocHubSyncLock::TryAcquire(const FString& InPath, const FString& InHolder, FString& OutCurrentHolder)
{
	Release();

	IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
	PlatformFile.CreateDirectoryTree(*FPaths::GetPath(InPath));

	// Write access shared for reading only: a second OpenWrite fails until this handle closes -- Windows denies
	// FILE_SHARE_WRITE (WindowsPlatformFile.cpp:1638-1646), Mac and Linux take an exclusive flock() instead
	// (ApplePlatformFile.cpp:704-706, UnixPlatformFile.cpp:1279-1281).
	IFileHandle* RawHandle = PlatformFile.OpenWrite(*InPath, false, true);
	if (RawHandle == nullptr)
	{
		FString Holder;
		FFileHelper::LoadFileToString(Holder, *InPath, FFileHelper::EHashOptions::None, FILEREAD_AllowWrite);
		Holder.TrimStartAndEndInline();
		OutCurrentHolder = Holder.IsEmpty() ? FString(TEXT("another process")) : Holder;
		return false;
	}

	Handle.Reset(RawHandle);
	const FString Text = FString::Printf(TEXT("%s, pid %u, since %s"), *InHolder, FPlatformProcess::GetCurrentProcessId(), *FDateTime::Now().ToString());
	const FTCHARToUTF8 Utf8(*Text);
	Handle->Write(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length());
	Handle->Flush();
	return true;
}

void FLocHubSyncLock::Release()
{
	Handle.Reset();
}

bool FLocHubSyncLock::IsHeld() const
{
	return Handle.IsValid();
}
