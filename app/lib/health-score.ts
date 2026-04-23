/**
 * Prospect health score — a 0–100 composite that blends HubSpot CRM signals
 * with Ranger debrief history. The score is computed deterministically from
 * inputs we already have (no extra LLM calls, no extra API round-trips), so
 * it's cheap to call once per row in the "Active prospects" list.
 *
 * Design intent:
 *   - Heavier weight on recency (stale deals decay fast) and pipeline stage
 *     (late-stage open deals are hotter than early-stage ones).
 *   - Ranger debrief history is the *strongest* single input when it exists —
 *     the AE has concrete call evidence, not a CRM proxy.
 *   - Total is clamped [0,100] and mapped to the same 4-band taxonomy as
 *     `closeLikelihood.band` in debriefs, so the UI can re-use the band
 *     palette.
 *
 * A separate per-signal breakdown is returned so the UI can show the user
 * *why* a prospect scored the way it did (tooltip / expanded row).
 */

export type HealthBand = "cold" | "warm" | "hot" | "ready to close";

export interface HealthSignals {
  /** Pipeline position 0–1 (stage index / total stages). Null when unknown
   *  (e.g. portal doesn't expose pipeline to this token). */
  stageProgress?: number | null;
  /** ISO timestamp of the most-recent deal or company activity. */
  lastActivityAt?: string | null;
  /** Most recent Ranger debrief close score (0–100). Null when no debrief. */
  latestCloseScore?: number | null;
  /** 2nd-most-recent debrief close score — used to detect trend direction. */
  previousCloseScore?: number | null;
  /** Number of HubSpot engagements (calls/meetings/notes) in the last 30d.
   *  Proxy for "active sales motion"; caps at a small bonus. */
  engagementsLast30d?: number | null;
  /** Present + numeric deal amount signals "real deal", not just an MQL. */
  hasDealValue?: boolean;
  /** Present primary contact = discoverable decision path. */
  hasPrimaryContact?: boolean;
}

export interface HealthScore {
  score: number;
  band: HealthBand;
  /** Short one-liner rolling up the dominant signal. Shown in the list row
   *  tooltip so the AE understands the number without opening the detail. */
  rationale: string;
  /** Per-signal points so the UI can render a breakdown bar. Sums to
   *  `score` (after clamp, so individual figures may total slightly more). */
  breakdown: {
    stage: number;
    recency: number;
    debriefTrend: number;
    engagement: number;
    qualifiers: number;
  };
}

function bandFor(score: number): HealthBand {
  if (score >= 81) return "ready to close";
  if (score >= 56) return "hot";
  if (score >= 31) return "warm";
  return "cold";
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
}

/**
 * Compute the health score from a bag of signals. All signals are optional;
 * missing ones contribute 0 rather than penalizing (we'd rather a sparse
 * prospect score low than imply it's actively cold).
 */
export function computeHealthScore(signals: HealthSignals): HealthScore {
  // ── 1. Pipeline stage (0–25) ───────────────────────────────────────────
  // Linear scale: top of funnel ~0, bottom of open funnel ~25.
  const stage =
    signals.stageProgress != null
      ? Math.round(Math.max(0, Math.min(1, signals.stageProgress)) * 25)
      : 0;

  // ── 2. Activity recency (0–25) ──────────────────────────────────────────
  // Going-cold deals decay fast. >60d gets 0; ≤7d gets full weight.
  let recency = 0;
  const days = daysSince(signals.lastActivityAt);
  if (days != null) {
    if (days <= 7) recency = 25;
    else if (days <= 14) recency = 18;
    else if (days <= 30) recency = 10;
    else if (days <= 60) recency = 3;
    else recency = 0;
  }

  // ── 3. Debrief trend (0–35) ─────────────────────────────────────────────
  // Strongest single signal when present. Base = 35% of the most recent
  // close score; then ±5 for trend direction (rising vs falling).
  let debriefTrend = 0;
  if (signals.latestCloseScore != null) {
    debriefTrend = Math.round(signals.latestCloseScore * 0.35);
    if (signals.previousCloseScore != null) {
      const delta = signals.latestCloseScore - signals.previousCloseScore;
      if (delta >= 10) debriefTrend += 5;
      else if (delta <= -10) debriefTrend -= 5;
    }
  }
  debriefTrend = Math.max(0, Math.min(35, debriefTrend));

  // ── 4. Engagement volume (0–10) ────────────────────────────────────────
  // Real activity in the last month — capped low so a chatty rep can't
  // inflate a dead deal by logging more notes.
  let engagement = 0;
  const e = signals.engagementsLast30d ?? 0;
  if (e >= 5) engagement = 10;
  else if (e >= 2) engagement = 6;
  else if (e >= 1) engagement = 3;

  // ── 5. Basic qualifiers (0–5) ──────────────────────────────────────────
  // Tiny bonuses that collectively separate MQL shells from real deals.
  let qualifiers = 0;
  if (signals.hasDealValue) qualifiers += 3;
  if (signals.hasPrimaryContact) qualifiers += 2;

  const rawScore = stage + recency + debriefTrend + engagement + qualifiers;
  const score = Math.max(0, Math.min(100, rawScore));

  // ── Rationale ──────────────────────────────────────────────────────────
  // Pick the dominant contributor so the tooltip makes the score legible.
  let rationale: string;
  if (debriefTrend >= 25) {
    rationale = `Strong Ranger debrief score (${signals.latestCloseScore}/100)`;
  } else if (recency === 0 && days != null && days > 60) {
    rationale = `No activity in ${days} days — deal likely stalling`;
  } else if (recency >= 20 && stage >= 15) {
    rationale = "Late-stage with recent activity";
  } else if (recency >= 20) {
    rationale = "Very recent activity";
  } else if (stage >= 20) {
    rationale = "Late-stage deal";
  } else if (debriefTrend > 0 && signals.latestCloseScore != null) {
    rationale = `Ranger debrief: ${signals.latestCloseScore}/100 last call`;
  } else if (engagement >= 6) {
    rationale = "High engagement volume";
  } else {
    rationale = "Limited signal — early-stage or stale";
  }

  return {
    score,
    band: bandFor(score),
    rationale,
    breakdown: { stage, recency, debriefTrend, engagement, qualifiers },
  };
}
