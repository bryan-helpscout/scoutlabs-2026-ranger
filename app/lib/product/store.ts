/**
 * Runtime loader for the product fact-sheet artifact. Reads
 * data/product/helpscout.json with a 60s TTL cache so chat requests don't
 * re-read the same file. Refreshed content picks up without a server restart.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import type { ProductKnowledge } from "./schema";

interface CacheEntry {
  data: ProductKnowledge | null;
  readAt: number;
}

const cache = { entry: null as CacheEntry | null };
const TTL_MS = 60_000;

function dataPath(): string {
  return resolve(process.cwd(), "data", "product", "helpscout.json");
}

export function getProductKnowledge(): ProductKnowledge | null {
  const now = Date.now();
  if (cache.entry && now - cache.entry.readAt < TTL_MS) return cache.entry.data;
  try {
    const raw = readFileSync(dataPath(), "utf8");
    const data = JSON.parse(raw) as ProductKnowledge;
    cache.entry = { data, readAt: now };
    return data;
  } catch {
    cache.entry = { data: null, readAt: now };
    return null;
  }
}

/**
 * Format the fact sheet as a compact block for the chat system prompt.
 * Optimized for token density — an AE can read the model's paraphrase in a
 * single breath, so the raw source data doesn't need to be prose.
 */
export function formatProductKnowledgeForPrompt(pk: ProductKnowledge): string {
  const L: string[] = [];
  L.push(`HELP SCOUT PRODUCT FACTS (refreshed ${pk.updatedAt.slice(0, 10)} from helpscout.com):`);
  L.push("");
  L.push(pk.summary);
  L.push("");

  // Pricing — the thing AEs cite most
  L.push("PRICING:");
  for (const t of pk.pricing.tiers) {
    const min = t.minimum ? ` (${t.minimum})` : "";
    L.push(`- ${t.name}: ${t.pricePerUser}${min} — ${t.highlights.join("; ")}`);
  }
  if (pk.pricing.discounts.length) L.push(`- Discounts: ${pk.pricing.discounts.join("; ")}`);
  L.push(`- Trial: ${pk.pricing.trial}`);
  L.push("");

  // Features — tier-inclusion is the common AE question
  if (pk.features.length) {
    L.push("FEATURES:");
    for (const f of pk.features) {
      const tiers = f.includedIn.length ? ` [${f.includedIn.join("/")}]` : "";
      L.push(`- ${f.name}${tiers}: ${f.description}${f.url ? ` — ${f.url}` : ""}`);
    }
    L.push("");
  }

  // Integrations
  if (pk.integrations.highlights.length) {
    L.push("INTEGRATIONS:");
    L.push(`- Highlights: ${pk.integrations.highlights.join(", ")}`);
    if (pk.integrations.enterpriseOnly.length) {
      L.push(`- Tier-gated: ${pk.integrations.enterpriseOnly.join(", ")}`);
    }
    if (pk.integrations.url) L.push(`- Full list: ${pk.integrations.url}`);
    L.push("");
  }

  // Security
  L.push("SECURITY & COMPLIANCE:");
  if (pk.security.certifications.length) {
    L.push(`- Certifications: ${pk.security.certifications.join(", ")}`);
  }
  if (pk.security.uptime) L.push(`- Uptime: ${pk.security.uptime}`);
  if (pk.security.dataResidency.length) {
    L.push(`- Data residency: ${pk.security.dataResidency.join(", ")}`);
  }
  if (pk.security.samlTier) L.push(`- SAML SSO: ${pk.security.samlTier}`);
  if (pk.security.url) L.push(`- More: ${pk.security.url}`);
  L.push("");

  // API
  if (pk.api.rateLimit || pk.api.authentication.length || pk.api.url) {
    L.push("API:");
    if (pk.api.rateLimit) L.push(`- Rate limit: ${pk.api.rateLimit}`);
    if (pk.api.authentication.length) L.push(`- Auth: ${pk.api.authentication.join(", ")}`);
    L.push(`- Webhooks: ${pk.api.webhooks ? "yes" : "no"}`);
    if (pk.api.url) L.push(`- Docs: ${pk.api.url}`);
    L.push("");
  }

  // Customer proof points — concrete numbers AEs can cite
  if (pk.customerProofPoints.length) {
    L.push("CUSTOMER PROOF POINTS (cite specific companies + metrics when relevant):");
    for (const p of pk.customerProofPoints) {
      const bits = [p.company, p.metric, p.quote ? `"${p.quote}"` : null]
        .filter(Boolean)
        .join(" — ");
      L.push(`- ${bits}`);
    }
    L.push("");
  }

  // Shareable URLs — the biggest lift for live calls
  if (pk.urlsForSalesSharing.length) {
    L.push("URLS THE AE CAN PASTE TO PROSPECTS:");
    for (const u of pk.urlsForSalesSharing) {
      L.push(`- ${u.label}: ${u.url}`);
    }
  }

  return L.join("\n");
}
