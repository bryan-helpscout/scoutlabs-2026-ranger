/**
 * POST /api/meeting/debrief
 *
 * Body: { meetingId: string, prospectName?: string | null }
 * Returns: MeetingDebrief JSON
 *
 * The debrief is returned synchronously (~5-10s for Sonnet). The BigQuery
 * persistence is fire-and-forget via Next's after() — if BQ is down or
 * misconfigured, the AE still gets their debrief immediately.
 */

import { NextRequest } from "next/server";
import { after } from "next/server";
import { generateDebrief } from "@/app/lib/debrief/generate";
import { persistDebrief } from "@/app/lib/debrief-persist";

export const maxDuration = 60;

interface DebriefRequestBody {
  meetingId?: string;
  prospectName?: string | null;
  /** Client-buffered transcript chunks. The browser keeps a copy of every
   *  chunk it POSTed to /api/transcript/ingest so the debrief works on
   *  serverless platforms where the in-memory store doesn't survive across
   *  function invocations. Safe to omit on long-running hosts — the route
   *  falls back to the server-side store in that case. */
  transcriptChunks?: Array<{
    speaker: string;
    text: string;
    timestamp?: number;
  }>;
}

export async function POST(req: NextRequest) {
  let body: DebriefRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.meetingId || typeof body.meetingId !== "string") {
    return Response.json({ error: "meetingId is required" }, { status: 400 });
  }

  try {
    const debrief = await generateDebrief(body.meetingId, {
      prospectName: body.prospectName ?? null,
      clientChunks: body.transcriptChunks,
    });

    // Persist to BOTH local JSONL (for pre-read brief history in dev) AND
    // BigQuery (if configured) after the response goes out. No-op on
    // serverless for the local path; failure-logged but never surfaces.
    after(async () => {
      await persistDebrief(debrief, { prospectName: body.prospectName ?? null });
    });

    return Response.json(debrief);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.startsWith("No transcript") ? 404 : 500;
    console.error("[debrief] generate failed:", err);
    return Response.json({ error: message }, { status });
  }
}
