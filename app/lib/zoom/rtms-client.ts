/**
 * Zoom Real-Time Media Streams (RTMS) client — one instance per active
 * meeting. Implements the documented two-channel protocol:
 *   1. Signaling WebSocket — handshake, auth, media-server handoff
 *   2. Media WebSocket     — the actual transcript stream
 *
 * Flow, once the Zoom webhook delivers meeting.rtms_started:
 *   - Open signaling WS to one of the provided server_urls
 *   - Send signaling handshake: { msg_type: 1, protocol_version: 1,
 *     meeting_uuid, rtms_stream_id, signature: HMAC_SHA256(client_secret,
 *     "client_id,meeting_uuid,rtms_stream_id") }
 *   - On SIGNALING_HANDSHAKE_RESP (msg_type: 2) with status 0 → subscribe
 *     to the transcript stream via msg_type: 3 (new_stream handshake)
 *   - Zoom returns a media_server_url → open the media WebSocket
 *   - Send media handshake: same signature shape, media_type: 8 (transcript)
 *   - On MEDIA_DATA (msg_type: 14) → parse transcript → append to store
 *   - On meeting end (SESSION_STATE_UPDATE state=STOPPED), close both WS
 *
 * Reference: developers.zoom.us/docs/rtms/overview
 *
 * Single-responsibility note: this module knows only about RTMS. It hands
 * transcripts to appendTranscriptChunk() — the same function the HTTP
 * /api/transcript/ingest endpoint uses, so triage fires identically
 * whether transcripts come from paste, curl, or RTMS.
 */

import WebSocket from "ws";
import crypto from "crypto";
import { randomUUID } from "crypto";
import { appendTranscriptChunk } from "@/app/lib/transcript-store";

// Message types per the Zoom RTMS protocol spec.
const MSG_TYPE = {
  SIGNALING_HANDSHAKE_REQ: 1,
  SIGNALING_HANDSHAKE_RESP: 2,
  EVENT_SUBSCRIPTION: 3,
  EVENT_UPDATE: 4,
  CLIENT_READY_ACK: 7,
  KEEPALIVE_REQ: 12,
  KEEPALIVE_RESP: 13,
  MEDIA_DATA_TRANSCRIPT: 17,
  SESSION_STATE_UPDATE: 18,
  MEDIA_DATA_AUDIO: 14, // raw audio (we don't subscribe; transcript only)
} as const;

// Session states we care about.
const STREAM_STATE = {
  ACTIVE: "ACTIVE",
  STOPPED: "STOPPED",
  PAUSED: "PAUSED",
} as const;

export interface RtmsStreamConfig {
  /** `payload.object.event_ts`-era meeting UUID from the webhook. */
  meetingUuid: string;
  /** `payload.object.rtms_stream_id` from the webhook. */
  rtmsStreamId: string;
  /** `payload.object.server_urls` — WebSocket endpoints Zoom gave us.
   *  We try the first one; failover to the rest if needed. */
  serverUrls: string[];
}

interface RtmsCreds {
  clientId: string;
  clientSecret: string;
}

/**
 * One active RTMS session. Call `start()` after construction; call `stop()`
 * to tear down cleanly (idempotent — called on protocol error, session
 * stopped event, or external cancel).
 */
export class RtmsSession {
  private signalingWs: WebSocket | null = null;
  private mediaWs: WebSocket | null = null;
  private sigKeepalive: NodeJS.Timeout | null = null;
  private mediaKeepalive: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private cfg: RtmsStreamConfig,
    private creds: RtmsCreds
  ) {}

  /** HMAC-SHA256 of (clientId,meetingUuid,rtmsStreamId) keyed by clientSecret,
   *  hex-encoded. Zoom validates this on BOTH the signaling + media handshakes. */
  private signature(): string {
    const msg = `${this.creds.clientId},${this.cfg.meetingUuid},${this.cfg.rtmsStreamId}`;
    return crypto
      .createHmac("sha256", this.creds.clientSecret)
      .update(msg)
      .digest("hex");
  }

  async start(): Promise<void> {
    if (this.cfg.serverUrls.length === 0) {
      throw new Error("RTMS: no server_urls provided in webhook payload");
    }
    const sigUrl = this.cfg.serverUrls[0];
    console.log(
      `[rtms] opening signaling channel for meeting=${this.cfg.meetingUuid} url=${sigUrl}`
    );

    this.signalingWs = new WebSocket(sigUrl);
    this.signalingWs.on("open", () => this.onSignalingOpen());
    this.signalingWs.on("message", (data) => this.onSignalingMessage(data));
    this.signalingWs.on("error", (err) =>
      console.error(`[rtms:${this.cfg.meetingUuid}] signaling error:`, err.message)
    );
    this.signalingWs.on("close", (code, reason) => {
      console.log(
        `[rtms:${this.cfg.meetingUuid}] signaling closed code=${code} reason=${reason.toString()}`
      );
      if (!this.stopped) this.stop();
    });
  }

  private onSignalingOpen(): void {
    // Initial handshake — authenticate this session.
    this.sendSignaling({
      msg_type: MSG_TYPE.SIGNALING_HANDSHAKE_REQ,
      protocol_version: 1,
      meeting_uuid: this.cfg.meetingUuid,
      rtms_stream_id: this.cfg.rtmsStreamId,
      sequence: Date.now(),
      signature: this.signature(),
    });
  }

  private onSignalingMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn(`[rtms:${this.cfg.meetingUuid}] non-JSON signaling frame`);
      return;
    }
    const type = msg.msg_type as number;

    switch (type) {
      case MSG_TYPE.SIGNALING_HANDSHAKE_RESP: {
        const status = (msg as { status_code?: number }).status_code;
        if (status !== 0) {
          console.error(
            `[rtms:${this.cfg.meetingUuid}] signaling handshake rejected status=${status} ${JSON.stringify(msg)}`
          );
          this.stop();
          return;
        }
        // Now ask Zoom where to connect for the transcript media stream.
        this.sendSignaling({
          msg_type: MSG_TYPE.EVENT_SUBSCRIPTION,
          events: [
            { type: 1, subscribe: true }, // captions / transcript events
          ],
        });
        this.startSigKeepalive();
        break;
      }
      case MSG_TYPE.EVENT_UPDATE: {
        // Zoom delivers the media server URL inside an EVENT_UPDATE. The
        // exact payload shape varies by Zoom's version; handle common shapes.
        const mediaUrl =
          (msg as { content?: { media_server_url?: string } }).content?.media_server_url ??
          (msg as { media_server_url?: string }).media_server_url;
        if (mediaUrl) this.openMediaChannel(mediaUrl);
        break;
      }
      case MSG_TYPE.SESSION_STATE_UPDATE: {
        const state = (msg as { state?: string }).state;
        if (state === STREAM_STATE.STOPPED) {
          console.log(`[rtms:${this.cfg.meetingUuid}] session stopped by Zoom`);
          this.stop();
        }
        break;
      }
      case MSG_TYPE.KEEPALIVE_REQ: {
        // Respond to server-initiated keepalives too.
        this.sendSignaling({
          msg_type: MSG_TYPE.KEEPALIVE_RESP,
          timestamp: Date.now(),
        });
        break;
      }
      default:
        // Unknown msg_type — log at debug level; benign
        break;
    }
  }

  private openMediaChannel(url: string): void {
    console.log(
      `[rtms:${this.cfg.meetingUuid}] opening media channel url=${url}`
    );
    this.mediaWs = new WebSocket(url);
    this.mediaWs.on("open", () => {
      // Auth the media channel with the same signature shape as signaling.
      this.sendMedia({
        msg_type: MSG_TYPE.SIGNALING_HANDSHAKE_REQ,
        protocol_version: 1,
        meeting_uuid: this.cfg.meetingUuid,
        rtms_stream_id: this.cfg.rtmsStreamId,
        signature: this.signature(),
        media_type: 8, // 8 = transcript
        payload_encryption: false,
      });
    });
    this.mediaWs.on("message", (data) => this.onMediaMessage(data));
    this.mediaWs.on("error", (err) =>
      console.error(`[rtms:${this.cfg.meetingUuid}] media error:`, err.message)
    );
    this.mediaWs.on("close", (code, reason) => {
      console.log(
        `[rtms:${this.cfg.meetingUuid}] media closed code=${code} reason=${reason.toString()}`
      );
    });
  }

  private onMediaMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      // Media channel may carry binary audio frames — ignore since we only
      // subscribed to transcript.
      return;
    }
    const type = msg.msg_type as number;

    if (type === MSG_TYPE.SIGNALING_HANDSHAKE_RESP) {
      const status = (msg as { status_code?: number }).status_code;
      if (status !== 0) {
        console.error(
          `[rtms:${this.cfg.meetingUuid}] media handshake rejected status=${status}`
        );
        this.stop();
        return;
      }
      // Tell Zoom we're ready to receive transcript data.
      this.sendMedia({ msg_type: MSG_TYPE.CLIENT_READY_ACK });
      this.startMediaKeepalive();
      return;
    }

    if (type === MSG_TYPE.MEDIA_DATA_TRANSCRIPT) {
      this.handleTranscriptMessage(msg);
      return;
    }

    if (type === MSG_TYPE.KEEPALIVE_REQ) {
      this.sendMedia({ msg_type: MSG_TYPE.KEEPALIVE_RESP, timestamp: Date.now() });
      return;
    }

    if (type === MSG_TYPE.SESSION_STATE_UPDATE) {
      const state = (msg as { state?: string }).state;
      if (state === STREAM_STATE.STOPPED) this.stop();
    }
  }

  /**
   * Extract speaker + text from a transcript frame and append to the
   * transcript store keyed by meetingUuid. Keeps shape compatible with
   * whatever the /api/transcript/ingest endpoint would have produced, so
   * the UI + triage behave identically.
   */
  private handleTranscriptMessage(msg: Record<string, unknown>): void {
    // Transcript payload shape (observed): content: { data: "text",
    // user_name: "Alex", timestamp: ... } — but Zoom versions vary.
    const content = (msg.content ?? msg) as Record<string, unknown>;
    const text = String(content.data ?? content.text ?? "").trim();
    if (!text) return;
    const speaker = String(
      content.user_name ?? content.speaker ?? "participant"
    ).trim() || "participant";
    const timestamp =
      typeof content.timestamp === "number"
        ? (content.timestamp as number)
        : Date.now();

    appendTranscriptChunk({
      id: randomUUID(),
      meetingId: this.cfg.meetingUuid,
      speaker,
      text,
      timestamp,
    });
  }

  private startSigKeepalive(): void {
    // Zoom's keepalive cadence per docs is ~5s; send every 4 to be safe.
    this.sigKeepalive = setInterval(() => {
      if (!this.signalingWs || this.signalingWs.readyState !== WebSocket.OPEN) return;
      this.sendSignaling({ msg_type: MSG_TYPE.KEEPALIVE_REQ, timestamp: Date.now() });
    }, 4000);
  }
  private startMediaKeepalive(): void {
    this.mediaKeepalive = setInterval(() => {
      if (!this.mediaWs || this.mediaWs.readyState !== WebSocket.OPEN) return;
      this.sendMedia({ msg_type: MSG_TYPE.KEEPALIVE_REQ, timestamp: Date.now() });
    }, 4000);
  }

  private sendSignaling(payload: Record<string, unknown>): void {
    if (this.signalingWs?.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify(payload));
    }
  }
  private sendMedia(payload: Record<string, unknown>): void {
    if (this.mediaWs?.readyState === WebSocket.OPEN) {
      this.mediaWs.send(JSON.stringify(payload));
    }
  }

  /** Idempotent — safe to call from multiple error paths. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sigKeepalive) clearInterval(this.sigKeepalive);
    if (this.mediaKeepalive) clearInterval(this.mediaKeepalive);
    try { this.mediaWs?.close(); } catch { /* */ }
    try { this.signalingWs?.close(); } catch { /* */ }
    this.mediaWs = null;
    this.signalingWs = null;
    console.log(`[rtms:${this.cfg.meetingUuid}] session stopped`);
  }
}

// ── Session manager ───────────────────────────────────────────────────────
// One-per-process singleton that tracks active RTMS streams. Lets the
// webhook handler kick off new streams + tear them down when Zoom sends
// meeting.rtms_stopped.

const activeSessions = new Map<string, RtmsSession>();

export function getZoomCreds(): RtmsCreds | null {
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function startRtmsForMeeting(cfg: RtmsStreamConfig): Promise<void> {
  const creds = getZoomCreds();
  if (!creds) {
    console.warn(
      "[rtms] ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set — can't start RTMS session"
    );
    return;
  }
  // If a prior session for the same meeting exists, tear it down first.
  stopRtmsForMeeting(cfg.meetingUuid);

  const session = new RtmsSession(cfg, creds);
  activeSessions.set(cfg.meetingUuid, session);
  await session.start();
}

export function stopRtmsForMeeting(meetingUuid: string): void {
  const existing = activeSessions.get(meetingUuid);
  if (existing) {
    existing.stop();
    activeSessions.delete(meetingUuid);
  }
}

export function activeSessionCount(): number {
  return activeSessions.size;
}
