// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class IFileHandle;

/**
 * Saved/LocHub/sync.lock held open for the whole Push or Pull. The open handle is the lock: a second OpenWrite of
 * the same file fails while this one is held on every platform LocHub ships on -- Windows denies FILE_SHARE_WRITE,
 * Mac and Linux take an exclusive flock() instead -- so the lock also works between the editor, a commandlet and
 * another editor session.
 */
class FLocHubSyncLock
{
public:
	FLocHubSyncLock() = default;
	~FLocHubSyncLock();

	FLocHubSyncLock(const FLocHubSyncLock&) = delete;
	FLocHubSyncLock& operator=(const FLocHubSyncLock&) = delete;

	/** <InProjectDir>/Saved/LocHub/sync.lock */
	static FString GetDefaultPath(const FString& InProjectDir);

	/** False, with who holds it, when the lock is taken. */
	bool TryAcquire(const FString& InPath, const FString& InHolder, FString& OutCurrentHolder);
	void Release();
	bool IsHeld() const;

private:
	TUniquePtr<IFileHandle> Handle;
};
