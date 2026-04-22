import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { MCP_SERVERS, SONNET_MODEL } from "@/app/lib/constants";
import { assembleChatContext } from "@/app/lib/chat-context";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { messages, prospectName } = await req.json();

  if (!messages || !Array.isArray(messages)) {
    return new Response("Bad request", { status: 400 });
  }

  // Assemble system prompt + baseline source flags. This is shared with
  // /api/slack/command (and any future ask-Ranger surfaces) so both use
  // the same brain.
  const { system, flags } = await assembleChatContext({ messages, prospectName });
  const { usedSlab, usedHubspot, usedCompetitor, usedReddit } = flags;

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
            // Anthropic surfaces MCP tool calls as `mcp_tool_use` blocks with
            // a `server_name` field matching our MCP_SERVERS config ("slack",
            // "linear"). Linear's tool names (list_issues, get_issue) don't
            // contain the word "linear", so server_name is the correct key.
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

        // Fallback: infer from text content if no tool_use blocks fired.
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
            `data: ${JSON.stringify({
              type: "done",
              usedSlack,
              usedHubspot,
              usedSlab,
              usedLinear,
              usedCompetitor,
              usedReddit,
            })}\n\n`
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
