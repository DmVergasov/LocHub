// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

/**
 * Sets an environment variable of this (the editor's) process for the lifetime of the object, then restores
 * whatever value it held before -- or clears it, if it held none -- when the object is destroyed. Used to hand a
 * value (the active provider's API key) to a child process this editor spawns right after (key-contract.md §1)
 * without leaving it in the editor's own environment, and without any other child started later inheriting it.
 *
 * FPlatformMisc::GetEnvironmentVariable returns an empty FString both when a variable is absent and when it is set
 * to an empty string (there is no way to tell the two apart), so capturing the previous value with
 * GetEnvironmentVariable and restoring it with SetEnvironmentVar is correct in every starting state (set, empty, or
 * altogether absent) without this class needing to track which one it was -- provided SetEnvironmentVar is always
 * called with a real nullptr for an empty value, never an empty string literal (*FString() is a pointer to L"",
 * not nullptr). This class does exactly that (see the .cpp): passing nullptr deletes the variable on every engine
 * version this plugin targets and every platform, but the two are not everywhere interchangeable:
 * - Windows: FWindowsPlatformMisc::SetEnvironmentVar forwards Value to ::SetEnvironmentVariable, which deletes the
 *   variable on a literal nullptr but sets it to an empty string on L"". 5.7/5.8 turn an empty Value into nullptr
 *   themselves before that call (WindowsPlatformMisc.cpp 5.7 :1184-1189, 5.8 :1293-1298); 5.6 does not
 *   (WindowsPlatformMisc.cpp :1176-1183) and would leave an empty, not absent, variable behind if this class ever
 *   passed L"" instead of nullptr.
 * - Mac/Linux: FMacPlatformMisc::SetEnvironmentVar (UE 5.6, MacPlatformMisc.cpp:643-655),
 *   FApplePlatformMisc::SetEnvironmentVar (5.7/5.8, ApplePlatformMisc.cpp 5.7 :364-376, 5.8 :369-381) and
 *   FUnixPlatformMisc::SetEnvironmentVar (all three versions, UnixPlatformMisc.cpp) already call unsetenv for
 *   either nullptr or an empty string, so nullptr changes nothing for them -- but it costs nothing to pass it
 *   uniformly rather than carry a platform-specific exception here.
 */
class FLocHubScopedEnvVar
{
public:
	FLocHubScopedEnvVar(const FString& InName, const FString& InValue);
	~FLocHubScopedEnvVar();

	FLocHubScopedEnvVar(const FLocHubScopedEnvVar&) = delete;
	FLocHubScopedEnvVar& operator=(const FLocHubScopedEnvVar&) = delete;

private:
	FString Name;
	FString PreviousValue;
};
