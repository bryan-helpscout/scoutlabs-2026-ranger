/**
 * Zoom caption-file tailer → Ranger transcript ingest.
 *
 * Watches Zoom's local captions folder for new meetings, tails the
 * captions file as Zoom's own STT fills it, and forwards each new line
 * to POST /api/transcript/ingest — the same endpoint used by paste /
 * curl / (formerly) mic. Cards surface in Ranger's live panel as the
 * conversation runs.
 *
 * Zero external deps — uses Node's built-in fs + setInterval polling
 * rather than chokidar so the script works without npm install on a
 * fresh machine.
 *
 * Prereqs (user side, one-time):
 *   - Zoom → Settings → Accessibility → Closed Captioning → enable
 *   - Zoom → Settings → Recording → "Save captions" → pick a folder
 *     (we default to ~/Documents/Zoom, Zoom's macOS default)
 *
 * During a call:
 *   - Click "Show Captions" in Zoom (CC icon). Captions start
 *     writing to <folder>/<meeting-subfolder>/meeting_saved_closed_caption.txt
 *   - The script detects the new meeting folder, starts tailing, and
 *     ingests under a stable meeting ID derived from the folder name
 *   - Script prints "→ meetingId: zoom-xxx" — paste that into Ranger's
 *     Meeting ID input and click Start.
 *
 * Env overrides:
 *   RANGER_URL=http://localhost:3000      (default)
 *   ZOOM_CAPTIONS_DIR=~/Documents/Zoom    (default on macOS)
 *   ZOOM_POLL_INTERVAL_MS=800             (default)
 */

import { existsSync, readdirSync, readFileSync, statSync, readFile } from "fs";
import { homedir } from "os";
import { resolve, join } from "path";
import { parseZoomTranscript } from "../app/lib/zoom-transcript.ts";

// ── Config ───────────────────────────────────────────────────────────────

const RANGER_URL = process.env.RANGER_URL ?? "http://localhost:3000";
const ZOOM_DIR =
  process.env.ZOOM_CAPTIONS_DIR ??
  resolve(homedir(), "Documents", "Zoom");
const POLL_MS = Number(process.env.ZOOM_POLL_INTERVAL_MS ?? 800);

// Common caption filenames Zoom uses across versions. We check all of them.
const CAPTION_FILENAMES = [
  "meeting_saved_closed_caption.txt",
  "meeting_saved_captions.txt",
];

// ── Per-meeting state ────────────────────────────────────────────────────

interface MeetingState {
  folder: string;          // absolute path to the meeting subfolder
  captionPath: string;     // absolute path to the active captions file
  meetingId: string;       // derived stable id we send to Ranger
  bytesRead: number;       // tail offset into captionPath
  lastSpeaker: string | null;
}

const tracked = new Map<string, MeetingState>();

// ── Main loop ────────────────────────────────────────────────────────────

function deriveMeetingId(folderName: string): string {
  // Zoom folders look like "2026-04-22 14.30.22 Demo Call 12345".
  // Slug down to something URL-friendly + reasonably readable in logs.
  return (
    "zoom-" +
    folderName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
  );
}

function findCaptionFile(folder: string): string | null {
  for (const name of CAPTION_FILENAMES) {
    const p = join(folder, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function discoverMeetings(): void {
  if (!existsSync(ZOOM_DIR)) return;
  let entries: string[];
  try {
    entries = readdirSync(ZOOM_DIR);
  } catch (err) {
    console.warn(`[watch-zoom] couldn't read ${ZOOM_DIR}:`, err);
    return;
  }
  for (const entry of entries) {
    const folder = join(ZOOM_DIR, entry);
    let stat;
    try {
      stat = statSync(folder);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Already tracking? Just check that the captions file still exists.
    if (tracked.has(folder)) continue;

    const captionPath = findCaptionFile(folder);
    if (!captionPath) continue; // folder exists but captions haven't started

    const meetingId = deriveMeetingId(entry);
    tracked.set(folder, {
      folder,
      captionPath,
      meetingId,
      bytesRead: 0, // start from 0 — we'll re-send any lines already in the
                    // file, which is fine: the transcript store de-dupes
                    // nothing but the triage layer is idempotent on topic
      lastSpeaker: null,
    });
    console.log(
      `\n╭─ New meeting detected ──────────────────────────────────────╮\n│ folder:    ${entry}\n│ captions:  ${captionPath}\n│ meetingId: ${meetingId}\n│ ► Paste this meetingId into Ranger's Meeting ID input + click Start\n╰──────────────────────────────────────────────────────────────╯`
    );
  }
}

async function tailMeeting(state: MeetingState): Promise<void> {
  let stat;
  try {
    stat = statSync(state.captionPath);
  } catch {
    // File may have been deleted at end of meeting — keep the state
    // around in case Zoom re-opens it, but skip this tick.
    return;
  }
  if (stat.size <= state.bytesRead) return; // no new content

  // Read just the new bytes. For Zoom captions (text file, small) this
  // is cheap; keeping the delta lets us handle big recordings gracefully.
  let chunk: string;
  try {
    chunk = await readRange(state.captionPath, state.bytesRead, stat.size);
  } catch (err) {
    console.warn(`[watch-zoom] read failed for ${state.captionPath}:`, err);
    return;
  }
  state.bytesRead = stat.size;

  // Parse speaker-tagged lines out of the new chunk. The parser is the
  // same one the UI uses for the Paste Zoom Transcript textarea, so
  // behaviour matches exactly.
  const parsed = parseZoomTranscript(chunk, { defaultSpeaker: "prospect" });
  if (parsed.length === 0) return;

  try {
    const res = await fetch(`${RANGER_URL}/api/transcript/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingId: state.meetingId, chunks: parsed }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[watch-zoom] ingest ${res.status} for ${state.meetingId}: ${body.slice(0, 120)}`
      );
      return;
    }
    // Compact status line so the terminal stays scannable during a live call.
    for (const p of parsed) {
      console.log(
        `  ${state.meetingId}  [${p.speaker}]  ${p.text.slice(0, 80)}${p.text.length > 80 ? "…" : ""}`
      );
    }
  } catch (err) {
    console.warn(`[watch-zoom] fetch failed:`, err);
  }
}

function readRange(path: string, start: number, end: number): Promise<string> {
  // We intentionally re-read the full file and slice — keeps the code
  // trivially correct vs. managing fd positions. The captions file is
  // small (a few KB per hour) so the overhead is negligible.
  return new Promise((res, rej) => {
    readFile(path, "utf8", (err, data) => {
      if (err) return rej(err);
      res(data.slice(start, end));
    });
  });
}

async function tick(): Promise<void> {
  discoverMeetings();
  await Promise.all([...tracked.values()].map(tailMeeting));
}

// ── Boot ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Watching Zoom captions folder: ${ZOOM_DIR}`);
  console.log(`Posting chunks to:           ${RANGER_URL}/api/transcript/ingest`);
  console.log(`Polling every ${POLL_MS}ms — waiting for a meeting with "Show Captions" enabled…\n`);
  if (!existsSync(ZOOM_DIR)) {
    console.warn(
      `⚠ ${ZOOM_DIR} doesn't exist yet — it'll be created the first time Zoom saves captions.\n`
    );
  }
  // Sanity-check Ranger is reachable.
  try {
    const res = await fetch(`${RANGER_URL}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) console.warn(`⚠ ${RANGER_URL} responded ${res.status} — is the dev server running?`);
  } catch {
    console.warn(
      `⚠ Can't reach ${RANGER_URL}. Make sure you've started the dev server with \`npm run dev\` in another terminal.`
    );
  }

  // Run forever.
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
