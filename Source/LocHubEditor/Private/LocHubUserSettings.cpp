// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "LocHubUserSettings.h"

FName ULocHubUserSettings::GetCategoryName() const
{
	return TEXT("Plugins");
}

FName ULocHubUserSettings::GetSectionName() const
{
	return TEXT("LocHub");
}
