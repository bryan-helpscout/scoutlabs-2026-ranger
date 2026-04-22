/**
 * Slack slash command handler for /ranger.
 *
 * Flow:
 *   1. Slack POSTs form-encoded body with `command`, `text`, `user_id`,
 *      `channel_id`, `response_url`, `X-Slack-Signature`,
 *      `X-Slack-Request-Timestamp`.
 *   2. We verify the HMAC signature with SLACK_SIGNING_SECRET.
 *   3. We must respond within 3 seconds — return a quick "Thinking…" ack,
 *      then use `after()` to continue processing after the response is sent.
 *   4. The background work calls our shared `assembleChatContext` brain
 *      (same logic the web chat uses) + Anthropic non-streaming, then POSTs
 *      the final answer to `response_url`.
 *
 * Slack app setup (one-time, by an admin):
 *   - api.slack.com/apps → Create → "Ranger" → From scratch
 *   - Features → Slash Commands → New: /ranger
 *       Request URL: https://<deployed-ranger>/api/slack/command
 *       Short description: "Ask Ranger any sales question"
 *       Usage hint: "[your question]"
 *   - Basic Information → Signing Secret → copy into SLACK_SIGNING_SECRET
 *   - Install App → Install to Workspace
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { MCP_SERVERS, SONNET_MODEL } from "@/app/lib/constants";
import { assembleChatContext } from "@/app/lib/chat-context";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Verify the Slack request signature per:
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Returns true if the signature is valid AND the timestamp is within 5
 * minutes (replay-attack guard).
 */
function verifySlackSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  signingSecret: string
): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(base).digest("hex");

  // timingSafeEqual needs equal-length buffers
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface SlackFormParams {
  command: string;
  text: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  channel_name: string;
  response_url: string;
  team_domain: string;
}

function parseSlackBody(raw: string): SlackFormParams {
  const params = new URLSearchParams(raw);
  return {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    user_id: params.get("user_id") ?? "",
    user_name: params.get("user_name") ?? "",
    channel_id: params.get("channel_id") ?? "",
    channel_name: params.get("channel_name") ?? "",
    response_url: params.get("response_url") ?? "",
    team_domain: params.get("team_domain") ?? "",
  };
}

/**
 * Turn the used-source flags into a short attribution line Slack users can
 * glance at without clicking into the reply.
 */
function formatSources(flags: {
  usedSlack: boolean;
  usedSlab: boolean;
  usedLinear: boolean;
  usedCompetitor: boolean;
  usedReddit: boolean;
}): string {
  const bits: string[] = [];
  if (flags.usedSlab) bits.push("Slab");
  if (flags.usedSlack) bits.push("Slack");
  if (flags.usedLinear) bits.push("Linear");
  if (flags.usedCompetitor) bits.push("battle card");
  if (flags.usedReddit) bits.push("user signals");
  if (bits.length === 0) return "";
  return `\n\n_Sources: ${bits.join(" · ")}_`;
}

/** Post the final answer (or an error) back to Slack via response_url. */
async function postReply(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel", // everyone in the channel sees it
        text,
      }),
    });
  } catch (err) {
    console.error("[slack-command] failed to post reply:", err);
  }
}

/**
 * Non-streaming Anthropic call that consumes the same assembled system
 * prompt the web chat uses. Returns the final text + used-source flags.
 */
async function generateAnswer(userQuestion: string): Promise<{ text: string; flags: Awaited<ReturnType<typeof assembleChatContext>>["flags"] & { usedSlack: boolean; usedLinear: boolean } }> {
  const { system, flags } = await assembleChatContext({
    messages: [{ role: "user", content: userQuestion }],
    prospectName: null,
  });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userQuestion }],
    mcp_servers: MCP_SERVERS,
    betas: ["mcp-client-2025-04-04"],
  });

  let text = "";
  let usedSlack = false;
  let usedLinear = false;
  for (const block of response.content) {
    // text blocks get concatenated into the final answer
    if (block.type === "text") text += block.text;
    // Detect MCP tool use for the sources footer
    const maybeMcp = block as { type: string; server_name?: string };
    if (maybeMcp.type === "mcp_tool_use") {
      if (maybeMcp.server_name === "slack") usedSlack = true;
      if (maybeMcp.server_name === "linear") usedLinear = true;
    }
  }

  return {
    text: text.trim(),
    flags: { ...flags, usedSlack, usedLinear },
  };
}

// ── main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("[slack-command] SLACK_SIGNING_SECRET not set");
    return NextResponse.json(
      { response_type: "ephemeral", text: "⚠️ Ranger isn't configured — SLACK_SIGNING_SECRET is missing on the server." },
      { status: 200 }
    );
  }

  // Read the raw body BEFORE parsing — signature verification needs the
  // exact bytes Slack sent, not a re-serialized form.
  const rawBody = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!verifySlackSignature(rawBody, signature, timestamp, signingSecret)) {
    console.warn("[slack-command] signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  const params = parseSlackBody(rawBody);
  const question = params.text?.trim();

  if (!question) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/ranger <your question>` — e.g. `/ranger what plan has SAML SSO?`",
    });
  }

  // Kick off the real work in the background. `after()` keeps the
  // function instance alive (on Vercel) until the promise resolves.
  after(async () => {
    try {
      const { text, flags } = await generateAnswer(question);
      const body =
        `*@${params.user_name}* asked: _${question}_\n\n` +
        (text || "⚠️ No response — please try again.") +
        formatSources(flags);
      await postReply(params.response_url, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await postReply(
        params.response_url,
        `⚠️ Ranger hit an error: ${msg}`
      );
    }
  });

  // Quick ack — visible only to the requester, replaced when the real
  // answer posts via response_url.
  return NextResponse.json({
    response_type: "ephemeral",
    text: `🔍 Ranger is digging up an answer for _${question}_…`,
  });
}
