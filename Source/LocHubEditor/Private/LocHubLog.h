// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#pragma once

#include "Logging/LogMacros.h"

// LocHub is a standalone editor plugin with no dependency on any host project's logging module, so it declares its own log category.
DECLARE_LOG_CATEGORY_EXTERN(LogLocHub, Log, All);
