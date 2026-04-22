/**
 * Battle-card schema. Produced by the refresh script, consumed by the
 * runtime (triage, chat route, UI). Shape is stable and committed to git
 * under data/competitors/<slug>.json so changes are reviewable.
 */

export interface CompetitorSource {
  url: string;
  kind: "homepage" | "pricing" | "features" | "compare" | "slab" | "slack";
  fetchedAt: string; // ISO
}

export interface CompetitorPricing {
  startingAt?: string | null; // e.g. "$55/agent/mo" or null if not found
  notes?: string | null;
}

export interface CompetitorCard {
  slug: string;
  name: string;
  /** One-sentence summary of how HS positions vs this competitor. */
  positioning: string;
  pricing: CompetitorPricing;
  /** 2–4 things they are GENUINELY better at — honesty keeps AE credible. */
  keyStrengths: string[];
  /** 3–6 concrete reasons HS wins, with numbers/features when possible. */
  ourAdvantages: string[];
  /** 2–4 prospect signals that suggest HS loses this deal. */
  landmines: string[];
  /** 2–4 "if they say X, say Y" sales plays. */
  pivots: string[];
  sources: CompetitorSource[];
  updatedAt: string; // ISO
}
