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
} from "@/app/lib/health-score";

export const maxDuration = 30;

export interface ActiveProspectListItem extends ActiveProspect {
  healthScore: number;
  healthBand: HealthBand;
  healthRationale: string;
  /** Ranger debrief count — lets the UI badge "3 prior calls" inline. */
  callCount: number;
  /** Latest debrief close score, for the mini-trend sparkline. */
  latestCloseScore?: number | null;
}

export async function GET(_req: NextRequest) {
  // HubSpot active deals first — everything else hangs off them.
  const prospects = await listActiveProspects(8);
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
      });

      return {
        ...p,
        healthScore: health.score,
        healthBand: health.band,
        healthRationale: health.rationale,
        callCount: briefing?.callCount ?? 0,
        latestCloseScore: latest,
      };
    })
  );

  // Sort by health score DESC so the AE's best-bet deals float to the top.
  // Ties break on recency (already the default from listActiveProspects).
  enriched.sort((a, b) => b.healthScore - a.healthScore);

  return Response.json({ prospects: enriched });
}
