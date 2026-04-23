/**
 * Pre-read brief aggregator — pulls a prospect's past debrief history and
 * rolls it up into a compact object for the sidebar card + chat system
 * prompt injection.
 *
 * Reads from BigQuery when configured; falls back to the local JSONL store
 * (writeable in local dev) so the brief works without any GCP setup.
 */

import { BigQuery } from "@google-cloud/bigquery";
import { readLocalDebriefs } from "@/app/lib/debrief-persist";

export interface BriefingScorePoint {
  /** ISO. */
  generatedAt: string;
  score: number;
  band: "cold" | "warm" | "hot" | "ready to close";
}

export interface BriefingActionItem {
  owner: "ae" | "prospect" | "team";
  description: string;
  priority: "high" | "medium" | "low";
  dueBy?: string | null;
  /** ISO — when the call that surfaced this item happened. */
  fromCallAt: string;
}

export interface BriefingQuestionTheme {
  theme: string;
  talkingPoint: string;
}

export interface BriefingNextCallPrep {
  painPoints: string[];
  questionThemes: BriefingQuestionTheme[];
  recommendedFocus: string;
}

/** HubSpot-sourced last call — used when the AE has logged a call/meeting
 *  in CRM but hasn't run a Ranger debrief yet. Lets the pre-read still show
 *  *something* on day one with a prospect. Shape matches `HubSpotLastCall`
 *  in `hubspot.ts` but is re-declared here so `briefing.ts` doesn't need to
 *  import from hubspot.ts (circular-import safety). */
export interface BriefingHubspotCall {
  kind: "call" | "meeting";
  at: string;
  title?: string | null;
  body?: string | null;
  durationSec?: number | null;
  direction?: string | null;
}

export interface ProspectBriefing {
  /** Total debriefs on record for this prospect. */
  callCount: number;
  /** ISO — most recent call's generatedAt, null if callCount === 0. */
  lastCallAt?: string | null;
  /** Summary from the most recent call. */
  lastCallSummary?: string | null;
  /** Most recent call's tone. */
  lastCallTone?: "positive" | "neutral" | "cautious" | "negative" | null;
  /** Last 5 close scores, newest first. */
  closeScoreHistory: BriefingScorePoint[];
  /** Tone signals from the most recent debrief — these are the concrete
   *  quotes/observations the system prompt instructs the model to produce
   *  (e.g. `"asked three detailed questions about SAML setup"`). Used to
   *  answer "what were they actually saying?" in the health panel. */
  lastCallSignals: string[];
  /** Action items from recent calls, newest first, deduped by description. */
  openActionItems: BriefingActionItem[];
  /** Risks that appeared in 2+ recent calls (the ones worth re-raising). */
  recurringRisks: string[];
  /** Risks from the SINGLE most recent call (not just recurring). These are
   *  the per-call things-to-worry-about that may not have shown up twice
   *  yet but matter for this score. */
  lastCallRisks: string[];
  /** Open questions still unresolved across recent calls. */
  recentOpenQuestions: string[];
  /** Synthesized "here's where to focus the NEXT call" from the most recent
   *  debrief. Null until at least one debrief has been generated. */
  nextCallPrep?: BriefingNextCallPrep | null;
  /** HubSpot's most recent call/meeting engagement for this prospect.
   *  Populated by `/api/prospect` (not by `getProspectBriefing` itself —
   *  that function doesn't know the companyId). Lets the pre-read render
   *  CRM-logged activity when no Ranger debrief exists yet. */
  hubspotLastCall?: BriefingHubspotCall | null;
}

const MAX_RECENT_CALLS = 5;

/** Coerce questionThemes from either the old (string[]) or new
 *  ({theme, talkingPoint}[]) shape into the uniform BriefingQuestionTheme
 *  array the UI expects. Drops empty entries. */
function normalizeThemes(raw: unknown): BriefingQuestionTheme[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      if (typeof q === "string") {
        return { theme: q, talkingPoint: "" };
      }
      if (q && typeof q === "object") {
        const obj = q as Record<string, unknown>;
        return {
          // BQ rows come through snake_case; local-stored + Sonnet output is
          // camelCase. Accept both.
          theme: String(obj.theme ?? ""),
          talkingPoint: String(
            obj.talkingPoint ?? obj.talking_point ?? ""
          ),
        };
      }
      return { theme: "", talkingPoint: "" };
    })
    .filter((q) => q.theme.trim().length > 0);
}

// ── Local JSONL path ──────────────────────────────────────────────────────

function briefFromRows(
  rows: Array<{ debrief: Record<string, unknown>; writtenAt: string }>,
  prospectName: string
): ProspectBriefing {
  // Shape rows newest-first (they already are from readLocalDebriefs, but be
  // defensive in case of mixed sources).
  const recent = rows.slice(0, MAX_RECENT_CALLS);

  const closeScoreHistory: BriefingScorePoint[] = recent.map((r) => {
    const d = r.debrief as {
      generatedAt: string;
      closeLikelihood: { score: number; band: BriefingScorePoint["band"] };
    };
    return {
      generatedAt: d.generatedAt ?? r.writtenAt,
      score: d.closeLikelihood?.score ?? 0,
      band: d.closeLikelihood?.band ?? "cold",
    };
  });

  // Dedup action items by normalized description, keep earliest call date.
  const actionSeen = new Map<string, BriefingActionItem>();
  for (const r of recent) {
    const d = r.debrief as {
      generatedAt?: string;
      actionItems?: Array<{
        owner: "ae" | "prospect" | "team";
        description: string;
        priority: "high" | "medium" | "low";
        dueBy?: string | null;
      }>;
    };
    for (const a of d.actionItems ?? []) {
      const key = a.description.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || actionSeen.has(key)) continue;
      actionSeen.set(key, {
        owner: a.owner,
        description: a.description,
        priority: a.priority,
        dueBy: a.dueBy ?? null,
        fromCallAt: d.generatedAt ?? r.writtenAt,
      });
    }
  }
  const openActionItems = [...actionSeen.values()]
    // Priority-sort so high items surface first.
    .sort((a, b) => {
      const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
      return (rank[b.priority] ?? 0) - (rank[a.priority] ?? 0);
    })
    .slice(0, 6);

  // Recurring risks: strings that appear in ≥2 recent calls.
  const riskCounts = new Map<string, number>();
  for (const r of recent) {
    const d = r.debrief as { risks?: string[] };
    const seenThisCall = new Set<string>();
    for (const risk of d.risks ?? []) {
      const key = risk.toLowerCase().slice(0, 100);
      if (seenThisCall.has(key)) continue;
      seenThisCall.add(key);
      riskCounts.set(risk, (riskCounts.get(risk) ?? 0) + 1);
    }
  }
  const recurringRisks = [...riskCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([risk]) => risk)
    .slice(0, 4);

  // Open questions: flatten + dedup newest first.
  const questionSeen = new Set<string>();
  const recentOpenQuestions: string[] = [];
  for (const r of recent) {
    const d = r.debrief as { openQuestions?: string[] };
    for (const q of d.openQuestions ?? []) {
      const key = q.toLowerCase().slice(0, 100);
      if (questionSeen.has(key)) continue;
      questionSeen.add(key);
      recentOpenQuestions.push(q);
      if (recentOpenQuestions.length >= 4) break;
    }
    if (recentOpenQuestions.length >= 4) break;
  }

  const latest = recent[0]?.debrief as
    | {
        generatedAt?: string;
        summary?: string;
        tone?: {
          overall?: ProspectBriefing["lastCallTone"];
          signals?: string[];
        };
        nextCallPrep?: BriefingNextCallPrep;
        risks?: string[];
      }
    | undefined;

  // Carry the most recent nextCallPrep into the briefing. If older debriefs
  // didn't have it (pre-feature data), fall back to null and the UI skips
  // the callout. Tolerates both old string[] and new {theme, talkingPoint}[]
  // shapes for questionThemes via normalizeThemes.
  const rawPrep = latest?.nextCallPrep as
    | {
        painPoints?: string[];
        questionThemes?: unknown;
        recommendedFocus?: string;
      }
    | undefined;
  const themes = normalizeThemes(rawPrep?.questionThemes);
  const nextCallPrep: BriefingNextCallPrep | null =
    rawPrep &&
    ((rawPrep.recommendedFocus ?? "") ||
      (rawPrep.painPoints?.length ?? 0) > 0 ||
      themes.length > 0)
      ? {
          painPoints: rawPrep.painPoints ?? [],
          questionThemes: themes,
          recommendedFocus: rawPrep.recommendedFocus ?? "",
        }
      : null;

  return {
    callCount: rows.length,
    lastCallAt: latest?.generatedAt ?? recent[0]?.writtenAt ?? null,
    lastCallSummary: latest?.summary ?? null,
    lastCallTone: latest?.tone?.overall ?? null,
    closeScoreHistory,
    lastCallSignals: (latest?.tone?.signals ?? []).slice(0, 4),
    openActionItems,
    recurringRisks,
    lastCallRisks: (latest?.risks ?? []).slice(0, 4),
    recentOpenQuestions,
    nextCallPrep,
    // prospectName is captured for future joins but not currently in the
    // output shape.
    ...(prospectName ? {} : {}),
  };
}

// ── BigQuery path ─────────────────────────────────────────────────────────

let cachedBqClient: BigQuery | null = null;

function bqClient(): BigQuery | null {
  if (cachedBqClient) return cachedBqClient;
  const projectId = process.env.BIGQUERY_PROJECT_ID;
  if (!projectId) return null;
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credsJson) {
    try {
      const credentials = JSON.parse(credsJson);
      cachedBqClient = new BigQuery({ projectId, credentials });
      return cachedBqClient;
    } catch (err) {
      console.warn("[briefing] BigQuery credential JSON invalid:", err);
      return null;
    }
  }
  cachedBqClient = new BigQuery({ projectId });
  return cachedBqClient;
}

async function readBqDebriefs(prospectName: string): Promise<
  Array<{ debrief: Record<string, unknown>; writtenAt: string }>
> {
  const client = bqClient();
  if (!client) return [];
  const dataset = process.env.BIGQUERY_DATASET ?? "ranger";
  const table = process.env.BIGQUERY_TABLE ?? "debriefs";

  try {
    // Parameterized query — no injection risk from prospect input.
    const [rows] = await client.query({
      query: `
        SELECT
          meeting_id,
          summary,
          close_score,
          close_band,
          close_rationale,
          tone_overall,
          tone_signals,
          action_items,
          email_drafts,
          next_call_prep,
          open_questions,
          risks,
          transcript_chunk_count,
          generated_at
        FROM \`${client.projectId}.${dataset}.${table}\`
        WHERE prospect_name = @name
        ORDER BY generated_at DESC
        LIMIT ${MAX_RECENT_CALLS * 2}
      `,
      params: { name: prospectName },
    });

    // Rehydrate to the same shape local rows use, so briefFromRows can
    // handle both uniformly.
    return rows.map((r: Record<string, unknown>) => ({
      writtenAt:
        typeof r.generated_at === "string"
          ? r.generated_at
          : ((r.generated_at as { value?: string })?.value ?? new Date().toISOString()),
      debrief: {
        meetingId: r.meeting_id,
        summary: r.summary,
        closeLikelihood: {
          score: Number(r.close_score ?? 0),
          band: r.close_band,
          rationale: r.close_rationale,
        },
        tone: {
          overall: r.tone_overall,
          signals: (r.tone_signals as string[]) ?? [],
        },
        actionItems: ((r.action_items as Array<Record<string, unknown>>) ?? []).map((a) => ({
          owner: a.owner,
          description: a.description,
          priority: a.priority,
          dueBy: a.due_by ?? null,
        })),
        emailDrafts: (r.email_drafts as Array<Record<string, unknown>>) ?? [],
        nextCallPrep: r.next_call_prep
          ? {
              painPoints:
                ((r.next_call_prep as { pain_points?: string[] }).pain_points) ?? [],
              // normalizeThemes handles both the old BQ ARRAY<STRING> shape
              // and the new ARRAY<STRUCT> shape, so tables migrated from
              // the pre-talkingPoint DDL keep working.
              questionThemes: normalizeThemes(
                (r.next_call_prep as { question_themes?: unknown }).question_themes
              ),
              recommendedFocus:
                ((r.next_call_prep as { recommended_focus?: string }).recommended_focus) ?? "",
            }
          : undefined,
        openQuestions: (r.open_questions as string[]) ?? [],
        risks: (r.risks as string[]) ?? [],
        transcriptChunkCount: Number(r.transcript_chunk_count ?? 0),
        generatedAt:
          typeof r.generated_at === "string"
            ? r.generated_at
            : ((r.generated_at as { value?: string })?.value ?? new Date().toISOString()),
      },
    }));
  } catch (err) {
    console.warn("[briefing] BigQuery read failed:", err);
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────

const EMPTY_BRIEFING: ProspectBriefing = {
  callCount: 0,
  lastCallAt: null,
  lastCallSummary: null,
  lastCallTone: null,
  closeScoreHistory: [],
  lastCallSignals: [],
  openActionItems: [],
  recurringRisks: [],
  lastCallRisks: [],
  recentOpenQuestions: [],
};

export async function getProspectBriefing(
  prospectName: string
): Promise<ProspectBriefing> {
  if (!prospectName?.trim()) return EMPTY_BRIEFING;
  const name = prospectName.trim();

  // Prefer BigQuery when configured — it's the cross-instance store.
  if (process.env.BIGQUERY_PROJECT_ID) {
    const rows = await readBqDebriefs(name);
    if (rows.length > 0) return briefFromRows(rows, name);
    // Fall through to local in case BQ returned nothing — happens during
    // migration / first-time setup.
  }

  // Local JSONL fallback — filter by prospect name (the row carries it).
  const allRows = readLocalDebriefs();
  const matching = allRows.filter(
    (r) =>
      r.prospectName &&
      r.prospectName.toLowerCase() === name.toLowerCase()
  );
  if (matching.length === 0) return EMPTY_BRIEFING;
  // MeetingDebrief has the same keys briefFromRows reads, just with stricter
  // field types; cast through unknown is the TS-sanctioned escape hatch.
  return briefFromRows(
    matching as unknown as Array<{ debrief: Record<string, unknown>; writtenAt: string }>,
    name
  );
}

/**
 * Format the briefing as a compact block for the chat system prompt.
 * Gives Claude specific references it can cite ("on your last call you
 * committed to send the migration guide").
 */
export function formatBriefingForPrompt(
  prospectName: string,
  b: ProspectBriefing
): string {
  if (b.callCount === 0) return "";
  const L: string[] = [
    `PRE-READ BRIEF — ${prospectName} (${b.callCount} prior call${b.callCount === 1 ? "" : "s"} on record):`,
  ];
  if (b.closeScoreHistory.length > 0) {
    const trend = b.closeScoreHistory
      .map((s) => `${s.score}/${s.band}`)
      .join(" → ");
    L.push(`- Close-score trend (newest→oldest): ${trend}`);
  }
  if (b.lastCallAt) {
    L.push(`- Last call: ${b.lastCallAt.slice(0, 10)} (tone: ${b.lastCallTone ?? "?"})`);
  }
  if (b.lastCallSummary) {
    L.push(`- Last call summary: ${b.lastCallSummary}`);
  }
  if (b.openActionItems.length > 0) {
    L.push(`- Open action items from prior calls:`);
    for (const a of b.openActionItems.slice(0, 5)) {
      const due = a.dueBy ? ` (due ${a.dueBy})` : "";
      L.push(`  · [${a.owner}, ${a.priority}] ${a.description}${due}`);
    }
  }
  if (b.recurringRisks.length > 0) {
    L.push(`- Risks raised repeatedly: ${b.recurringRisks.join("; ")}`);
  }
  if (b.recentOpenQuestions.length > 0) {
    L.push(`- Still-open questions: ${b.recentOpenQuestions.join("; ")}`);
  }
  if (b.nextCallPrep?.recommendedFocus) {
    L.push(`- Planned focus for this call: ${b.nextCallPrep.recommendedFocus}`);
    if (b.nextCallPrep.painPoints.length > 0) {
      L.push(`  (known pains: ${b.nextCallPrep.painPoints.join("; ")})`);
    }
    if (b.nextCallPrep.questionThemes.length > 0) {
      L.push(`- Expected questions with talk tracks:`);
      for (const q of b.nextCallPrep.questionThemes) {
        L.push(`  · ${q.theme}${q.talkingPoint ? ` — ${q.talkingPoint}` : ""}`);
      }
    }
  }
  L.push(
    "Use this to personalize answers — reference specific prior commitments and avoid repeating questions already answered."
  );
  return L.join("\n");
}
