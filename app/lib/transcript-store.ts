/**
 * In-memory per-meeting store for live call transcripts and surfaced cards.
 *
 * Shape: module-level singleton. Meeting IDs are opaque strings (Zoom meeting
 * ID, Fireflies conversation ID, "test-1" during dev — we don't care).
 *
 * Dev-only limitations:
 *  - Memory is process-local. For multi-instance deploys, swap this for Redis
 *    pub/sub and a shared store. The `MeetingStore` interface is the seam.
 *  - HMR in Next dev can wipe state; we hang the singleton off globalThis so
 *    hot reloads don't cause duplicate stores with orphaned subscribers.
 */

import { EventEmitter } from "events";

export type Speaker = "ae" | "prospect" | "other" | string;

export interface TranscriptChunk {
  id: string; // unique per chunk
  meetingId: string;
  speaker: Speaker;
  text: string;
  timestamp: number; // epoch ms
}

export type CardSource = "slab" | "slack" | "linear" | "hubspot" | "competitor" | "reddit" | "answer";

export interface Card {
  id: string; // stable hash of source+ref — used for dedup
  source: CardSource;
  title: string;
  snippet?: string;
  url?: string;
  triggeredBy?: string; // reason string from the triage model
  surfacedAt: number;
  // Answer-card only — present when source === "answer". The question is the
  // prospect/AE's inferred concrete question; sourceRefs are human-readable
  // attributions ("Slab", "Slack", "product facts") shown as a "based on" line.
  question?: string;
  sourceRefs?: string[];
}

export type MeetingEvent =
  | { type: "transcript"; chunk: TranscriptChunk }
  | { type: "card"; card: Card }
  | { type: "triage"; phase: "running" | "idle" };

interface MeetingState {
  id: string;
  chunks: TranscriptChunk[]; // full history, trimmed to MAX_CHUNKS
  cards: Card[]; // surfaced cards, newest first
  surfacedCardIds: Set<string>; // dedup
  surfacedQueryKeys: Map<string, number>; // query-key → timestamp (dedup by query)
  lastTriageAt: number;
  wordsSinceTriage: number;
  triageInFlight: boolean;
  emitter: EventEmitter;
}

const MAX_CHUNKS = 2000; // ~4–8 hours of talk, plenty
const MAX_CARDS = 200;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.__rangerMeetings) g.__rangerMeetings = new Map<string, MeetingState>();
const meetings: Map<string, MeetingState> = g.__rangerMeetings;

function getOrCreate(id: string): MeetingState {
  let m = meetings.get(id);
  if (m) return m;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100); // many SSE clients on one meeting is fine
  m = {
    id,
    chunks: [],
    cards: [],
    surfacedCardIds: new Set(),
    surfacedQueryKeys: new Map(),
    lastTriageAt: 0,
    wordsSinceTriage: 0,
    triageInFlight: false,
    emitter,
  };
  meetings.set(id, m);
  return m;
}

export function appendTranscriptChunk(chunk: TranscriptChunk): MeetingState {
  const m = getOrCreate(chunk.meetingId);
  m.chunks.push(chunk);
  if (m.chunks.length > MAX_CHUNKS) m.chunks.splice(0, m.chunks.length - MAX_CHUNKS);
  m.wordsSinceTriage += countWords(chunk.text);
  const event: MeetingEvent = { type: "transcript", chunk };
  m.emitter.emit("event", event);
  return m;
}

export function addCard(meetingId: string, card: Card): boolean {
  const m = getOrCreate(meetingId);
  if (m.surfacedCardIds.has(card.id)) return false;
  m.surfacedCardIds.add(card.id);
  m.cards.unshift(card);
  if (m.cards.length > MAX_CARDS) m.cards.length = MAX_CARDS;
  const event: MeetingEvent = { type: "card", card };
  m.emitter.emit("event", event);
  return true;
}

/** Record that a query was used so we don't re-surface it for ~60s. */
export function markQuerySurfaced(meetingId: string, source: CardSource, query: string): void {
  const m = getOrCreate(meetingId);
  m.surfacedQueryKeys.set(`${source}:${normalizeQuery(query)}`, Date.now());
}

/** Has the same (source, query) been surfaced within `windowMs`? */
export function wasQueryRecentlySurfaced(
  meetingId: string,
  source: CardSource,
  query: string,
  windowMs = 60_000
): boolean {
  const m = getOrCreate(meetingId);
  const t = m.surfacedQueryKeys.get(`${source}:${normalizeQuery(query)}`);
  return !!t && Date.now() - t < windowMs;
}

export function emitTriagePhase(meetingId: string, phase: "running" | "idle"): void {
  const m = getOrCreate(meetingId);
  m.emitter.emit("event", { type: "triage", phase } satisfies MeetingEvent);
}

export function getMeetingSnapshot(meetingId: string): {
  chunks: TranscriptChunk[];
  cards: Card[];
} {
  const m = getOrCreate(meetingId);
  return { chunks: [...m.chunks], cards: [...m.cards] };
}

/** Subscribe to a meeting's event stream. Returns unsubscribe fn. */
export function subscribe(meetingId: string, handler: (e: MeetingEvent) => void): () => void {
  const m = getOrCreate(meetingId);
  m.emitter.on("event", handler);
  return () => m.emitter.off("event", handler);
}

/** Last N seconds of transcript as a flat array. */
export function getRecentTranscript(meetingId: string, windowMs: number): TranscriptChunk[] {
  const m = getOrCreate(meetingId);
  const cutoff = Date.now() - windowMs;
  return m.chunks.filter((c) => c.timestamp >= cutoff);
}

/** Expose the internal state to the triage scheduler (read/write). */
export function getMutableState(meetingId: string): MeetingState {
  return getOrCreate(meetingId);
}

// ── helpers ────────────────────────────────────────────────────────────────

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeQuery(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}
