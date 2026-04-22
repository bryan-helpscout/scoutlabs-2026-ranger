/**
 * Canonical list of competitors we track. Used by:
 *  - scripts/refresh-competitors.ts → which sites to scrape + which internal
 *    Slab/Slack terms to search
 *  - app/lib/competitors/detect.ts  → which names/aliases to match in
 *    transcript chunks and chat messages
 *
 * Adding one: append here, run `node scripts/refresh-competitors.ts <slug>`
 * to generate data/competitors/<slug>.json, commit both files.
 */

export interface CompetitorConfig {
  slug: string;
  name: string;
  /** Alternate mentions detected in transcript/chat — case-insensitive word match. */
  aliases: string[];
  urls: {
    homepage?: string;
    pricing?: string;
    features?: string;
    /** Their /compare/helpscout page if it exists — usually the richest source. */
    compare?: string;
  };
}

export const COMPETITORS: CompetitorConfig[] = [
  {
    slug: "zendesk",
    name: "Zendesk",
    aliases: ["ZD"],
    urls: {
      homepage: "https://www.zendesk.com/",
      pricing: "https://www.zendesk.com/pricing/",
      features: "https://www.zendesk.com/service/ticketing-system/",
    },
  },
  {
    slug: "intercom",
    name: "Intercom",
    aliases: [],
    urls: {
      homepage: "https://www.intercom.com/",
      pricing: "https://www.intercom.com/pricing",
      features: "https://www.intercom.com/customer-support",
    },
  },
  {
    slug: "freshdesk",
    name: "Freshdesk",
    aliases: ["Freshworks"],
    urls: {
      homepage: "https://www.freshworks.com/freshdesk/",
      pricing: "https://www.freshworks.com/freshdesk/pricing/",
    },
  },
];

export function getCompetitorConfig(slug: string): CompetitorConfig | undefined {
  return COMPETITORS.find((c) => c.slug === slug);
}
