/** @jest-environment node */

import { NextRequest } from "next/server";

import { POST } from "@/app/api/internal/notifications/events/route";
import type { PublisherAuthentication } from "@/lib/notifications/publisher.server";

const mockPublish = jest.fn();
let authentication: PublisherAuthentication;

jest.mock("@/lib/notifications/fanout.server", () => ({
  publishNotificationRequest: (...args: unknown[]) => mockPublish(...args),
}));
jest.mock("@/lib/notifications/publisher.server", () => ({
  authenticatePublisher: () => authentication,
}));

const appPublisher = {
  id: "app-example",
  kind: "app" as const,
  namespaces: ["example"],
  canNotifyOrgAdmins: false,
  maxRecipients: 50,
};

function call(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/internal/notifications/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ignored-by-mock" },
      body: JSON.stringify(body),
    }),
  );
}

const baseEvent = {
  id: "evt-1",
  version: 1,
  occurred_at: "2026-10-14T10:00:00Z",
  resource: { type: "example_thing", id: "thing-1" },
  attempt_id: "attempt-1",
  data: { status: "ready", title: "Digest ready", summary: "Your digest is ready." },
  recipients: [{ subject: "sub-1" }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPublish.mockResolvedValue({ recipients: 1, skipped: 0, rejected: 0, results: { delivered: 1, queued: 0, disabled: 0, invalid: 0, failed: 0 } });
  authentication = { status: "authenticated", publisher: appPublisher };
});

describe("publisher permissions on the internal events route", () => {
  it("returns 403, not 401, when an authenticated app uses another namespace", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const response = await call({ ...baseEvent, type: "workflow.completed" });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/may not send 'workflow' events/);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("app-example");
    warn.mockRestore();
  });

  it("returns 403 when a publisher without org-admin rights asks for org admins", async () => {
    // Uses a built-in type because app-declared types are not accepted by the
    // validator until the event registry exists.
    authentication = { status: "authenticated", publisher: { ...appPublisher, namespaces: ["ingestion"] } };
    const response = await call({ ...baseEvent, type: "ingestion.completed", include_org_admins: true });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("this publisher may not notify org admins");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("accepts a publisher's permitted namespace to listed users", async () => {
    authentication = { status: "authenticated", publisher: { ...appPublisher, namespaces: ["ingestion"] } };
    const response = await call({ ...baseEvent, type: "ingestion.completed" });

    expect(response.status).toBe(202);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("answers an invalid body with 400 before any permission check", async () => {
    const response = await call({ ...baseEvent, type: "ingestion.completed", recipients: [] });
    expect(response.status).toBe(400);
  });

  it("returns 401 and 503 from authentication without reading the body", async () => {
    authentication = { status: "unauthorized" };
    expect((await call({ ...baseEvent, type: "ingestion.completed" })).status).toBe(401);
    authentication = { status: "unconfigured" };
    expect((await call({ ...baseEvent, type: "ingestion.completed" })).status).toBe(503);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("lets the first-party publisher through for any namespace and org admins", async () => {
    const { FIRST_PARTY_PUBLISHER } = jest.requireActual("@/lib/notifications/publisher");
    authentication = { status: "authenticated", publisher: FIRST_PARTY_PUBLISHER };
    const response = await call({ ...baseEvent, type: "ingestion.completed", include_org_admins: true });
    expect(response.status).toBe(202);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
