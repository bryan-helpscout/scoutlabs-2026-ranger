"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./CoPilot.module.css";
import DebriefModal, { type Debrief } from "./DebriefModal";
import { useSpeechRecognition } from "@/app/lib/use-speech-recognition";
import { parseZoomTranscript } from "@/app/lib/zoom-transcript";

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
  /**
   * Current prospect name loaded in the main sidebar. Passed through to
   * the debrief generator so email drafts can personalize to the right
   * contact.
   */
  prospectName?: string | null;
}

// Debrief type is imported from DebriefModal, which owns both the schema
// mirror and the rendering. The panel only needs to hand the debrief
// object to the modal when it's ready.

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

export default function LiveCallPanel({
  onAskAboutCard,
  prospectName,
}: LiveCallPanelProps = {}) {
  const [meetingId, setMeetingId] = useState("");
  const [active, setActive] = useState(false);
  const [triagePhase, setTriagePhase] = useState<"running" | "idle">("idle");
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [debrief, setDebrief] = useState<Debrief | null>(null);
  const [debriefOpen, setDebriefOpen] = useState(false);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [debriefError, setDebriefError] = useState<string | null>(null);
  /** Live interim transcript from the mic — shown under the button as
   *  "Listening: '…'" so the AE can see the recognizer is working. */
  const [interim, setInterim] = useState("");
  /** Stable handle to the active meeting id so mic callbacks (which capture
   *  closures) always POST to the current meeting. */
  const activeMeetingIdRef = useRef<string | null>(null);
  /** Zoom-transcript paste — the primary input method. The textarea is
   *  visible whenever the call is active. */
  const [pasteValue, setPasteValue] = useState("");
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  /** Browser mic is available but OFF by default — flip via the advanced
   *  toggle. Most setups don't capture the other caller's voice so it's
   *  not a good default. */
  const [micEnabled, setMicEnabled] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Mic-driven transcript capture. POSTs each FINAL speech chunk to the
  // same ingest webhook curl/Zoom/Fireflies would use — no backend change.
  const speech = useSpeechRecognition({
    onFinal: (text) => {
      const mid = activeMeetingIdRef.current;
      if (!mid) return;
      // fire-and-forget — one dropped chunk isn't worth surfacing an error
      fetch("/api/transcript/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: mid,
          speaker: "prospect",
          text,
        }),
      }).catch((err) => console.error("[mic] ingest failed:", err));
      setInterim(""); // clear preview once the chunk finalizes
    },
    onInterim: setInterim,
  });
  const esRef = useRef<EventSource | null>(null);
  /** Ref on the transcript scroll container (NOT a sentinel inside it).
   *  scrollIntoView would scroll all scrollable ancestors and drag the
   *  answer cards out of view; setting scrollTop directly keeps the
   *  scroll scoped to the transcript alone. */
  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    // Only auto-scroll if the user is already near the bottom — respects
    // manual scroll-up (so the AE can review a prior line without being
    // yanked back to the latest).
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom < 60) el.scrollTop = el.scrollHeight;
  }, [chunks.length]);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setActive(false);
    setTriagePhase("idle");
    speech.stop();
    activeMeetingIdRef.current = null;
    setInterim("");
  }, [speech]);

  /** End the call AND fire a post-call debrief. Stops the SSE, then hits
   *  /api/meeting/debrief with the current meetingId + loaded prospect. */
  const endAndDebrief = useCallback(async () => {
    const id = meetingId.trim();
    if (!id) return;
    // Tear down the SSE first so no more cards mutate state under us.
    esRef.current?.close();
    esRef.current = null;
    setActive(false);
    setTriagePhase("idle");
    setDebriefLoading(true);
    setDebriefError(null);

    try {
      const res = await fetch("/api/meeting/debrief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: id,
          prospectName: prospectName ?? null,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as Debrief;
      setDebrief(body);
      setDebriefOpen(true); // auto-open the modal when generation finishes
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setDebriefError(msg);
    } finally {
      setDebriefLoading(false);
    }
  }, [meetingId, prospectName]);


  const start = useCallback(() => {
    // Auto-generate a meeting id if empty so "click one button, go" works.
    // The AE can always override by typing one first.
    let id = meetingId.trim();
    if (!id) {
      id = `mic-${Date.now()}`;
      setMeetingId(id);
    }
    // If already connected to a different meeting, tear it down first
    // and clear any debrief from a prior call.
    esRef.current?.close();
    setChunks([]);
    setCards([]);
    setDebrief(null);
    setDebriefOpen(false);
    setDebriefError(null);
    setActive(true);
    activeMeetingIdRef.current = id;
    setPasteStatus(null);
    // Mic is OFF by default — user must explicitly enable via the advanced
    // toggle. The browser mic typically only captures the AE's voice well,
    // which is why paste-Zoom-transcript is the primary input method.
    if (speech.supported && micEnabled) speech.start();

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
  }, [meetingId, speech, micEnabled]);

  /**
   * Ingest a pasted Zoom transcript. Parses speaker-tagged lines (VTT, live
   * captions, or simple "Name: text" form), batches them into a single
   * /api/transcript/ingest call, and clears the textarea on success.
   * Triggers triage immediately for all chunks.
   */
  const ingestPastedTranscript = useCallback(async () => {
    const id = activeMeetingIdRef.current ?? meetingId.trim();
    if (!id) {
      setPasteStatus("Start the session first so the chunks have a meeting ID.");
      return;
    }
    const raw = pasteValue.trim();
    if (!raw) return;

    const chunks = parseZoomTranscript(raw, { defaultSpeaker: "prospect" });
    if (chunks.length === 0) {
      setPasteStatus("Couldn't find any speaker-tagged lines in that paste.");
      return;
    }

    setPasteStatus(`Ingesting ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}…`);
    try {
      const res = await fetch("/api/transcript/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: id, chunks }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { accepted?: number };
      setPasteStatus(
        `✓ Ingested ${body.accepted ?? chunks.length} line${chunks.length === 1 ? "" : "s"}. Cards will surface as triage runs.`
      );
      setPasteValue("");
    } catch (err) {
      setPasteStatus(
        `✗ Ingest failed: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
  }, [meetingId, pasteValue]);

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
            ? "Paste Zoom transcript chunks below — triage surfaces cards as they arrive"
            : "Start a session, then paste your Zoom transcript as the call runs"}
        </div>
        <div className={styles.lcpMeetingRow}>
          <input
            className={styles.lcpMeetingInput}
            placeholder="Meeting ID (auto-generated if empty)"
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            disabled={active}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !active) start();
            }}
          />
          <button
            className={`${styles.lcpMeetingBtn} ${active ? styles.active : ""} ${
              active && speech.listening ? styles.lcpMicListening : ""
            }`}
            onClick={active ? stop : start}
            title={
              active
                ? "End the transcript session"
                : "Open a transcript session — you can paste Zoom captions below"
            }
          >
            {active ? "Stop" : "Start"}
          </button>
        </div>
        {/* Zoom-transcript paste — the primary input method. Paste the
            live captions from Zoom every minute or two as the call runs,
            or dump the whole transcript at the end. Parser handles VTT
            + live-caption + simple "Name: text" form. */}
        {active && (
          <>
            <textarea
              className={styles.lcpPasteArea}
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder={`Paste Zoom transcript here…\n\nSupports:\n• VTT (00:00 --> 00:04\\nAlice: ...)\n• "Name  00:01:23" captions\n• "Alice: Hi"`}
              rows={5}
            />
            <div className={styles.lcpPasteRow}>
              <button
                type="button"
                className={styles.lcpMeetingBtn}
                onClick={ingestPastedTranscript}
                disabled={!pasteValue.trim()}
                style={{ flex: 1 }}
              >
                Ingest transcript
              </button>
              <button
                type="button"
                className={styles.lcpMeetingBtn}
                onClick={() => setShowAdvanced((v) => !v)}
                title="Advanced options — mic capture + audio loopback tip"
              >
                {showAdvanced ? "▾" : "▸"}
              </button>
            </div>
            {pasteStatus && (
              <div className={styles.lcpPasteStatus}>{pasteStatus}</div>
            )}
            {showAdvanced && (
              <div className={styles.lcpAdvanced}>
                <label className={styles.lcpAdvancedRow}>
                  <input
                    type="checkbox"
                    checked={micEnabled}
                    onChange={(e) => {
                      setMicEnabled(e.target.checked);
                      if (e.target.checked && speech.supported) speech.start();
                      else speech.stop();
                    }}
                    disabled={!speech.supported}
                  />
                  <span>
                    🎤 Use browser mic (experimental)
                    <div className={styles.lcpAdvancedHint}>
                      Browser mic only captures YOUR voice reliably. To capture
                      both sides, route Zoom&apos;s output through{" "}
                      <a
                        href="https://existential.audio/blackhole/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        BlackHole
                      </a>{" "}
                      (macOS) or{" "}
                      <a
                        href="https://vb-audio.com/Cable/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        VB-Cable
                      </a>{" "}
                      (Windows) and select it as your mic.
                    </div>
                  </span>
                </label>
                {speech.error && (
                  <div className={styles.lcpMicError}>{speech.error}</div>
                )}
                {micEnabled && speech.listening && interim && (
                  <div className={styles.lcpMicInterim}>
                    <span className={styles.lcpMicInterimLabel}>Listening:</span>{" "}
                    {interim}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {/* "Call ended" triggers the debrief. Appears whenever there's a
            transcript to analyze — the AE may have already clicked Stop
            and then realized they want the debrief. When the debrief is
            ready, the modal takes over the main window. */}
        {(active || chunks.length > 0) && !debrief && (
          <div className={styles.lcpMeetingRow}>
            <button
              className={`${styles.lcpMeetingBtn} ${styles.lcpDebriefBtn}`}
              onClick={endAndDebrief}
              disabled={debriefLoading || chunks.length === 0}
              style={{ flex: 1 }}
              title={
                chunks.length === 0
                  ? "Need at least one transcript chunk to generate a debrief"
                  : "End the call and generate a post-call debrief"
              }
            >
              {debriefLoading ? "Analyzing call…" : "📋 Call ended"}
            </button>
          </div>
        )}
        {/* Once debriefed, offer a way to re-open the modal in case the
            AE dismissed it. */}
        {debrief && !debriefOpen && (
          <div className={styles.lcpMeetingRow}>
            <button
              className={`${styles.lcpMeetingBtn} ${styles.lcpDebriefBtn}`}
              onClick={() => setDebriefOpen(true)}
              style={{ flex: 1 }}
            >
              📋 View debrief
            </button>
          </div>
        )}
      </div>

      <div className={styles.lcpBody}>
        {!active && chunks.length === 0 && cards.length === 0 && !debrief && (
          <div className={styles.lcpEmpty}>
            Feed transcripts to{" "}
            <code>POST /api/transcript/ingest</code> with this meeting ID and
            relevant Slab docs will appear here automatically as topics come
            up.
          </div>
        )}

        {debriefError && (
          <div className={styles.lcpEmpty} style={{ color: "var(--text-danger)" }}>
            ⚠️ Debrief failed: {debriefError}
          </div>
        )}

        {/* Debrief now renders in a modal (see <DebriefModal /> below).
            The panel just shows the "Call ended" / "View debrief" button
            in its header. */}

        {/* Cards split into three zones: Answers pinned-ish at top with
            their own internal scroll, Suggested source cards in the middle,
            Transcript at the bottom with independent auto-scroll. Prevents
            new transcript chunks from yanking the Q&A out of view. */}
        {(() => {
          const answerCards = cards.filter((c) => c.source === "answer");
          const sourceCards = cards.filter((c) => c.source !== "answer");
          const renderCard = (card: Card) => {
            const openUrl = () => {
              if (card.url) window.open(card.url, "_blank", "noopener,noreferrer");
            };
            const askAbout = (e: React.MouseEvent) => {
              e.stopPropagation();
              onAskAboutCard?.(promptForCard(card));
            };
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
                    <span className={styles.lcpAnswerLabel}>Q:</span>{" "}
                    {card.question ?? card.title}
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
          };

          return (
            <>
              {answerCards.length > 0 && (
                <section className={styles.lcpAnswerZone}>
                  <div className={styles.lcpSectionLabel}>
                    💡 Answers · {answerCards.length}
                  </div>
                  <div className={styles.lcpAnswerZoneScroll}>
                    <div className={styles.lcpCards}>
                      {answerCards.map(renderCard)}
                    </div>
                  </div>
                </section>
              )}

              {sourceCards.length > 0 && (
                <section className={styles.lcpSourceZone}>
                  <div className={styles.lcpSectionLabel}>
                    Suggested · {sourceCards.length}
                  </div>
                  <div className={styles.lcpSourceZoneScroll}>
                    <div className={styles.lcpCards}>
                      {sourceCards.map(renderCard)}
                    </div>
                  </div>
                </section>
              )}
            </>
          );
        })()}

        {chunks.length > 0 && (
          <section className={styles.lcpTranscriptZone}>
            <div className={styles.lcpSectionLabel}>Transcript</div>
            <div ref={transcriptScrollRef} className={styles.lcpTranscript}>
              {chunks.slice(-40).map((c) => (
                <div key={c.id} className={styles.chunk}>
                  <span className={styles.speaker}>{c.speaker}:</span>
                  {c.text}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      {debrief && debriefOpen && (
        <DebriefModal
          debrief={debrief}
          prospectName={prospectName ?? null}
          onClose={() => setDebriefOpen(false)}
        />
      )}
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
