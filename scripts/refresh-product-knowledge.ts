/**
 * Product fact-sheet refresh pipeline.
 *
 *   npm run refresh-product-knowledge
 *
 * Scrapes helpscout.com's public pages, feeds the stripped text to Sonnet,
 * writes a structured JSON artifact to data/product/helpscout.json. The
 * /api/chat route reads this at request time and injects it into the system
 * prompt, so every chat reply has fresh pricing / feature / URL data.
 *
 * Unlike the competitor pipeline there's no per-URL "slug" concept — one
 * artifact per run, one output file.
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// Node 25's --env-file is silently broken on some setups — same workaround
// as scripts/refresh-competitors.ts.
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

const OUT_PATH = resolve(process.cwd(), "data", "product", "helpscout.json");

// Keep in sync with SONNET_MODEL in app/lib/constants.ts.
const SONNET_MODEL = process.env.PRODUCT_MODEL ?? "claude-sonnet-4-6";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CHARS_PER_PAGE = 18_000;
const MAX_SOURCES_BLOB = 140_000;

/** Curated list of high-signal sales pages. URLs discovered via recon of the
 *  homepage's nav links; intentionally excludes compare pages (already in the
 *  competitor battle cards) and blog/careers/press. Edit this list to add
 *  new pages — e.g. new feature pages or industry verticals. */
const URLS: Array<{ label: string; url: string }> = [
  { label: "homepage", url: "https://www.helpscout.com/" },
  { label: "pricing", url: "https://www.helpscout.com/pricing/" },
  { label: "shared inbox", url: "https://www.helpscout.com/inbox/" },
  { label: "knowledge base (Docs)", url: "https://www.helpscout.com/knowledge-base/" },
  { label: "proactive messages (Beacon)", url: "https://www.helpscout.com/proactive-messages/" },
  { label: "self-service", url: "https://www.helpscout.com/self-service/" },
  { label: "AI features", url: "https://www.helpscout.com/ai-features/" },
  { label: "analytics", url: "https://www.helpscout.com/analytics/" },
  { label: "customers / case studies", url: "https://www.helpscout.com/customers/" },
  { label: "security & compliance", url: "https://www.helpscout.com/company/legal/security/" },
  { label: "SaaS industry page", url: "https://www.helpscout.com/industry/saas/" },
];

// ── synthesis prompt ───────────────────────────────────────────────────────

const SYSTEM = `You are a sales-enablement writer for Help Scout. Given scraped content from helpscout.com's public pages, produce a structured "sales kit" JSON artifact that Account Executives can reference on live sales calls.

RULES:
- Accuracy > detail. Only include claims you can trace to the source content — do not invent features, numbers, or URLs.
- Use actual numbers where present (prices, uptime SLAs, integration counts, customer metrics).
- Feature descriptions: 1–2 plain sentences, written so an AE can paraphrase without sounding like marketing copy.
- For each feature, identify which pricing tier(s) include it based on what's said on the pricing page.
- urlsForSalesSharing: only include URLs we actually scraped (they're listed in the SOURCES blocks below). Give each a short human-readable label.
- Keep each list scannable — max ~6 bullets per sub-list. Quality over completeness.

OUTPUT (JSON only, no markdown fences, no preface):
{
  "summary": "<one-paragraph elevator pitch, 2–3 sentences>",
  "pricing": {
    "tiers": [
      { "name": "<tier name>", "pricePerUser": "<e.g. $20/user/month>", "minimum": "<min billing if any, else null>", "highlights": ["<3–5 bullets of what's included>"] }
    ],
    "discounts": ["<annual %, nonprofit, startup, etc.>"],
    "trial": "<trial terms, e.g. '15-day free trial, no credit card required'>"
  },
  "features": [
    { "name": "<feature name>", "description": "<1–2 sentences>", "url": "<full URL if present in sources, else null>", "includedIn": ["<tier names, or 'all'>"] }
  ],
  "integrations": {
    "highlights": ["<top 5–10 integration names>"],
    "enterpriseOnly": ["<integrations gated to specific tiers, e.g. Salesforce on Plus+>"],
    "url": "<full URL if scraped, else null>"
  },
  "security": {
    "certifications": ["<SOC 2 Type II, GDPR, HIPAA (Pro), CCPA, etc.>"],
    "uptime": "<uptime SLA if stated, else null>",
    "dataResidency": ["<US, EU>"],
    "samlTier": "<tier name that includes SAML SSO, or null>",
    "url": "<full URL if scraped, else null>"
  },
  "api": {
    "rateLimit": "<requests per minute if stated, or null>",
    "authentication": ["<OAuth 2.0, API key, etc.>"],
    "webhooks": true,
    "url": "<developer portal URL if known, else null>"
  },
  "customerProofPoints": [
    { "company": "<customer name>", "quote": "<brief quote if present, else null>", "metric": "<specific metric — 30% faster response, 20% ticket deflection, etc.>" }
  ],
  "urlsForSalesSharing": [
    { "label": "<e.g. Pricing page>", "url": "<full URL>" }
  ]
}`;

// ── helpers ────────────────────────────────────────────────────────────────

interface PageFetch {
  label: string;
  url: string;
  text: string;
}

async function fetchPage(label: string, url: string): Promise<PageFetch | null> {
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
      console.warn(`  ✗ ${label} ${url} → HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const text = htmlToText(html).slice(0, MAX_CHARS_PER_PAGE);
    if (text.length < 200) {
      console.warn(`  ⚠ ${label} → only ${text.length} chars (JS-rendered / bot-blocked?)`);
      return null;
    }
    console.log(`  ✓ ${label} ${url} → ${text.length} chars`);
    return { label, url, text };
  } catch (err) {
    console.warn(`  ✗ ${label} → ${(err as Error).message}`);
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

// ── synthesize ─────────────────────────────────────────────────────────────

async function synthesize(pages: PageFetch[]): Promise<Record<string, unknown>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let blob = "";
  for (const p of pages) {
    const section = `\n\n━━━ SOURCE: ${p.label} (${p.url}) ━━━\n${p.text}`;
    if (blob.length + section.length > MAX_SOURCES_BLOB) break;
    blob += section;
  }
  if (!blob.trim()) throw new Error("no usable source material");

  const res = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `SOURCES:${blob}\n\nProduce the sales-kit JSON now.`,
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
  return JSON.parse(json) as Record<string, unknown>;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }
  console.log(`Refreshing Help Scout product fact-sheet from ${URLS.length} URLs…\n`);

  const pages: PageFetch[] = [];
  for (const { label, url } of URLS) {
    const p = await fetchPage(label, url);
    if (p) pages.push(p);
  }
  if (pages.length === 0) {
    console.error("no pages fetched successfully — aborting");
    process.exit(1);
  }

  console.log(`\nSynthesizing from ${pages.length} sources…`);
  const body = await synthesize(pages);

  const out = {
    ...body,
    sources: pages.map((p) => ({ url: p.url, fetchedAt: new Date().toISOString() })),
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(resolve(OUT_PATH, ".."), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n→ wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
