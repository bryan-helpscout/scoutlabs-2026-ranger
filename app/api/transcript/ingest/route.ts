/**
 * Source-agnostic transcript ingest webhook.
 *
 * POST body (single chunk):
 *   { meetingId: string, speaker?: string, text: string, timestamp?: number }
 *
 * POST body (batch):
 *   { meetingId: string, chunks: Array<{ speaker?, text, timestamp? }> }
 *
 * Whatever provides the transcript (Zoom RTMS adapter, Fireflies webhook,
 * local Whisper loop, curl in tests) posts here. We append, emit to SSE
 * subscribers, and coalesce a triage run in the background.
 */

import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { appendTranscriptChunk, TranscriptChunk } from "@/app/lib/transcript-store";
import { maybeRunTriage } from "@/app/lib/triage";

export const runtime = "nodejs"; // need long-lived module state + EventEmitter

interface IngestSingle {
  meetingId: string;
  speaker?: string;
  text: string;
  timestamp?: number;
}
interface IngestBatch {
  meetingId: string;
  chunks: Array<{ speaker?: string; text: string; timestamp?: number }>;
}

export async function POST(req: NextRequest) {
  let body: IngestSingle | IngestBatch;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.meetingId || typeof body.meetingId !== "string") {
    return Response.json({ error: "meetingId is required" }, { status: 400 });
  }

  const incoming: Array<{ speaker?: string; text: string; timestamp?: number }> =
    "chunks" in body && Array.isArray((body as IngestBatch).chunks)
      ? (body as IngestBatch).chunks
      : [
          {
            speaker: (body as IngestSingle).speaker,
            text: (body as IngestSingle).text,
            timestamp: (body as IngestSingle).timestamp,
          },
        ];

  const accepted: TranscriptChunk[] = [];
  for (const c of incoming) {
    if (!c || typeof c.text !== "string" || !c.text.trim()) continue;
    const chunk: TranscriptChunk = {
      id: randomUUID(),
      meetingId: body.meetingId,
      speaker: (c.speaker as string) || "unknown",
      text: c.text.trim(),
      timestamp: typeof c.timestamp === "number" ? c.timestamp : Date.now(),
    };
    appendTranscriptChunk(chunk);
    accepted.push(chunk);
  }

  if (accepted.length === 0) {
    return Response.json({ error: "no non-empty chunks" }, { status: 400 });
  }

  // Fire-and-forget — must not block the ingest response. Triage coalesces
  // itself, so spamming this is safe.
  maybeRunTriage(body.meetingId);

  return Response.json({ accepted: accepted.length });
}
