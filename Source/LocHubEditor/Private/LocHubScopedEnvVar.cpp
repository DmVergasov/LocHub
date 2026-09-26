// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubScopedEnvVar.h"

#include "HAL/PlatformMisc.h"

FLocHubScopedEnvVar::FLocHubScopedEnvVar(const FString& InName, const FString& InValue)
	: Name(InName)
	, PreviousValue(FPlatformMisc::GetEnvironmentVariable(*InName))
{
	// A real nullptr, not *InValue (which for an empty FString is a pointer to an empty string literal, not
	// nullptr): see the class comment above for why the two are not interchangeable on every engine version.
	FPlatformMisc::SetEnvironmentVar(*Name, InValue.IsEmpty() ? nullptr : *InValue);
}

FLocHubScopedEnvVar::~FLocHubScopedEnvVar()
{
	FPlatformMisc::SetEnvironmentVar(*Name, PreviousValue.IsEmpty() ? nullptr : *PreviousValue);
}
