---
sidebar_position: 5
---

# UI API Reference

The CAIPE UI API is a Next.js BFF. It serves browser requests, enforces
UI-facing authz, persists UI data in MongoDB, and proxies selected backend
services.

## Backend Services

| Service | Configuration |
|---|---|
| Dynamic Agents | `DYNAMIC_AGENTS_URL` |
| MongoDB | `MONGODB_URI`, `MONGODB_DATABASE` |
| RAG server | `RAG_SERVER_URL` |
| Slack bot admin API | configured bot admin URL/token |
| Webex bot admin API | configured bot admin URL/token |

## Chat Routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/v1/chat/stream/start` | Start a Dynamic Agents SSE stream |
| `POST` | `/api/v1/chat/stream/resume` | Resume a HITL/interrupted stream |
| `POST` | `/api/v1/chat/stream/cancel` | Cancel an active stream |
| `POST` | `/api/v1/chat/invoke` | Non-streaming Dynamic Agents invocation |

Example:

```bash
curl -N -X POST http://localhost:3000/api/v1/chat/stream/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "message": "Check production ArgoCD apps",
    "conversation_id": "conv-123",
    "agent_id": "platform-engineer"
  }'
```

## Health And Config

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | UI process health |
| `GET` | `/api/version` | Build metadata |
| `GET` | `/api/config` | Client-visible UI config |
| `GET` | `/api/admin/platform-config` | Admin-managed runtime defaults |

## Skills

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/skills` | List catalog skills |
| `POST` | `/api/skills` | Create or update a skill |
| `GET` | `/api/skills/install.sh` | Render local install script |
| `POST` | `/api/catalog-api-keys` | Mint catalog API key |

## Dynamic Agent Admin

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/dynamic-agents/available` | List chat-capable agents |
| `GET` | `/api/dynamic-agents/configs` | List agent configs |
| `POST` | `/api/dynamic-agents/configs` | Create agent config |

## Notifications

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/notifications` | Current user's inbox, paged, with unread count |
| `PATCH` | `/api/notifications/{id}` | Mark one notification read |
| `POST` | `/api/notifications/read-all` | Mark all notifications read |
| `GET` | `/api/settings/notification-preferences` | Effective event preferences for the current user |
| `PATCH` | `/api/settings/notification-preferences` | Set or clear category and event overrides |

`PATCH` accepts `{ "categories": {...}, "events": {...} }`. Each value is `true`, `false`, or `null`. `null` removes the override, so the event returns to its default. Unknown keys are rejected with `400`. Concurrent edits are merged safely. If the settings keep changing under the request, it returns `409`.

## Internal Service Routes

These routes are for other CAIPE services, not browsers. They are not part of the user-facing API.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/internal/notifications/events` | `Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN` | Publish one event to a resolved audience |

Responses:

| Status | Meaning |
|---|---|
| `202` | Accepted, no delivery failed. Body: `{ recipients, skipped, rejected, results: { delivered, queued, disabled, invalid, failed } }`. `skipped` counts recipients with no matching user. `rejected` counts recipients whose subject and email do not name the same user. |
| `400` | Body is not JSON, or the request or event is invalid. Nothing was published. |
| `401` | Missing or wrong token |
| `403` | Authenticated publisher not permitted (namespace, org admins, or recipient count). Cannot occur with the shared token today, which maps to a first-party publisher with full authority. Needs the publisher policy layer. |
| `503` | Token not configured, or at least one delivery failed (`results.failed > 0`). Safe to retry. |

Example:

```bash
curl -X POST http://caipe-ui:3000/api/internal/notifications/events \
  -H "Authorization: Bearer $NOTIFICATIONS_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "evt-example-1",
    "type": "ingestion.completed",
    "version": 1,
    "occurred_at": "2026-10-14T10:00:00Z",
    "resource": { "type": "datasource", "id": "example-source" },
    "attempt_id": "job-example-1",
    "recipients": [{ "email": "test-user@example.com" }],
    "include_org_admins": false,
    "data": { "status": "completed", "title": "Ingestion finished", "summary": "Example source finished indexing.", "href": "/knowledge-bases" }
  }'
```

Envelope fields are documented in `ui/src/lib/notifications/envelope.ts`. The event registry is in `ui/src/lib/notifications/registry.ts`. See [Event Notifications](../architecture/notifications.md#event-registry).

### Notification ingress contract

- OpenAPI 3.1: [notification-ingress.openapi.yaml](./notification-ingress.openapi.yaml)
- JSON Schema (request body): [schemas/notification-event.schema.json](./schemas/notification-event.schema.json)
- `ui/src/lib/__tests__/notification-contract.test.ts` fails if the schema drifts from the code.
- The schema lists the 12 built-in event types only. Types that an app registers through the event registry are accepted at runtime but are not described by this schema.
- Auth is one shared token, verified into a single first-party publisher identity. Per-app credentials are not implemented.

### Can an external app call this?

What the repo shows:

- The route checks only the bearer token. Nothing in `ui/src/proxy.ts` affects it: its matcher is `/apps/:path*` only.
- Docker Compose: `caipe-ui` publishes port `3000:3000` to the host, and other services reach it as `http://caipe-ui:3000`. The route is therefore reachable from the host and from containers on the same Compose network, if they hold the token. `NOTIFICATIONS_INTERNAL_TOKEN` defaults to empty, which makes the route answer `503`.
- Helm: the `caipe-ui` Ingress is off by default (`ingress.enabled: false`). When enabled, the sample path is `/` with `Prefix`, which forwards `/api/internal/*` like any other path. The chart has no path exclusion and no NetworkPolicy templates.

What the repo cannot tell you:

- Whether your cluster's ingress controller, gateway, WAF, or network policies expose or block `/api/internal/*`. That is set outside this repo.
- Whether `next.config` or an external gateway rewrites or filters the path. Only `proxy.ts` was checked.
- Whether the token is set in a given deployment.
- Treat an external app as supported only if the operator confirms reachability and issues it the token. Because the token is shared, prefer in-cluster callers until per-publisher identity exists.

Route files under `ui/src/app/api` are the implementation source of truth.
