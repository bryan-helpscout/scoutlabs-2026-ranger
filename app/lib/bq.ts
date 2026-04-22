/**
 * BigQuery persistence for meeting debriefs.
 *
 * Fail-soft + opt-in:
 *   - If BIGQUERY_PROJECT_ID isn't set, everything here no-ops with a log
 *     line. Local dev without GCP credentials keeps working.
 *   - Insert errors are caught and logged; they never bubble to the client
 *     (debrief is already returned by the time this runs, via after()).
 *   - Credentials: either GOOGLE_APPLICATION_CREDENTIALS_JSON (inline JSON
 *     blob, preferred for Vercel-style env vars) or the standard
 *     GOOGLE_APPLICATION_CREDENTIALS file path.
 *
 * Table DDL lives in sql/debriefs-table.sql — run it once in your dataset
 * before pointing this at it.
 */

import { BigQuery } from "@google-cloud/bigquery";
import type { MeetingDebrief } from "@/app/lib/debrief/schema";

const DEFAULT_DATASET = "ranger";
const DEFAULT_TABLE = "debriefs";

// Cache the client across requests to avoid re-parsing credentials on every
// insert. Env changes during dev-server lifetime won't pick up without a
// restart, which is fine.
let cachedClient: BigQuery | null = null;
let credentialsNoteLogged = false;

function getClient(): BigQuery | null {
  if (cachedClient) return cachedClient;
  const projectId = process.env.BIGQUERY_PROJECT_ID;
  if (!projectId) return null;

  // Prefer inline JSON credentials — cleanest for deploy envs where file
  // paths don't exist.
  const inlineJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (inlineJson) {
    try {
      const credentials = JSON.parse(inlineJson) as {
        client_email?: string;
        private_key?: string;
      };
      cachedClient = new BigQuery({ projectId, credentials });
      return cachedClient;
    } catch (err) {
      console.error("[bq] GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON:", err);
      return null;
    }
  }

  // Fall back to the GCP default credential chain (file path, gcloud ADC,
  // metadata server on GCE/Cloud Run). No-op if nothing's configured — the
  // first insert will surface the real error.
  if (!credentialsNoteLogged) {
    console.info(
      "[bq] no GOOGLE_APPLICATION_CREDENTIALS_JSON set; using default credential chain"
    );
    credentialsNoteLogged = true;
  }
  cachedClient = new BigQuery({ projectId });
  return cachedClient;
}

/**
 * Flatten the debrief into the table's column shape. Arrays of structs
 * (action_items, email_drafts) stay arrays — BigQuery handles the
 * STRUCT mapping from JS objects.
 */
function toRow(debrief: MeetingDebrief, prospectName?: string | null) {
  return {
    meeting_id: debrief.meetingId,
    prospect_name: prospectName ?? null,
    summary: debrief.summary,
    close_score: debrief.closeLikelihood.score,
    close_band: debrief.closeLikelihood.band,
    close_rationale: debrief.closeLikelihood.rationale,
    tone_overall: debrief.tone.overall,
    tone_signals: debrief.tone.signals,
    action_items: debrief.actionItems.map((a) => ({
      owner: a.owner,
      description: a.description,
      priority: a.priority,
      due_by: a.dueBy ?? null,
    })),
    email_drafts: debrief.emailDrafts.map((d) => ({
      purpose: d.purpose,
      subject: d.subject,
      body: d.body,
    })),
    next_call_prep: {
      pain_points: debrief.nextCallPrep?.painPoints ?? [],
      // Each theme rides with its talking point — nested STRUCT ARRAY so
      // analysts can UNNEST(question_themes) to count "how often do
      // prospects ask about X?" with the talk track attached.
      question_themes: (debrief.nextCallPrep?.questionThemes ?? []).map((q) => ({
        theme: q.theme,
        talking_point: q.talkingPoint,
      })),
      recommended_focus: debrief.nextCallPrep?.recommendedFocus ?? "",
    },
    open_questions: debrief.openQuestions,
    risks: debrief.risks,
    transcript_chunk_count: debrief.transcriptChunkCount,
    generated_at: debrief.generatedAt,
  };
}

/**
 * Stream-insert one debrief row into BigQuery. Returns true if the write
 * was attempted AND succeeded; false on any failure (including "BQ not
 * configured" — caller should log, not fail).
 */
export async function logDebriefToBigQuery(
  debrief: MeetingDebrief,
  opts: { prospectName?: string | null } = {}
): Promise<boolean> {
  const client = getClient();
  if (!client) {
    // BQ not configured — this is expected in local dev without credentials.
    // Log once-ish so operators notice if they THOUGHT it was configured.
    if (!credentialsNoteLogged) {
      console.info(
        "[bq] BIGQUERY_PROJECT_ID not set — skipping BigQuery persistence. " +
          "Set it + a credentials env var to enable."
      );
      credentialsNoteLogged = true;
    }
    return false;
  }

  const dataset = process.env.BIGQUERY_DATASET ?? DEFAULT_DATASET;
  const table = process.env.BIGQUERY_TABLE ?? DEFAULT_TABLE;

  try {
    const row = toRow(debrief, opts.prospectName ?? null);
    await client.dataset(dataset).table(table).insert([row]);
    console.log(
      `[bq] logged debrief meeting_id=${debrief.meetingId} score=${debrief.closeLikelihood.score} to ${dataset}.${table}`
    );
    return true;
  } catch (err) {
    // BigQuery's streaming insert errors can be noisy + structured
    // (PartialFailureError with per-row reasons). Log the first error's
    // row + reason concisely rather than dumping the whole thing.
    const e = err as { name?: string; errors?: Array<{ errors?: unknown }>; message?: string };
    if (e.name === "PartialFailureError") {
      console.error(
        `[bq] partial failure inserting debrief ${debrief.meetingId}:`,
        JSON.stringify(e.errors?.[0]?.errors ?? e.errors, null, 2)
      );
    } else {
      console.error(`[bq] insert failed for debrief ${debrief.meetingId}:`, e.message ?? err);
    }
    return false;
  }
}
