"use client";

import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { fallbackCategoryCopy } from "@/lib/notifications/display";
import { cn } from "@/lib/utils";
import { BellRing, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/** A category id. Built-in pages use workflow, ingestion, and agent. An app category works too. */
export type NotificationArea = string;

// The events a built-in page-level toggle controls. These are the completion
// and failure style events people care about on that page. Started events are
// left to the full settings page. Any other category toggles all of its events.
// Writes go to the same stored preference as Settings, so the two always agree.
const BUILTIN_AREA_EVENTS: Record<string, string[]> = {
  workflow: ["workflow.completed", "workflow.failed", "workflow.requires_input"],
  ingestion: ["ingestion.completed", "ingestion.failed"],
  agent: ["agent.completed", "agent.failed"],
};

// Used when the API sends no category details, so older responses still render.
const FALLBACK_LABELS: Record<string, string> = {
  workflow: "Notify me about workflows",
  ingestion: "Notify me about ingestion",
  agent: "Notify me about agent runs",
};

interface EventRow {
  type: string;
  category?: string;
  enabled: boolean;
}

interface CategoryDetail {
  id: string;
  label?: string;
  description?: string;
}

interface Props {
  area: NotificationArea;
  className?: string;
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export function AreaNotificationToggle({ area, className }: Props): React.ReactElement {
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [details, setDetails] = useState<CategoryDetail[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Serialize writes so a slow response cannot overwrite a newer choice.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const apply = useCallback((data: unknown): boolean => {
    const view = data as { events?: EventRow[]; categoryDetails?: CategoryDetail[] } | null;
    if (!Array.isArray(view?.events)) return false;
    setRows(view.events);
    if (Array.isArray(view.categoryDetails)) setDetails(view.categoryDetails);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/notification-preferences")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Could not load notification settings");
        if (!cancelled && !apply(body.data)) throw new Error("Unexpected response");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: reason instanceof Error ? reason.message : "Could not load notification settings",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const areaEvents =
    BUILTIN_AREA_EVENTS[area] ?? (rows ?? []).filter((row) => row.category === area).map((row) => row.type);
  const detail = details.find((candidate) => candidate.id === area);
  const fallback = fallbackCategoryCopy(area);
  const copy = {
    events: areaEvents,
    label: detail?.label
      ? `Notify me about ${detail.label.toLowerCase()}`
      : (FALLBACK_LABELS[area] ?? `Notify me about ${fallback.label.toLowerCase()}`),
    description: detail?.description || fallback.description,
  };
  const enabled = rows !== null && copy.events.length > 0 && copy.events.every((type) => rows.find((row) => row.type === type)?.enabled === true);

  const change = (value: boolean): void => {
    setStatus({ kind: "saving" });
    const patch = { events: Object.fromEntries(copy.events.map((type) => [type, value])) };
    queueRef.current = queueRef.current.then(async () => {
      try {
        const response = await fetch("/api/settings/notification-preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Could not save this change");
        if (!apply(body.data)) throw new Error("Unexpected response");
        setStatus({ kind: "saved" });
      } catch (reason: unknown) {
        setStatus({
          kind: "error",
          message: reason instanceof Error ? reason.message : "Could not save this change",
        });
      }
    });
  };

  // A category with no events, such as an app that was uninstalled, has nothing to toggle.
  if (rows !== null && copy.events.length === 0) return <></>;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-sm", className)} data-testid={`area-notification-${area}`}>
      <BellRing aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="font-medium" title={copy.description}>{copy.label}</span>
      {rows === null && status.kind !== "error" ? (
        <Loader2 aria-label="Loading" className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <SettingsSwitch
          checked={enabled}
          disabled={rows === null || status.kind === "saving"}
          label={copy.label}
          onCheckedChange={change}
          testId={`area-notification-${area}-toggle`}
        />
      )}
      <span aria-live="polite" className={cn("text-xs", status.kind === "error" ? "text-destructive" : "text-muted-foreground")} role="status">
        {status.kind === "saving" ? "Saving…" : null}
        {status.kind === "saved" ? "Saved" : null}
        {status.kind === "error" ? status.message : null}
      </span>
      <Link
        className="rounded-sm text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href="/settings/notifications"
      >
        All notification settings
      </Link>
    </div>
  );
}
