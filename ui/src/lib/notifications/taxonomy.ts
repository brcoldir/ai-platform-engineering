import type { InAppNotificationSeverity } from "@/types/in-app-notification";

// Built-in notification events. These are the seed entries of the registry in
// `registry.ts`, which is the source of truth at runtime. Installed apps add
// their own entries there, so event types and categories are plain strings.
// This file stays free of server imports so the UI can use it for fallback copy.
export type NotificationCategory = string;
export type NotificationEventType = string;

export const BUILTIN_NOTIFICATION_CATEGORIES = [
  "workflow",
  "ingestion",
  "agent",
  "platform",
] as const;

export type BuiltinNotificationCategory = (typeof BUILTIN_NOTIFICATION_CATEGORIES)[number];

export const BUILTIN_NOTIFICATION_EVENT_TYPES = [
  "ingestion.completed",
  "ingestion.failed",
  "ingestion.started",
  "workflow.completed",
  "workflow.failed",
  "workflow.requires_input",
  "workflow.started",
  "agent.completed",
  "agent.failed",
  "agent.started",
  "service.degraded",
  "service.recovered",
] as const;

export type BuiltinNotificationEventType = (typeof BUILTIN_NOTIFICATION_EVENT_TYPES)[number];

/**
 * Event types stored once for a whole audience instead of once per person. Only
 * the platform health audit produces them, so apps cannot opt in.
 */
export const BUILTIN_SHARED_INBOX_EVENT_TYPES: readonly BuiltinNotificationEventType[] = [
  "service.degraded",
  "service.recovered",
];

/** Event-type prefixes owned by built-in producers. An app cannot use them as its namespace. */
export const BUILTIN_NOTIFICATION_NAMESPACES = ["ingestion", "workflow", "agent", "service"] as const;

export interface BuiltinCategorySeed {
  id: BuiltinNotificationCategory;
  label: string;
  description: string;
}

export interface BuiltinEventSeed {
  type: BuiltinNotificationEventType;
  category: BuiltinNotificationCategory;
  label: string;
  description: string;
  /** Whether a user who has set no preference receives this event. */
  defaultEnabled: boolean;
  severity: InAppNotificationSeverity;
}

export const BUILTIN_CATEGORY_SEEDS: readonly BuiltinCategorySeed[] = [
  { id: "workflow", label: "Workflows", description: "Workflow runs you start or own." },
  { id: "ingestion", label: "Knowledge ingestion", description: "Sources you add to a knowledge base." },
  { id: "agent", label: "Agent tasks", description: "Scheduled and background agent tasks you own." },
  { id: "platform", label: "Platform", description: "Service health changes that affect the platform." },
];

export const BUILTIN_EVENT_SEEDS: readonly BuiltinEventSeed[] = [
  { type: "ingestion.completed", category: "ingestion", label: "Ingestion finished", description: "A source finished indexing.", defaultEnabled: true, severity: "success" },
  { type: "ingestion.failed", category: "ingestion", label: "Ingestion failed", description: "A source could not be indexed.", defaultEnabled: true, severity: "error" },
  { type: "ingestion.started", category: "ingestion", label: "Ingestion started", description: "A source began indexing.", defaultEnabled: false, severity: "info" },
  { type: "workflow.completed", category: "workflow", label: "Workflow completed", description: "A workflow run finished successfully.", defaultEnabled: true, severity: "success" },
  { type: "workflow.failed", category: "workflow", label: "Workflow failed", description: "A workflow run stopped with an error.", defaultEnabled: true, severity: "error" },
  { type: "workflow.requires_input", category: "workflow", label: "Workflow needs input", description: "A workflow is waiting for your answer.", defaultEnabled: true, severity: "warning" },
  { type: "workflow.started", category: "workflow", label: "Workflow started", description: "A workflow run began.", defaultEnabled: false, severity: "info" },
  { type: "agent.completed", category: "agent", label: "Agent task completed", description: "A background agent task finished.", defaultEnabled: true, severity: "success" },
  { type: "agent.failed", category: "agent", label: "Agent task failed", description: "A background agent task failed.", defaultEnabled: true, severity: "error" },
  { type: "agent.started", category: "agent", label: "Agent task started", description: "A background agent task began.", defaultEnabled: false, severity: "info" },
  { type: "service.degraded", category: "platform", label: "Service degraded", description: "A service is no longer healthy.", defaultEnabled: true, severity: "warning" },
  { type: "service.recovered", category: "platform", label: "Service recovered", description: "A degraded service is healthy again.", defaultEnabled: true, severity: "success" },
];
