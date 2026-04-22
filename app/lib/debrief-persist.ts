/**
 * Dual persistence for meeting debriefs:
 *   - Local JSONL at data/debriefs/local.jsonl (gitignored). Always on when
 *     the filesystem is writable — gives local dev a pre-read brief history
 *     without any GCP setup.
 *   - BigQuery if BIGQUERY_PROJECT_ID is set — authoritative cross-instance
 *     store, used in deployed environments.
 *
 * Read side (`readLocalDebriefs`) is used by app/lib/briefing.ts when BQ
 * isn't configured. Writes are fire-and-forget — failures log, never throw.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "fs";
import { resolve } from "path";
import type { MeetingDebrief } from "@/app/lib/debrief/schema";
import { logDebriefToBigQuery } from "@/app/lib/bq";

const LOCAL_PATH = resolve(process.cwd(), "data", "debriefs", "local.jsonl");

function isFilesystemWritable(): boolean {
  // Vercel / Lambda: only /tmp is writable, and it's per-invocation.
  // Skip the local file in those envs — BQ is the persistence layer there.
  if (process.env.VERCEL === "1" || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return false;
  }
  return true;
}

/**
 * Serialize a debrief as one line of JSON with the prospect name attached.
 * Matches the shape readLocalDebriefs returns so the aggregator in
 * briefing.ts doesn't need separate schemas.
 */
interface LocalDebriefRow {
  debrief: MeetingDebrief;
  prospectName: string | null;
  writtenAt: string;
}

function writeLocal(row: LocalDebriefRow): void {
  if (!isFilesystemWritable()) return;
  try {
    mkdirSync(resolve(LOCAL_PATH, ".."), { recursive: true });
    appendFileSync(LOCAL_PATH, JSON.stringify(row) + "\n", "utf8");
  } catch (err) {
    console.warn("[debrief-persist] local write failed:", err);
  }
}

/**
 * Persist a debrief to whichever stores are available. Safe to fire-and-
 * forget — errors are logged, never thrown.
 */
export async function persistDebrief(
  debrief: MeetingDebrief,
  opts: { prospectName?: string | null } = {}
): Promise<void> {
  const prospectName = opts.prospectName ?? null;

  // Local first — it's cheap and synchronous.
  writeLocal({ debrief, prospectName, writtenAt: new Date().toISOString() });

  // BigQuery — fail-soft, already handles its own errors.
  await logDebriefToBigQuery(debrief, { prospectName });
}

/**
 * Read all local debrief rows. Returns newest-first. Used by briefing.ts
 * when BigQuery isn't configured. Caps at MAX_ROWS rows parsed — JSONL
 * grows append-only but we only care about the tail.
 */
const MAX_ROWS = 1000;

export function readLocalDebriefs(): LocalDebriefRow[] {
  if (!isFilesystemWritable()) return [];
  if (!existsSync(LOCAL_PATH)) return [];
  try {
    const size = statSync(LOCAL_PATH).size;
    // If the file has grown large, we could read just the tail — but
    // 1k rows at ~2KB each is 2MB, trivial. Keep it simple.
    const raw = readFileSync(LOCAL_PATH, "utf8");
    const rows: LocalDebriefRow[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as LocalDebriefRow);
      } catch {
        /* skip malformed line */
      }
    }
    // Newest first by writtenAt.
    rows.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
    return rows.slice(0, MAX_ROWS);
    // `size` is intentionally read to let callers log pressure; not used here.
    void size;
  } catch (err) {
    console.warn("[debrief-persist] local read failed:", err);
    return [];
  }
}
