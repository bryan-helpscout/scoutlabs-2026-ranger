/**
 * SSE stream of live call events: transcript chunks + surfaced cards.
 *
 * GET /api/transcript/stream?meetingId=<id>
 *
 * On connect we push a `snapshot` event with the current transcript + cards
 * so a late-joining client catches up without gaps. Then events stream in as
 * they happen. Client disconnects unsubscribe automatically.
 */

import { NextRequest } from "next/server";
import { getMeetingSnapshot, subscribe, MeetingEvent } from "@/app/lib/transcript-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const meetingId = req.nextUrl.searchParams.get("meetingId");
  if (!meetingId) {
    return new Response("meetingId query param required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller may already be closed (client disconnected)
        }
      };

      // 1) Initial snapshot so the UI can hydrate without race conditions.
      const snap = getMeetingSnapshot(meetingId);
      send({ type: "snapshot", ...snap });

      // 2) Live subscription.
      const unsubscribe = subscribe(meetingId, (e: MeetingEvent) => send(e));

      // 3) Heartbeat every 20s so intermediate proxies don't close the
      //    connection during quiet periods.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 20_000);

      // 4) Clean up on client disconnect.
      const abort = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx proxy buffering if present
    },
  });
}
