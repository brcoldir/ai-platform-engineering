import { timingSafeEqual } from "crypto";

import { FIRST_PARTY_PUBLISHER, type PublisherIdentity } from "@/lib/notifications/publisher";

export type PublisherAuthentication =
  | { status: "authenticated"; publisher: PublisherIdentity }
  /** The server has no way to authenticate publishers. Nobody may publish. */
  | { status: "unconfigured" }
  | { status: "unauthorized" };

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * The single place that turns a request's credential into a publisher
 * identity. Today the only credential is the shared service token, which maps
 * to the first-party publisher. Per-app credentials would be verified here and
 * return an `app` identity, so the route and the permission checks do not
 * change when they arrive.
 */
export function authenticatePublisher(authorizationHeader: string | null): PublisherAuthentication {
  const expected = process.env.NOTIFICATIONS_INTERNAL_TOKEN?.trim();
  if (!expected) return { status: "unconfigured" };

  const header = authorizationHeader ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!presented || !tokensMatch(presented, expected)) return { status: "unauthorized" };

  return { status: "authenticated", publisher: FIRST_PARTY_PUBLISHER };
}
