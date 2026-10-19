import type { InAppNotificationSeverity } from "@/types/in-app-notification";
import {
  BUILTIN_CATEGORY_SEEDS,
  BUILTIN_EVENT_SEEDS,
  BUILTIN_NOTIFICATION_NAMESPACES,
} from "@/lib/notifications/taxonomy";

// Registry of notification event types and categories. The built-in events seed
// it, and an installed app adds its own through a versioned catalog document,
// so nothing here needs a code change per app. State is per server process.
// The settings UI never imports this file. It reads the registry through the
// preferences API.

export const BUILTIN_SOURCE = "builtin";
export const CATALOG_SCHEMA_VERSION = 1;

const SEVERITIES: readonly InAppNotificationSeverity[] = ["info", "success", "warning", "error"];
const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VERSION_LENGTH = 64;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_EVENTS_PER_APP = 50;

/** `builtin`, or the id of the app that registered the entry. */
export type NotificationSource = string;

export interface NotificationCategoryEntry {
  id: string;
  label: string;
  description: string;
  source: NotificationSource;
}

export interface NotificationEventEntry {
  /** `<namespace>.<name>`. For an app, the namespace is the app id. */
  type: string;
  category: string;
  label: string;
  description: string;
  /** Whether a user who has set no preference receives this event. */
  defaultEnabled: boolean;
  severity: InAppNotificationSeverity;
  /** Version of the event's `data` payload. Informational. The registry does not enforce it. */
  schemaVersion: number;
  source: NotificationSource;
}

/**
 * Sidecar document an installed app provides. It is stored as one document in
 * the `notification_catalogs` collection. See `registry.server.ts`.
 */
export interface NotificationAppCatalog {
  /** Slug that namespaces every event type the app registers. */
  app_id: string;
  /** App version the catalog belongs to. Any non-empty string. */
  version: string;
  /** Every app gets its own category, whose id is the app id. */
  category: { label: string; description?: string };
  events: {
    /** Full type, `<app_id>.<name>`. */
    type: string;
    label: string;
    description?: string;
    default_enabled: boolean;
    severity: InAppNotificationSeverity;
    /** Positive integer. Defaults to 1. */
    schema_version?: number;
  }[];
}

export type CatalogValidationResult =
  | { ok: true; appId: string; version: string; category: NotificationCategoryEntry; events: NotificationEventEntry[] }
  | { ok: false; error: string };

export type RegisterCatalogResult =
  | { ok: true; appId: string; version: string; replaced: boolean; eventTypes: string[] }
  | { ok: false; error: string };

interface RegistryState {
  categories: ReadonlyMap<string, NotificationCategoryEntry>;
  events: ReadonlyMap<string, NotificationEventEntry>;
  /** Registered app id to catalog version. */
  apps: ReadonlyMap<string, string>;
}

function seedState(): RegistryState {
  const categories = new Map<string, NotificationCategoryEntry>();
  for (const seed of BUILTIN_CATEGORY_SEEDS) {
    categories.set(seed.id, Object.freeze({ ...seed, source: BUILTIN_SOURCE }));
  }
  const events = new Map<string, NotificationEventEntry>();
  for (const seed of BUILTIN_EVENT_SEEDS) {
    events.set(seed.type, Object.freeze({ ...seed, schemaVersion: 1, source: BUILTIN_SOURCE }));
  }
  return { categories, events, apps: new Map() };
}

let state: RegistryState = seedState();

// ---- Lookup ----------------------------------------------------------------

export function getEventEntry(type: unknown): NotificationEventEntry | undefined {
  return typeof type === "string" ? state.events.get(type) : undefined;
}

export function getCategoryEntry(id: unknown): NotificationCategoryEntry | undefined {
  return typeof id === "string" ? state.categories.get(id) : undefined;
}

export function isNotificationEventType(value: unknown): value is string {
  return getEventEntry(value) !== undefined;
}

export function isNotificationCategory(value: unknown): value is string {
  return getCategoryEntry(value) !== undefined;
}

/** Built-in events first, then app events in registration order. */
export function listEventEntries(): NotificationEventEntry[] {
  return [...state.events.values()];
}

export function listCategoryEntries(): NotificationCategoryEntry[] {
  return [...state.categories.values()];
}

export function listRegisteredApps(): { appId: string; version: string }[] {
  return [...state.apps].map(([appId, version]) => ({ appId, version }));
}

// ---- Validation and registration ---------------------------------------------

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Checks an untrusted app catalog without touching the registry. Collisions
 * with other registered entries are checked at registration, because they
 * depend on what is already registered.
 */
export function validateNotificationAppCatalog(input: unknown): CatalogValidationResult {
  if (!isRecord(input)) return { ok: false, error: "catalog must be an object" };

  const appId = typeof input.app_id === "string" ? input.app_id : "";
  if (!APP_ID_PATTERN.test(appId)) {
    return { ok: false, error: "app_id must be a lowercase slug of letters, digits, and hyphens" };
  }
  if ((BUILTIN_NOTIFICATION_NAMESPACES as readonly string[]).includes(appId)) {
    return { ok: false, error: `app_id ${appId} collides with a built-in namespace` };
  }
  if (state.categories.get(appId)?.source === BUILTIN_SOURCE) {
    return { ok: false, error: `app_id ${appId} collides with a built-in category` };
  }

  const version = boundedString(input.version, MAX_VERSION_LENGTH);
  if (!version) return { ok: false, error: "version is required" };

  if (!isRecord(input.category)) return { ok: false, error: "category is required" };
  const categoryLabel = boundedString(input.category.label, MAX_LABEL_LENGTH);
  if (!categoryLabel) return { ok: false, error: "category.label is required" };
  let categoryDescription = "";
  if (input.category.description !== undefined) {
    const parsed = boundedString(input.category.description, MAX_DESCRIPTION_LENGTH);
    if (!parsed) return { ok: false, error: "category.description must be a short string" };
    categoryDescription = parsed;
  }

  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, error: "events must be a non-empty array" };
  }
  if (input.events.length > MAX_EVENTS_PER_APP) {
    return { ok: false, error: `events may contain at most ${MAX_EVENTS_PER_APP} entries` };
  }

  const events: NotificationEventEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input.events as unknown[]) {
    if (!isRecord(raw)) return { ok: false, error: "each event must be an object" };
    const type = typeof raw.type === "string" ? raw.type : "";
    const separator = type.indexOf(".");
    const namespace = separator === -1 ? "" : type.slice(0, separator);
    const name = separator === -1 ? "" : type.slice(separator + 1);
    if (!namespace || !EVENT_NAME_PATTERN.test(name)) {
      return { ok: false, error: `event type must look like ${appId}.<name>: ${type || "(missing)"}` };
    }
    if (namespace !== appId) {
      return { ok: false, error: `event type ${type} must use the namespace ${appId}` };
    }
    if (seen.has(type)) return { ok: false, error: `duplicate event type: ${type}` };
    seen.add(type);

    const label = boundedString(raw.label, MAX_LABEL_LENGTH);
    if (!label) return { ok: false, error: `${type}: label is required` };
    let description = "";
    if (raw.description !== undefined) {
      const parsed = boundedString(raw.description, MAX_DESCRIPTION_LENGTH);
      if (!parsed) return { ok: false, error: `${type}: description must be a short string` };
      description = parsed;
    }
    if (typeof raw.default_enabled !== "boolean") {
      return { ok: false, error: `${type}: default_enabled must be a boolean` };
    }
    if (!SEVERITIES.includes(raw.severity as InAppNotificationSeverity)) {
      return { ok: false, error: `${type}: severity must be one of ${SEVERITIES.join(", ")}` };
    }
    const schemaVersion = raw.schema_version === undefined ? 1 : raw.schema_version;
    if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      return { ok: false, error: `${type}: schema_version must be a positive integer` };
    }

    events.push(
      Object.freeze({
        type,
        category: appId,
        label,
        description,
        defaultEnabled: raw.default_enabled,
        severity: raw.severity as InAppNotificationSeverity,
        schemaVersion,
        source: appId,
      }),
    );
  }

  return {
    ok: true,
    appId,
    version,
    category: Object.freeze({ id: appId, label: categoryLabel, description: categoryDescription, source: appId }),
    events,
  };
}

/**
 * Registers an app catalog. Registering an app that is already registered
 * replaces all of its earlier entries in one step, which is how a version bump
 * works. The next state is built on the side and swapped in only after every
 * check passes, so a rejected catalog leaves the registry exactly as it was.
 */
export function registerNotificationAppCatalog(input: unknown): RegisterCatalogResult {
  const validated = validateNotificationAppCatalog(input);
  if (validated.ok === false) return validated;
  const { appId, version, category, events } = validated;

  const categories = new Map(state.categories);
  const nextEvents = new Map(state.events);
  const replaced = state.apps.has(appId);
  for (const [type, entry] of state.events) {
    if (entry.source === appId) nextEvents.delete(type);
  }

  // Entries owned by another source can only clash if the rules above were
  // bypassed. Checked anyway so one app can never take over another's entries.
  const existingCategory = categories.get(category.id);
  if (existingCategory && existingCategory.source !== appId) {
    return { ok: false, error: `category ${category.id} is already registered by ${existingCategory.source}` };
  }
  for (const event of events) {
    const owner = nextEvents.get(event.type);
    if (owner) return { ok: false, error: `event type ${event.type} is already registered by ${owner.source}` };
  }

  categories.set(category.id, category);
  for (const event of events) nextEvents.set(event.type, event);
  const apps = new Map(state.apps);
  apps.set(appId, version);

  state = { categories, events: nextEvents, apps };
  return { ok: true, appId, version, replaced, eventTypes: events.map((event) => event.type) };
}

/** Removes an app's category and events. Returns false if the app was not registered. */
export function unregisterNotificationAppCatalog(appId: string): boolean {
  if (!state.apps.has(appId)) return false;
  const categories = new Map(state.categories);
  categories.delete(appId);
  const events = new Map(state.events);
  for (const [type, entry] of state.events) {
    if (entry.source === appId) events.delete(type);
  }
  const apps = new Map(state.apps);
  apps.delete(appId);
  state = { categories, events, apps };
  return true;
}

/** Drops every app and restores the built-in entries. For tests. */
export function resetNotificationRegistry(): void {
  state = seedState();
}
