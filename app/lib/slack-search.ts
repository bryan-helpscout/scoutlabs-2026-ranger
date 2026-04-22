/**
 * Direct Slack Web API search wrapper — called from the triage loop to
 * surface past customer/support threads. This is separate from the Slack
 * MCP path used in /api/chat: triage needs predictable, low-latency results
 * without going through a second model round-trip.
 *
 * Requires a user token (xoxp-) with `search:read.public` scope. Bot tokens
 * (xoxb-) cannot call search.messages.
 *
 * We filter results to the 4 channels in SLACK_CHANNELS so triage surfaces
 * only curated support/sales threads, not random side conversations.
 */

import { SLACK_CHANNELS } from "@/app/lib/constants";

export interface SlackSearchResult {
  text: string;
  permalink: string;
  username: string;
  channelName?: string;
  channelId: string;
  ts: string;
}

const SLACK_URL = "https://slack.com/api/search.messages";
const ALLOWED_CHANNEL_IDS = new Set<string>(Object.values(SLACK_CHANNELS));

interface SlackApiMessage {
  text?: string;
  permalink?: string;
  username?: string;
  user?: string;
  ts?: string;
  channel?: { id?: string; name?: string };
}

export async function searchSlack(query: string, limit = 3): Promise<SlackSearchResult[]> {
  const token = process.env.SLACK_TOKEN;
  if (!token || !query.trim()) return [];

  // Fetch more than we need so the channel filter has room to work.
  const qs = new URLSearchParams({
    query,
    count: String(Math.max(limit * 3, 15)),
    sort: "score",
  });

  try {
    const res = await fetch(`${SLACK_URL}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error("[slack-search] http", res.status);
      return [];
    }
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: { matches?: SlackApiMessage[] };
    };
    if (!data.ok) {
      console.error("[slack-search] api error:", data.error);
      return [];
    }
    const matches = data.messages?.matches ?? [];
    return matches
      .filter((m) => m.channel?.id && ALLOWED_CHANNEL_IDS.has(m.channel.id))
      .slice(0, limit)
      .map<SlackSearchResult>((m) => ({
        text: m.text ?? "",
        permalink: m.permalink ?? "",
        username: m.username ?? m.user ?? "unknown",
        channelName: m.channel?.name,
        channelId: m.channel!.id!,
        ts: m.ts ?? "",
      }));
  } catch (err) {
    console.error("[slack-search] failed:", err);
    return [];
  }
}
