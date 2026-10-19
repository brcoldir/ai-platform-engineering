/** @jest-environment node */

import { handleJetStreamMessage, publishNotificationEvent } from "@/lib/notifications/consumer.server";
import { resetNotificationRegistry } from "@/lib/notifications/registry";
import {
  MIN_FORCED_REFRESH_MS,
  parseWithFreshCatalogs,
  resetNotificationCatalogLoader,
} from "@/lib/notifications/registry.server";
import { parseNotificationEnvelope } from "@/lib/notifications/envelope";

// One in-memory stand-in for the two collections these paths touch.
let catalogDocs: unknown[] = [];
let catalogReads = 0;
const mockCreateInAppNotification = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => {
    if (name === "notification_catalogs") {
      return {
        find: () => ({
          sort: () => ({
            toArray: async () => {
              catalogReads += 1;
              return catalogDocs;
            },
          }),
        }),
      };
    }
    return { findOne: async () => null };
  },
}));
jest.mock("@/lib/in-app-notifications.server", () => ({
  createInAppNotification: (...args: unknown[]) => mockCreateInAppNotification(...args),
}));

const appCatalog = {
  app_id: "example",
  version: "1.0.0",
  category: { label: "Example app" },
  events: [{ type: "example.digest_ready", label: "Digest ready", default_enabled: true, severity: "success" }],
};

function envelope(type: string) {
  return {
    id: "evt-1",
    type,
    version: 1,
    occurred_at: "2026-10-14T10:00:00Z",
    resource: { type: "example_thing", id: "thing-1" },
    attempt_id: "attempt-1",
    recipient_subject: "subject-1",
    recipient_email: "test-user@example.com",
    data: { status: "ready", title: "Digest ready", summary: "Your digest is ready." },
  };
}

function fakeMessage(body: unknown) {
  return {
    data: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    ack: jest.fn(),
    nak: jest.fn(),
    term: jest.fn(),
  };
}

let now = 1_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockImplementation(() => now);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  catalogDocs = [];
  catalogReads = 0;
  now += 10 * MIN_FORCED_REFRESH_MS;
  resetNotificationRegistry();
  resetNotificationCatalogLoader();
  mockCreateInAppNotification.mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("parseWithFreshCatalogs", () => {
  it("accepts an app event whose catalog appeared after this process cached", async () => {
    await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope("workflow.completed"))); // primes the cache while empty
    expect(catalogReads).toBe(1);

    catalogDocs = [appCatalog]; // the app is installed now, inside the cache interval
    now += 1_000;
    const result = await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope("example.digest_ready")));

    expect(result.ok).toBe(true);
    expect(catalogReads).toBe(2);
  });

  it("still rejects a type that no catalog declares, after one refresh", async () => {
    const result = await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope("example.never_declared")));
    expect(result).toEqual({ ok: false, error: "unknown event type: example.never_declared" });
    expect(catalogReads).toBe(2); // the cached load, then one forced refresh
  });

  it("does not hit the database again for a burst of unknown types", async () => {
    for (let i = 0; i < 20; i += 1) {
      await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope(`example.bogus_${i}`)));
    }
    expect(catalogReads).toBe(2);
  });

  it("allows another forced refresh once the floor has passed", async () => {
    await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope("example.bogus_a")));
    now += MIN_FORCED_REFRESH_MS + 1;
    await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope("example.bogus_b")));
    expect(catalogReads).toBe(3);
  });

  it("does not refresh for failures that are not about the event type", async () => {
    await parseWithFreshCatalogs(() => parseNotificationEnvelope({ ...envelope("workflow.completed"), recipient_email: "" }));
    expect(catalogReads).toBe(1);
  });

  it("does not refresh when the event type is already known", async () => {
    await parseWithFreshCatalogs(() => parseNotificationEnvelope(envelope("workflow.completed")));
    expect(catalogReads).toBe(1);
  });
});

describe("JetStream consumer and a late catalog", () => {
  it("stores and acks an app event whose catalog was added after the cache was filled", async () => {
    await publishNotificationEvent(envelope("workflow.completed")); // fills the cache with no apps
    catalogDocs = [appCatalog];
    now += 1_000;
    const message = fakeMessage(envelope("example.digest_ready"));

    await handleJetStreamMessage(message as never);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.term).not.toHaveBeenCalled();
    expect(mockCreateInAppNotification).toHaveBeenCalledWith(expect.objectContaining({ eventType: "example.digest_ready" }));
  });

  it("still terminates a message whose type no catalog declares", async () => {
    const message = fakeMessage(envelope("example.never_declared"));
    await handleJetStreamMessage(message as never);
    expect(message.term).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(mockCreateInAppNotification).not.toHaveBeenCalled();
  });

  it("terminates unparseable bytes and naks a storage failure so it is redelivered", async () => {
    const garbage = fakeMessage("not json");
    await handleJetStreamMessage(garbage as never);
    expect(garbage.term).toHaveBeenCalledTimes(1);

    jest.spyOn(console, "error").mockImplementation(() => {});
    mockCreateInAppNotification.mockRejectedValue(new Error("mongo unavailable"));
    const retry = fakeMessage(envelope("workflow.completed"));
    await handleJetStreamMessage(retry as never);
    expect(retry.nak).toHaveBeenCalledWith(5_000);
    expect(retry.term).not.toHaveBeenCalled();
  });
});
