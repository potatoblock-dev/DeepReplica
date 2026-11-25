import { idbRequest, openDb } from "../db/openDb";

export type UsageEvent = {
  id: string;
  createdAt: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated CNY cost for this call (local estimate, not platform bill). */
  estimatedCostCny: number;
};

export type UsageRange = "today" | "7d" | "30d";

export type UsageBucket = {
  /** Bucket start timestamp (ms). */
  start: number;
  label: string;
  requests: number;
  tokens: number;
  costCny: number;
};

export type UsageAggregate = {
  range: UsageRange;
  requests: number;
  tokens: number;
  costCny: number;
  buckets: UsageBucket[];
};

/** Rough deepseek-flash list prices (CNY / 1M tokens) for local estimates only. */
const PRICE_PROMPT_PER_M = 0.14;
const PRICE_COMPLETION_PER_M = 0.28;

/** Estimates CNY cost from token counts using published-style unit prices. */
export function estimateCostCny(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1_000_000) * PRICE_PROMPT_PER_M +
    (completionTokens / 1_000_000) * PRICE_COMPLETION_PER_M
  );
}

/** Appends one completed API call to the local usage ledger. */
export async function recordUsage(input: {
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}): Promise<UsageEvent> {
  const promptTokens = Math.max(0, Math.floor(input.promptTokens));
  const completionTokens = Math.max(0, Math.floor(input.completionTokens));
  const totalTokens =
    typeof input.totalTokens === "number"
      ? Math.max(0, Math.floor(input.totalTokens))
      : promptTokens + completionTokens;
  const event: UsageEvent = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    model: input.model?.trim() || "deepseek-flash",
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostCny: estimateCostCny(promptTokens, completionTokens),
  };
  const db = await openDb();
  await idbRequest(db.transaction("usage", "readwrite").objectStore("usage").put(event));
  return event;
}

/** Returns the inclusive start ms for a usage range in local timezone. */
export function rangeStartMs(range: UsageRange, now = Date.now()): number {
  const d = new Date(now);
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === "today") {
    return startToday;
  }
  if (range === "7d") {
    return startToday - 6 * 86_400_000;
  }
  return startToday - 29 * 86_400_000;
}

/** Loads all usage events at or after `since` (ms). */
async function listUsageSince(since: number): Promise<UsageEvent[]> {
  const db = await openDb();
  const all = (await idbRequest(
    db.transaction("usage", "readonly").objectStore("usage").getAll(),
  )) as UsageEvent[];
  return all.filter((e) => e.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
}

/** Builds empty hour buckets for "today". */
function hourBuckets(dayStart: number): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  for (let h = 0; h < 24; h += 1) {
    const start = dayStart + h * 3_600_000;
    buckets.push({
      start,
      label: `${String(h).padStart(2, "0")}:00`,
      requests: 0,
      tokens: 0,
      costCny: 0,
    });
  }
  return buckets;
}

/** Builds empty day buckets from rangeStart through today (inclusive). */
function dayBuckets(rangeStart: number, now: number): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const d = new Date(now);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  for (let t = rangeStart; t <= todayStart; t += 86_400_000) {
    const dt = new Date(t);
    buckets.push({
      start: t,
      label: `${dt.getMonth() + 1}/${dt.getDate()}`,
      requests: 0,
      tokens: 0,
      costCny: 0,
    });
  }
  return buckets;
}

/** Aggregates local usage for the selected time range into summary + chart buckets. */
export async function aggregateUsage(range: UsageRange, now = Date.now()): Promise<UsageAggregate> {
  const since = rangeStartMs(range, now);
  const events = await listUsageSince(since);
  const dayStart = new Date(
    new Date(now).getFullYear(),
    new Date(now).getMonth(),
    new Date(now).getDate(),
  ).getTime();
  const buckets =
    range === "today" ? hourBuckets(dayStart) : dayBuckets(since, now);

  let requests = 0;
  let tokens = 0;
  let costCny = 0;
  for (const event of events) {
    requests += 1;
    tokens += event.totalTokens;
    costCny += event.estimatedCostCny;
    if (range === "today") {
      const hour = new Date(event.createdAt).getHours();
      const bucket = buckets[hour];
      if (bucket) {
        bucket.requests += 1;
        bucket.tokens += event.totalTokens;
        bucket.costCny += event.estimatedCostCny;
      }
    } else {
      const eventDay = new Date(event.createdAt);
      const eventDayStart = new Date(
        eventDay.getFullYear(),
        eventDay.getMonth(),
        eventDay.getDate(),
      ).getTime();
      const bucket = buckets.find((b) => b.start === eventDayStart);
      if (bucket) {
        bucket.requests += 1;
        bucket.tokens += event.totalTokens;
        bucket.costCny += event.estimatedCostCny;
      }
    }
  }

  return { range, requests, tokens, costCny, buckets };
}
