/**
 * Reddit-signal artifact: structured "why people are switching from <X>"
 * intel, distilled from the #z-reddigent Slack channel's bot alerts.
 *
 * Produced by scripts/refresh-reddit-signals.ts (daily). Consumed at
 * chat-request time (system-prompt injection on competitor mention) and at
 * triage time (live-panel card surfacing on competitor mention in transcript).
 */

export interface RedditSignal {
  /** Stable ID — the Reddit thread URL. Used as card ID to dedup. */
  postUrl: string;
  /** Bot's relevance score, e.g. "8/10". */
  score: string;
  /** "high" | "medium" | "low" | "unknown". */
  urgency: string;
  /**
   * The synthesized one-liner from the reddigent bot explaining why this
   * post is relevant. The highest-signal field — this is what the AE actually
   * needs to see.
   */
  reason: string;
  /** ISO — when the reddigent bot posted this in Slack (Reddit-thread freshness proxy). */
  capturedAt: string;
}

export interface RedditSignalsForCompetitor {
  /** Competitor slug from COMPETITORS in app/lib/competitors/config.ts. */
  competitor: string;
  /** Human-readable name for UI/prompt rendering. */
  competitorName: string;
  /** 10–20 most recent signals, newest first. */
  signals: RedditSignal[];
  /**
   * 3–5 short themes synthesized across all signals — e.g. "pricing
   * transparency complaints", "AI feature gaps". Gives chat/UI something
   * compact to surface when there isn't room for individual signals.
   */
  topPatterns: string[];
  /** ISO. */
  updatedAt: string;
}
