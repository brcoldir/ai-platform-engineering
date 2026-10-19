import { BUILTIN_CATEGORY_SEEDS, BUILTIN_EVENT_SEEDS } from "@/lib/notifications/taxonomy";

// Fallback copy for the settings UI. The registry's display fields win when the
// API sends them. This only fills a gap, such as an older server response.

function humanize(identifier: string): string {
  const spaced = identifier.replace(/[._-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : identifier;
}

export function fallbackCategoryCopy(id: string): { label: string; description: string } {
  const seed = BUILTIN_CATEGORY_SEEDS.find((candidate) => candidate.id === id);
  return seed ? { label: seed.label, description: seed.description } : { label: humanize(id), description: "" };
}

export function fallbackEventCopy(type: string): { label: string; description: string } {
  const seed = BUILTIN_EVENT_SEEDS.find((candidate) => candidate.type === type);
  return seed ? { label: seed.label, description: seed.description } : { label: humanize(type), description: "" };
}
