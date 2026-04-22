/**
 * Reddit-signal refresh pipeline.
 *
 *   npm run refresh-reddit-signals [slug]...
 *
 * For each known competitor (from app/lib/competitors/config.ts):
 *   1. Search #z-reddigent (ID hardcoded below, mirrors constants.ts) for
 *      the competitor's name, newest first
 *   2. Parse each reddigent-bot message into {score, urgency, reason, postUrl, capturedAt}
 *   3. Ask Sonnet to synthesize 3–5 "top patterns" across the recent signals
 *   4. Write data/reddit-signals/<slug>.json
 *
 * Self-contained (like the competitor refresh) so it runs under Node's
 * --experimental-strip-types without the Next.js @/... alias resolver.
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { COMPETITORS, type CompetitorConfig } from "../app/lib/competitors/config.ts";
import type { RedditSignal, RedditSignalsForCompetitor } from "../app/lib/reddit-signals/schema.ts";

// Same env-load workaround as the other scripts — Node 25 --env-file is broken
// on this setup, and CI/devs expect .env.local to "just work" for local runs.
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (k && v && !process.env[k.trim()]) process.env[k.trim()] = v;
  }
}

// ── config ─────────────────────────────────────────────────────────────────

const DATA_DIR = resolve(process.cwd(), "data", "reddit-signals");
const REDDIGENT_CHANNEL_ID = "C0AH4Q0GL75"; // mirrors constants.ts
const SONNET_MODEL = process.env.REDDIT_MODEL ?? "claude-sonnet-4-6";
const MAX_SIGNALS_PER_COMPETITOR = 20;
const MAX_PARSED_FETCH_SIZE = 50; // fetch extra; parser drops non-bot posts

// ── helpers ────────────────────────────────────────────────────────────────

/** Extract structured fields from a reddigent-bot Slack message. */
function parseReddigentMessage(
  text: string,
  ts: string
): RedditSignal | null {
  const m = {
    score: /\*Score:\*\s*([^*]+?)\s*(?=\*|$)/i.exec(text)?.[1]?.trim(),
    // [^*]+? spans newlines without the ES2018 `s` flag
    reason: /\*Reason:\*\s*([^*]+?)\s*(?=\*(?:Urgency|Post URL|Score):\*|$)/i
      .exec(text)?.[1]?.trim(),
    urgency: /\*Urgency:\*\s*([^*\s]+)/i.exec(text)?.[1]?.trim(),
    postUrl: /\*Post URL:\*\s*<([^|>]+)/i.exec(text)?.[1]?.trim(),
  };
  if (!m.reason || !m.score) return null;
  // ts is a Slack timestamp like "1760123456.123456" — seconds as decimal.
  const epochMs = Math.round(parseFloat(ts) * 1000) || Date.now();
  return {
    postUrl: m.postUrl ?? "",
    score: m.score,
    urgency: (m.urgency ?? "unknown").toLowerCase(),
    reason: m.reason,
    capturedAt: new Date(epochMs).toISOString(),
  };
}

interface SlackMessageMatch {
  text?: string;
  ts?: string;
  channel?: { id?: string };
}

async function pullSignalsForCompetitor(
  name: string
): Promise<RedditSignal[]> {
  const token = process.env.SLACK_TOKEN;
  if (!token) {
    console.warn(`  ✗ SLACK_TOKEN not set — skipping Slack search for "${name}"`);
    return [];
  }
  const qs = new URLSearchParams({
    query: `${name} in:<#${REDDIGENT_CHANNEL_ID}>`,
    count: String(MAX_PARSED_FETCH_SIZE),
    sort: "timestamp",
    sort_dir: "desc",
  });
  try {
    const res = await fetch(`https://slack.com/api/search.messages?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: { matches?: SlackMessageMatch[] };
    };
    if (!data.ok) {
      console.warn(`  ✗ slack api error → ${data.error}`);
      return [];
    }
    const signals: RedditSignal[] = [];
    const seenUrls = new Set<string>(); // dedup across multiple alert re-posts
    for (const m of data.messages?.matches ?? []) {
      if (m.channel?.id !== REDDIGENT_CHANNEL_ID) continue; // defensive
      const parsed = parseReddigentMessage(m.text ?? "", m.ts ?? "");
      if (!parsed) continue;
      const key = parsed.postUrl || parsed.reason.slice(0, 80);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      signals.push(parsed);
      if (signals.length >= MAX_SIGNALS_PER_COMPETITOR) break;
    }
    return signals;
  } catch (err) {
    console.warn(`  ✗ slack search failed → ${(err as Error).message}`);
    return [];
  }
}

// ── synthesize top patterns ────────────────────────────────────────────────

const PATTERNS_SYSTEM = `You analyze a batch of structured Reddit-signal messages (each is a bot-scored Reddit post where someone is considering switching away from a customer-support tool). Your job: identify 3–5 DISTINCT RECURRING THEMES across the batch.

Good patterns are short (5–12 words), specific, and actionable for a sales team. Examples:
  - "pricing transparency complaints after AI Copilot add-on"
  - "API reliability issues with enterprise integrations"
  - "support quality decline after tier downgrade"

Bad patterns are vague:
  - "users want something better" (too generic)
  - "pricing" (too short, no signal)

Output ONLY a JSON object:
  { "topPatterns": ["<pattern 1>", "<pattern 2>", ...] }

If fewer than 3 distinct themes exist in the batch, return what you have honestly — don't pad.`;

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

async function synthesizePatterns(
  name: string,
  signals: RedditSignal[]
): Promise<string[]> {
  if (signals.length < 2) return []; // not enough to find a pattern
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const blob = signals
    .map((s, i) => `${i + 1}. [${s.urgency}, ${s.score}] ${s.reason}`)
    .join("\n");
  try {
    const res = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      system: PATTERNS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `COMPETITOR: ${name}\n\nSIGNALS:\n${blob}\n\nReturn the JSON now.`,
        },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();
    const json = extractFirstJsonObject(text);
    if (!json) return [];
    const parsed = JSON.parse(json) as { topPatterns?: string[] };
    return Array.isArray(parsed.topPatterns) ? parsed.topPatterns.slice(0, 5) : [];
  } catch (err) {
    console.warn(`  ✗ pattern synthesis failed for ${name}: ${(err as Error).message}`);
    return [];
  }
}

// ── orchestrator ───────────────────────────────────────────────────────────

async function refreshOne(cfg: CompetitorConfig): Promise<void> {
  console.log(`\n═══ ${cfg.name} (${cfg.slug}) ═══`);
  const signals = await pullSignalsForCompetitor(cfg.name);
  console.log(`  ✓ pulled ${signals.length} parseable signals`);

  if (signals.length === 0) {
    console.warn(`  ! no signals — writing an empty record so readers know the source was checked`);
  }

  const topPatterns = await synthesizePatterns(cfg.name, signals);
  if (topPatterns.length) {
    console.log(`  ✓ synthesized ${topPatterns.length} patterns:`);
    for (const p of topPatterns) console.log(`    • ${p}`);
  }

  const out: RedditSignalsForCompetitor = {
    competitor: cfg.slug,
    competitorName: cfg.name,
    signals,
    topPatterns,
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = resolve(DATA_DIR, `${cfg.slug}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`  → wrote ${outPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length
    ? COMPETITORS.filter((c) => args.includes(c.slug))
    : COMPETITORS;
  if (targets.length === 0) {
    console.error(`No competitors matched. Known: ${COMPETITORS.map((c) => c.slug).join(", ")}`);
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — can't synthesize patterns");
    process.exit(1);
  }
  if (!process.env.SLACK_TOKEN) {
    console.error("SLACK_TOKEN not set — Reddit signals come from #z-reddigent");
    process.exit(1);
  }
  console.log(`Refreshing Reddit signals for ${targets.length} competitor(s): ${targets.map((c) => c.slug).join(", ")}`);
  for (const t of targets) {
    try {
      await refreshOne(t);
    } catch (err) {
      console.error(`  ! failed for ${t.slug}:`, (err as Error).message);
    }
  }
  console.log("\ndone.");
}

main();
