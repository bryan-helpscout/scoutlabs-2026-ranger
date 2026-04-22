import { NextRequest } from "next/server";
import { lookupProspect } from "@/app/lib/hubspot";
import { getProspectBriefing } from "@/app/lib/briefing";

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

  // Briefing is attached regardless of HubSpot outcome — a prospect can
  // have past debriefs even if HubSpot has no record (e.g. after a
  // company-name change or a fresh lead that hasn't been CRM'd yet).
  return Response.json({ ...data, briefing });
}
