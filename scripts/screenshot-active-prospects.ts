/**
 * Screenshot the new Active Prospects + health-score + HubSpot last-call UI.
 *
 *   npm run dev                        # in one terminal (with RANGER_DEV_NO_AUTH=1)
 *   npm run screenshot-active-prospects  # in another — saves to screenshots/
 *
 * This script doesn't need a real HubSpot token: it intercepts the
 * /api/prospects/list and /api/prospect calls with Puppeteer and injects a
 * hand-built demo payload, so the sidebar renders the new components
 * deterministically. Captures two shots:
 *
 *   1. active-prospects-list.png     — the list view, before any row click
 *   2. active-prospects-detail.png   — after clicking the top row, showing
 *                                      the health pill on the detail card +
 *                                      the HubSpot-orange last-call block
 *                                      inside the pre-read briefing.
 */

import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const CHROME_PATH = CHROME_PATHS.find(existsSync);
if (!CHROME_PATH) {
  console.error("No Chrome/Chromium binary found. Tried:", CHROME_PATHS);
  process.exit(1);
}

const URL = process.env.RANGER_URL ?? "http://localhost:3000";
const OUT_DIR = resolve(process.cwd(), "screenshots");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// ── Fake payloads ────────────────────────────────────────────────────────
// Six plausible prospects spanning the health bands so the screenshot shows
// the full color range. The API route sorts by healthScore DESC, so we
// pre-sort here to match what the real server would do.

const EMPTY_EVIDENCE = {
  sentiment: null,
  prospectVoice: [] as string[],
  painPoints: [] as string[],
  risks: [] as string[],
  openQuestions: [] as string[],
  contributors: [] as Array<{ label: string; direction: "up" | "down" | "flat"; weight: number }>,
};

const LIST_PAYLOAD = {
  prospects: [
    {
      companyId: "c-1",
      companyName: "Vistabeam",
      contactName: "Tyler Weinrich",
      dealStage: "Contract Sent",
      dealValue: "$48k",
      dealAmount: 48000,
      lastActivity: new Date(Date.now() - 2 * 864e5).toISOString(),
      lastActivityAt: new Date(Date.now() - 2 * 864e5).toISOString(),
      stageProgress: 0.85,
      healthScore: 87,
      healthBand: "ready to close",
      healthRationale: "Strong Ranger debrief score (78/100)",
      healthEvidence: {
        sentiment: "positive",
        prospectVoice: [
          "asked three detailed questions about SAML SSO setup with Okta",
          "said the pricing model is 'a real improvement' over their Zendesk renewal",
        ],
        painPoints: [
          "Zendesk renewal cost pressure from CFO",
          "Poor SLA-breach reporting on current plan",
        ],
        risks: [
          "Tyler is not the economic buyer — VP Ops signs",
        ],
        openQuestions: [
          "Exact migration window for 80k historical conversations?",
        ],
        contributors: [
          { label: "Close score trending up (62→78)", direction: "up", weight: 32 },
          { label: "Late-stage deal", direction: "up", weight: 21 },
          { label: "Very recent activity", direction: "up", weight: 25 },
          { label: "1 open risk", direction: "down", weight: 3 },
        ],
      },
      callCount: 3,
      latestCloseScore: 78,
    },
    {
      companyId: "c-2",
      companyName: "Acme Logistics",
      contactName: "Priya Shah",
      dealStage: "Decision Maker Bought-In",
      dealValue: "$62k",
      dealAmount: 62000,
      lastActivity: new Date(Date.now() - 5 * 864e5).toISOString(),
      lastActivityAt: new Date(Date.now() - 5 * 864e5).toISOString(),
      stageProgress: 0.7,
      healthScore: 71,
      healthBand: "hot",
      healthRationale: "Late-stage with recent activity",
      healthEvidence: EMPTY_EVIDENCE,
      callCount: 2,
      latestCloseScore: 62,
    },
    {
      companyId: "c-3",
      companyName: "Northwind Health",
      contactName: "Jordan Kim",
      dealStage: "Presentation Scheduled",
      dealValue: "$24k",
      dealAmount: 24000,
      lastActivity: new Date(Date.now() - 3 * 864e5).toISOString(),
      lastActivityAt: new Date(Date.now() - 3 * 864e5).toISOString(),
      stageProgress: 0.5,
      healthScore: 58,
      healthBand: "hot",
      healthRationale: "Ranger debrief: 54/100 last call",
      healthEvidence: EMPTY_EVIDENCE,
      callCount: 1,
      latestCloseScore: 54,
    },
    {
      companyId: "c-4",
      companyName: "Helios Energy",
      contactName: "Marcus Webb",
      dealStage: "Qualified To Buy",
      dealValue: "$18k",
      dealAmount: 18000,
      lastActivity: new Date(Date.now() - 9 * 864e5).toISOString(),
      lastActivityAt: new Date(Date.now() - 9 * 864e5).toISOString(),
      stageProgress: 0.3,
      healthScore: 44,
      healthBand: "warm",
      healthRationale: "Very recent activity",
      healthEvidence: EMPTY_EVIDENCE,
      callCount: 0,
      latestCloseScore: null,
    },
    {
      companyId: "c-5",
      companyName: "Brightline CX",
      contactName: "Sam Okafor",
      dealStage: "Appointment Scheduled",
      dealValue: null,
      dealAmount: null,
      lastActivity: new Date(Date.now() - 18 * 864e5).toISOString(),
      lastActivityAt: new Date(Date.now() - 18 * 864e5).toISOString(),
      stageProgress: 0.15,
      healthScore: 36,
      healthBand: "warm",
      healthRationale: "Limited signal — early-stage or stale",
      healthEvidence: EMPTY_EVIDENCE,
      callCount: 0,
      latestCloseScore: null,
    },
    {
      companyId: "c-6",
      companyName: "Fernwood Retail",
      contactName: null,
      dealStage: "Qualified To Buy",
      dealValue: "$31k",
      dealAmount: 31000,
      lastActivity: new Date(Date.now() - 72 * 864e5).toISOString(),
      lastActivityAt: new Date(Date.now() - 72 * 864e5).toISOString(),
      stageProgress: 0.3,
      healthScore: 18,
      healthBand: "cold",
      healthRationale: "No activity in 72 days — deal likely stalling",
      healthEvidence: EMPTY_EVIDENCE,
      callCount: 2,
      latestCloseScore: 34,
    },
  ],
};

// The detail payload returned when the user clicks Vistabeam. Matches what
// /api/prospect would produce — including the HubSpot last-call block inside
// the briefing — so the screenshot shows the new orange-accented panel.
const VISTABEAM_DETAIL = {
  found: true,
  companyId: "c-1",
  companyName: "Vistabeam",
  dealStage: "Contract Sent",
  dealValue: "$48k",
  dealAmount: 48000,
  lastActivity: "Apr 20, 2026",
  lastActivityAt: new Date(Date.now() - 2 * 864e5).toISOString(),
  ownerName: "Casey Alvarez",
  notes: "Vistabeam Q2 rollout",
  contactName: "Tyler Weinrich",
  contactTitle: "IS Manager",
  health: {
    score: 87,
    band: "ready to close",
    rationale: "Strong Ranger debrief score (78/100)",
    evidence: {
      sentiment: "positive",
      prospectVoice: [
        "asked three detailed questions about SAML SSO setup with Okta",
        "said the pricing model is 'a real improvement' over their Zendesk renewal",
      ],
      painPoints: [
        "Zendesk renewal cost pressure from CFO",
        "Poor SLA-breach reporting on current plan",
      ],
      risks: [
        "Tyler is not the economic buyer — VP Ops signs",
        "Data residency question for Berlin office still open",
      ],
      openQuestions: [
        "Exact migration window for 80k historical conversations?",
        "Do we support data residency in EU for their Berlin office?",
      ],
      contributors: [
        { label: "Close score trending up (62→78)", direction: "up", weight: 32 },
        { label: "Late-stage deal", direction: "up", weight: 21 },
        { label: "Very recent activity", direction: "up", weight: 25 },
        { label: "2 open risks", direction: "down", weight: 6 },
      ],
    },
  },
  briefing: {
    callCount: 3,
    lastCallAt: new Date(Date.now() - 4 * 864e5).toISOString(),
    lastCallSummary:
      "Third call with Vistabeam. Tyler walked us through their current Zendesk pain — CFO pressure on the renewal, limited reporting on SLA breaches. Positively received the pricing comparison; asked about our migration timeline and SAML setup process. Commitment to bring in IT next week for the SSO walkthrough.",
    lastCallTone: "positive",
    closeScoreHistory: [
      { generatedAt: new Date(Date.now() - 4 * 864e5).toISOString(), score: 78, band: "hot" },
      { generatedAt: new Date(Date.now() - 14 * 864e5).toISOString(), score: 62, band: "hot" },
      { generatedAt: new Date(Date.now() - 28 * 864e5).toISOString(), score: 48, band: "warm" },
    ],
    openActionItems: [
      {
        owner: "ae",
        description: "Send migration timeline + Import2 reference customer list",
        priority: "high",
        dueBy: "Apr 24",
        fromCallAt: new Date(Date.now() - 4 * 864e5).toISOString(),
      },
      {
        owner: "team",
        description: "Loop in SE for SAML/Okta walkthrough (Tyler + IT joining)",
        priority: "high",
        dueBy: "next call",
        fromCallAt: new Date(Date.now() - 4 * 864e5).toISOString(),
      },
      {
        owner: "ae",
        description: "Share cost-savings model vs Zendesk renewal",
        priority: "medium",
        dueBy: null,
        fromCallAt: new Date(Date.now() - 14 * 864e5).toISOString(),
      },
    ],
    recurringRisks: [
      "CFO renewal-pressure is the real constraint, not feature gaps",
      "Tyler is not the economic buyer — VP Ops signs",
    ],
    recentOpenQuestions: [
      "Exact migration window for 80k historical conversations?",
      "Do we support data residency in EU for their Berlin office?",
    ],
    nextCallPrep: {
      painPoints: [
        "Zendesk renewal cost pressure from CFO",
        "Poor SLA-breach reporting on current plan",
      ],
      questionThemes: [
        {
          theme: "SAML / Okta compliance setup",
          talkingPoint:
            "SAML SSO with Okta is included on Pro ($65/user/mo). Typical setup is 20 min via our step-by-step guide; SCIM user provisioning available if IT wants auto-deprovision.",
        },
        {
          theme: "Migration timeline for 80k conversations",
          talkingPoint:
            "Typical 2–3 week migration for 45-agent teams — Import2 handles conversation data, our native importer handles Docs/KB. I'd loop in an SE to validate exact scope before committing to a hard date.",
        },
        {
          theme: "Reference customers at Vistabeam's size",
          talkingPoint:
            "Two solid fits: Fastspring (40 agents, migrated from Zendesk in 3 weeks) and Litmus (55 agents, B2B SaaS). Happy to set up a ref call with either.",
        },
      ],
      recommendedFocus:
        "Lead with the cost-savings math — the CFO is the constraint. Have the Fastspring ref ready. Close by confirming who on the IT side beyond Tyler needs to sign off before contract.",
    },
    hubspotLastCall: {
      kind: "call",
      at: new Date(Date.now() - 2 * 864e5).toISOString(),
      title: "Follow-up: pricing model + SAML questions",
      body: "Tyler called back after reviewing the pricing doc. CFO flagged the TCO model and wants a line-item comparison vs Zendesk renewal ($72k → $48k). Tyler agreed to share the Zendesk invoice so we can build an apples-to-apples breakdown. He'll also introduce Marta (VP Ops) next call — she signs. Left voicemail for Marta; will follow up Thursday.",
      durationSec: 1140,
      direction: "OUTBOUND",
    },
  },
};

async function main() {
  console.log(`URL: ${URL}`);
  console.log(`Chrome: ${CHROME_PATH}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1600, height: 1100, deviceScaleFactor: 2 },
  });
  try {
    const page = await browser.newPage();

    // Intercept the two endpoints that drive the new UI. Everything else
    // passes through so the rest of the app still renders (sources panel,
    // quick prompts, etc.).
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      // Use pathname match so query-string variants (e.g. ?sort=health) all
      // hit the intercept.
      const pathname = new globalThis.URL(url).pathname;
      if (pathname === "/api/prospects/list") {
        req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(LIST_PAYLOAD),
        });
        return;
      }
      if (pathname === "/api/prospect" && req.method() === "POST") {
        req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(VISTABEAM_DETAIL),
        });
        return;
      }
      req.continue();
    });

    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // Wait for the list to render — the Active prospects panel only appears
    // once the /api/prospects/list fetch resolves.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("div")].some(
          (el) => el.textContent?.trim() === "Active prospects"
        ),
      { timeout: 15_000 }
    );
    await new Promise((r) => setTimeout(r, 400)); // small settle

    const listPath = resolve(OUT_DIR, "active-prospects-list.png");
    await page.screenshot({ path: listPath as `${string}.png`, fullPage: false });
    console.log(`✓ saved ${listPath}`);

    // Click the top row (Vistabeam) → /api/prospect fires, detail panel +
    // HubSpot last-call block render.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("button")].find(
        (b) =>
          (b.textContent ?? "").includes("Vistabeam") &&
          (b.textContent ?? "").includes("Contract Sent")
      ) as HTMLButtonElement | undefined;
      row?.click();
    });

    // Wait for the HubSpot orange panel to appear.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("span")].some(
          (el) => el.textContent?.trim().startsWith("Last HubSpot")
        ),
      { timeout: 10_000 }
    );
    await new Promise((r) => setTimeout(r, 400));

    const detailPath = resolve(OUT_DIR, "active-prospects-detail.png");
    await page.screenshot({ path: detailPath as `${string}.png`, fullPage: false });
    console.log(`✓ saved ${detailPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
