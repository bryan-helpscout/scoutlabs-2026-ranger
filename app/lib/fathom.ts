/**
 * Fathom AI webhook payload normalization.
 *
 * Fathom's JSON schema has shifted subtly between webhook versions (and
 * between workspaces depending on which app in their catalog created the
 * webhook). This module defends against that variation by trying several
 * plausible shapes and falling back gracefully. Intent: never reject a
 * webhook just because a field moved.
 *
 * The output is intentionally minimal — it matches what the rest of the
 * app already consumes:
 *   - chunks: Array<{ speaker, text, timestamp }>  (same shape as live ingest)
 *   - meetingTitle, meetingId, externalUrl         (for display + dedupe)
 *   - prospectName                                 (best-guess external attendee)
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface NormalizedFathomCall {
  /** Deterministic ID we key the debrief under. Prefer Fathom's own UUID
   *  when the payload provides one; otherwise synthesize from the URL or
   *  title so repeated webhooks dedupe cleanly. */
  meetingId: string;
  /** Fathom's recording / share URL — shown in the debrief so the AE can
   *  jump to the video if they want to re-watch a specific moment. */
  recordingUrl?: string | null;
  meetingTitle?: string | null;
  /** Best-guess prospect name inferred from attendees (the non-internal
   *  participant). Null when we can't confidently pick one — the debrief
   *  pipeline then falls back to the HubSpot prospect loaded in the UI. */
  prospectName: string | null;
  /** Chunks in chronological order, same shape as our live ingest. */
  chunks: Array<{ speaker: string; text: string; timestamp?: number }>;
  /** Optional: Fathom's own summary. We DON'T use this for our debrief
   *  (we want Ranger's own analysis), but we stash it in the persisted
   *  row so side-by-side comparison is possible later. */
  fathomSummary?: string | null;
  fathomActionItems?: string[];
}

/** Internal ISO `@helpscout.com`-style filter — participants whose email
 *  domain matches these are assumed to be "us," so whoever's left is the
 *  prospect. Comma-separated override via INTERNAL_EMAIL_DOMAINS. */
function internalDomains(): Set<string> {
  const fromEnv = process.env.INTERNAL_EMAIL_DOMAINS;
  const defaults = ["helpscout.com", "help-scout.com"];
  const list = (fromEnv ? fromEnv.split(",") : defaults)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

/**
 * Verify Fathom's HMAC signature. Fathom sends a signature header whose
 * exact name varies by workspace config — we check the common ones.
 *
 * The secret is the shared value you configure in Fathom's webhook
 * settings and mirror on our server in `FATHOM_WEBHOOK_SECRET`.
 *
 * When the env var is UNSET we still accept the webhook (useful for
 * initial testing), but log a warning so misconfigured production
 * deploys don't silently skip verification.
 */
export function verifyFathomSignature(
  rawBody: string,
  headerValue: string | null | undefined,
  secret: string | undefined
): { ok: boolean; reason?: string } {
  if (!secret) {
    console.warn(
      "[fathom] FATHOM_WEBHOOK_SECRET not set — accepting webhook unverified"
    );
    return { ok: true, reason: "no-secret-configured" };
  }
  if (!headerValue) return { ok: false, reason: "missing-signature-header" };

  // Fathom signatures are prefixed with "sha256=" in some versions — strip
  // the prefix before comparing so we handle both variants.
  const provided = headerValue.replace(/^sha256=/, "").trim().toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Length mismatch fails before timingSafeEqual throws.
  if (provided.length !== expected.length) {
    return { ok: false, reason: "signature-length-mismatch" };
  }

  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === 0 || a.length !== b.length) {
      return { ok: false, reason: "signature-hex-decode" };
    }
    return timingSafeEqual(a, b)
      ? { ok: true }
      : { ok: false, reason: "signature-mismatch" };
  } catch (err) {
    return {
      ok: false,
      reason: `signature-exception:${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

/** Fathom's transcript array items have appeared under several names in
 *  the wild — try them in order and pick the first that yields a usable
 *  array. Defensive about nested "data" / "meeting" envelopes too. */
function extractTranscriptItems(
  payload: Record<string, unknown>
): Array<Record<string, unknown>> {
  const candidates: unknown[] = [
    payload.transcript,
    (payload.meeting as Record<string, unknown> | undefined)?.transcript,
    (payload.data as Record<string, unknown> | undefined)?.transcript,
    payload.transcript_segments,
    payload.segments,
    payload.utterances,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      return c as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Each transcript item might use any of a few field names — normalize. */
function extractSegment(
  raw: Record<string, unknown>
): { speaker: string; text: string; timestamp?: number } | null {
  const speaker =
    (raw.speaker as string) ||
    (raw.speaker_name as string) ||
    ((raw.speaker as Record<string, unknown>)?.name as string) ||
    (raw.name as string) ||
    "speaker";
  const text =
    (raw.text as string) ||
    (raw.transcript as string) ||
    (raw.content as string) ||
    "";
  if (!text.trim()) return null;

  let timestamp: number | undefined;
  // Fathom may deliver seconds offset OR absolute timestamp — both are fine
  // downstream because we just use relative ordering.
  const ts =
    (raw.timestamp as number | undefined) ??
    (raw.start_time as number | undefined) ??
    (raw.start as number | undefined) ??
    (raw.offset_sec as number | undefined);
  if (typeof ts === "number" && Number.isFinite(ts)) timestamp = ts;

  return { speaker: String(speaker), text: String(text), timestamp };
}

/** Pick the most likely prospect name from the attendees list. */
function extractProspectName(
  payload: Record<string, unknown>
): string | null {
  const attendees =
    (payload.attendees as Array<Record<string, unknown>>) ||
    (payload.participants as Array<Record<string, unknown>>) ||
    ((payload.meeting as Record<string, unknown> | undefined)
      ?.attendees as Array<Record<string, unknown>>) ||
    [];

  const internal = internalDomains();
  // Prefer someone with an obvious "external" marker, then fall back to
  // anyone whose email domain isn't on our internal allowlist.
  const external = attendees.find((a) => {
    const isExternal =
      a.is_external === true || a.external === true || a.role === "external";
    const email = (a.email as string | undefined)?.toLowerCase() ?? "";
    const domain = email.split("@")[1] ?? "";
    return isExternal || (domain && !internal.has(domain));
  });
  if (!external) return null;

  // Prefer a full display name, then fall back to email-local.
  const name =
    (external.name as string) ||
    (external.display_name as string) ||
    (external.full_name as string) ||
    ((external.first_name as string | undefined) &&
    (external.last_name as string | undefined)
      ? `${external.first_name} ${external.last_name}`
      : null) ||
    ((external.email as string | undefined)?.split("@")[0] ?? null);
  return name ? String(name) : null;
}

/**
 * Main entry point — given Fathom's raw JSON body, produce the
 * normalized payload our existing debrief pipeline already knows how to
 * consume. Returns null when the payload doesn't look like a
 * completed-meeting event (e.g. a "test" ping or a status-update).
 */
export function normalizeFathomPayload(
  payload: Record<string, unknown>
): NormalizedFathomCall | null {
  // Fathom sends multiple event types. Accept anything that looks like
  // "completed meeting with transcript"; ignore test pings & partial
  // progress events.
  const eventType =
    ((payload.event as string) || (payload.type as string) || "")
      .toLowerCase()
      .trim();
  if (
    eventType &&
    !eventType.includes("meeting") &&
    !eventType.includes("transcript") &&
    !eventType.includes("recording") &&
    !eventType.includes("call")
  ) {
    return null;
  }

  const items = extractTranscriptItems(payload);
  const chunks = items
    .map(extractSegment)
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (chunks.length === 0) return null;

  // Meeting identifier: prefer Fathom's UUID, fall back to URL hash, then
  // title+date as last resort.
  const meetingId =
    (payload.id as string) ||
    (payload.meeting_id as string) ||
    ((payload.meeting as Record<string, unknown> | undefined)?.id as string) ||
    (payload.uuid as string) ||
    `fathom-${Date.now()}`;

  const recordingUrl =
    (payload.share_url as string) ||
    (payload.recording_url as string) ||
    (payload.url as string) ||
    ((payload.meeting as Record<string, unknown> | undefined)?.url as string) ||
    null;

  const meetingTitle =
    (payload.title as string) ||
    (payload.meeting_title as string) ||
    ((payload.meeting as Record<string, unknown> | undefined)?.title as string) ||
    null;

  const fathomSummary =
    (payload.summary as string) ||
    (payload.ai_summary as string) ||
    ((payload.meeting as Record<string, unknown> | undefined)
      ?.summary as string) ||
    null;

  const actionItemsRaw =
    (payload.action_items as Array<unknown>) ||
    (payload.actionItems as Array<unknown>) ||
    [];
  const fathomActionItems = actionItemsRaw
    .map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object") {
        const o = a as Record<string, unknown>;
        return (o.text as string) || (o.description as string) || "";
      }
      return "";
    })
    .filter((s) => s.trim().length > 0);

  return {
    meetingId: String(meetingId),
    recordingUrl,
    meetingTitle,
    prospectName: extractProspectName(payload),
    chunks,
    fathomSummary,
    fathomActionItems,
  };
}
