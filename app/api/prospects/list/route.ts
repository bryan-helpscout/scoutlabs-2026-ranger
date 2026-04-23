/**
 * GET /api/prospects/list
 *
 * Returns the "Active prospects" list that populates the sidebar above the
 * manual prospect-lookup search. Each entry is a HubSpot open-deal row
 * enriched with:
 *   - a locally-computed health score (0–100) + band, and
 *   - the latest Ranger debrief's close score for trend context (when any
 *     debriefs exist for that prospect).
 *
 * The request is cheap-ish: ~1 deals search + N * 2 association lookups
 * (capped at 8 rows by default), plus one debrief query per row. Everything
 * fans out in parallel.
 */

import { NextRequest } from "next/server";
import { listActiveProspects, type ActiveProspect } from "@/app/lib/hubspot";
import { getProspectBriefing } from "@/app/lib/briefing";
import {
  computeHealthScore,
  type HealthBand,
  type HealthEvidence,
} from "@/app/lib/health-score";

export const maxDuration = 30;

export interface ActiveProspectListItem extends ActiveProspect {
  healthScore: number;
  healthBand: HealthBand;
  healthRationale: string;
  healthEvidence: HealthEvidence;
  /** Ranger debrief count — lets the UI badge "3 prior calls" inline. */
  callCount: number;
  /** Latest debrief close score, for the mini-trend sparkline. */
  latestCloseScore?: number | null;
}

export async function GET(req: NextRequest) {
  // Default: sort by health score DESC so the AE's best-bet deals float up.
  // `?sort=recency` overrides to sort by most-recent-activity — handy when
  // the AE wants a "what moved today" view instead of "what should I work."
  const sortParam = req.nextUrl.searchParams.get("sort");
  const sortMode: "health" | "recency" = sortParam === "recency" ? "recency" : "health";

  // Fetch a wide window of open deals (default 20). "Active" = any deal
  // whose stage isn't closed-won or closed-lost — the canonical definition
  // of "we're talking with them but haven't closed yet." Over-fetch a bit
  // so the health-score sort has enough candidates to rank properly.
  const prospects = await listActiveProspects(20);
  if (prospects.length === 0) {
    return Response.json({ prospects: [] });
  }

  // Pull the Ranger debrief briefing for each prospect in parallel. The
  // briefing lookup is cheap (BigQuery or local JSONL) and lets us factor
  // recent close scores into the health calc.
  const enriched = await Promise.all(
    prospects.map(async (p): Promise<ActiveProspectListItem> => {
      const briefing = await getProspectBriefing(p.companyName).catch(
        () => null
      );
      const latest = briefing?.closeScoreHistory?.[0]?.score ?? null;
      const previous = briefing?.closeScoreHistory?.[1]?.score ?? null;

      const health = computeHealthScore({
        stageProgress: p.stageProgress,
        lastActivityAt: p.lastActivityAt,
        latestCloseScore: latest,
        previousCloseScore: previous,
        hasDealValue: p.dealAmount != null,
        hasPrimaryContact: !!p.contactName,
        // We don't fetch engagement counts here — one extra round-trip per
        // row would nearly double the request time. The debrief count +
        // activity recency already approximate this signal.
        engagementsLast30d: null,
        // Debrief-derived colour for the "why this score" panel.
        lastCallTone: briefing?.lastCallTone ?? null,
        lastCallSignals: briefing?.lastCallSignals ?? [],
        lastCallSummary: briefing?.lastCallSummary ?? null,
        lastCallPains: briefing?.nextCallPrep?.painPoints ?? [],
        lastCallRisks: briefing?.lastCallRisks ?? [],
        lastCallOpenQuestions: briefing?.recentOpenQuestions ?? [],
      });

      return {
        ...p,
        healthScore: health.score,
        healthBand: health.band,
        healthRationale: health.rationale,
        healthEvidence: health.evidence,
        callCount: briefing?.callCount ?? 0,
        latestCloseScore: latest,
      };
    })
  );

  if (sortMode === "health") {
    // Primary sort by health DESC; tie-break by recency DESC so two 70s
    // land in a sensible order.
    enriched.sort((a, b) => {
      if (b.healthScore !== a.healthScore) return b.healthScore - a.healthScore;
      const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bt - at;
    });
  } else {
    // Recency mode — what moved most recently, regardless of score.
    enriched.sort((a, b) => {
      const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bt - at;
    });
  }

  return Response.json({ prospects: enriched, sort: sortMode });
}
