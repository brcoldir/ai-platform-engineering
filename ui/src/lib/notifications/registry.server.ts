import { getCollection } from "@/lib/mongodb";
import {
  listRegisteredApps,
  registerNotificationAppCatalog,
  unregisterNotificationAppCatalog,
} from "@/lib/notifications/registry";

/**
 * Collection of app catalogs. One document per installed app, in the shape of
 * `NotificationAppCatalog`:
 *
 *   {
 *     app_id: "tome",                       // unique, slug, the event namespace
 *     version: "1.4.0",
 *     category: { label: "TOME", description: "Updates from TOME." },
 *     events: [
 *       { type: "tome.sync_failed", label: "Sync failed", description: "...",
 *         default_enabled: true, severity: "error", schema_version: 1 }
 *     ]
 *   }
 *
 * Nothing writes this collection yet. An operator or the app installer inserts
 * documents, and a unique index on `app_id` is recommended. Documents that fail
 * validation are skipped and logged.
 */
export const NOTIFICATION_CATALOGS_COLLECTION = "notification_catalogs";

export const CATALOG_CACHE_TTL_MS = 30_000;

export interface CatalogRefreshResult {
  /** Apps registered or replaced from the collection. */
  registered: string[];
  /** Apps removed because their document is gone. */
  removed: string[];
  /** Documents that were skipped, with the reason. The app keeps its earlier entries. */
  rejected: { appId: string; error: string }[];
  /** False when the collection could not be read. Nothing changed. */
  ok: boolean;
}

// Apps this loader registered, so a refresh only removes what it owns.
const loadedApps = new Set<string>();
let loadedAt = 0;
let inFlight: Promise<CatalogRefreshResult> | null = null;

/**
 * Reads every catalog and applies it to the registry. Each valid document is
 * registered atomically. An invalid one is skipped and the app keeps its
 * earlier entries. An app whose document is gone is unregistered. If the read
 * fails the registry is left untouched. Never throws.
 */
export function refreshNotificationCatalogs(): Promise<CatalogRefreshResult> {
  if (!inFlight) {
    inFlight = loadCatalogs().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * Refreshes at most once per `CATALOG_CACHE_TTL_MS`. Call it before consulting
 * the registry on a request. A failed read also waits out the interval, so an
 * unavailable database is not queried on every event. Never throws.
 */
export async function ensureNotificationCatalogsLoaded(): Promise<void> {
  if (Date.now() - loadedAt < CATALOG_CACHE_TTL_MS) return;
  await refreshNotificationCatalogs();
}

/** Forgets the cache and the apps this loader registered. For tests. */
export function resetNotificationCatalogLoader(): void {
  loadedApps.clear();
  loadedAt = 0;
  inFlight = null;
}

async function loadCatalogs(): Promise<CatalogRefreshResult> {
  const result: CatalogRefreshResult = { registered: [], removed: [], rejected: [], ok: true };
  let documents: unknown[];
  try {
    const collection = await getCollection<Record<string, unknown>>(NOTIFICATION_CATALOGS_COLLECTION);
    documents = await collection.find({}).sort({ app_id: 1 }).toArray();
  } catch (error) {
    console.warn("[notifications] could not load app catalogs", error);
    loadedAt = Date.now();
    return { ...result, ok: false };
  }

  const present = new Set<string>();
  for (const document of documents) {
    const appId = (document as { app_id?: unknown } | null)?.app_id;
    const label = typeof appId === "string" ? appId : "(unknown)";
    if (typeof appId === "string" && present.has(appId)) {
      result.rejected.push({ appId: label, error: "duplicate catalog document" });
      continue;
    }
    if (typeof appId === "string") present.add(appId);

    const registered = registerNotificationAppCatalog(document);
    if (registered.ok === true) {
      loadedApps.add(registered.appId);
      result.registered.push(registered.appId);
    } else {
      console.warn(`[notifications] skipped catalog for ${label}: ${registered.error}`);
      result.rejected.push({ appId: label, error: registered.error });
    }
  }

  for (const { appId } of listRegisteredApps()) {
    if (loadedApps.has(appId) && !present.has(appId)) {
      unregisterNotificationAppCatalog(appId);
      loadedApps.delete(appId);
      result.removed.push(appId);
    }
  }

  loadedAt = Date.now();
  return result;
}
