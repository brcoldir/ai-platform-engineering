/** @jest-environment node */

import { parseNotificationEnvelope } from "@/lib/notifications/envelope";
import { isNotificationEnabled, parseNotificationPreferencePatch } from "@/lib/notifications/preferences";
import { publishNotificationEvent } from "@/lib/notifications/consumer.server";
import {
  getEventEntry,
  isNotificationCategory,
  isNotificationEventType,
  listCategoryEntries,
  listEventEntries,
  registerNotificationAppCatalog,
  resetNotificationRegistry,
  unregisterNotificationAppCatalog,
  validateNotificationAppCatalog,
} from "@/lib/notifications/registry";
import {
  ensureNotificationCatalogsLoaded,
  refreshNotificationCatalogs,
  resetNotificationCatalogLoader,
} from "@/lib/notifications/registry.server";
import { BUILTIN_EVENT_SEEDS } from "@/lib/notifications/taxonomy";

const mockGetCollection = jest.fn();
const mockCreateInAppNotification = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/in-app-notifications.server", () => ({
  createInAppNotification: (...args: unknown[]) => mockCreateInAppNotification(...args),
}));

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    app_id: "example-app",
    version: "1.0.0",
    category: { label: "Example App", description: "Updates from Example App." },
    events: [
      { type: "example-app.sync_failed", label: "Sync failed", description: "A sync failed.", default_enabled: true, severity: "error" },
      { type: "example-app.digest", label: "Digest ready", default_enabled: false, severity: "info", schema_version: 2 },
    ],
    ...overrides,
  };
}

function snapshot(): string {
  return JSON.stringify([listCategoryEntries(), listEventEntries()]);
}

beforeEach(() => {
  resetNotificationRegistry();
  resetNotificationCatalogLoader();
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("built-in entries", () => {
  it("seeds exactly the 12 built-in events with their defaults and severities", () => {
    const entries = listEventEntries();
    expect(entries).toHaveLength(12);
    expect(entries.map((entry) => [entry.type, entry.category, entry.defaultEnabled, entry.severity])).toEqual([
      ["ingestion.completed", "ingestion", true, "success"],
      ["ingestion.failed", "ingestion", true, "error"],
      ["ingestion.started", "ingestion", false, "info"],
      ["workflow.completed", "workflow", true, "success"],
      ["workflow.failed", "workflow", true, "error"],
      ["workflow.requires_input", "workflow", true, "warning"],
      ["workflow.started", "workflow", false, "info"],
      ["agent.completed", "agent", true, "success"],
      ["agent.failed", "agent", true, "error"],
      ["agent.started", "agent", false, "info"],
      ["service.degraded", "platform", true, "warning"],
      ["service.recovered", "platform", true, "success"],
    ]);
    expect(entries.every((entry) => entry.source === "builtin" && entry.schemaVersion === 1)).toBe(true);
    expect(BUILTIN_EVENT_SEEDS).toHaveLength(12);
    expect(listCategoryEntries().map((entry) => entry.id)).toEqual(["workflow", "ingestion", "agent", "platform"]);
  });

  it("does not know an unregistered type, category, or non-string", () => {
    expect(isNotificationEventType("billing.paid")).toBe(false);
    expect(isNotificationEventType(42)).toBe(false);
    expect(isNotificationCategory("billing")).toBe(false);
    expect(isNotificationEnabled("billing.paid", { events: { "billing.paid": true } })).toBe(false);
  });
});

describe("registerNotificationAppCatalog", () => {
  it("registers an app with its own category and namespaced events", () => {
    const result = registerNotificationAppCatalog(catalog());
    expect(result).toEqual({
      ok: true,
      appId: "example-app",
      version: "1.0.0",
      replaced: false,
      eventTypes: ["example-app.sync_failed", "example-app.digest"],
    });
    expect(listCategoryEntries().find((entry) => entry.id === "example-app")).toMatchObject({
      label: "Example App",
      source: "example-app",
    });
    expect(getEventEntry("example-app.digest")).toMatchObject({
      category: "example-app",
      defaultEnabled: false,
      severity: "info",
      schemaVersion: 2,
      source: "example-app",
    });
    expect(getEventEntry("example-app.sync_failed")?.category).not.toBe("agent");
  });

  it.each([
    ["a namespace that is not the app id", { events: [{ type: "other.sync", label: "x", default_enabled: true, severity: "info" }] }],
    ["a type with no namespace", { events: [{ type: "sync", label: "x", default_enabled: true, severity: "info" }] }],
    ["a type with a nested name", { events: [{ type: "example-app.a.b", label: "x", default_enabled: true, severity: "info" }] }],
    ["a duplicate type", { events: [
      { type: "example-app.a", label: "x", default_enabled: true, severity: "info" },
      { type: "example-app.a", label: "y", default_enabled: true, severity: "info" },
    ] }],
    ["an unknown severity", { events: [{ type: "example-app.a", label: "x", default_enabled: true, severity: "fatal" }] }],
    ["a non-boolean default", { events: [{ type: "example-app.a", label: "x", default_enabled: "yes", severity: "info" }] }],
    ["a bad schema version", { events: [{ type: "example-app.a", label: "x", default_enabled: true, severity: "info", schema_version: 0 }] }],
    ["no events", { events: [] }],
    ["a missing version", { version: " " }],
    ["a missing category label", { category: {} }],
    ["an app id that is not a slug", { app_id: "Example App" }],
  ])("rejects %s", (_label, overrides) => {
    const result = registerNotificationAppCatalog(catalog(overrides));
    expect(result.ok).toBe(false);
  });

  it.each(["ingestion", "workflow", "agent", "service", "platform"])(
    "rejects the built-in namespace %s",
    (namespace) => {
      const before = snapshot();
      const result = registerNotificationAppCatalog(
        catalog({
          app_id: namespace,
          events: [{ type: `${namespace}.custom`, label: "x", default_enabled: true, severity: "info" }],
        }),
      );
      expect(result.ok).toBe(false);
      expect(snapshot()).toBe(before);
    },
  );

  it("rejects non-object input", () => {
    expect(registerNotificationAppCatalog(null).ok).toBe(false);
    expect(registerNotificationAppCatalog([catalog()]).ok).toBe(false);
  });

  it("replaces an app's earlier entries in one step on a version bump", () => {
    registerNotificationAppCatalog(catalog());
    const result = registerNotificationAppCatalog(
      catalog({
        version: "2.0.0",
        events: [{ type: "example-app.new_thing", label: "New thing", default_enabled: true, severity: "success" }],
      }),
    );
    expect(result).toMatchObject({ ok: true, replaced: true, version: "2.0.0" });
    expect(getEventEntry("example-app.sync_failed")).toBeUndefined();
    expect(getEventEntry("example-app.new_thing")).toBeDefined();
    expect(listEventEntries()).toHaveLength(13);
  });

  it("leaves the registry untouched when a replacement fails validation", () => {
    registerNotificationAppCatalog(catalog());
    const before = snapshot();
    const result = registerNotificationAppCatalog(
      catalog({
        version: "2.0.0",
        events: [
          { type: "example-app.fine", label: "Fine", default_enabled: true, severity: "info" },
          { type: "example-app.bad", label: "Bad", default_enabled: true, severity: "nope" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(snapshot()).toBe(before);
    expect(getEventEntry("example-app.sync_failed")).toBeDefined();
  });

  it("keeps two apps' entries separate", () => {
    registerNotificationAppCatalog(catalog());
    registerNotificationAppCatalog(
      catalog({
        app_id: "second-app",
        events: [{ type: "second-app.sync_failed", label: "Sync failed", default_enabled: true, severity: "error" }],
      }),
    );
    expect(getEventEntry("example-app.sync_failed")?.source).toBe("example-app");
    expect(getEventEntry("second-app.sync_failed")?.source).toBe("second-app");
    expect(unregisterNotificationAppCatalog("second-app")).toBe(true);
    expect(getEventEntry("example-app.sync_failed")).toBeDefined();
    expect(unregisterNotificationAppCatalog("second-app")).toBe(false);
  });

  it("validate does not register", () => {
    expect(validateNotificationAppCatalog(catalog()).ok).toBe(true);
    expect(getEventEntry("example-app.sync_failed")).toBeUndefined();
  });
});

describe("registry-backed validators", () => {
  beforeEach(() => {
    registerNotificationAppCatalog(catalog());
  });

  const envelope = {
    id: "evt-1",
    type: "example-app.sync_failed",
    version: 1,
    occurred_at: "2026-10-14T10:00:00Z",
    resource: { type: "sync", id: "sync-1" },
    attempt_id: "attempt-1",
    recipient_subject: "subject-1",
    recipient_email: "test-user@example.com",
    data: { status: "failed", title: "Sync failed", summary: "A sync failed." },
  };

  it("accepts an envelope for an app type and rejects an unknown one", () => {
    expect(parseNotificationEnvelope(envelope).ok).toBe(true);
    expect(parseNotificationEnvelope({ ...envelope, type: "example-app.other" }).ok).toBe(false);
  });

  it("resolves app defaults, category overrides, and event overrides", () => {
    expect(isNotificationEnabled("example-app.sync_failed", null)).toBe(true);
    expect(isNotificationEnabled("example-app.digest", null)).toBe(false);
    expect(isNotificationEnabled("example-app.sync_failed", { categories: { "example-app": false } })).toBe(false);
    expect(
      isNotificationEnabled("example-app.sync_failed", {
        categories: { "example-app": false },
        events: { "example-app.sync_failed": true },
      }),
    ).toBe(true);
  });

  it("accepts app keys in a preference patch and still rejects unknown ones", () => {
    expect(
      parseNotificationPreferencePatch({
        categories: { "example-app": false },
        events: { "example-app.digest": true },
      }).ok,
    ).toBe(true);
    expect(parseNotificationPreferencePatch({ events: { "example-app.nope": true } }).ok).toBe(false);
    expect(parseNotificationPreferencePatch({ categories: { nope: true } }).ok).toBe(false);
  });
});

describe("an app event through publish", () => {
  const envelope = {
    id: "evt-1",
    type: "example-app.sync_failed",
    version: 1,
    occurred_at: "2026-10-14T10:00:00Z",
    resource: { type: "sync", id: "sync-1" },
    attempt_id: "attempt-1",
    recipient_subject: "subject-1",
    recipient_email: "test-user@example.com",
    data: { status: "failed", title: "Sync failed", summary: "A sync failed.", href: "/apps/example-app" },
  };

  function mockStores(options: { catalogs?: unknown[]; preferences?: unknown }) {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "notification_catalogs") {
        return { find: () => ({ sort: () => ({ toArray: async () => options.catalogs ?? [] }) }) };
      }
      return {
        findOne: jest.fn().mockResolvedValue(options.preferences ? { notification_preferences: options.preferences } : null),
      };
    });
  }

  it("loads the catalog, applies its severity and default, and tags the source with the app category", async () => {
    mockStores({ catalogs: [catalog()] });
    const outcome = await publishNotificationEvent(envelope);

    expect(outcome).toBe("delivered");
    expect(mockCreateInAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "example-app.sync_failed",
        severity: "error",
        sourceLabel: "example-app",
        eventKey: "example-app.sync_failed:sync:sync-1:attempt-1:subject-1",
      }),
    );
  });

  it("skips delivery when the recipient turned the app category off", async () => {
    mockStores({ catalogs: [catalog()], preferences: { categories: { "example-app": false } } });
    expect(await publishNotificationEvent(envelope)).toBe("disabled");
    expect(mockCreateInAppNotification).not.toHaveBeenCalled();
  });

  it("does not deliver an opt-out-by-default app event without an opt-in", async () => {
    mockStores({ catalogs: [catalog()] });
    expect(await publishNotificationEvent({ ...envelope, type: "example-app.digest" })).toBe("disabled");
  });

  it("rejects an app event when no catalog is registered", async () => {
    mockStores({ catalogs: [] });
    expect(await publishNotificationEvent(envelope)).toBe("invalid");
  });

  it("does not turn an app event on through the agent category", async () => {
    mockStores({ catalogs: [catalog()], preferences: { categories: { agent: false } } });
    expect(await publishNotificationEvent(envelope)).toBe("delivered");
  });
});

describe("catalog loader", () => {
  function mockCatalogs(...results: (unknown[] | Error)[]) {
    const queue = [...results];
    mockGetCollection.mockImplementation(async () => ({
      find: () => ({
        sort: () => ({
          toArray: async () => {
            const next = queue.length > 1 ? queue.shift() : queue[0];
            if (next instanceof Error) throw next;
            return next;
          },
        }),
      }),
    }));
  }

  it("registers valid documents and skips invalid ones", async () => {
    mockCatalogs([catalog(), { app_id: "ingestion", version: "1", category: { label: "x" }, events: [] }]);
    const result = await refreshNotificationCatalogs();
    expect(result.registered).toEqual(["example-app"]);
    expect(result.rejected.map((entry) => entry.appId)).toEqual(["ingestion"]);
    expect(getEventEntry("example-app.sync_failed")).toBeDefined();
  });

  it("keeps an app's earlier entries when its new document is invalid", async () => {
    mockCatalogs([catalog()], [catalog({ version: "2.0.0", events: [] })]);
    await refreshNotificationCatalogs();
    const result = await refreshNotificationCatalogs();
    expect(result.rejected).toHaveLength(1);
    expect(getEventEntry("example-app.sync_failed")).toBeDefined();
  });

  it("applies a version bump and removes an app whose document is gone", async () => {
    mockCatalogs(
      [catalog()],
      [catalog({ version: "2.0.0", events: [{ type: "example-app.x", label: "X", default_enabled: true, severity: "info" }] })],
      [],
    );
    await refreshNotificationCatalogs();
    await refreshNotificationCatalogs();
    expect(getEventEntry("example-app.sync_failed")).toBeUndefined();
    expect(getEventEntry("example-app.x")).toBeDefined();

    const result = await refreshNotificationCatalogs();
    expect(result.removed).toEqual(["example-app"]);
    expect(getEventEntry("example-app.x")).toBeUndefined();
  });

  it("changes nothing when the collection cannot be read", async () => {
    mockCatalogs([catalog()], new Error("database unavailable"));
    await refreshNotificationCatalogs();
    const result = await refreshNotificationCatalogs();
    expect(result.ok).toBe(false);
    expect(getEventEntry("example-app.sync_failed")).toBeDefined();
  });

  it("does not remove an app that was registered outside the loader", async () => {
    registerNotificationAppCatalog(catalog());
    mockCatalogs([]);
    await refreshNotificationCatalogs();
    expect(getEventEntry("example-app.sync_failed")).toBeDefined();
  });

  it("caches for the interval and refreshes again after it", async () => {
    jest.useFakeTimers();
    try {
      mockCatalogs([catalog()]);
      await ensureNotificationCatalogsLoaded();
      await ensureNotificationCatalogsLoaded();
      expect(mockGetCollection).toHaveBeenCalledTimes(1);

      jest.setSystemTime(Date.now() + 31_000);
      await ensureNotificationCatalogsLoaded();
      expect(mockGetCollection).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("shares one read between concurrent refreshes", async () => {
    mockCatalogs([catalog()]);
    await Promise.all([refreshNotificationCatalogs(), refreshNotificationCatalogs()]);
    expect(mockGetCollection).toHaveBeenCalledTimes(1);
  });
});
