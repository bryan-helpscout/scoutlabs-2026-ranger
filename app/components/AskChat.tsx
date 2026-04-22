"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./CoPilot.module.css";
import askStyles from "../ask/ask.module.css";

/**
 * AskChat — a stripped, centered Q&A surface for /ask.
 *
 * Renders the same streaming-chat experience as the main co-pilot middle
 * pane (source pills, lead/rest collapse, error handling) without the
 * sidebar, prospect lookup, or live-call panel. Intended for teammates
 * who just want to ask Ranger a question without loading a prospect or
 * running the full call-ready UI.
 *
 * Reuses /api/chat — no server-side divergence.
 */

type Role = "user" | "assistant";

interface Message {
  role: Role;
  content: string;
  usedSlack?: boolean;
  usedHubspot?: boolean;
  usedSlab?: boolean;
  usedLinear?: boolean;
  usedCompetitor?: boolean;
  usedReddit?: boolean;
  streaming?: boolean;
}

const STARTER_PROMPTS = [
  "Does Help Scout support SAML SSO on Okta? What plan?",
  "Recent Reddit chatter about why people leave Zendesk?",
  "What customer proof points can I cite for support-team efficiency?",
  "When is bulk data export shipping?",
];

// ── icons (inlined from CoPilot.tsx to keep AskChat self-contained) ───────

const SlackIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path fill="#4A154B" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
  </svg>
);
const HubspotIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path fill="#FF7A59" d="M22.006 9.386a3.956 3.956 0 0 0-3.415-3.907V3.966A1.966 1.966 0 0 0 16.625 2h-.082a1.966 1.966 0 0 0-1.966 1.966v1.489a3.956 3.956 0 0 0-2.483 6.386l-4.595 5.81a1.966 1.966 0 1 0 1.56 1.234l4.596-5.81a3.94 3.94 0 0 0 4.487-.018l2.31 2.31a1.966 1.966 0 1 0 1.39-1.39l-2.31-2.31a3.944 3.944 0 0 0 .474-2.281zm-5.463 2.016a1.966 1.966 0 1 1 0-3.932 1.966 1.966 0 0 1 0 3.932z" />
  </svg>
);
const LinearIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="10" fill="#5E6AD2" />
    <path d="M7 12.5l3.5 3.5 6.5-7" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const SlabIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="2" y="3" width="20" height="18" rx="3" fill="#FF6542" />
    <path d="M6 8h12M6 12h8M6 16h10" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const SendIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
);

// ── helpers (mirrors CoPilot.tsx) ─────────────────────────────────────────

function formatMessage(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^### (.*)$/gm, "<strong>$1</strong>")
    .replace(/^## (.*)$/gm, '<strong style="font-size:14px">$1</strong>')
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, "<br /><br />")
    .replace(/\n/g, "<br />");
}

function splitLeadAndRest(content: string): { lead: string; rest: string } {
  const blank = content.indexOf("\n\n");
  if (blank !== -1) {
    return { lead: content.slice(0, blank).trim(), rest: content.slice(blank + 2).trim() };
  }
  const match = content.match(/\n(?=#+\s|-\s|\*\s|\d+\.\s|---)/);
  if (match && match.index !== undefined) {
    return { lead: content.slice(0, match.index).trim(), rest: content.slice(match.index).trim() };
  }
  return { lead: content.trim(), rest: "" };
}

// ── component ──────────────────────────────────────────────────────────────

export default function AskChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      const newMessages: Message[] = [...messages, { role: "user", content: text }];
      setMessages(newMessages);
      setInput("");
      setIsLoading(true);

      setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
            prospectName: null,
          }),
        });
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let usedSlack = false;
        let usedHubspot = false;
        let usedSlab = false;
        let usedLinear = false;
        let usedCompetitor = false;
        let usedReddit = false;
        let serverError: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.type === "text") {
                fullText += parsed.text;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: fullText,
                    streaming: true,
                  };
                  return updated;
                });
              } else if (parsed.type === "done") {
                usedSlack = parsed.usedSlack;
                usedHubspot = parsed.usedHubspot;
                usedSlab = parsed.usedSlab;
                usedLinear = parsed.usedLinear;
                usedCompetitor = parsed.usedCompetitor;
                usedReddit = parsed.usedReddit;
              } else if (parsed.type === "error") {
                serverError = String(parsed.message ?? "Unknown server error");
              }
            } catch {
              /* skip */
            }
          }
        }

        setMessages((prev) => {
          const updated = [...prev];
          const content =
            fullText ||
            (serverError
              ? `⚠️ Server error: ${serverError}`
              : "No response — please try again.");
          updated[updated.length - 1] = {
            role: "assistant",
            content,
            streaming: false,
            usedSlack,
            usedHubspot,
            usedSlab,
            usedLinear,
            usedCompetitor,
            usedReddit,
          };
          return updated;
        });
      } catch {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Something went wrong. Check the server and try again.",
            streaming: false,
          };
          return updated;
        });
      }

      setIsLoading(false);
    },
    [isLoading, messages]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  return (
    <div className={askStyles.root}>
      <header className={askStyles.header}>
        <div className={askStyles.logo}>
          <div className={askStyles.logoDot}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="white" aria-hidden>
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
            </svg>
          </div>
          <div>
            <div className={askStyles.logoText}>Ask Ranger</div>
            <div className={askStyles.logoSub}>
              Help Scout sales knowledge — pricing, features, competitors, team discussions
            </div>
          </div>
        </div>
      </header>

      <main className={askStyles.main}>
        <div className={askStyles.messages}>
          {messages.length === 0 && (
            <div className={askStyles.welcomeCard}>
              <h3>What would you like to know?</h3>
              <p>
                Ranger pulls real-time context from Help Scout&apos;s docs,
                Slack history, product fact-sheet, competitor battle cards,
                Reddit signals, and engineering roadmap.
              </p>
              <div className={askStyles.chipRow}>
                {STARTER_PROMPTS.map((chip) => (
                  <button
                    key={chip}
                    className={askStyles.chip}
                    onClick={() => {
                      setInput(chip);
                      inputRef.current?.focus();
                    }}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`${styles.msg} ${msg.role === "user" ? styles.msgUser : styles.msgAssistant}`}>
              <div className={styles.msgAvatar}>{msg.role === "user" ? "You" : "R"}</div>
              <div className={styles.msgBubble}>
                {msg.streaming && msg.content === "" ? (
                  <div className={styles.thinking}>
                    <div className={styles.dots}>
                      <span /><span /><span />
                    </div>
                    <span>Searching Slack + Slab…</span>
                  </div>
                ) : (() => {
                  if (msg.role === "user" || msg.streaming) {
                    return (
                      <div dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }} />
                    );
                  }
                  const { lead, rest } = splitLeadAndRest(msg.content);
                  const isOpen = expanded.has(i);
                  const visible = rest && isOpen ? `${lead}\n\n${rest}` : lead;
                  return (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: formatMessage(visible) }} />
                      {rest && (
                        <button
                          type="button"
                          className={styles.showMoreBtn}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i);
                              else next.add(i);
                              return next;
                            })
                          }
                        >
                          {isOpen ? "Show less ↑" : "Show more ↓"}
                        </button>
                      )}
                    </>
                  );
                })()}
                {!msg.streaming && (msg.usedSlack || msg.usedHubspot || msg.usedSlab || msg.usedLinear || msg.usedCompetitor || msg.usedReddit) && (
                  <div className={styles.sourcePills}>
                    {msg.usedSlack && (
                      <span className={`${styles.pill} ${styles.pillSlack}`}>
                        <SlackIcon /> Slack
                      </span>
                    )}
                    {msg.usedSlab && (
                      <span className={`${styles.pill} ${styles.pillSlab}`}>
                        <SlabIcon /> Slab
                      </span>
                    )}
                    {msg.usedLinear && (
                      <span className={`${styles.pill} ${styles.pillLinear}`}>
                        <LinearIcon /> Linear
                      </span>
                    )}
                    {msg.usedHubspot && (
                      <span className={`${styles.pill} ${styles.pillHubspot}`}>
                        <HubspotIcon /> HubSpot
                      </span>
                    )}
                    {msg.usedCompetitor && (
                      <span className={`${styles.pill} ${styles.pillCompetitor}`}>⚔ Battle card</span>
                    )}
                    {msg.usedReddit && (
                      <span className={`${styles.pill} ${styles.pillReddit}`}>👤 Reddit signals</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className={askStyles.inputArea}>
          <textarea
            ref={inputRef}
            className={styles.userInput}
            placeholder="Ask Ranger anything — pricing, features, competitors, roadmap…"
            rows={1}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
          />
          <button
            className={styles.sendBtn}
            onClick={() => sendMessage(input)}
            disabled={isLoading || !input.trim()}
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>
      </main>
    </div>
  );
}
