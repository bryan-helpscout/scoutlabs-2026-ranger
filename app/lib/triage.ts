/**
 * Live-call triage loop. Given recent transcript chunks, asks Haiku whether
 * there's a specific topic we should surface docs for. If yes, fires the
 * corresponding searches and emits Card events to the meeting's SSE stream.
 *
 * Event-driven cadence (not fixed interval):
 *   - Trigger when >= MIN_WORDS new words have arrived since last triage, OR
 *   - When >= MIN_INTERVAL_MS have elapsed AND new content exists
 *   - Hard floor of MIN_INTERVAL_MS between triage runs
 *
 * Self-tunes: fast conversation → quick surfacing. Silence → idle. No wasted
 * Haiku calls on "uh, right, yeah, so, okay" small talk (the model itself is
 * prompted to return {trigger:false} for that).
 */

import Anthropic from "@anthropic-ai/sdk";
import { searchSlab } from "@/app/lib/slab";
import { searchSlack } from "@/app/lib/slack-search";
import { searchLinear } from "@/app/lib/linear-search";
import { detectAllCompetitorSlugs } from "@/app/lib/competitors/detect";
import { getCompetitorCard, formatCardForPrompt as formatCompetitorForPrompt } from "@/app/lib/competitors/store";
import { getCompetitorConfig } from "@/app/lib/competitors/config";
import { getRedditSignals, topSignals } from "@/app/lib/reddit-signals/store";
import {
  getProductKnowledge,
  formatProductKnowledgeForPrompt,
} from "@/app/lib/product/store";
import {
  addCard,
  Card,
  emitTriagePhase,
  getMutableState,
  getRecentTranscript,
  markQuerySurfaced,
  wasQueryRecentlySurfaced,
} from "@/app/lib/transcript-store";

// Env-tunable cadence — see .env.example
const MIN_WORDS = Number(process.env.TRIAGE_MIN_WORDS ?? 12);
const MIN_INTERVAL_MS = Number(process.env.TRIAGE_MIN_INTERVAL_MS ?? 1200);
const TRANSCRIPT_WINDOW_MS = Number(process.env.TRIAGE_WINDOW_MS ?? 30_000);
// Intentionally inlined rather than importing from constants.ts — lets this
// file stay self-contained and makes the triage cadence+model easy to tune
// from one place without touching the chat route.
const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "claude-haiku-4-5";

const TRIAGE_SYSTEM = `You are a real-time triage assistant on a LIVE B2B SaaS sales call for Help Scout.

Your job: decide whether the RECENT transcript (last ~30s) contains a specific, lookup-worthy topic that deserves surfacing information to the Account Executive RIGHT NOW. Be selective — false positives break the AE's concentration.

SURFACE when the prospect or AE mentions any of:
  - a specific Help Scout feature, integration, or API (webhooks, Beacon, Docs, Workflows, Salesforce, etc.)
  - a specific competitor by name (Zendesk, Intercom, Freshdesk, Front, Gorgias)
  - a concrete technical question (rate limits, SSO, SAML, HIPAA, data residency, migration)
  - a pricing/packaging question tied to a tier or feature
  - a specific objection that likely has an existing answer
  - a roadmap/timing question ("when will X ship", "is Y on the roadmap")

DO NOT surface for:
  - greetings, filler, hold music, "can you hear me", scheduling talk
  - vague generalities ("we want better support")
  - topics already listed under RECENTLY_SURFACED

When you decide to surface, emit search queries for the right source(s):
  - slab_query: official Help Scout documentation — feature specs, runbooks, how-tos, pricing, security/compliance details. Use 2–6 descriptive words.
  - slack_query: past team discussions — ad-hoc customer Q&A, workaround threads, "how have we answered this before". Use short keyword-style queries (2–5 words, no quotes, no punctuation).
  - linear_query: engineering roadmap — only when the prospect asks about delivery timing or in-flight work. Use the feature/project name (1–4 words).

ALSO — and this is the key field for the AE — emit a "question": a concrete lookup-worthy phrasing of what's actually being asked (5–12 words, ending with "?"). Examples:
  - "Does SAML SSO work with Okta, and on which plan?"
  - "What are Help Scout's API rate limits per tier?"
  - "How does pricing compare to Zendesk for a 20-person team?"

If the moment doesn't have a crisp answerable question (e.g. they only mentioned a competitor name without an explicit question), set "question" to null — the competitor battle card will handle positioning on its own.

Return null for any source that doesn't apply. Returning only one is fine; returning all three is fine when each is genuinely useful.

Output ONLY a JSON object, no markdown fences, no prose:
  {"trigger": false}
or
  {"trigger": true,
   "reason": "<10 words max>",
   "question": "<crisp question string ending in '?', or null>",
   "slab_query": "<query>" | null,
   "slack_query": "<query>" | null,
   "linear_query": "<query>" | null}`;

interface TriageDecision {
  trigger: boolean;
  reason?: string;
  /** Concrete lookup-worthy phrasing of what's being asked — drives the
   *  Answer card synthesis. null when the transcript has no crisp question. */
  question?: string | null;
  slab_query?: string | null;
  slack_query?: string | null;
  linear_query?: string | null;
}

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

/**
 * Called by the ingest endpoint after every new chunk. Coalesces concurrent
 * triage into a single run per meeting and enforces the cadence rules.
 */
export function maybeRunTriage(meetingId: string): void {
  const state = getMutableState(meetingId);
  const now = Date.now();

  if (state.triageInFlight) return;
  if (state.chunks.length === 0) return;

  const enoughWords = state.wordsSinceTriage >= MIN_WORDS;
  const enoughTime = now - state.lastTriageAt >= MIN_INTERVAL_MS && state.wordsSinceTriage > 0;
  if (!enoughWords && !enoughTime) return;
  // Hard floor — even if MIN_WORDS hit, never spin faster than this.
  if (now - state.lastTriageAt < MIN_INTERVAL_MS) return;

  state.triageInFlight = true;
  state.lastTriageAt = now;
  state.wordsSinceTriage = 0;

  // Fire-and-forget — ingest must return immediately.
  runTriage(meetingId)
    .catch((err) => console.error("[triage] run failed:", err))
    .finally(() => {
      state.triageInFlight = false;
    });
}

async function runTriage(meetingId: string): Promise<void> {
  const recent = getRecentTranscript(meetingId, TRANSCRIPT_WINDOW_MS);
  if (recent.length === 0) return;

  emitTriagePhase(meetingId, "running");
  try {
    // ── Fast-path: regex-match known competitor names in the transcript
    // before we even hit Haiku. Stored battle cards surface in <10ms and
    // have way more signal than any search result.
    const transcriptText = recent.map((c) => c.text).join(" ");
    const competitorSlugs = detectAllCompetitorSlugs(transcriptText);
    const competitorCardsArrays = await Promise.all(
      competitorSlugs.map((slug) => surfaceCompetitor(meetingId, slug))
    );
    const competitorCards = competitorCardsArrays.flat();

    const decision = await decide(meetingId, recent);
    if (!decision.trigger) return;

    // Fan out to search sources in parallel. A slow Slack API shouldn't
    // gate Slab or Linear cards from reaching the panel. Each surface
    // function returns the cards it actually emitted (after dedup), so we
    // can pass the complete set into the synthesis step below.
    const [slabCards, slackCards, linearCards] = await Promise.all([
      decision.slab_query
        ? surfaceSlab(meetingId, decision.slab_query, decision.reason)
        : Promise.resolve<Card[]>([]),
      decision.slack_query
        ? surfaceSlack(meetingId, decision.slack_query, decision.reason)
        : Promise.resolve<Card[]>([]),
      decision.linear_query
        ? surfaceLinear(meetingId, decision.linear_query, decision.reason)
        : Promise.resolve<Card[]>([]),
    ]);

    // Synthesize an Answer card on top. This is the "here's the question,
    // here's the answer in 2-4 sentences" view the AE relays verbatim.
    // We require a clear question AND some grounding (either search results
    // or competitor intel, or at minimum the baseline product facts).
    const sourceCards = [
      ...slabCards,
      ...slackCards,
      ...linearCards,
      ...competitorCards,
    ];
    if (decision.question) {
      await surfaceAnswer(meetingId, decision.question, sourceCards, decision.reason);
    }
  } finally {
    emitTriagePhase(meetingId, "idle");
  }
}

async function decide(meetingId: string, chunks: ReturnType<typeof getRecentTranscript>): Promise<TriageDecision> {
  const transcriptText = chunks
    .map((c) => `[${c.speaker}] ${c.text}`)
    .join("\n")
    .slice(-3000); // cap input size

  // Show the model what we've already surfaced so it doesn't repeat itself.
  const state = getMutableState(meetingId);
  const recentQueries = [...state.surfacedQueryKeys.entries()]
    .filter(([, t]) => Date.now() - t < 120_000)
    .map(([k]) => k)
    .slice(-10);
  const recentlySurfaced =
    recentQueries.length === 0 ? "(none yet)" : recentQueries.join(", ");

  try {
    const res = await getClient().messages.create({
      model: TRIAGE_MODEL,
      max_tokens: 120,
      system: TRIAGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `RECENT_TRANSCRIPT:\n${transcriptText}\n\nRECENTLY_SURFACED: ${recentlySurfaced}\n\nDecide now.`,
        },
      ],
    });
    const raw = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();
    // Haiku occasionally adds trailing prose after the JSON, or code fences.
    // Pull the first balanced {...} block out of the response to stay robust.
    const jsonText = extractFirstJsonObject(raw);
    if (!jsonText) return { trigger: false };
    const parsed = JSON.parse(jsonText) as TriageDecision;
    if (typeof parsed.trigger !== "boolean") return { trigger: false };
    return parsed;
  } catch (err) {
    console.error("[triage] decide failed:", err);
    return { trigger: false };
  }
}

// ── Answer synthesis ───────────────────────────────────────────────────────

const ANSWER_SYSTEM = `You synthesize a tight answer for a sales Account Executive during a LIVE call. The AE will read your answer in ~2 seconds and paraphrase it to the prospect, so specificity and brevity matter.

You receive:
  - QUESTION: the concrete question being asked (inferred from the transcript)
  - SOURCES: snippets we just pulled from Slab (internal docs), Slack (past team discussions), Linear (roadmap), competitor battle cards, and Reddit signals
  - PRODUCT_FACTS: Help Scout's current pricing, features, and URLs (source of truth for any numbers)

Rules:
  - 2–4 sentences. Lead with the direct answer — NO "great question" filler, no preamble.
  - Cite specific tiers / prices / numbers when PRODUCT_FACTS or SOURCES support them. No vague "affordable" or "enterprise-grade".
  - If sources disagree or are thin, say so honestly — "Slab docs say X but team discussion suggests Y".
  - Do NOT name "Slack" or "Reddit" in the answer — say "we've seen the team answer this before" or "users frequently report" instead. The AE shouldn't have to filter internal sourcing out when paraphrasing.
  - If PRODUCT_FACTS contradicts an old SOURCE (e.g. pricing shifted), trust PRODUCT_FACTS.
  - If the question is really a competitor-positioning question and a battle-card source is present, lean on its pivots.

Output ONLY a JSON object, no markdown fences:
  {"answer": "<2-4 sentence answer>"}

If the question genuinely can't be answered from the available sources + PRODUCT_FACTS, return:
  {"answer": "Not enough in the available sources to answer this confidently — worth flagging to the prospect that you'll follow up."}`;

interface AnswerDecision {
  answer: string;
}

/** Short human-readable label for a source card (appears on the Answer card's
 *  "Based on: ..." attribution line). */
function attributionLabel(s: Card["source"]): string {
  switch (s) {
    case "slab": return "Slab";
    case "slack": return "team discussions";
    case "linear": return "Linear";
    case "competitor": return "battle card";
    case "reddit": return "user signals";
    case "hubspot": return "HubSpot";
    case "answer": return "";
  }
}

async function surfaceAnswer(
  meetingId: string,
  question: string,
  sourceCards: Card[],
  reason?: string
): Promise<void> {
  // Dedup by normalized question text — same question within 90s doesn't
  // re-synthesize. Different phrasing → new answer.
  const qKey = `answer:${question.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim()}`;
  if (wasQueryRecentlySurfaced(meetingId, "answer", qKey, 90_000)) return;
  markQuerySurfaced(meetingId, "answer", qKey);

  // Build source blob — titles + snippets only. Cap per-card to avoid blowing
  // out Haiku's context; we're aiming for speed here.
  const MAX_PER_CARD = 400;
  const MAX_BLOB = 6000;
  let blob = "";
  for (const c of sourceCards) {
    const s = c.snippet ? `: ${c.snippet.slice(0, MAX_PER_CARD)}` : "";
    const line = `- [${c.source}] ${c.title}${s}\n`;
    if (blob.length + line.length > MAX_BLOB) break;
    blob += line;
  }

  const pk = getProductKnowledge();
  const productFactsBlock = pk ? `\n\nPRODUCT_FACTS:\n${formatProductKnowledgeForPrompt(pk)}` : "";

  try {
    const res = await getClient().messages.create({
      model: TRIAGE_MODEL,
      max_tokens: 400,
      system: ANSWER_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `QUESTION: ${question}\n\nSOURCES:\n${blob || "(none — rely on PRODUCT_FACTS)"}${productFactsBlock}\n\nReturn the JSON now.`,
        },
      ],
    });

    const raw = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();
    const jsonText = extractFirstJsonObject(raw);
    if (!jsonText) return;
    const parsed = JSON.parse(jsonText) as AnswerDecision;
    if (!parsed.answer || typeof parsed.answer !== "string") return;

    // Attribution: unique list of source kinds, in a sensible order.
    const refs = Array.from(
      new Set(sourceCards.map((c) => attributionLabel(c.source)).filter(Boolean))
    );
    if (pk && refs.indexOf("product facts") === -1) refs.push("product facts");

    addCard(meetingId, {
      id: qKey,
      source: "answer",
      title: question,
      snippet: parsed.answer,
      question,
      sourceRefs: refs,
      triggeredBy: reason,
      surfacedAt: Date.now(),
    });
  } catch (err) {
    console.error("[triage] answer synthesis failed:", err);
  }
}

// Silence the unused-import warning for now — formatCompetitorForPrompt is
// imported in case we later want to inject full battle cards into synthesis.
void formatCompetitorForPrompt;

/** Scan for the first balanced {...} object, tolerating prose/fences around it. */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

async function surfaceSlab(meetingId: string, query: string, reason?: string): Promise<Card[]> {
  if (wasQueryRecentlySurfaced(meetingId, "slab", query)) return [];
  markQuerySurfaced(meetingId, "slab", query);

  const surfaced: Card[] = [];
  const results = await searchSlab(query, 3);
  for (const r of results) {
    const card: Card = {
      id: `slab:${r.id}`,
      source: "slab",
      title: r.title,
      triggeredBy: reason,
      surfacedAt: Date.now(),
    };
    if (addCard(meetingId, card)) surfaced.push(card);
  }
  return surfaced;
}

async function surfaceSlack(meetingId: string, query: string, reason?: string): Promise<Card[]> {
  if (wasQueryRecentlySurfaced(meetingId, "slack", query)) return [];
  markQuerySurfaced(meetingId, "slack", query);

  const surfaced: Card[] = [];
  const results = await searchSlack(query, 3);
  for (const r of results) {
    const channel = r.channelName ? `#${r.channelName}` : "slack";
    const card: Card = {
      id: `slack:${r.channelId}:${r.ts}`,
      source: "slack",
      title: `${channel} · @${r.username}`,
      snippet: r.text.slice(0, 200),
      url: r.permalink || undefined,
      triggeredBy: reason,
      surfacedAt: Date.now(),
    };
    if (addCard(meetingId, card)) surfaced.push(card);
  }
  return surfaced;
}

async function surfaceCompetitor(meetingId: string, slug: string): Promise<Card[]> {
  // Dedup per meeting — once a competitor has been surfaced, don't re-emit
  // the same card every time the name gets mentioned again. The card stays
  // visible in the panel for the whole call.
  if (wasQueryRecentlySurfaced(meetingId, "competitor", slug, 30 * 60_000)) return [];
  markQuerySurfaced(meetingId, "competitor", slug);

  const card = getCompetitorCard(slug);
  const cfg = getCompetitorConfig(slug);
  if (!card || !cfg) return [];

  const surfaced: Card[] = [];

  // Pack the most scannable signal into the card's snippet: positioning +
  // the top 2 advantages. Full card is available via "Ask Ranger →".
  const topAdvantages = card.ourAdvantages.slice(0, 2).join(" · ");
  const snippet = topAdvantages
    ? `${card.positioning}\n\n${topAdvantages}`
    : card.positioning;

  const compCard: Card = {
    id: `competitor:${slug}`,
    source: "competitor",
    title: `vs ${card.name}`,
    snippet,
    triggeredBy: `Prospect mentioned ${card.name}`,
    surfacedAt: Date.now(),
  };
  if (addCard(meetingId, compCard)) surfaced.push(compCard);

  // Alongside the battle card, surface the top Reddit signals as individual
  // cards — gives the AE the raw customer voice + Reddit URLs for context,
  // not just the synthesized positioning. Dedup is via card.id, so these
  // won't re-surface if the same signal was already shown.
  const signals = getRedditSignals(slug);
  if (signals && signals.signals.length > 0) {
    for (const s of topSignals(signals, 2)) {
      const redditCard: Card = {
        id: `reddit:${s.postUrl || s.reason.slice(0, 60)}`,
        source: "reddit",
        title: `Reddit · ${card.name} · ${s.urgency} urgency`,
        snippet: s.reason,
        url: s.postUrl || undefined,
        triggeredBy: `Prospect mentioned ${card.name}`,
        surfacedAt: Date.now(),
      };
      if (addCard(meetingId, redditCard)) surfaced.push(redditCard);
    }
  }

  return surfaced;
}

async function surfaceLinear(meetingId: string, query: string, reason?: string): Promise<Card[]> {
  if (wasQueryRecentlySurfaced(meetingId, "linear", query)) return [];
  markQuerySurfaced(meetingId, "linear", query);

  const surfaced: Card[] = [];
  const results = await searchLinear(query, 3);
  for (const r of results) {
    const metaParts = [r.stateName, r.projectName].filter(Boolean);
    const card: Card = {
      id: `linear:${r.identifier}`,
      source: "linear",
      title: `${r.identifier}: ${r.title}`,
      snippet: metaParts.join(" · ") || undefined,
      url: r.url || undefined,
      triggeredBy: reason,
      surfacedAt: Date.now(),
    };
    if (addCard(meetingId, card)) surfaced.push(card);
  }
  return surfaced;
}
