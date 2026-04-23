import { NextRequest } from "next/server";
import { lookupProspect, getLastCallForCompany } from "@/app/lib/hubspot";
import { getProspectBriefing } from "@/app/lib/briefing";
import {
  computeHealthScore,
  type HealthBand,
  type HealthEvidence,
} from "@/app/lib/health-score";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { name } = await req.json();
  if (!name?.trim()) {
    return Response.json({ found: false });
  }

  // HubSpot card + pre-read briefing in parallel. The briefing reads from
  // BigQuery if configured, otherwise from the local JSONL fallback; both
  // are fast (< 500ms typically), so they piggyback on one round-trip.
  const [data, briefing] = await Promise.all([
    lookupProspect(name),
    getProspectBriefing(name),
  ]);

  // Once we've resolved a company ID, grab the latest HubSpot-logged call
  // or meeting engagement. This gives the pre-read something to show on
  // day one — before Ranger has generated any of its own debriefs.
  const hubspotLastCall = data.companyId
    ? await getLastCallForCompany(data.companyId).catch(() => null)
    : null;

  // Compute the same health score we surface in the list so the detail
  // view is consistent with whatever got the rep to click through.
  const latestCloseScore = briefing.closeScoreHistory?.[0]?.score ?? null;
  const previousCloseScore = briefing.closeScoreHistory?.[1]?.score ?? null;

  let health: {
    score: number;
    band: HealthBand;
    rationale: string;
    evidence: HealthEvidence;
  } | null = null;
  if (data.found) {
    const h = computeHealthScore({
      // stageProgress not returned by lookupProspect (single-lookup path
      // skips the pipeline join). That's fine — the health score still
      // works, it just gets 0 from the stage component.
      stageProgress: null,
      lastActivityAt: data.lastActivityAt,
      latestCloseScore,
      previousCloseScore,
      hasDealValue: data.dealAmount != null,
      hasPrimaryContact: !!data.contactName,
      engagementsLast30d: null,
      // Rich evidence from the latest debrief — powers the "Why this
      // score" panel in the detail card.
      lastCallTone: briefing.lastCallTone,
      lastCallSignals: briefing.lastCallSignals ?? [],
      lastCallSummary: briefing.lastCallSummary,
      lastCallPains: briefing.nextCallPrep?.painPoints ?? [],
      lastCallRisks: briefing.lastCallRisks ?? [],
      lastCallOpenQuestions: briefing.recentOpenQuestions ?? [],
    });
    health = {
      score: h.score,
      band: h.band,
      rationale: h.rationale,
      evidence: h.evidence,
    };
  }

  // Briefing is attached regardless of HubSpot outcome — a prospect can
  // have past debriefs even if HubSpot has no record (e.g. after a
  // company-name change or a fresh lead that hasn't been CRM'd yet).
  return Response.json({
    ...data,
    briefing: { ...briefing, hubspotLastCall },
    health,
  });
}
