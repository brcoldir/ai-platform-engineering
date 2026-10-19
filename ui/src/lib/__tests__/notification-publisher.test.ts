/** @jest-environment node */

import {
  authorizePublish,
  eventNamespace,
  FIRST_PARTY_PUBLISHER,
  type PublisherIdentity,
} from "@/lib/notifications/publisher";
import { authenticatePublisher } from "@/lib/notifications/publisher.server";
import type { NotificationEventRequest } from "@/lib/notifications/request";

const appPublisher: PublisherIdentity = {
  id: "app-example",
  kind: "app",
  namespaces: ["example"],
  canNotifyOrgAdmins: false,
  maxRecipients: 2,
};

function request(overrides: Partial<NotificationEventRequest> & { type?: unknown } = {}): NotificationEventRequest {
  const { type = "example.digest_ready", ...rest } = overrides;
  return {
    base: { type },
    recipients: [{ subject: "sub-1" }],
    includeOrgAdmins: false,
    ...rest,
  };
}

describe("eventNamespace", () => {
  it.each([
    ["workflow.completed", "workflow"],
    ["example.digest.ready", "example"],
  ])("takes the part before the first dot from %s", (type, expected) => {
    expect(eventNamespace(type)).toBe(expected);
  });

  it.each([[".leading"], ["nodot"], [""], [undefined], [5], [null]])("returns null for %p", (type) => {
    expect(eventNamespace(type)).toBeNull();
  });
});

describe("authorizePublish", () => {
  it("lets the first-party publisher send any namespace to org admins", () => {
    expect(authorizePublish(FIRST_PARTY_PUBLISHER, request({ type: "ingestion.failed", includeOrgAdmins: true }))).toEqual({ allowed: true });
    expect(authorizePublish(FIRST_PARTY_PUBLISHER, request({ type: "example.digest_ready" }))).toEqual({ allowed: true });
  });

  it("lets an app publisher send its own namespace to listed users", () => {
    expect(authorizePublish(appPublisher, request())).toEqual({ allowed: true });
  });

  it("denies an app publisher another namespace, including built-in ones", () => {
    for (const type of ["workflow.completed", "agent.failed", "other.thing"]) {
      const decision = authorizePublish(appPublisher, request({ type }));
      expect(decision.allowed).toBe(false);
    }
  });

  it("denies an app publisher that asks for org admins", () => {
    const decision = authorizePublish(appPublisher, request({ includeOrgAdmins: true }));
    expect(decision).toEqual({ allowed: false, reason: "this publisher may not notify org admins" });
  });

  it("denies an app publisher that lists more recipients than allowed", () => {
    const decision = authorizePublish(appPublisher, request({ recipients: [{ subject: "a" }, { subject: "b" }, { subject: "c" }] }));
    expect(decision.allowed).toBe(false);
  });

  it("denies an event type with no namespace", () => {
    expect(authorizePublish(FIRST_PARTY_PUBLISHER, request({ type: "nodot" })).allowed).toBe(false);
  });

  it("does not let a namespace that merely starts with an allowed one through", () => {
    const decision = authorizePublish(appPublisher, request({ type: "example2.digest_ready" }));
    expect(decision.allowed).toBe(false);
  });
});

describe("authenticatePublisher", () => {
  const previous = process.env.NOTIFICATIONS_INTERNAL_TOKEN;
  afterEach(() => {
    if (previous === undefined) delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
    else process.env.NOTIFICATIONS_INTERNAL_TOKEN = previous;
  });

  it("reports unconfigured when no token is set, even for a request that sends one", () => {
    delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
    expect(authenticatePublisher("Bearer anything")).toEqual({ status: "unconfigured" });
  });

  it("maps the shared token to the first-party publisher", () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "test-token-value";
    expect(authenticatePublisher("Bearer test-token-value")).toEqual({ status: "authenticated", publisher: FIRST_PARTY_PUBLISHER });
  });

  it.each([[null], [""], ["Bearer "], ["Bearer wrong"], ["Basic test-token-value"], ["Bearer test-token-valuX"], ["Bearer test-token-value-longer"]])(
    "rejects %p",
    (header) => {
      process.env.NOTIFICATIONS_INTERNAL_TOKEN = "test-token-value";
      expect(authenticatePublisher(header)).toEqual({ status: "unauthorized" });
    },
  );
});
