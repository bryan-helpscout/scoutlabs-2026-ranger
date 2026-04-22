/**
 * Runtime loader for Reddit-signal artifacts. Read data/reddit-signals/<slug>.json
 * with a 60s TTL cache so the triage loop and chat route don't re-read the
 * same file on every hit, but daily refreshes pick up without a restart.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import type { RedditSignal, RedditSignalsForCompetitor } from "./schema";

interface CacheEntry {
  data: RedditSignalsForCompetitor | null;
  readAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function dataPath(slug: string): string {
  return resolve(process.cwd(), "data", "reddit-signals", `${slug}.json`);
}

export function getRedditSignals(slug: string): RedditSignalsForCompetitor | null {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && now - hit.readAt < TTL_MS) return hit.data;
  try {
    const raw = readFileSync(dataPath(slug), "utf8");
    const data = JSON.parse(raw) as RedditSignalsForCompetitor;
    cache.set(slug, { data, readAt: now });
    return data;
  } catch {
    cache.set(slug, { data: null, readAt: now });
    return null;
  }
}

/**
 * Pick the N most-actionable signals for quick surfacing (live-panel cards).
 * Ranking: most recent AND higher urgency beats older lower-urgency. We
 * already store `signals` in newest-first order, so urgency is the tiebreaker.
 */
export function topSignals(
  data: RedditSignalsForCompetitor,
  n = 2
): RedditSignal[] {
  const urgencyRank: Record<string, number> = { high: 3, medium: 2, low: 1, unknown: 0 };
  return [...data.signals]
    .slice(0, 10) // only consider recent ones
    .sort((a, b) => {
      const ur = (urgencyRank[b.urgency.toLowerCase()] ?? 0) -
        (urgencyRank[a.urgency.toLowerCase()] ?? 0);
      if (ur !== 0) return ur;
      // same urgency → newer first (capturedAt is ISO so string compare works)
      return b.capturedAt.localeCompare(a.capturedAt);
    })
    .slice(0, n);
}

/**
 * Format signals as a compact block for the chat system prompt. Gives the
 * model access to specific thread URLs + reasons when a competitor is
 * mentioned in the user's message.
 */
export function formatSignalsForPrompt(data: RedditSignalsForCompetitor): string {
  const L: string[] = [];
  L.push(
    `RECENT REDDIT SIGNALS — ${data.competitorName} (${data.signals.length} threads; refreshed ${data.updatedAt.slice(0, 10)}):`
  );
  if (data.topPatterns.length) {
    L.push(`Patterns: ${data.topPatterns.join("; ")}`);
  }
  L.push("");
  for (const s of data.signals.slice(0, 8)) {
    L.push(`- [${s.urgency}, ${s.score}] ${s.reason}${s.postUrl ? ` (${s.postUrl})` : ""}`);
  }
  L.push("");
  L.push(
    "When relevant, cite these as 'users on Reddit are reporting X' patterns — do NOT link to individual threads in AE-facing replies unless explicitly asked."
  );
  return L.join("\n");
}
