// POST /api/internal/notifications/events
//
// Service-to-service entry point for producers that run outside the UI server,
// such as the Python ingestion and autonomous-agent services. Callers present
// NOTIFICATIONS_INTERNAL_TOKEN as a bearer token. The request carries one event
// plus its audience: explicit recipients, org admins, or both. The server
// resolves each person's identifiers from its own user records and publishes one
// event per recipient through the same path that in-process producers use.
//
// Trust model: the credential is verified into a publisher identity, and the
// identity decides which event namespaces and audiences the request may use.
// Today the shared token maps to one first-party publisher with full authority.
// Each recipient's preferences are still applied before anything is written.

import { authorizePublish } from "@/lib/notifications/publisher";
import { authenticatePublisher } from "@/lib/notifications/publisher.server";
import { publishNotificationRequest } from "@/lib/notifications/fanout.server";
import { parseNotificationEventRequest } from "@/lib/notifications/request";
import { parseWithFreshCatalogs } from "@/lib/notifications/registry.server";
import { NextRequest } from "next/server";

export async function POST(request: NextRequest): Promise<Response> {
  const authentication = authenticatePublisher(request.headers.get("authorization"));
  if (authentication.status === "unconfigured") {
    return Response.json({ error: "Notification internal token is not configured" }, { status: 503 });
  }
  if (authentication.status === "unauthorized") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { publisher } = authentication;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = await parseWithFreshCatalogs(() => parseNotificationEventRequest(body));
  if (parsed.ok === false) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const decision = authorizePublish(publisher, parsed.request);
  if (decision.allowed === false) {
    console.warn(
      `[notifications] publisher ${publisher.id} denied for ${String(parsed.request.base.type)}: ${decision.reason}`,
    );
    return Response.json({ error: decision.reason }, { status: 403 });
  }

  const outcome = await publishNotificationRequest(parsed.request);

  // 202 means the event was accepted. 503 tells the caller that at least one
  // delivery failed and it may retry; recipients already delivered are
  // deduplicated by event key.
  const status = outcome.results.failed > 0 ? 503 : 202;
  return Response.json(outcome, { status });
}
