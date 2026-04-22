/**
 * Competitor battle-card refresh pipeline.
 *
 *   node --env-file=.env.local --experimental-strip-types \
 *        scripts/refresh-competitors.ts [slug]...
 *
 * Flow per competitor:
 *   1. Fetch public site URLs (homepage/pricing/features/compare), strip HTML
 *   2. Pull internal intel from Slab ("<name>" search) and Slack
 *      (#sales-opportunities mentions) — this is what makes the card stronger
 *      than a raw scrape
 *   3. Feed everything to Sonnet with a structured-JSON prompt
 *   4. Write data/competitors/<slug>.json
 *
 * Runs ONE competitor at a time sequentially (we're writing JSON to disk and
 * calling Sonnet — no need to parallelize; also friendlier to target sites).
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// Node 25's --env-file is silently broken on some setups; manually load
// .env.local (matches the fallback in next.config.mjs). This has to run
// BEFORE any import that reads from process.env at module scope.
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (k && v && !process.env[k.trim()]) process.env[k.trim()] = v;
  }
}

import { COMPETITORS, type CompetitorConfig } from "../app/lib/competitors/config.ts";
import type {
  CompetitorCard,
  CompetitorSource,
} from "../app/lib/competitors/schema.ts";

// ── config ─────────────────────────────────────────────────────────────────

const DATA_DIR = resolve(process.cwd(), "data", "competitors");
// Keep in sync with SONNET_MODEL in app/lib/constants.ts — intentionally
// duplicated so this script stays self-contained for --experimental-strip-types
// (avoids pulling the Next.js @/... alias graph into a plain Node script).
const SONNET_MODEL = process.env.COMPETITOR_MODEL ?? "claude-sonnet-4-6";
// A generic-looking UA — some sites (Intercom especially) 403 curl-style UAs.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CHARS_PER_SOURCE = 15_000;
const MAX_SOURCES_BLOB = 120_000;

// ── system prompt ──────────────────────────────────────────────────────────

// Bot-posted Reddit intel channel — stays in sync with REDDIGENT_CHANNEL_ID
// in app/lib/constants.ts (intentionally duplicated; script is self-contained
// for Node's --experimental-strip-types).
const REDDIGENT_CHANNEL_ID = "C0AH4Q0GL75";

const BATTLE_CARD_SYSTEM = `You are a B2B SaaS competitive intelligence analyst for Help Scout.

Given scraped content from a competitor's public website, internal Help Scout discussions (Slab docs, Slack threads), AND external Reddit signals (real users discussing why they're switching away from the competitor), produce a structured battle card that an Account Executive can reference during a live sales call.

HELP SCOUT POSITIONING (use as your frame):
- Support-first platform; simpler and more human than Zendesk/Intercom
- Shared inbox + Docs (knowledge base) + Beacon (in-app widget) — no ticket numbers, feels like email
- Strong fit: SMB to mid-market B2B SaaS with support teams of 5–100
- Pricing: Standard $20, Plus $40, Pro $65 per user/mo; 15-day free trial; 17% annual discount
- Plus adds Salesforce + AI Assist + multiple Docs sites; Pro adds HIPAA + SAML SSO + dedicated IP

RULES:
- Accuracy > plausibility. If sources don't support a claim, don't make it.
- Be honest about the competitor's genuine strengths. AE credibility dies if they dismiss real advantages a prospect has already identified.
- Use actual numbers (prices, feature counts) from the sources when available.
- Keep each bullet scannable — the AE reads these mid-call, under 3 seconds per bullet.
- When internal Slab/Slack discussions contradict the competitor's marketing claims, prefer the internal intel (it's probably based on actual deals/customers).
- REDDIT SIGNALS are gold for "landmines" and "pivots" — they're verbatim reasons real users are switching away. Weave specific pain points into those fields. Don't name individual Reddit users, but patterns like "users frequently cite X" or "common complaint: Y" are legitimate.

OUTPUT (JSON only, no markdown fences, no prose):
{
  "positioning": "<one-sentence summary of how Help Scout should be positioned vs this competitor>",
  "pricing": {
    "startingAt": "<their lowest published per-seat tier as a short string, or null>",
    "notes": "<pricing gotchas — billed annually, per-feature add-ons, seat minimums, or null>"
  },
  "keyStrengths": ["<2-4 things they are genuinely better at>"],
  "ourAdvantages": ["<3-6 concrete reasons Help Scout wins, with specific features/numbers>"],
  "landmines": ["<2-4 prospect signals suggesting we lose this deal — enterprise-only, omni-channel required, etc.>"],
  "pivots": ["<2-4 'If the prospect says X, respond with Y' sales plays>"]
}`;

// ── helpers ────────────────────────────────────────────────────────────────

interface FetchedChunk {
  kind: CompetitorSource["kind"];
  url: string;
  text: string;
}

async function fetchAndExtract(
  url: string,
  kind: CompetitorSource["kind"]
): Promise<FetchedChunk | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`  ✗ ${kind} ${url} → HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const text = htmlToText(html).slice(0, MAX_CHARS_PER_SOURCE);
    if (text.length < 200) {
      console.warn(`  ⚠ ${kind} ${url} → only ${text.length} chars (likely bot-blocked or JS-rendered)`);
    } else {
      console.log(`  ✓ ${kind} ${url} → ${text.length} chars`);
    }
    return { kind, url, text };
  } catch (err) {
    console.warn(`  ✗ ${kind} ${url} → ${(err as Error).message}`);
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── internal-intel enrichment (Slab + Slack) ───────────────────────────────
//
// These are intentionally inlined copies of the existing Slab/Slack search
// logic — the alternative is wiring Next.js's path-alias imports into a plain
// Node script, which is messy with --experimental-strip-types. Script stays
// self-contained; runtime code stays untouched.

// Module-level Slab reachability cache — parallel to app/lib/slab.ts. Once
// we see a DNS failure in one competitor's enrichment, skip Slab for the
// remaining competitors rather than re-failing + re-logging per slug.
let slabScriptUnreachable = false;

function isDnsError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e; depth++) {
    const msg = (e as { message?: string }).message ?? "";
    const code = (e as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|EAI_AGAIN/.test(msg)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function searchSlabForCompetitor(name: string, limit = 3): Promise<FetchedChunk[]> {
  if (slabScriptUnreachable || process.env.SLAB_DISABLED === "1") return [];
  const url = process.env.SLAB_MCP_URL ?? "https://hs-slab-mcp.nonprod.superscout.net/mcp";
  try {
    const sessionId = await initSlabSession(url);
    const search = await slabCall(url, sessionId, "slab_search", {
      query: name,
      first: limit,
      types: ["POST"],
    });
    const text = extractSlabText(search);
    const ids = text
      .split("\n")
      .filter((l) => l.startsWith("["))
      .map((l) => l.match(/\(id:\s*(\w+)\)/)?.[1])
      .filter(Boolean) as string[];

    const chunks: FetchedChunk[] = [];
    for (const id of ids.slice(0, limit)) {
      const got = await slabCall(url, sessionId, "slab_get_post", { id });
      const body = extractSlabText(got).slice(0, MAX_CHARS_PER_SOURCE);
      if (body.length > 100) {
        chunks.push({ kind: "slab", url: `slab://${id}`, text: body });
      }
    }
    console.log(`  ✓ slab → ${chunks.length} posts about "${name}"`);
    return chunks;
  } catch (err) {
    if (isDnsError(err)) {
      slabScriptUnreachable = true;
      console.warn(
        `  ⚠ slab host unreachable (not on VPN?) — skipping Slab enrichment for remaining competitors. ` +
          `Set SLAB_DISABLED=1 to silence, or reconnect to VPN before re-running.`
      );
    } else {
      console.warn(`  ✗ slab → ${(err as Error).message}`);
    }
    return [];
  }
}

async function initSlabSession(url: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ranger-competitor-refresh", version: "1.0" },
      },
    }),
  });
  const sid = res.headers.get("mcp-session-id") ?? "";
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  return sid;
}

async function slabCall(
  url: string,
  sid: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const p = JSON.parse(line.slice(6));
      if (p.result !== undefined) return p.result;
      if (p.error) throw new Error(p.error.message);
    } catch {
      /* continue */
    }
  }
  return null;
}

function extractSlabText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> } | null;
  if (!r?.content) return "";
  return r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** Parse a reddigent-bot Slack message into its structured fields. Returns
 *  null if the message doesn't match the expected format (manual posts, etc). */
interface RedditSignal {
  score: string;
  reason: string;
  urgency: string;
  postUrl: string;
}

function parseReddigentMessage(text: string): RedditSignal | null {
  // Bot format: "*Reddit Relevance Alert* *Score:* 8/10 *Reason:* ... *Urgency:* medium *Post URL:* <https://...>"
  // Each field starts with *Label:* and ends at the next *Label:* boundary.
  const m = {
    score: /\*Score:\*\s*([^*]+?)\s*(?=\*|$)/i.exec(text)?.[1]?.trim(),
    // [^*]+? already spans newlines without the `s` flag (which needs ES2018+)
    reason: /\*Reason:\*\s*([^*]+?)\s*(?=\*(?:Urgency|Post URL|Score):\*|$)/i.exec(text)?.[1]?.trim(),
    urgency: /\*Urgency:\*\s*([^*\s]+)/i.exec(text)?.[1]?.trim(),
    postUrl: /\*Post URL:\*\s*<([^|>]+)/i.exec(text)?.[1]?.trim(),
  };
  if (!m.reason || !m.score) return null;
  return {
    score: m.score,
    reason: m.reason,
    urgency: m.urgency ?? "unknown",
    postUrl: m.postUrl ?? "",
  };
}

async function searchZReddigentForCompetitor(name: string, limit = 8): Promise<FetchedChunk[]> {
  const token = process.env.SLACK_TOKEN;
  if (!token) return [];
  // Scope to the z-reddigent channel and sort by recency — fresh signals
  // reflect the current market, not 18-month-old gripes.
  const qs = new URLSearchParams({
    query: `${name} in:<#${REDDIGENT_CHANNEL_ID}>`,
    count: String(limit * 2), // fetch extra; some won't parse
    sort: "timestamp",
    sort_dir: "desc",
  });
  try {
    const res = await fetch(`https://slack.com/api/search.messages?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: { matches?: Array<{ text?: string; channel?: { id?: string } }> };
    };
    if (!data.ok) {
      console.warn(`  ✗ z-reddigent → ${data.error}`);
      return [];
    }
    const signals: RedditSignal[] = [];
    for (const m of data.messages?.matches ?? []) {
      if (m.channel?.id !== REDDIGENT_CHANNEL_ID) continue; // defensive: search can return cross-channel
      const parsed = parseReddigentMessage(m.text ?? "");
      if (parsed) signals.push(parsed);
      if (signals.length >= limit) break;
    }
    if (signals.length === 0) {
      console.log(`  - z-reddigent → no parseable signals for "${name}"`);
      return [];
    }
    // Fold into ONE chunk with a clear header so Sonnet treats it as Reddit
    // intel, distinct from internal Slack chatter.
    const text = signals
      .map(
        (s, i) =>
          `Signal ${i + 1} [score ${s.score} · urgency ${s.urgency}] ${s.reason}${
            s.postUrl ? ` (${s.postUrl})` : ""
          }`
      )
      .join("\n");
    console.log(`  ✓ z-reddigent → ${signals.length} Reddit signals about "${name}"`);
    return [
      {
        kind: "slack",
        url: `slack://reddit-signals:${name}`,
        text: `REDDIT SIGNALS — users on Reddit discussing ${name}, distilled by the reddigent bot:\n\n${text}`,
      },
    ];
  } catch (err) {
    console.warn(`  ✗ z-reddigent → ${(err as Error).message}`);
    return [];
  }
}

async function searchSlackForCompetitor(name: string, limit = 5): Promise<FetchedChunk[]> {
  const token = process.env.SLACK_TOKEN;
  if (!token) {
    console.warn(`  - slack: SLACK_TOKEN not set, skipping`);
    return [];
  }
  const qs = new URLSearchParams({ query: name, count: "20", sort: "score" });
  try {
    const res = await fetch(`https://slack.com/api/search.messages?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: {
        matches?: Array<{
          text?: string;
          permalink?: string;
          channel?: { id?: string; name?: string };
          username?: string;
          user?: string;
        }>;
      };
    };
    if (!data.ok) {
      console.warn(`  ✗ slack → ${data.error}`);
      return [];
    }
    // Prioritize #sales-opportunities, then #t-customers — richest sources of lost-deal intel
    const priority = ["C07PQFD9X5Z", "C048JTK7J"];
    const matches = (data.messages?.matches ?? []).filter((m) => m.channel?.id);
    matches.sort((a, b) => {
      const ap = priority.indexOf(a.channel!.id!);
      const bp = priority.indexOf(b.channel!.id!);
      return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
    });
    const chunks = matches.slice(0, limit).map<FetchedChunk>((m) => ({
      kind: "slack",
      url: m.permalink ?? "",
      text: `#${m.channel?.name ?? "?"} @${m.username ?? m.user ?? "?"}: ${m.text ?? ""}`.slice(
        0,
        MAX_CHARS_PER_SOURCE
      ),
    }));
    console.log(`  ✓ slack → ${chunks.length} threads mentioning "${name}"`);
    return chunks;
  } catch (err) {
    console.warn(`  ✗ slack → ${(err as Error).message}`);
    return [];
  }
}

// ── synthesize with Sonnet ─────────────────────────────────────────────────

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
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

async function synthesize(
  cfg: CompetitorConfig,
  chunks: FetchedChunk[]
): Promise<Omit<CompetitorCard, "slug" | "name" | "sources" | "updatedAt">> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let blob = "";
  for (const c of chunks) {
    const section = `\n\n--- ${c.kind.toUpperCase()} · ${c.url} ---\n${c.text}`;
    if (blob.length + section.length > MAX_SOURCES_BLOB) break;
    blob += section;
  }
  if (!blob.trim()) {
    throw new Error(`no usable source material for ${cfg.name}`);
  }

  const res = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 2000,
    system: BATTLE_CARD_SYSTEM,
    messages: [
      {
        role: "user",
        content: `COMPETITOR: ${cfg.name}\n\nSOURCES:${blob}\n\nProduce the battle card JSON now.`,
      },
    ],
  });

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();
  const json = extractFirstJsonObject(text);
  if (!json) throw new Error(`model response had no JSON object: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(json) as Omit<
    CompetitorCard,
    "slug" | "name" | "sources" | "updatedAt"
  >;
  // Shape sanity
  parsed.keyStrengths ??= [];
  parsed.ourAdvantages ??= [];
  parsed.landmines ??= [];
  parsed.pivots ??= [];
  parsed.pricing ??= { startingAt: null, notes: null };
  return parsed;
}

// ── per-competitor orchestrator ────────────────────────────────────────────

async function refreshOne(cfg: CompetitorConfig): Promise<void> {
  console.log(`\n═══ ${cfg.name} (${cfg.slug}) ═══`);
  const sources: CompetitorSource[] = [];
  const chunks: FetchedChunk[] = [];

  // 1. Public-site scrapes
  for (const [kind, url] of Object.entries(cfg.urls)) {
    if (!url) continue;
    const got = await fetchAndExtract(url, kind as CompetitorSource["kind"]);
    if (got) {
      chunks.push(got);
      sources.push({ url, kind: kind as CompetitorSource["kind"], fetchedAt: new Date().toISOString() });
    }
  }

  // 2. Internal intel (Slab + Slack) + external intel (#z-reddigent Reddit
  //    signals) — all in parallel. Reddit signals flow in as their own chunk
  //    with a distinctive header so Sonnet recognizes them vs. Slack chatter.
  const [slabChunks, slackChunks, redditChunks] = await Promise.all([
    searchSlabForCompetitor(cfg.name, 3),
    searchSlackForCompetitor(cfg.name, 5),
    searchZReddigentForCompetitor(cfg.name, 8),
  ]);
  for (const c of [...slabChunks, ...slackChunks, ...redditChunks]) {
    chunks.push(c);
    sources.push({ url: c.url, kind: c.kind, fetchedAt: new Date().toISOString() });
  }

  if (chunks.length === 0) {
    console.error(`  ! no sources collected for ${cfg.name} — skipping`);
    return;
  }

  console.log(`  synthesizing battle card from ${chunks.length} sources…`);
  const body = await synthesize(cfg, chunks);

  const card: CompetitorCard = {
    slug: cfg.slug,
    name: cfg.name,
    ...body,
    sources,
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = resolve(DATA_DIR, `${cfg.slug}.json`);
  writeFileSync(outPath, JSON.stringify(card, null, 2) + "\n");
  console.log(`  → wrote ${outPath}`);
}

// ── main ───────────────────────────────────────────────────────────────────

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
    console.error("ANTHROPIC_API_KEY not set — pass --env-file=.env.local");
    process.exit(1);
  }
  console.log(`Refreshing ${targets.length} competitor(s): ${targets.map((c) => c.slug).join(", ")}`);
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
