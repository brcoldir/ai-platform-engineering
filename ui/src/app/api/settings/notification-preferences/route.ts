// GET   /api/settings/notification-preferences - effective event preferences for the current user
// PATCH /api/settings/notification-preferences - update category and event overrides

import { ApiError } from "@/lib/api-error";
import {
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  isNotificationEnabled,
  parseNotificationPreferencePatch,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import { getCategoryEntry, listCategoryEntries, listEventEntries } from "@/lib/notifications/registry";
import { ensureNotificationCatalogsLoaded } from "@/lib/notifications/registry.server";
import { updateNotificationPreferences } from "@/lib/notifications/preferences.server";
import type { UserSettings } from "@/types/mongodb";
import { NextRequest } from "next/server";

function effectiveView(preferences: NotificationPreferences | null) {
  const categories = listCategoryEntries();
  return {
    categories: categories.map((category) => category.id),
    categoryDetails: categories.map(({ id, label, description, source }) => ({ id, label, description, source })),
    events: listEventEntries().map((entry) => ({
      type: entry.type,
      category: entry.category,
      label: entry.label,
      description: entry.description,
      categoryLabel: getCategoryEntry(entry.category)?.label ?? entry.category,
      source: entry.source,
      enabled: isNotificationEnabled(entry.type, preferences),
      explicit:
        preferences?.events?.[entry.type] !== undefined ||
        preferences?.categories?.[entry.category] !== undefined,
    })),
    preferences: preferences ?? { categories: {}, events: {} },
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    await ensureNotificationCatalogsLoaded();
    const settings = await getCollection<UserSettings>("user_settings");
    const doc = await settings.findOne(
      { user_id: user.email },
      { projection: { notification_preferences: 1 } },
    );
    return successResponse(effectiveView(doc?.notification_preferences ?? null));
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError("Request body must be JSON", 400, "INVALID_JSON");
    }

    await ensureNotificationCatalogsLoaded();
    const parsed = parseNotificationPreferencePatch(body);
    if (parsed.ok === false) {
      throw new ApiError(parsed.error, 400, "INVALID_PREFERENCES");
    }

    const merged = await updateNotificationPreferences(user.email, parsed.patch);

    return successResponse(effectiveView(merged));
  });
});
