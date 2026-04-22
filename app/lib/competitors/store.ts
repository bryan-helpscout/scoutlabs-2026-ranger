/**
 * Runtime loader for committed battle-card JSON files. Reads from
 * data/competitors/<slug>.json on disk with a 60s per-slug cache so the
 * triage loop doesn't re-read the same file every 2s, but new data from
 * the refresh script gets picked up without a server restart.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { COMPETITORS } from "./config";
import type { CompetitorCard } from "./schema";

interface CacheEntry {
  card: CompetitorCard | null; // null = known-missing, still cache so we don't pound the disk
  readAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function dataPath(slug: string): string {
  return resolve(process.cwd(), "data", "competitors", `${slug}.json`);
}

export function getCompetitorCard(slug: string): CompetitorCard | null {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && now - hit.readAt < TTL_MS) return hit.card;

  try {
    const raw = readFileSync(dataPath(slug), "utf8");
    const card = JSON.parse(raw) as CompetitorCard;
    cache.set(slug, { card, readAt: now });
    return card;
  } catch {
    cache.set(slug, { card: null, readAt: now });
    return null;
  }
}

export function listAvailableCompetitorCards(): CompetitorCard[] {
  return COMPETITORS.map((c) => getCompetitorCard(c.slug)).filter(
    (x): x is CompetitorCard => x !== null
  );
}

/**
 * Format a battle card as a tight block for injection into the chat system
 * prompt. Optimized for signal density — the AE needs to be able to relay
 * these points verbatim.
 */
export function formatCardForPrompt(card: CompetitorCard): string {
  const lines: string[] = [
    `Positioning: ${card.positioning}`,
  ];
  if (card.pricing.startingAt) {
    lines.push(
      `Their pricing: starting at ${card.pricing.startingAt}` +
        (card.pricing.notes ? ` (${card.pricing.notes})` : "")
    );
  }
  if (card.keyStrengths.length) {
    lines.push(`What they're genuinely good at: ${card.keyStrengths.join("; ")}`);
  }
  if (card.ourAdvantages.length) {
    lines.push(`Help Scout advantages: ${card.ourAdvantages.join("; ")}`);
  }
  if (card.pivots.length) {
    lines.push(`Talk-track pivots: ${card.pivots.join(" / ")}`);
  }
  if (card.landmines.length) {
    lines.push(`Watch out for: ${card.landmines.join("; ")}`);
  }
  return lines.join("\n");
}
