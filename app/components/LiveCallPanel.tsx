"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./CoPilot.module.css";

// ── types mirrored from lib/transcript-store ──────────────────────────────

interface TranscriptChunk {
  id: string;
  meetingId: string;
  speaker: string;
  text: string;
  timestamp: number;
}

type CardSource = "slab" | "slack" | "linear" | "hubspot" | "competitor" | "reddit" | "answer";

interface Card {
  id: string;
  source: CardSource;
  title: string;
  snippet?: string;
  url?: string;
  triggeredBy?: string;
  surfacedAt: number;
  // Answer-card only
  question?: string;
  sourceRefs?: string[];
}

type StreamEvent =
  | { type: "snapshot"; chunks: TranscriptChunk[]; cards: Card[] }
  | { type: "transcript"; chunk: TranscriptChunk }
  | { type: "card"; card: Card }
  | { type: "triage"; phase: "running" | "idle" };

// ── component ──────────────────────────────────────────────────────────────

interface LiveCallPanelProps {
  /**
   * Called when the AE clicks "Ask Ranger →" on a surfaced card. Receives a
   * natural-language prompt that should be dropped into the main chat input.
   * We don't auto-send — AEs want to preview before hitting Enter during a
   * live call.
   */
  onAskAboutCard?: (prompt: string) => void;
}

/** Build a chat prompt from a surfaced card, tuned for each source's tools. */
function promptForCard(card: Card): string {
  const reasonHint = card.triggeredBy ? ` (surfaced because: "${card.triggeredBy}")` : "";
  switch (card.source) {
    case "slab":
      return `Give me the key details from the Slab doc "${card.title}"${reasonHint} — cover setup, what plan tier it's on, and any limitations I should mention to the prospect.`;
    case "slack":
      return `Find and summarize this Slack thread${reasonHint}:\n\n**${card.title}**${
        card.snippet ? `\n> ${card.snippet}` : ""
      }\n\nWhat's the key takeaway I should relay to the prospect?`;
    case "linear":
      return `What's the current status, expected timeline, and customer-facing story for ${card.title}${reasonHint}? Safe to mention to prospects yet, or still internal?`;
    case "hubspot":
      return `Tell me more about ${card.title}${reasonHint}.`;
    case "competitor": {
      // Title is "vs <Name>" — strip the "vs " for a clean competitor name.
      const name = card.title.replace(/^vs\s+/i, "");
      return `The prospect mentioned they're evaluating ${name}. Give me the full battle card — their pricing, what they're genuinely good at, our strongest advantages with specific numbers, landmines to watch for, and 2-3 pivot moves I can use on this call.`;
    }
    case "answer": {
      const q = card.question ?? card.title;
      const a = card.snippet ?? "";
      return `On a live call, Ranger synthesized this answer:\n\nQ: ${q}\nA: ${a}\n\nExpand it for me — add concrete proof points, the specific tier/plan details, and 1–2 follow-up questions the prospect might ask next so I can pre-load the answers.`;
    }
    case "reddit": {
      // Title looks like "Reddit · Zendesk · high urgency" — extract competitor name
      const nameMatch = card.title.match(/Reddit · ([^·]+?)\s*·/i);
      const name = nameMatch ? nameMatch[1].trim() : "the competitor";
      const pain = card.snippet ?? "";
      return `A Reddit user is voicing this pain point about ${name}:\n\n> ${pain}\n\nA prospect on my call might raise the same concern. Draft a response I can use live — address the underlying pain directly, reference Help Scout's specific advantage, but do NOT mention Reddit or quote this verbatim. Keep it to 3-4 sentences.`;
    }
  }
}

export default function LiveCallPanel({ onAskAboutCard }: LiveCallPanelProps = {}) {
  const [meetingId, setMeetingId] = useState("");
  const [active, setActive] = useState(false);
  const [triagePhase, setTriagePhase] = useState<"running" | "idle">("idle");
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript to bottom as chunks arrive.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [chunks.length]);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setActive(false);
    setTriagePhase("idle");
  }, []);

  const start = useCallback(() => {
    const id = meetingId.trim();
    if (!id) return;
    // If already connected to a different meeting, tear it down first.
    esRef.current?.close();
    setChunks([]);
    setCards([]);
    setActive(true);

    const es = new EventSource(
      `/api/transcript/stream?meetingId=${encodeURIComponent(id)}`
    );
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as StreamEvent;
        if (event.type === "snapshot") {
          setChunks(event.chunks);
          setCards(event.cards);
        } else if (event.type === "transcript") {
          setChunks((prev) => [...prev, event.chunk]);
        } else if (event.type === "card") {
          // Server already dedups by id, but guard against duplicate dispatch
          // (e.g. transient React StrictMode double-subscribe in dev).
          setCards((prev) =>
            prev.find((c) => c.id === event.card.id) ? prev : [event.card, ...prev]
          );
        } else if (event.type === "triage") {
          setTriagePhase(event.phase);
        }
      } catch {
        // ignore malformed lines
      }
    };

    es.onerror = () => {
      // Browser auto-reconnects on error; if the server is truly down, the
      // user can just hit Stop.
    };
  }, [meetingId]);

  // Clean up on unmount.
  useEffect(() => {
    return () => esRef.current?.close();
  }, []);

  const sourceColor = (s: CardSource): string => {
    switch (s) {
      case "slab": return "#FF6542";       // Slab brand
      case "slack": return "#4A154B";      // Slack brand
      case "linear": return "#5E6AD2";     // Linear brand
      case "hubspot": return "#FF7A59";    // HubSpot brand
      case "competitor": return "#B83525"; // HSDS red 600 (destructive feel)
      case "reddit": return "#FF4500";     // Reddit brand
      case "answer": return "#2D7A4F";     // HSDS ranger 600 — "Ranger speaking"
    }
  };

  return (
    <aside className={styles.liveCallPanel}>
      <div className={styles.lcpHeader}>
        <div className={styles.lcpTitle}>
          <span
            className={`${styles.lcpLiveDot} ${active ? "" : styles.idle}`}
          />
          Live call
          {active && triagePhase === "running" && (
            <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-tertiary)" }}>
              triaging…
            </span>
          )}
        </div>
        <div className={styles.lcpSub}>
          {active
            ? "Listening — surfaces Slab docs as the conversation moves"
            : "Connect a meeting ID to start a transcript feed"}
        </div>
        <div className={styles.lcpMeetingRow}>
          <input
            className={styles.lcpMeetingInput}
            placeholder="Meeting ID (e.g. zoom-8471 or test-1)"
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            disabled={active}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !active) start();
            }}
          />
          <button
            className={`${styles.lcpMeetingBtn} ${active ? styles.active : ""}`}
            onClick={active ? stop : start}
            disabled={!active && !meetingId.trim()}
          >
            {active ? "Stop" : "Start"}
          </button>
        </div>
      </div>

      <div className={styles.lcpBody}>
        {!active && chunks.length === 0 && cards.length === 0 && (
          <div className={styles.lcpEmpty}>
            Feed transcripts to{" "}
            <code>POST /api/transcript/ingest</code> with this meeting ID and
            relevant Slab docs will appear here automatically as topics come
            up.
          </div>
        )}

        {cards.length > 0 && (
          <>
            <div className={styles.lcpSectionLabel}>
              Suggested · {cards.length}
            </div>
            <div className={styles.lcpCards}>
              {cards.map((card) => {
                const openUrl = () => {
                  if (card.url) window.open(card.url, "_blank", "noopener,noreferrer");
                };
                const askAbout = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  onAskAboutCard?.(promptForCard(card));
                };

                // Answer cards get a distinct Q/A layout — the AE scans the
                // question first, then the synthesized answer. Source cards
                // keep the existing title/snippet/reason layout.
                if (card.source === "answer") {
                  return (
                    <div
                      key={card.id}
                      className={`${styles.lcpCard} ${styles.lcpCardAnswer}`}
                    >
                      <div className={styles.lcpCardHead}>
                        <span
                          className={styles.lcpCardSource}
                          style={{ color: sourceColor(card.source) }}
                        >
                          💡 Answer
                        </span>
                        <span className={styles.lcpCardTime}>
                          {formatClock(card.surfacedAt)}
                        </span>
                      </div>
                      <div className={styles.lcpAnswerQuestion}>
                        <span className={styles.lcpAnswerLabel}>Q:</span> {card.question ?? card.title}
                      </div>
                      {card.snippet && (
                        <div className={styles.lcpAnswerBody}>
                          <span className={styles.lcpAnswerLabel}>A:</span> {card.snippet}
                        </div>
                      )}
                      {card.sourceRefs && card.sourceRefs.length > 0 && (
                        <div className={styles.lcpAnswerRefs}>
                          Based on: {card.sourceRefs.join(" · ")}
                        </div>
                      )}
                      <div className={styles.lcpCardActions}>
                        <button
                          type="button"
                          className={styles.lcpAskBtn}
                          onClick={askAbout}
                          title="Expand this answer in the main chat"
                        >
                          Expand →
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={card.id}
                    className={styles.lcpCard}
                    role={card.url ? "link" : undefined}
                    tabIndex={card.url ? 0 : undefined}
                    onClick={openUrl}
                    onKeyDown={(e) => {
                      if (card.url && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        openUrl();
                      }
                    }}
                    style={card.url ? undefined : { cursor: "default" }}
                  >
                    <div className={styles.lcpCardHead}>
                      <span
                        className={styles.lcpCardSource}
                        style={{ color: sourceColor(card.source) }}
                      >
                        {card.source}
                      </span>
                      <span className={styles.lcpCardTime}>
                        {formatClock(card.surfacedAt)}
                      </span>
                    </div>
                    <div className={styles.lcpCardTitle}>{card.title}</div>
                    {card.snippet && (
                      <div className={styles.lcpCardSnippet}>{card.snippet}</div>
                    )}
                    {card.triggeredBy && (
                      <div className={styles.lcpCardReason}>
                        “{card.triggeredBy}”
                      </div>
                    )}
                    <div className={styles.lcpCardActions}>
                      <button
                        type="button"
                        className={styles.lcpAskBtn}
                        onClick={askAbout}
                        title="Drop a question about this into the main chat"
                      >
                        Ask Ranger →
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {chunks.length > 0 && (
          <>
            <div className={styles.lcpSectionLabel}>Transcript</div>
            <div className={styles.lcpTranscript}>
              {chunks.slice(-40).map((c) => (
                <div key={c.id} className={styles.chunk}>
                  <span className={styles.speaker}>{c.speaker}:</span>
                  {c.text}
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
