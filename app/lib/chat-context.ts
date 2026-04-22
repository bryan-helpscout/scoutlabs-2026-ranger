/**
 * Assembles the system prompt for a chat request by pre-fetching every data
 * source Ranger uses as "baseline context": product facts, Slab search,
 * competitor battle cards, Reddit signals, and HubSpot prospect lookup.
 *
 * Extracted from /api/chat/route.ts so the Slack slash command (and any
 * future surfaces — /ask, email-in, etc.) share the exact same brain
 * without drift between them.
 */

import { SYSTEM_PROMPT } from "@/app/lib/constants";
import { searchSlab, getSlabPost } from "@/app/lib/slab";
import { lookupProspect, formatProspectForPrompt } from "@/app/lib/hubspot";
import { detectAllCompetitorSlugs } from "@/app/lib/competitors/detect";
import { getCompetitorCard, formatCardForPrompt } from "@/app/lib/competitors/store";
import {
  getProductKnowledge,
  formatProductKnowledgeForPrompt,
} from "@/app/lib/product/store";
import { getRedditSignals, formatSignalsForPrompt } from "@/app/lib/reddit-signals/store";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContextInput {
  messages: ChatMessage[];
  /** If set, HubSpot is queried for this company/contact and injected. */
  prospectName?: string | null;
}

export interface ChatContextResult {
  /** Fully assembled system prompt ready to send to Anthropic. */
  system: string;
  /** "Was this data source actually contributing?" flags — consumers use
   *  these to drive UI source pills or Slack attribution lines. */
  flags: {
    usedSlab: boolean;
    usedHubspot: boolean;
    usedCompetitor: boolean;
    usedReddit: boolean;
  };
}

/** Extract keywords from the user's last message for Slab pre-search. */
function extractQuery(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.content?.slice(0, 200) ?? "";
}

export async function assembleChatContext(
  input: ChatContextInput
): Promise<ChatContextResult> {
  const { messages, prospectName } = input;

  const slabQuery = extractQuery(messages);
  const [slabResults, prospectData] = await Promise.all([
    searchSlab(slabQuery, 3),
    prospectName ? lookupProspect(prospectName) : Promise.resolve(null),
  ]);

  // Slab context — top 3 titles + the full text of the top result (capped).
  let slabContext = "";
  if (slabResults.length > 0) {
    const topPost = await getSlabPost(slabResults[0].id);
    slabContext =
      `\n\nSLAB DOCUMENTATION (pre-fetched):\n` +
      slabResults.map((r) => `- "${r.title}" (id: ${r.id})`).join("\n") +
      (topPost ? `\n\nTop result content:\n${topPost}` : "");
  }

  // Competitor battle cards + Reddit signals — triggered by name mentions
  // in the user's message.
  const lastUserText = extractQuery(messages);
  const mentionedSlugs = detectAllCompetitorSlugs(lastUserText);
  const mentionedCompetitors = mentionedSlugs
    .map((slug) => getCompetitorCard(slug))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const mentionedSignals = mentionedSlugs
    .map((slug) => getRedditSignals(slug))
    .filter((s): s is NonNullable<typeof s> => s !== null && s.signals.length > 0);
  const usedCompetitor = mentionedCompetitors.length > 0;
  const usedReddit = mentionedSignals.length > 0;

  let competitorContext = "";
  if (usedCompetitor) {
    competitorContext =
      `\n\nCOMPETITOR BATTLE CARDS (pre-fetched because the AE's message mentioned these competitors):\n\n` +
      mentionedCompetitors
        .map((c) => `━━━ vs ${c.name} ━━━\n${formatCardForPrompt(c)}`)
        .join("\n\n") +
      `\n\nUse these as your primary source for competitive positioning; they already reflect both the competitor's public claims AND internal Help Scout team discussions. Lead with our advantages, acknowledge their real strengths, and offer the AE concrete pivot language.`;
  }

  let redditContext = "";
  if (usedReddit) {
    redditContext =
      `\n\n` + mentionedSignals.map((s) => formatSignalsForPrompt(s)).join("\n\n");
  }

  // HubSpot prospect context — injected when prospectName resolves to a
  // real company/contact in HubSpot.
  let hubspotContext = "";
  const prospectFound = Boolean(prospectData?.found);
  if (prospectName && prospectFound && prospectData) {
    hubspotContext =
      `\n\nHUBSPOT PROSPECT CONTEXT (pre-fetched for "${prospectName}"):\n` +
      formatProspectForPrompt(prospectData) +
      `\n\nLead your answer with this context when relevant, e.g. "For ${prospectData.companyName} (${prospectData.dealStage ?? "—"}${prospectData.dealValue ? `, ${prospectData.dealValue}` : ""}): ..."`;
  } else if (prospectName && !prospectFound) {
    hubspotContext = `\n\nHUBSPOT: searched for "${prospectName}" but no matching company/contact was found. Do not fabricate deal data.`;
  }

  // Product fact-sheet — injected into EVERY reply as the baseline
  // product-knowledge layer (refreshed weekly via CI).
  const pk = getProductKnowledge();
  const productContext = pk ? `\n\n${formatProductKnowledgeForPrompt(pk)}` : "";

  const system =
    SYSTEM_PROMPT +
    productContext +
    slabContext +
    hubspotContext +
    competitorContext +
    redditContext;

  return {
    system,
    flags: {
      usedSlab: slabResults.length > 0,
      usedHubspot: prospectFound,
      usedCompetitor,
      usedReddit,
    },
  };
}
