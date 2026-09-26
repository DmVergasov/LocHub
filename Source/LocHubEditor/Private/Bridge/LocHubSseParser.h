// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

struct FLocHubSseEvent
{
	FString Event;
	FString Data;
};

/**
 * Incremental text/event-stream parser: bytes arrive in arbitrary chunks, and a chunk may end inside a line or inside
 * a UTF-8 sequence. Keeps the fields LocHub uses (event, data) and counts comment lines, which the service sends as
 * ": connected" on open and ": ping" as a heartbeat. Lines end with LF or CRLF; a lone CR is not a line end.
 */
class FLocHubSseParser
{
public:
	void Feed(TConstArrayView<uint8> InBytes, TArray<FLocHubSseEvent>& OutEvents);
	void Reset();
	int32 GetNumComments() const { return NumComments; }

private:
	void ProcessLine(const FString& InLine, TArray<FLocHubSseEvent>& OutEvents);

	TArray<uint8> Pending;
	FString EventName;
	FString DataBuffer;
	int32 NumComments = 0;
	bool bHasData = false;
};
