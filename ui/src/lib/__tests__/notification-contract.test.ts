/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-explicit-any -- schema walking and body mutation are intentionally untyped */

// Keeps docs/docs/ui/schemas/notification-event.schema.json in sync with the
// code. ajv is not a direct dependency (only an old draft-07 copy exists
// transitively, which cannot read a 2020-12 schema), so this file uses a small
// validator that supports exactly the keywords the schema uses: type, const,
// enum, required, properties, items, anyOf, min/maxLength, min/maxItems,
// pattern and format date-time. It throws on any other keyword, so extending
// the schema forces extending the helper.

import fs from "fs";
import path from "path";

import {
  MAX_ID_LENGTH,
  MAX_RESOURCE_TYPE_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  NOTIFICATION_ENVELOPE_VERSION,
  parseNotificationEnvelope,
} from "@/lib/notifications/envelope";
import { MAX_REQUEST_RECIPIENTS, parseNotificationEventRequest } from "@/lib/notifications/request";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/taxonomy";

type Schema = Record<string, any>;

const schemaPath = path.resolve(__dirname, "../../../../docs/docs/ui/schemas/notification-event.schema.json");
const schema: Schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

const SUPPORTED = new Set([
  "$schema", "$id", "title", "description", "type", "const", "enum", "required", "properties",
  "items", "anyOf", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format",
  "additionalProperties",
]);

function typeOk(type: string, v: unknown): boolean {
  if (type === "object") return !!v && typeof v === "object" && !Array.isArray(v);
  if (type === "array") return Array.isArray(v);
  return typeof v === type;
}

function validate(s: Schema, v: unknown): boolean {
  for (const key of Object.keys(s)) {
    if (!SUPPORTED.has(key)) throw new Error(`validator does not support keyword: ${key}`);
  }
  if (s.type && !typeOk(s.type, v)) return false;
  if ("const" in s && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) return false;
    if (s.maxLength !== undefined && v.length > s.maxLength) return false;
    if (s.pattern && !new RegExp(s.pattern).test(v)) return false;
    if (s.format === "date-time" && !Number.isFinite(Date.parse(v))) return false;
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return false;
    if (s.maxItems !== undefined && v.length > s.maxItems) return false;
    if (s.items && !v.every((item) => validate(s.items, item))) return false;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in obj)) return false;
    for (const [key, sub] of Object.entries<Schema>(s.properties ?? {})) {
      if (key in obj && !validate(sub, obj[key])) return false;
    }
  }
  if (s.anyOf && !s.anyOf.some((sub: Schema) => validate(sub, v))) return false;
  return true;
}

const valid = () => ({
  id: "evt-1",
  type: "ingestion.completed",
  version: 1,
  occurred_at: "2026-10-14T10:00:00Z",
  resource: { type: "datasource", id: "example-source" },
  attempt_id: "job-1",
  recipients: [{ email: "test-user@example.com" }],
  data: { status: "completed", title: "Done", summary: "Finished.", href: "/knowledge-bases" },
});

function mutate(fn: (body: any) => void): unknown {
  const body: any = valid();
  fn(body);
  return body;
}

describe("notification contract matches the code", () => {
  it("uses limits equal to the exported constants", () => {
    const p = schema.properties;
    expect(p.id.maxLength).toBe(MAX_ID_LENGTH);
    expect(p.attempt_id.maxLength).toBe(MAX_ID_LENGTH);
    expect(p.correlation_id.maxLength).toBe(MAX_ID_LENGTH);
    expect(p.resource.properties.id.maxLength).toBe(MAX_ID_LENGTH);
    expect(p.resource.properties.type.maxLength).toBe(MAX_RESOURCE_TYPE_LENGTH);
    expect(p.data.properties.status.maxLength).toBe(MAX_STATUS_LENGTH);
    expect(p.data.properties.title.maxLength).toBe(MAX_TITLE_LENGTH);
    expect(p.data.properties.summary.maxLength).toBe(MAX_SUMMARY_LENGTH);
    expect(p.recipients.maxItems).toBe(MAX_REQUEST_RECIPIENTS);
    expect(p.version.const).toBe(NOTIFICATION_ENVELOPE_VERSION);
  });

  it("lists exactly the built-in event types", () => {
    expect([...schema.properties.type.enum].sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
    expect(NOTIFICATION_EVENT_TYPES).toHaveLength(12);
  });

  it("requires the same top-level fields the parser requires", () => {
    expect([...schema.required].sort()).toEqual(
      ["attempt_id", "data", "id", "occurred_at", "resource", "type", "version"],
    );
  });
});

describe("request bodies agree between parser and schema", () => {
  const long = (n: number) => "x".repeat(n);
  const manyRecipients = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ email: `user${i}@example.com` }));

  // [name, body, accepted by both parser and schema]
  const cases: Array<[string, unknown, boolean]> = [
    ["valid with recipients", valid(), true],
    ["valid with org admins only", mutate((b) => { delete b.recipients; b.include_org_admins = true; }), true],
    ["valid legacy recipient pair", mutate((b) => { delete b.recipients; b.recipient_subject = "sub-1"; b.recipient_email = "a@example.com"; }), true],
    ["valid without href", mutate((b) => { delete b.data.href; }), true],
    ["valid with unknown extra field", mutate((b) => { b.extra = { prompt: "x" }; }), true],
    ["valid at max id length", mutate((b) => { b.id = long(MAX_ID_LENGTH); }), true],
    ["valid at max recipients", mutate((b) => { b.recipients = manyRecipients(MAX_REQUEST_RECIPIENTS); }), true],
    ["wrong version", mutate((b) => { b.version = 2; }), false],
    ["unknown type", mutate((b) => { b.type = "example.unknown"; }), false],
    ["missing id", mutate((b) => { delete b.id; }), false],
    ["blank id", mutate((b) => { b.id = "   "; }), false],
    ["id too long", mutate((b) => { b.id = long(MAX_ID_LENGTH + 1); }), false],
    ["missing attempt_id", mutate((b) => { delete b.attempt_id; }), false],
    ["bad occurred_at", mutate((b) => { b.occurred_at = "not a date"; }), false],
    ["missing resource.id", mutate((b) => { delete b.resource.id; }), false],
    ["resource.type too long", mutate((b) => { b.resource.type = long(MAX_RESOURCE_TYPE_LENGTH + 1); }), false],
    ["title too long", mutate((b) => { b.data.title = long(MAX_TITLE_LENGTH + 1); }), false],
    ["summary too long", mutate((b) => { b.data.summary = long(MAX_SUMMARY_LENGTH + 1); }), false],
    ["status too long", mutate((b) => { b.data.status = long(MAX_STATUS_LENGTH + 1); }), false],
    ["absolute href", mutate((b) => { b.data.href = "https://example.com/x"; }), false],
    ["protocol-relative href", mutate((b) => { b.data.href = "//example.com/x"; }), false],
    ["href without leading slash", mutate((b) => { b.data.href = "knowledge-bases"; }), false],
    ["too many recipients", mutate((b) => { b.recipients = manyRecipients(MAX_REQUEST_RECIPIENTS + 1); }), false],
    ["recipient with neither field", mutate((b) => { b.recipients = [{}]; }), false],
    ["no audience", mutate((b) => { delete b.recipients; }), false],
    ["include_org_admins false and no recipients", mutate((b) => { delete b.recipients; b.include_org_admins = false; }), false],
    ["include_org_admins not boolean", mutate((b) => { b.include_org_admins = "yes"; }), false],
    ["body is an array", [], false],
  ];

  it.each(cases)("%s", (_name, body, accepted) => {
    expect(parseNotificationEventRequest(body).ok).toBe(accepted);
    expect(validate(schema, body)).toBe(accepted);
  });

  it("documents the one place the schema is stricter than the parser", () => {
    // The server silently omits an over-long correlation_id instead of rejecting it.
    const body = mutate((b) => { b.correlation_id = long(MAX_ID_LENGTH + 1); });
    expect(parseNotificationEventRequest(body).ok).toBe(true);
    expect(validate(schema, body)).toBe(false);
  });

  it("drops unknown fields when the envelope is built", () => {
    const parsed = parseNotificationEnvelope({
      ...(valid() as object),
      recipient_subject: "sub-1",
      recipient_email: "a@example.com",
      extra: "x",
      data: { ...valid().data, prompt: "x" },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope).not.toHaveProperty("extra");
      expect(parsed.envelope.data).not.toHaveProperty("prompt");
    }
  });
});
