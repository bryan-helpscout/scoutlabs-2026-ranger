"use client";

/**
 * Parse a pasted Zoom transcript into speaker-tagged chunks ready for
 * /api/transcript/ingest.
 *
 * Tolerates the three shapes Zoom actually produces:
 *
 *   1) WebVTT (cloud-recording export):
 *        WEBVTT
 *        1
 *        00:00:01.234 --> 00:00:04.567
 *        Alice Smith: Hello, thanks for making time today.
 *
 *   2) Live caption log (save-captions export):
 *        Alice Smith  00:01:23
 *        Hello, thanks for making time today.
 *
 *   3) Simple colon-prefixed lines (hand-edited or Fireflies):
 *        Alice Smith: Hello, thanks for making time today.
 *        Bob Johnson: Sure, happy to be here.
 *
 * Speaker normalization: raw names are carried through as-is. The triage
 * layer doesn't care about speaker identity; the UI transcript strip just
 * shows whatever label we pass. Callers can override via the
 * defaultSpeaker option if they want everything bucketed as
 * "prospect"/"ae".
 */

export interface ParsedChunk {
  speaker: string;
  text: string;
}

interface ParseOptions {
  /** Fallback speaker when no name can be detected (e.g. a lone line of text
   *  between WebVTT timestamps). Defaults to "speaker". */
  defaultSpeaker?: string;
}

// Lines that look like VTT headers or cue counters — always safe to skip.
const VTT_NOISE = /^(WEBVTT|NOTE\s|STYLE|\d+\s*$|\s*$)/i;
// VTT timestamp line: 00:00:01.234 --> 00:00:04.567
const VTT_TIMESTAMP = /^\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/;
// "Name: text" — the main speaker form. Stops at the FIRST colon so names
// with multiple words work. Requires the name side to be short-ish and the
// text side non-empty.
const COLON_LINE = /^\s*([A-Z][\w .'-]{0,60}?)\s*:\s*(.+?)\s*$/;
// "Name  00:01:23" — live-caption header. Name followed by timestamp, no
// colon in between.
const CAPTION_HEADER = /^\s*([A-Z][\w .'-]{0,60})\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/;
// "From Alice Smith to Everyone 00:01:23: Hello" — Zoom chat export form.
const ZOOM_CHAT = /^\s*From\s+(.+?)\s+to\s+.+?\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s*)?:\s*(.+?)\s*$/i;

export function parseZoomTranscript(
  raw: string,
  opts: ParseOptions = {}
): ParsedChunk[] {
  const defaultSpeaker = opts.defaultSpeaker ?? "speaker";
  const out: ParsedChunk[] = [];
  let pendingSpeaker: string | null = null; // for the caption-header form

  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      // Blank line resets the caption-header state — the "Name 00:01:23"
      // header only applies to the immediately-following line(s).
      pendingSpeaker = null;
      continue;
    }
    if (VTT_NOISE.test(line) || VTT_TIMESTAMP.test(line)) continue;

    // "From X to Y: msg" — rare but distinct; short-circuit so we don't
    // confuse it with the generic colon form.
    const zc = ZOOM_CHAT.exec(line);
    if (zc) {
      pushChunk(out, zc[1].trim(), zc[2].trim());
      pendingSpeaker = null;
      continue;
    }

    // "Name  00:01:23" header → remember speaker, next line is their text.
    const ch = CAPTION_HEADER.exec(line);
    if (ch) {
      pendingSpeaker = ch[1].trim();
      continue;
    }

    // "Name: text" — primary form.
    const cl = COLON_LINE.exec(line);
    if (cl && !looksLikeNoise(cl[1])) {
      pushChunk(out, cl[1].trim(), cl[2].trim());
      pendingSpeaker = null;
      continue;
    }

    // Otherwise it's a body line — attach to the pending speaker (caption
    // header) or the most-recent chunk, or fall back to defaultSpeaker.
    if (pendingSpeaker) {
      pushChunk(out, pendingSpeaker, line);
      // pendingSpeaker stays so multi-line captions merge
      continue;
    }
    if (out.length > 0) {
      // Body continuation — append to last chunk's text.
      const last = out[out.length - 1];
      last.text = (last.text + " " + line).replace(/\s+/g, " ").trim();
      continue;
    }
    // Nothing established yet — emit under the default speaker rather than drop.
    pushChunk(out, defaultSpeaker, line);
  }

  return out;
}

/** Guard against false-positive "Speaker: text" matches from lines that
 *  look like URLs, file paths, ratios, etc. */
function looksLikeNoise(candidate: string): boolean {
  const s = candidate.trim();
  if (!s) return true;
  // "http", "https", "c", etc. — single-word-with-no-spaces names are
  // usually real ("Alice"), but keep a tiny blocklist for the common lies.
  return /^(https?|www|file|https)$/i.test(s);
}

function pushChunk(out: ParsedChunk[], speaker: string, text: string): void {
  const cleanSpeaker = speaker.replace(/\s+/g, " ").trim() || "speaker";
  const cleanText = text.trim();
  if (!cleanText) return;
  // If the last chunk has the same speaker and no terminal punctuation,
  // merge to avoid flooding the triage layer with tiny fragments.
  const last = out[out.length - 1];
  if (
    last &&
    last.speaker === cleanSpeaker &&
    !/[.!?]["')\]]?$/.test(last.text)
  ) {
    last.text = (last.text + " " + cleanText).replace(/\s+/g, " ").trim();
    return;
  }
  out.push({ speaker: cleanSpeaker, text: cleanText });
}
