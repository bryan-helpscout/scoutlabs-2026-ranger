/**
 * Product fact-sheet schema. Produced by scripts/refresh-product-knowledge.ts
 * by scraping helpscout.com's public pages and synthesizing via Sonnet.
 * Committed to data/product/helpscout.json so diffs are auditable (pricing
 * changes and new features show up as reviewable PRs).
 *
 * Consumed by app/api/chat/route.ts — injected into the system prompt so
 * every chat reply has fresh pricing, feature specs, and sharable URLs.
 */

export interface PricingTier {
  name: string; // "Standard" | "Plus" | "Pro"
  pricePerUser: string; // "$20/user/month"
  minimum?: string | null; // "min $50/mo" or null
  highlights: string[]; // 3-5 bullets of what's included
}

export interface ProductFeature {
  name: string; // "Shared Inbox"
  description: string; // AE-ready 1-2 sentence description
  url?: string | null; // full helpscout.com URL if present
  includedIn: string[]; // tier names or ["all"]
}

export interface CustomerProofPoint {
  company: string;
  quote?: string | null;
  metric?: string | null; // e.g. "30% faster response time"
}

export interface ShareableUrl {
  label: string; // "Pricing page", "Security & compliance"
  url: string;
}

export interface ProductKnowledge {
  summary: string; // one-paragraph elevator pitch
  pricing: {
    tiers: PricingTier[];
    discounts: string[]; // "Annual: ~17% savings", "Nonprofit: 50% off", ...
    trial: string; // "15-day free trial, no CC required"
  };
  features: ProductFeature[];
  integrations: {
    highlights: string[]; // top 5-10 names
    enterpriseOnly: string[]; // integrations gated to specific tiers
    url?: string | null;
  };
  security: {
    certifications: string[]; // SOC 2 Type II, GDPR, HIPAA, ...
    uptime?: string | null; // "99.99% uptime" if stated
    dataResidency: string[]; // ["US", "EU"]
    samlTier?: string | null; // which tier includes SAML
    url?: string | null;
  };
  api: {
    rateLimit?: string | null;
    authentication: string[]; // ["OAuth 2.0", "API key"]
    webhooks: boolean;
    url?: string | null;
  };
  customerProofPoints: CustomerProofPoint[];
  urlsForSalesSharing: ShareableUrl[];
  sources: Array<{ url: string; fetchedAt: string }>;
  updatedAt: string; // ISO
}
