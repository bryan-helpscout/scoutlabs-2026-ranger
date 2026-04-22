/**
 * Post-call debrief generator. Takes a meeting ID (and optional prospect
 * name), loads the full transcript + surfaced cards, and asks Sonnet to
 * produce a structured debrief.
 *
 * Reuses the shared chat-context assembly so email drafts quote fresh
 * pricing, accurate feature names, and personalize to the HubSpot prospect
 * when one is loaded.
 */

import Anthropic from "@anthropic-ai/sdk";
import { SONNET_MODEL } from "@/app/lib/constants";
import { getMeetingSnapshot } from "@/app/lib/transcript-store";
import { assembleChatContext } from "@/app/lib/chat-context";
import type { MeetingDebrief } from "./schema";

const MAX_TRANSCRIPT_CHARS = 25_000;

const SYSTEM = `You are an expert sales call analyst producing a POST-CALL DEBRIEF for a Help Scout Account Executive (AE). The AE wants to scan your output in under 60 seconds and act on it — so specificity beats completeness.

You're given:
  - TRANSCRIPT: the speaker-tagged call transcript (prospect + AE alternating)
  - SURFACED_CONTEXT: baseline product facts, competitor battle cards (if the
    prospect mentioned one), Reddit signals, and HubSpot prospect context (if
    the AE had a prospect loaded)
  - PROSPECT_NAME (optional): the contact the AE is primarily talking to;
    use this to personalize email drafts

RULES:
- Be honest. If the call was lukewarm, don't inflate the score. If the
  prospect raised a real concern, flag it in "risks" — the AE needs to know.
- Cite specific tier / price / feature numbers from SURFACED_CONTEXT. Never
  invent pricing or features.
- Email drafts should be short (4–8 sentences), specific, and ready to send
  with minor edits. No "I hope this email finds you well" filler. Lead with
  the commitment you made on the call; attach relevant URLs from SURFACED_CONTEXT.
- Tone signals should be concrete: actual quotes or observable behaviors
  (e.g. "asked three detailed questions about SAML setup" not "seemed engaged").
- Action items: use the owner field honestly. "ae" = we committed to do it.
  "prospect" = they said they'd do it. "team" = needs a handoff to SE / CS /
  PM. Priority based on what would kill the deal if missed.
- Close score is a 0–100 gut-check based on: (a) depth of technical questions,
  (b) explicit buying signals ("when could you onboard?", "what's the contract
  length?"), (c) competitor evaluation stage, (d) timing pressure the prospect
  is under. Band mapping: 0–30 cold, 31–55 warm, 56–80 hot, 81+ ready to close.
- If the transcript is too short or generic to draw real conclusions, say so
  in the rationale and use a low score — don't make things up.

ALSO produce a "nextCallPrep" — concrete guidance for the AE's NEXT call:
- painPoints: 2–4 specific customer pain points SURFACED IN THIS CALL (not generic — e.g. "Zendesk renewal cost pressure from CFO", not "cost"). If prior-call context is present in SURFACED_CONTEXT, use it to confirm which pains are recurring vs newly raised.
- questionThemes: 2–4 items. Each is a pair {theme, talkingPoint}:
    • theme: short phrase describing the question type ("SSO compliance setup", "migration timeline", "reference customers at our size")
    • talkingPoint: 1–2 sentences the AE can actually say in response. Use specific product facts / numbers / URLs from SURFACED_CONTEXT. When prior-call context shows the AE already committed to sending something, reference that commitment.
    • Example:
        {
          "theme": "Migration timeline for 80k conversations",
          "talkingPoint": "Typical 2–3 week migration for 45-agent teams — Import2 handles conversation data, our native importer handles Docs/KB. I'd loop in an SE to validate exact scope before committing to a hard date."
        }
    • The talkingPoint should NOT just restate the theme. It should be SOMETHING TO SAY.
- recommendedFocus: 2–3 sentences of ACTIONABLE advice for the next call. Examples:
    • "Lead with the cost-savings math — the CFO is the constraint. Have 2–3 reference customers queued up before the call. Don't re-explain the product; they already understand the value."
    • "Start with the SAML walkthrough since IT is joining. Avoid the AI features detour — they explicitly said not relevant. Close by asking who else needs sign-off beyond the VP."
  Be specific and punchy. If this is the FIRST call, focus on qualifying questions to ask next time.

OUTPUT JSON ONLY (no markdown fences, no prose):
{
  "summary": "<2-4 sentence recap>",
  "tone": {
    "overall": "positive" | "neutral" | "cautious" | "negative",
    "signals": ["<concrete signal quotes/observations>", "..."]
  },
  "closeLikelihood": {
    "score": <0-100 integer>,
    "band": "cold" | "warm" | "hot" | "ready to close",
    "rationale": "<one sentence>"
  },
  "actionItems": [
    { "owner": "ae" | "prospect" | "team", "description": "<what>", "priority": "high" | "medium" | "low", "dueBy": "<date/soon/null>" }
  ],
  "emailDrafts": [
    { "purpose": "<short label>", "subject": "<email subject>", "body": "<plain-text body>" }
  ],
  "nextCallPrep": {
    "painPoints": ["<2-4 specific pains>"],
    "questionThemes": [
      { "theme": "<short question type>", "talkingPoint": "<1-2 sentences the AE can say>" }
    ],
    "recommendedFocus": "<2-3 actionable sentences>"
  },
  "openQuestions": ["<prospect question left unanswered>", "..."],
  "risks": ["<deal risk>", "..."]
}`;

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export async function generateDebrief(
  meetingId: string,
  opts: { prospectName?: string | null } = {}
): Promise<MeetingDebrief> {
  const snapshot = getMeetingSnapshot(meetingId);
  const chunks = snapshot.chunks;

  if (chunks.length === 0) {
    throw new Error(`No transcript recorded for meetingId="${meetingId}"`);
  }

  const transcript = chunks
    .map((c) => `[${c.speaker}] ${c.text}`)
    .join("\n")
    .slice(-MAX_TRANSCRIPT_CHARS);

  // Pull in the shared context (product facts + any competitor cards
  // triggered by mentions in the transcript + HubSpot prospect if loaded).
  // We pass the transcript as one synthetic user message for context-
  // assembly purposes — its competitor-detection + HubSpot-lookup logic
  // keys off text content, so this gives us the right surfaces.
  const { system: sharedContext } = await assembleChatContext({
    messages: [{ role: "user", content: transcript.slice(0, 4000) }],
    prospectName: opts.prospectName ?? null,
  });

  const prospectHint = opts.prospectName
    ? `\n\nPROSPECT_NAME: ${opts.prospectName}`
    : "";

  const userMessage =
    `TRANSCRIPT (${chunks.length} chunks, newest last):\n` +
    transcript +
    prospectHint +
    `\n\nSURFACED_CONTEXT (baseline product facts, battle cards if relevant, HubSpot if loaded):\n` +
    sharedContext +
    `\n\nProduce the debrief JSON now.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 3000,
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();
  const json = extractFirstJsonObject(raw);
  if (!json) {
    throw new Error(`Model response had no JSON object: ${raw.slice(0, 200)}`);
  }

  const parsed = JSON.parse(json) as Omit<
    MeetingDebrief,
    "meetingId" | "generatedAt" | "transcriptChunkCount"
  >;

  // Light sanity defaults so the UI never crashes on a missing field.
  return {
    meetingId,
    summary: parsed.summary ?? "(no summary generated)",
    tone: parsed.tone ?? { overall: "neutral", signals: [] },
    closeLikelihood: parsed.closeLikelihood ?? {
      score: 0,
      band: "cold",
      rationale: "Debrief incomplete.",
    },
    actionItems: parsed.actionItems ?? [],
    emailDrafts: parsed.emailDrafts ?? [],
    nextCallPrep: parsed.nextCallPrep ?? {
      painPoints: [],
      questionThemes: [],
      recommendedFocus: "",
    },
    openQuestions: parsed.openQuestions ?? [],
    risks: parsed.risks ?? [],
    generatedAt: new Date().toISOString(),
    transcriptChunkCount: chunks.length,
  };
}
