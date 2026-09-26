// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Bridge/LocHubSseParser.h"

void FLocHubSseParser::Feed(TConstArrayView<uint8> InBytes, TArray<FLocHubSseEvent>& OutEvents)
{
	Pending.Append(InBytes.GetData(), InBytes.Num());

	int32 LineStart = 0;
	for (int32 Index = 0; Index < Pending.Num(); ++Index)
	{
		if (Pending[Index] != '\n')
		{
			continue;
		}

		int32 LineEnd = Index;
		if (LineEnd > LineStart && Pending[LineEnd - 1] == '\r')
		{
			--LineEnd;
		}

		// Lines split on the '\n' byte, which never occurs inside a UTF-8 sequence, so every line decodes whole.
		const UTF8CHAR* LineData = reinterpret_cast<const UTF8CHAR*>(Pending.GetData() + LineStart);
		ProcessLine(FString::ConstructFromPtrSize(LineData, LineEnd - LineStart), OutEvents);
		LineStart = Index + 1;
	}

	if (LineStart > 0)
	{
		Pending.RemoveAt(0, LineStart, EAllowShrinking::No);
	}
}

void FLocHubSseParser::Reset()
{
	Pending.Reset();
	EventName.Reset();
	DataBuffer.Reset();
	NumComments = 0;
	bHasData = false;
}

void FLocHubSseParser::ProcessLine(const FString& InLine, TArray<FLocHubSseEvent>& OutEvents)
{
	if (InLine.IsEmpty())
	{
		if (bHasData)
		{
			FLocHubSseEvent& Event = OutEvents.AddDefaulted_GetRef();
			Event.Event = EventName.IsEmpty() ? FString(TEXT("message")) : EventName;
			Event.Data = DataBuffer;
		}

		EventName.Reset();
		DataBuffer.Reset();
		bHasData = false;
		return;
	}

	if (InLine[0] == TEXT(':'))
	{
		++NumComments;
		return;
	}

	FString Field = InLine;
	FString Value;
	int32 ColonIndex = INDEX_NONE;
	if (InLine.FindChar(TEXT(':'), ColonIndex))
	{
		Field = InLine.Left(ColonIndex);
		Value = InLine.Mid(ColonIndex + 1);
		// Exactly one space after the colon belongs to the syntax, not to the value.
		Value.RemoveFromStart(TEXT(" "), ESearchCase::CaseSensitive);
	}

	if (Field.Equals(TEXT("event"), ESearchCase::CaseSensitive))
	{
		EventName = Value;
	}
	else if (Field.Equals(TEXT("data"), ESearchCase::CaseSensitive))
	{
		if (bHasData)
		{
			DataBuffer += TEXT("\n");
		}
		DataBuffer += Value;
		bHasData = true;
	}
}
