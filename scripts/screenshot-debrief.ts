/**
 * Screenshot the post-call debrief UI.
 *
 *   npm run dev             # in one terminal
 *   npm run screenshot-debrief
 *
 * Drives the full debrief flow in headless Chrome so the output is a real
 * rendered state, not a mock:
 *   1. Load prospect "Vistabeam" (HubSpot pulls the Tyler Weinrich card)
 *   2. Start a meeting, POST 7 rich transcript chunks (Zendesk-migration call)
 *   3. Click "📋 End & debrief", wait for Sonnet to synthesize (~30–45s)
 *   4. Save screenshots/debrief.png
 *
 * Uses puppeteer-core against system Chrome (same as screenshot-ui.ts).
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "fs";
import { resolve } from "path";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const CHROME_PATH = CHROME_PATHS.find(existsSync);
if (!CHROME_PATH) {
  console.error("No Chrome/Chromium binary found.");
  process.exit(1);
}

const URL = process.env.RANGER_URL ?? "http://localhost:3000";
const OUT = resolve(process.cwd(), "screenshots", "debrief.png");
const MEETING_ID = `shot-debrief-${Date.now()}`;
const PROSPECT = process.env.RANGER_PROSPECT ?? "Vistabeam";

/** Rich call transcript — same shape we use for the demo/test run. Gives
 *  Sonnet enough signal to produce a meaningful score, multiple action
 *  items, open questions, risks, and a couple of email drafts. */
const TRANSCRIPT: Array<{ speaker: string; text: string }> = [
  { speaker: "ae", text: "Thanks for making time today, Alex. I wanted to start by understanding your current setup and what brought you to evaluate Help Scout." },
  { speaker: "prospect", text: "Yeah, so we are a 45-person support team, we have been on Zendesk for four years. We are paying about 70 per agent per month when you add all the add-ons — AI Copilot, Workforce Management. Renewal is coming up in six weeks and my CFO is asking me why we pay Zendesk more than our entire productivity stack combined." },
  { speaker: "prospect", text: "Two things I really need clarity on. First, SAML SSO — we use Okta, this is a compliance requirement. Second, what does migration actually look like? We have about 80,000 historical conversations, plus a Docs site with maybe 400 articles." },
  { speaker: "ae", text: "Both great questions. SAML SSO with Okta is included on our Pro plan at 75 per user per month — natively supported, no add-on. On migration, we have done this for teams your size; typical timeline is 2 to 3 weeks from kickoff to full cutover. I will follow up with a migration guide and an example timeline from a team of your size." },
  { speaker: "prospect", text: "OK that is helpful. What is the next step typically? If this looks right we would want to move before our Zendesk renewal. Can you introduce me to a customer who migrated from Zendesk recently? And what is your contract length — annual, or can we go month-to-month to start?" },
  { speaker: "ae", text: "Annual gets you 17 percent off, but we can do month-to-month — let me send over both pricing options. I will also loop in a reference customer. Let us set up a technical deep-dive with your IT team for next week to walk through SAML and the migration plan end to end." },
  { speaker: "prospect", text: "Sounds good. Send all of that over, I will forward to my CFO and IT director. If the numbers work we can move fast — we really need to make a decision in the next two weeks." },
];

async function ingestAll(): Promise<void> {
  for (const chunk of TRANSCRIPT) {
    const res = await fetch(`${URL}/api/transcript/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingId: MEETING_ID, ...chunk }),
    });
    if (!res.ok) throw new Error(`transcript ingest failed: ${res.status}`);
  }
}

async function main() {
  console.log(`URL: ${URL}`);
  console.log(`Chrome: ${CHROME_PATH}`);
  console.log(`Meeting: ${MEETING_ID}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    // Tall viewport — the debrief panel stacks 6 cards, needs vertical room.
    defaultViewport: { width: 1700, height: 1800, deviceScaleFactor: 2 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // 1. Load the prospect so HubSpot context flows into email drafts
    await page.waitForSelector("input[placeholder*='Company name']");
    await page.type("input[placeholder*='Company name']", PROSPECT, { delay: 20 });

    // 2. Enter meeting ID + click Start
    await page.waitForSelector("input[placeholder*='Meeting ID']");
    await page.type("input[placeholder*='Meeting ID']", MEETING_ID, { delay: 20 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("aside button")].find(
        (b) => b.textContent?.trim() === "Start"
      ) as HTMLButtonElement | undefined;
      btn?.click();
    });

    // 3. Let the HubSpot debounce land + the SSE subscribe
    await new Promise((r) => setTimeout(r, 1500));

    // 4. Feed the transcript
    await ingestAll();
    console.log(`  ✓ ingested ${TRANSCRIPT.length} transcript chunks`);
    // Let triage surface some cards first (optional — the debrief ignores
    // the panel cards anyway, but looks more authentic in screenshot)
    await new Promise((r) => setTimeout(r, 4000));

    // 5. Click "Call ended" — the button label as of the debrief-modal refresh
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("aside button")].find((b) =>
        b.textContent?.includes("Call ended")
      ) as HTMLButtonElement | undefined;
      btn?.click();
      return !!btn;
    });
    if (!clicked) throw new Error("Call ended button not found");
    console.log(`  ✓ clicked Call ended — waiting for Sonnet…`);

    // 6. Wait for the debrief modal to actually render (Post-call debrief
    //    title appears in the DOM). Sonnet takes ~30-45s.
    await page.waitForFunction(
      () => {
        return [...document.querySelectorAll("h2")].some(
          (el) => el.textContent?.trim() === "Post-call debrief"
        );
      },
      { timeout: 90_000 }
    );
    // A small buffer so all debrief cards have rendered with their content.
    await new Promise((r) => setTimeout(r, 1500));

    // 7. Capture full-page PNG — fullPage: true grabs the scroll-past-viewport
    //    bits so all 6 debrief cards land in one image.
    await page.screenshot({ path: OUT, fullPage: true });
    console.log(`\n✓ saved ${OUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
