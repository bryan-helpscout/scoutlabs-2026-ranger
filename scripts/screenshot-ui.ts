/**
 * Screenshot the Ranger UI in its populated state.
 *
 *   npm run dev          # in one terminal
 *   npm run screenshot-ui  # in another — saves screenshots/ranger-ui.png
 *
 * Drives the flow end-to-end so the image reflects a real working session,
 * not just the empty start page:
 *   1. Loads a prospect (Vistabeam) → HubSpot card populates via REST
 *   2. Starts a live call with a test meeting ID
 *   3. Ingests a transcript chunk mentioning Zendesk + SAML + webhooks → the
 *      triage loop surfaces competitor + Reddit + Slack + Slab cards
 *   4. Waits for cards to settle, then captures a full-page PNG
 *
 * Uses puppeteer-core + the system Chrome (no bundled browser download).
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
  console.error("No Chrome/Chromium binary found. Tried:", CHROME_PATHS);
  process.exit(1);
}

const URL = process.env.RANGER_URL ?? "http://localhost:3000";
const OUT = resolve(
  process.cwd(),
  "screenshots",
  `ranger-ui-${new Date().toISOString().slice(0, 10)}.png`
);
const MEETING_ID = `shot-${Date.now()}`;
const PROSPECT = process.env.RANGER_PROSPECT ?? "Vistabeam";

async function ingestTranscript(): Promise<void> {
  // Fire the transcript chunk from Node (same origin as the browser, doesn't
  // matter). This kicks the triage loop to surface cards via SSE.
  const res = await fetch(`${URL}/api/transcript/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      meetingId: MEETING_ID,
      speaker: "prospect",
      // Phrased as a concrete question so the triage layer synthesizes an
      // Answer card. Override via RANGER_TRANSCRIPT env var for other demos.
      text:
        process.env.RANGER_TRANSCRIPT ??
        "We're currently on Zendesk, paying about $70/agent/month. Can you tell me what the actual cost savings on Help Scout would look like, and does SAML SSO with Okta come included on your Pro plan?",
    }),
  });
  if (!res.ok) throw new Error(`transcript ingest failed: ${res.status}`);
}

async function main() {
  console.log(`URL: ${URL}`);
  console.log(`Chrome: ${CHROME_PATH}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // 1. Type the prospect name — the app debounces for 800ms then calls /api/prospect
    await page.waitForSelector("input[placeholder*='Company name']");
    await page.type("input[placeholder*='Company name']", PROSPECT, { delay: 20 });

    // 2. Fill meeting ID + click Start (CSS-Module class names are hashed,
    //    so we find by placeholder then by the page's own DOM shape).
    await page.waitForSelector("input[placeholder*='Meeting ID']");
    await page.type("input[placeholder*='Meeting ID']", MEETING_ID, { delay: 20 });
    await page.evaluate(() => {
      const startBtn = [...document.querySelectorAll("aside button")].find(
        (b) => b.textContent?.trim() === "Start"
      ) as HTMLButtonElement | undefined;
      startBtn?.click();
    });

    // 3. Give the HubSpot lookup its debounce + round-trip.
    await new Promise((r) => setTimeout(r, 1500));

    // 4. Fire the transcript chunk → triage surfaces cards via SSE.
    await ingestTranscript();

    // 5. Wait until the synthesized Answer card renders — this comes last in
    //    the triage pipeline (after all source cards settle), so its presence
    //    means the panel is fully populated.
    await page.waitForFunction(
      () => {
        return [...document.querySelectorAll("aside div")].some((el) =>
          (el.textContent ?? "").includes("💡 Answer")
        );
      },
      { timeout: 25_000 }
    );
    // Small settle for animations.
    await new Promise((r) => setTimeout(r, 800));

    // 6. Capture full-page PNG.
    await page.screenshot({ path: OUT, fullPage: false });
    console.log(`✓ saved ${OUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
