import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { MCP_SERVERS, SONNET_MODEL, SYSTEM_PROMPT } from "@/app/lib/constants";
import { searchSlab, getSlabPost } from "@/app/lib/slab";
import { lookupProspect, formatProspectForPrompt } from "@/app/lib/hubspot";
import { detectAllCompetitorSlugs } from "@/app/lib/competitors/detect";
import { getCompetitorCard, formatCardForPrompt } from "@/app/lib/competitors/store";
import { getProductKnowledge, formatProductKnowledgeForPrompt } from "@/app/lib/product/store";
import { getRedditSignals, formatSignalsForPrompt } from "@/app/lib/reddit-signals/store";

export const maxDuration = 60;

/** Extract keywords from the user's last message for Slab pre-search */
function extractQuery(messages: Array<{ role: string; content: string }>): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.content?.slice(0, 200) ?? "";
}

export async function POST(req: NextRequest) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { messages, prospectName } = await req.json();

  if (!messages || !Array.isArray(messages)) {
    return new Response("Bad request", { status: 400 });
  }

  // Pre-fetch Slab + HubSpot in parallel. Both use server-side REST proxies
  // (not MCP) because:
  //   - Slab's MCP host is on internal DNS Anthropic can't resolve
  //   - HubSpot's MCP requires full OAuth authorization-code flow, and we
  //     want a stand-alone app using a Private App access token
  const slabQuery = extractQuery(messages);
  const [slabResults, prospectData] = await Promise.all([
    searchSlab(slabQuery, 3),
    prospectName ? lookupProspect(prospectName) : Promise.resolve(null),
  ]);

  let slabContext = "";
  if (slabResults.length > 0) {
    const topPost = await getSlabPost(slabResults[0].id);
    slabContext = `\n\nSLAB DOCUMENTATION (pre-fetched):\n` +
      slabResults.map((r) => `- "${r.title}" (id: ${r.id})`).join("\n") +
      (topPost ? `\n\nTop result content:\n${topPost}` : "");
  }

  // Competitor battle cards + Reddit signals: scan the last user message for
  // known competitor names and inject both data layers. Battle cards are the
  // curated sales positioning; Reddit signals are raw recent customer voice
  // (refreshed daily from #z-reddigent) and let the model cite specific
  // current pain points when relevant.
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

  let hubspotContext = "";
  const prospectFound = Boolean(prospectData?.found);
  if (prospectName && prospectFound && prospectData) {
    hubspotContext =
      `\n\nHUBSPOT PROSPECT CONTEXT (pre-fetched for "${prospectName}"):\n` +
      formatProspectForPrompt(prospectData) +
      `\n\nLead your answer with this context when relevant, e.g. "For ${prospectData.companyName} (${prospectData.dealStage ?? "—"}${prospectData.dealValue ? `, ${prospectData.dealValue}` : ""}): ..."`;
  } else if (prospectName && !prospectFound) {
    hubspotContext =
      `\n\nHUBSPOT: searched for "${prospectName}" but no matching company/contact was found. Do not fabricate deal data.`;
  }

  // Product fact-sheet: injected into EVERY chat reply as the baseline
  // product-knowledge layer. Replaces the stale hardcoded PRODUCT KNOWLEDGE
  // block that used to live in constants.ts. No per-call detection — the
  // artifact is refreshed weekly by scripts/refresh-product-knowledge.ts.
  const pk = getProductKnowledge();
  const productContext = pk
    ? `\n\n${formatProductKnowledgeForPrompt(pk)}`
    : "";

  const system =
    SYSTEM_PROMPT +
    productContext +
    slabContext +
    hubspotContext +
    competitorContext +
    redditContext;

  // Stream the response back
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await client.beta.messages.create({
          model: SONNET_MODEL,
          max_tokens: 1024,
          system,
          messages,
          mcp_servers: MCP_SERVERS,
          betas: ["mcp-client-2025-04-04"],
          stream: true,
        });

        let usedSlack = false;
        // Pre-fetched sources: the "used" flag is driven by whether we actually
        // pulled data, not by what the model's output text happens to say.
        const usedSlab = slabResults.length > 0;
        const usedHubspot = prospectFound;
        let usedLinear = false;
        let fullText = "";

        for await (const event of response) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            fullText += event.delta.text;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`
              )
            );
          }

          if (event.type === "content_block_start") {
            // Anthropic surfaces MCP tool calls as `mcp_tool_use` blocks with a
            // `server_name` field matching our MCP_SERVERS config ("slack",
            // "linear"). Native `tool_use` blocks could appear in the future
            // (e.g. if we add non-MCP tools) — handle both, and prefer
            // server_name since Linear's tool names (list_issues, get_issue)
            // don't contain the word "linear".
            const block = event.content_block as {
              type: string;
              name?: string;
              server_name?: string;
            };
            if (block.type === "mcp_tool_use") {
              if (block.server_name === "slack") usedSlack = true;
              if (block.server_name === "linear") usedLinear = true;
            } else if (block.type === "tool_use") {
              if (block.name?.includes("slack")) usedSlack = true;
              if (block.name?.includes("linear")) usedLinear = true;
            }
          }
        }

        // Fallback: infer from text content if no tool_use blocks fired
        // (e.g. model paraphrased pre-fetched context, or used only native
        // knowledge). HubSpot is driven by prospectFound above — no text-
        // sniffing needed.
        const lower = fullText.toLowerCase();
        if (
          !usedSlack &&
          (lower.includes("#t-customers") ||
            lower.includes("#sales-") ||
            lower.includes("#t-integrations") ||
            lower.includes("#t-self"))
        )
          usedSlack = true;

        if (
          !usedLinear &&
          (lower.includes("linear:") ||
            (lower.includes("in progress") && lower.includes("targeting")))
        )
          usedLinear = true;

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "done", usedSlack, usedHubspot, usedSlab, usedLinear, usedCompetitor, usedReddit })}\n\n`
          )
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
