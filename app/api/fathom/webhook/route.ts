/**
 * POST /api/fathom/webhook
 *
 * Receives Fathom's post-call webhook, verifies the HMAC signature,
 * translates the payload into our transcript-chunk shape, and fires the
 * existing debrief pipeline. The AE gets a fresh Ranger debrief in their
 * pre-read within ~30s of hanging up — no paste, no copy-transcript
 * dance.
 *
 * Configure:
 *   - FATHOM_WEBHOOK_SECRET=...   (shared signing secret; see .env.example)
 *   - INTERNAL_EMAIL_DOMAINS=...  (CSV, optional; default helpscout.com)
 *
 * Then in Fathom Team settings → Integrations → Webhooks, add the URL
 * (https://<your-ranger>/api/fathom/webhook) and paste the same secret.
 */

import { NextRequest } from "next/server";
import { after } from "next/server";
import {
  normalizeFathomPayload,
  verifyFathomSignature,
} from "@/app/lib/fathom";
import { appendTranscriptChunk } from "@/app/lib/transcript-store";
import { generateDebrief } from "@/app/lib/debrief/generate";
import { persistDebrief } from "@/app/lib/debrief-persist";

// Fathom's webhook delivery has no tight latency target on their side —
// we're free to spend some time synthesizing the debrief before ACKing.
// But the ACK itself is cheap: normalize, reply, do the real work in
// after(). This keeps Fathom's retry loop healthy.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Read the raw body as text so we can HMAC it verbatim before any
  // JSON round-trip mutates whitespace. (Common webhook-signing gotcha.)
  const rawBody = await req.text();

  // Signature header name varies by Fathom workspace config; try the
  // common ones. Case-insensitive per the Headers API.
  const sigHeader =
    req.headers.get("x-fathom-signature") ||
    req.headers.get("x-signature") ||
    req.headers.get("x-webhook-signature");

  const verify = verifyFathomSignature(
    rawBody,
    sigHeader,
    process.env.FATHOM_WEBHOOK_SECRET
  );
  if (!verify.ok) {
    console.warn("[fathom] signature verification failed:", verify.reason);
    return Response.json(
      { error: "invalid signature", reason: verify.reason },
      { status: 401 }
    );
  }

  // Parse + normalize.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const normalized = normalizeFathomPayload(payload);
  if (!normalized) {
    // Likely a test ping or a non-transcript event — ACK 200 so Fathom
    // doesn't retry, but don't pretend we did anything.
    return Response.json({ ok: true, skipped: "no-transcript-in-payload" });
  }

  // Write the chunks into the shared transcript store using a Fathom-
  // specific meeting ID. This keeps them isolated from any parallel live
  // session (so a live session and an after-the-fact Fathom debrief of
  // the same meeting don't collide on chunks). The debrief uses the
  // meetingId we set here.
  const meetingId = `fathom-${normalized.meetingId}`;
  const baseTimestamp = Date.now() - normalized.chunks.length * 1000;
  for (let i = 0; i < normalized.chunks.length; i++) {
    const c = normalized.chunks[i];
    appendTranscriptChunk({
      id: `fathom-${normalized.meetingId}-${i}`,
      meetingId,
      speaker: c.speaker,
      text: c.text,
      timestamp: baseTimestamp + i * 1000,
    });
  }

  // ACK immediately; synthesize the debrief asynchronously so Fathom's
  // retry clock doesn't pressure us. Any failure here is logged but
  // silent to Fathom — we don't want them retrying a partially-persisted
  // debrief on our end.
  after(async () => {
    try {
      const debrief = await generateDebrief(meetingId, {
        prospectName: normalized.prospectName,
        // Pass chunks through explicitly (serverless-safe — in-memory
        // store might not be visible on a different Vercel instance).
        clientChunks: normalized.chunks.map((c, i) => ({
          speaker: c.speaker,
          text: c.text,
          timestamp: c.timestamp ?? baseTimestamp + i * 1000,
        })),
      });
      await persistDebrief(debrief, {
        prospectName: normalized.prospectName,
      });
      console.log(
        `[fathom] debrief generated for "${normalized.meetingTitle ?? meetingId}" (${normalized.chunks.length} chunks, score=${debrief.closeLikelihood.score})`
      );
    } catch (err) {
      console.error(
        "[fathom] debrief failed for",
        normalized.meetingTitle ?? meetingId,
        "—",
        err instanceof Error ? err.message : err
      );
    }
  });

  return Response.json({
    ok: true,
    meetingId,
    chunks: normalized.chunks.length,
    prospect: normalized.prospectName,
  });
}
