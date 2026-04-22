/**
 * Fast-path competitor-name detection in raw text. Used by the triage loop
 * (transcript chunks) and the chat route (user messages) to know which
 * battle card to surface/inject.
 *
 * Case-insensitive word-boundary match against each competitor's name +
 * aliases. Intentionally simple — if the transcript says "the one with the
 * orange logo" we miss it, but Haiku triage also gets a separate signal
 * (competitor_slug in its JSON output) that can catch fuzzy mentions.
 */

import { COMPETITORS } from "./config";

const patterns: Array<{ slug: string; regex: RegExp }> = COMPETITORS.flatMap((c) => {
  const terms = [c.name, ...c.aliases];
  return terms.map((term) => ({
    slug: c.slug,
    // \b doesn't play well with some punctuation/unicode — use a loose
    // boundary: start or non-word char on each side.
    regex: new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}($|[^a-z0-9])`, "i"),
  }));
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the first competitor slug mentioned in the text, or null. */
export function detectCompetitorSlug(text: string): string | null {
  if (!text) return null;
  for (const { slug, regex } of patterns) {
    if (regex.test(text)) return slug;
  }
  return null;
}

/** Returns every distinct competitor slug mentioned in the text (preserves order). */
export function detectAllCompetitorSlugs(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { slug, regex } of patterns) {
    if (!seen.has(slug) && regex.test(text)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}
