import { NextRequest } from "next/server";
import { lookupProspect } from "@/app/lib/hubspot";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { name } = await req.json();
  if (!name?.trim()) {
    return Response.json({ found: false });
  }

  // Direct HubSpot REST call — no Claude round-trip needed for a basic lookup.
  // Returns the exact shape the UI's ProspectData interface expects.
  const data = await lookupProspect(name);
  return Response.json(data);
}
