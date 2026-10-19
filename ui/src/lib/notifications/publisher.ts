import type { NotificationEventRequest } from "@/lib/notifications/request";

/**
 * Who is publishing, and what they are allowed to publish. The shared
 * service token maps to one first-party identity with full authority. A
 * per-app credential would map to an `app` identity limited to its own
 * namespace and to explicit user recipients. Issuing such credentials is not
 * implemented here: that belongs to the app install flow.
 */
export interface PublisherIdentity {
  /** Stable id for logs and audit. Never a secret. */
  id: string;
  kind: "first-party" | "app";
  /** Event-type namespaces this publisher may use, or "*" for all. */
  namespaces: string[] | "*";
  /** May the request ask for every org admin? */
  canNotifyOrgAdmins: boolean;
  /** Maximum explicit recipients in one request. */
  maxRecipients: number;
}

export const FIRST_PARTY_PUBLISHER: PublisherIdentity = {
  id: "first-party",
  kind: "first-party",
  namespaces: "*",
  canNotifyOrgAdmins: true,
  maxRecipients: 50,
};

export type PublishDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/** The namespace of an event type is the part before the first dot. */
export function eventNamespace(type: unknown): string | null {
  if (typeof type !== "string") return null;
  const dot = type.indexOf(".");
  return dot > 0 ? type.slice(0, dot) : null;
}

/**
 * Decides whether a verified publisher may send this request. The event and
 * the audience are both checked, so a publisher cannot borrow another
 * namespace's event types or widen its audience. The identity comes from
 * authentication, never from the request body.
 */
export function authorizePublish(
  publisher: PublisherIdentity,
  request: NotificationEventRequest,
): PublishDecision {
  const namespace = eventNamespace(request.base.type);
  if (!namespace) {
    return { allowed: false, reason: "event type must be '<namespace>.<name>'" };
  }
  if (publisher.namespaces !== "*" && !publisher.namespaces.includes(namespace)) {
    return { allowed: false, reason: `this publisher may not send '${namespace}' events` };
  }
  if (request.includeOrgAdmins && !publisher.canNotifyOrgAdmins) {
    return { allowed: false, reason: "this publisher may not notify org admins" };
  }
  if (request.recipients.length > publisher.maxRecipients) {
    return { allowed: false, reason: `this publisher may list at most ${publisher.maxRecipients} recipients` };
  }
  return { allowed: true };
}
