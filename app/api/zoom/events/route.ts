/**
 * Zoom event webhook → RTMS session lifecycle.
 *
 * Handles three kinds of POSTs from Zoom:
 *   1. URL validation challenge — Zoom pings this endpoint on initial
 *      subscription setup with { event: "endpoint.url_validation",
 *      payload: { plainToken } }. We respond with the HMAC of plainToken
 *      keyed by ZOOM_SECRET_TOKEN. Must complete within 30s.
 *   2. meeting.rtms_started — a host has started a meeting AND enabled
 *      RTMS. Payload includes meeting_uuid + rtms_stream_id + server_urls.
 *      We kick off an RtmsSession that opens the WebSocket(s) to Zoom and
 *      starts streaming transcripts into our store.
 *   3. meeting.rtms_stopped — meeting ended or host disabled RTMS. Close
 *      the corresponding session.
 *
 * All other events are acknowledged (200 OK) but otherwise ignored — Zoom
 * will retry webhooks on 5xx, so we never 500 for an unknown event type.
 *
 * Security: every incoming webhook is HMAC-signed with ZOOM_SECRET_TOKEN.
 * We verify the signature before trusting the payload. Rejects with 401
 * on mismatch.
 *
 * Runtime note: RTMS opens long-lived WebSockets from our server back to
 * Zoom. On serverless platforms (Vercel's default) those connections die
 * when the function invocation ends. Deploy this on a long-running host
 * (Render / Railway / Fly / a VPS) for production use. The webhook handler
 * itself returns in <100ms; it's the in-memory session manager that
 * requires process persistence.
 */

import { NextRequest } from "next/server";
import crypto from "crypto";
import { startRtmsForMeeting, stopRtmsForMeeting } from "@/app/lib/zoom/rtms-client";

export const runtime = "nodejs";

interface ZoomWebhook {
  event: string;
  event_ts?: number;
  payload?: {
    plainToken?: string; // URL validation
    object?: {
      meeting_uuid?: string;
      rtms_stream_id?: string;
      server_urls?: string[] | string;
      state?: string;
      stop_reason?: string;
    };
  };
}

/** HMAC-SHA256 of the raw body keyed by ZOOM_SECRET_TOKEN, then compared
 *  timing-safely to the x-zm-signature header. Zoom's header format is
 *  "v0=<hex>" where the payload is `v0:<timestamp>:<rawBody>`. */
function verifySignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secretToken: string
): boolean {
  if (!signature || !timestamp) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    "v0=" +
    crypto.createHmac("sha256", secretToken).update(base).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secretToken = process.env.ZOOM_SECRET_TOKEN;
  if (!secretToken) {
    console.error("[zoom-events] ZOOM_SECRET_TOKEN not set");
    return Response.json(
      { error: "Zoom integration not configured" },
      { status: 500 }
    );
  }

  const rawBody = await req.text();
  let body: ZoomWebhook;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  // 1. URL validation — Zoom uses this during webhook-URL setup. NO
  //    signature header is present on this event. Respond with the hash
  //    within 30s or setup fails.
  if (body.event === "endpoint.url_validation" && body.payload?.plainToken) {
    const plainToken = body.payload.plainToken;
    const encryptedToken = crypto
      .createHmac("sha256", secretToken)
      .update(plainToken)
      .digest("hex");
    return Response.json({ plainToken, encryptedToken });
  }

  // 2. Every other event must be signature-verified.
  if (
    !verifySignature(
      rawBody,
      req.headers.get("x-zm-signature"),
      req.headers.get("x-zm-request-timestamp"),
      secretToken
    )
  ) {
    console.warn("[zoom-events] signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  const obj = body.payload?.object ?? {};
  switch (body.event) {
    case "meeting.rtms_started": {
      const meetingUuid = obj.meeting_uuid;
      const rtmsStreamId = obj.rtms_stream_id;
      const serverUrls = Array.isArray(obj.server_urls)
        ? obj.server_urls
        : obj.server_urls
          ? [obj.server_urls]
          : [];
      if (!meetingUuid || !rtmsStreamId || serverUrls.length === 0) {
        console.warn(
          "[zoom-events] rtms_started missing fields:",
          JSON.stringify(obj).slice(0, 200)
        );
        return Response.json({ ok: true });
      }
      console.log(
        `[zoom-events] rtms_started meeting=${meetingUuid} stream=${rtmsStreamId}`
      );
      // Fire-and-forget — the session manages its own lifecycle, and we
      // must ack the webhook within Zoom's ~3s timeout or Zoom will retry.
      startRtmsForMeeting({ meetingUuid, rtmsStreamId, serverUrls }).catch(
        (err) => console.error("[zoom-events] startRtms failed:", err)
      );
      return Response.json({ ok: true });
    }

    case "meeting.rtms_stopped": {
      const meetingUuid = obj.meeting_uuid;
      if (meetingUuid) {
        console.log(
          `[zoom-events] rtms_stopped meeting=${meetingUuid} reason=${obj.stop_reason ?? "unknown"}`
        );
        stopRtmsForMeeting(meetingUuid);
      }
      return Response.json({ ok: true });
    }

    default:
      // Unknown / unsubscribed event — ack and move on.
      return Response.json({ ok: true });
  }
}

// GET is occasionally used by Zoom's app validator / humans sanity-checking.
export async function GET() {
  return Response.json({
    ok: true,
    message:
      "Ranger Zoom events endpoint. POST-only in normal operation. See README for Marketplace-app setup.",
  });
}
