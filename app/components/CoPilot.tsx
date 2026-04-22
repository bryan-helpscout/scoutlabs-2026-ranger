"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./CoPilot.module.css";
import LiveCallPanel from "./LiveCallPanel";

// ── types ──────────────────────────────────────────────────────────────────

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

interface ProspectData {
  found: boolean;
  companyName?: string;
  dealStage?: string;
  dealValue?: string;
  lastActivity?: string;
  ownerName?: string;
  notes?: string;
  contactName?: string;
  contactTitle?: string;
}

// ── quick prompt groups ────────────────────────────────────────────────────

const QUICK_PROMPTS = [
  {
    label: "Pricing",
    items: [
      { icon: "💰", text: "Plans overview", prompt: "What are Help Scout's pricing plans and what's included in each tier?" },
      { icon: "⚖️", text: "vs competitors", prompt: "How does Help Scout pricing compare to Zendesk and Intercom?" },
      { icon: "🏷️", text: "Discounts", prompt: "What discounts does Help Scout offer — annual, nonprofit, startup?" },
    ],
  },
  {
    label: "Objections",
    items: [
      { icon: "🛡️", text: '"Intercom does more"', prompt: "A prospect says Intercom does everything Help Scout does. How should I respond?" },
      { icon: "🛡️", text: '"Too expensive"', prompt: "Prospect says Help Scout is too expensive vs Freshdesk. How do I handle this?" },
      { icon: "🛡️", text: "Migration fears", prompt: "Prospect is worried about migrating from Zendesk. What should I tell them?" },
    ],
  },
  {
    label: "Technical",
    items: [
      { icon: "🔌", text: "API & integrations", prompt: "What are Help Scout's API capabilities, rate limits and authentication options?" },
      { icon: "🔐", text: "SSO & security", prompt: "Does Help Scout support SSO? What identity providers are supported?" },
      { icon: "🌍", text: "GDPR & compliance", prompt: "How does Help Scout handle GDPR compliance and data residency?" },
      { icon: "✨", text: "AI features", prompt: "What AI features does Help Scout have? What can AI Assist do?" },
    ],
  },
  {
    label: "Talking points",
    items: [
      { icon: "🎯", text: "vs Zendesk pitch", prompt: "Give me 5 strong talking points for why a B2B SaaS company should choose Help Scout over Zendesk." },
      { icon: "📈", text: "ROI proof points", prompt: "What's the ROI story for Help Scout? Metrics and proof points I can use with prospects." },
    ],
  },
];

const CHIPS = [
  "How does Help Scout handle shared inbox for multiple brands?",
  "What's included in the free trial?",
  "Can Help Scout integrate with Salesforce?",
  "Does Help Scout have an uptime SLA?",
  "How does Help Scout Beacon work for live chat?",
];

// ── icons ──────────────────────────────────────────────────────────────────

const SlackIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path fill="#4A154B" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
  </svg>
);

const HubspotIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path fill="#FF7A59" d="M22.006 9.386a3.956 3.956 0 0 0-3.415-3.907V3.966A1.966 1.966 0 0 0 16.625 2h-.082a1.966 1.966 0 0 0-1.966 1.966v1.489a3.956 3.956 0 0 0-2.483 6.386l-4.595 5.81a1.966 1.966 0 1 0 1.56 1.234l4.596-5.81a3.94 3.94 0 0 0 4.487-.018l2.31 2.31a1.966 1.966 0 1 0 1.39-1.39l-2.31-2.31a3.944 3.944 0 0 0 .474-2.281zm-5.463 2.016a1.966 1.966 0 1 1 0-3.932 1.966 1.966 0 0 1 0 3.932z" />
  </svg>
);

const LinearIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="#5E6AD2" />
    <path d="M7 12.5l3.5 3.5 6.5-7" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SlabIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="2" y="3" width="20" height="18" rx="3" fill="#FF6542" />
    <path d="M6 8h12M6 12h8M6 16h10" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const SendIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
);

// ── helpers ────────────────────────────────────────────────────────────────

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

/**
 * Split an assistant reply into (lead, rest) so we can render the AE's
 * "verbatim-able" answer by default and hide supporting detail behind a
 * "Show more" toggle. The system prompt instructs the model to put the lead
 * first, then a blank line, then details — but we also fall back to
 * splitting on the first structural break (markdown heading, list item,
 * horizontal rule) in case the model skips the blank line.
 */
function splitLeadAndRest(content: string): { lead: string; rest: string } {
  // 1) Prefer the explicit blank-line break.
  const blank = content.indexOf("\n\n");
  if (blank !== -1) {
    return {
      lead: content.slice(0, blank).trim(),
      rest: content.slice(blank + 2).trim(),
    };
  }
  // 2) Otherwise cut before the first structural detail marker.
  const match = content.match(/\n(?=#+\s|-\s|\*\s|\d+\.\s|---)/);
  if (match && match.index !== undefined) {
    return {
      lead: content.slice(0, match.index).trim(),
      rest: content.slice(match.index).trim(),
    };
  }
  // 3) No break → the whole reply is the lead.
  return { lead: content.trim(), rest: "" };
}

// ── component ──────────────────────────────────────────────────────────────

export default function CoPilot() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [prospectInput, setProspectInput] = useState("");
  const [prospect, setProspect] = useState<ProspectData | null>(null);
  const [prospectLoading, setProspectLoading] = useState(false);
  /** Indices of assistant messages whose "rest" body is currently expanded.
   *  While a message is streaming we always show the full content; on
   *  completion the rest collapses unless the user had already expanded it. */
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prospectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── prospect lookup ──────────────────────────────────────────────────────

  const lookupProspect = useCallback(async (name: string) => {
    if (!name.trim()) {
      setProspect(null);
      return;
    }
    setProspectLoading(true);
    try {
      const res = await fetch("/api/prospect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data: ProspectData = await res.json();
      setProspect(data);
    } catch {
      setProspect({ found: false });
    }
    setProspectLoading(false);
  }, []);

  const handleProspectChange = (val: string) => {
    setProspectInput(val);
    if (prospectTimer.current) clearTimeout(prospectTimer.current);
    if (!val.trim()) { setProspect(null); return; }
    prospectTimer.current = setTimeout(() => lookupProspect(val), 800);
  };

  // ── chat ─────────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userContent = prospectInput.trim()
      ? `[Prospect context: ${prospectInput.trim()}]\n\n${text}`
      : text;

    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: text },
    ];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    // Add streaming placeholder
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", streaming: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: userContent },
          ],
          prospectName: prospectInput.trim() || null,
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
              // Server emitted an error mid-stream. Stash the message so the
              // final render shows a diagnostic instead of the generic "No
              // response" fallback (which hides real failures).
              serverError = String(parsed.message ?? "Unknown server error");
            }
          } catch {
            // skip malformed
          }
        }
      }

      setMessages((prev) => {
        const updated = [...prev];
        // Prefer real content; fall back to the server's error message (not
        // the generic "No response" string) so failures are diagnosable.
        // Common cause in dev: HMR recompiled a route mid-stream.
        const content =
          fullText ||
          (serverError
            ? `⚠️ Server error: ${serverError}\n\n(If you just edited code, Next.js HMR may have interrupted the request — try again.)`
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
  }, [isLoading, messages, prospectInput]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  const prospectBadgeClass = () => {
    const stage = (prospect?.dealStage || "").toLowerCase();
    if (stage.includes("close") || stage.includes("won")) return styles.badgeSuccess;
    if (stage.includes("lost")) return styles.badgeDanger;
    return styles.badgeWarning;
  };

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <div className={styles.root}>
      {/* ── sidebar ── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.logo}>
            <div className={styles.logoDot}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="white">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
            </div>
            <div>
              <div className={styles.logoText}>Ranger</div>
              <div className={styles.logoSub}>Help Scout sales co-pilot</div>
            </div>
          </div>
        </div>

        {/* prospect lookup */}
        <div className={styles.prospectPanel}>
          <div className={styles.panelLabel}>Active prospect</div>
          <input
            className={styles.prospectInput}
            type="text"
            placeholder="Company name or email..."
            value={prospectInput}
            onChange={(e) => handleProspectChange(e.target.value)}
          />
          {prospectLoading && (
            <div className={styles.prospectStatus}>Searching HubSpot...</div>
          )}
          {prospect && prospect.found && !prospectLoading && (
            <div className={styles.prospectCard}>
              <div className={styles.pcName}>{prospect.companyName}</div>
              <div className={styles.pcMeta}>
                {[
                  prospect.contactName &&
                    `${prospect.contactName}${prospect.contactTitle ? `, ${prospect.contactTitle}` : ""}`,
                  prospect.dealValue,
                  prospect.lastActivity && `Last active: ${prospect.lastActivity}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {prospect.dealStage && (
                <span className={`${styles.pcBadge} ${prospectBadgeClass()}`}>
                  {prospect.dealStage}
                </span>
              )}
            </div>
          )}
          {prospect && !prospect.found && !prospectLoading && (
            <div className={styles.prospectStatus}>Not found in HubSpot</div>
          )}
        </div>

        {/* quick prompts */}
        <nav className={styles.quickPrompts}>
          {QUICK_PROMPTS.map((group) => (
            <div key={group.label}>
              <div className={styles.sectionLabel}>{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.text}
                  className={styles.qpBtn}
                  onClick={() => {
                    setInput(item.prompt);
                    inputRef.current?.focus();
                  }}
                >
                  <span className={styles.qpIcon}>{item.icon}</span>
                  {item.text}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* source status */}
        <div className={styles.sourcesPanel}>
          <div className={styles.sourceRow}>
            <SlackIcon />
            <div className={styles.sourceInfo}>
              <div className={styles.sourceName}>Slack</div>
              <div className={styles.sourceDetail}>4 channels live</div>
            </div>
            <div className={`${styles.sourceDot} ${styles.dotGreen}`} />
          </div>
          <div className={styles.sourceRow}>
            <SlabIcon />
            <div className={styles.sourceInfo}>
              <div className={styles.sourceName}>Slab</div>
              <div className={styles.sourceDetail}>Internal knowledge base</div>
            </div>
            <div className={`${styles.sourceDot} ${styles.dotGreen}`} />
          </div>
          <div className={styles.sourceRow}>
            <LinearIcon />
            <div className={styles.sourceInfo}>
              <div className={styles.sourceName}>Linear</div>
              <div className={styles.sourceDetail}>Engineering projects & issues</div>
            </div>
            <div className={`${styles.sourceDot} ${styles.dotGreen}`} />
          </div>
          <div className={styles.sourceRow}>
            <HubspotIcon />
            <div className={styles.sourceInfo}>
              <div className={styles.sourceName}>HubSpot</div>
              <div className={styles.sourceDetail}>
                {prospectLoading
                  ? "Looking up..."
                  : prospect?.found
                  ? prospect.companyName ?? "Loaded"
                  : "Enter prospect above"}
              </div>
            </div>
            <div
              className={`${styles.sourceDot} ${
                prospectLoading
                  ? styles.dotAmber
                  : prospect?.found
                  ? styles.dotGreen
                  : styles.dotGray
              }`}
            />
          </div>
        </div>
      </aside>

      {/* ── chat ── */}
      <main className={styles.chatArea}>
        <div className={styles.chatHeader}>
          <div>
            <div className={styles.chatTitle}>
              <span className={styles.statusDot} />
              Ranger
            </div>
            <div className={styles.chatSubtitle}>
              {prospect?.found
                ? `Prospect: ${prospect.companyName}${prospect.dealStage ? ` · ${prospect.dealStage}` : ""}`
                : "No prospect loaded — answers from Slack + knowledge base"}
            </div>
          </div>
          <div className={styles.headerBadges}>
            <div className={styles.hdrBadge}>
              <SlackIcon size={10} /> 4 channels
            </div>
            <div className={styles.hdrBadge}>
              <SlabIcon size={10} /> Slab
            </div>
            <div className={styles.hdrBadge}>
              <LinearIcon size={10} /> Linear
            </div>
            <div className={styles.hdrBadge}>
              <HubspotIcon size={10} /> HubSpot
            </div>
          </div>
        </div>

        <div className={styles.messages}>
          {messages.length === 0 && (
            <div className={styles.welcomeCard}>
              <h3>Hey — I&apos;m your Help Scout sales co-pilot</h3>
              <p>
                Enter a prospect above and I&apos;ll pull their HubSpot history before
                answering. Every response also searches your Slack channels and Slab
                knowledge base in real time — no more waiting.
              </p>
              <div className={styles.chipRow}>
                {CHIPS.map((chip) => (
                  <button
                    key={chip}
                    className={styles.chip}
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
              <div className={styles.msgAvatar}>
                {msg.role === "user" ? "You" : "R"}
              </div>
              <div className={styles.msgBubble}>
                {msg.streaming && msg.content === "" ? (
                  <div className={styles.thinking}>
                    <div className={styles.dots}>
                      <span /><span /><span />
                    </div>
                    <span>
                      Searching Slack + Slab
                      {prospectInput ? ` + looking up ${prospectInput} in HubSpot` : ""}
                      ...
                    </span>
                  </div>
                ) : (() => {
                  // User messages + currently-streaming assistant messages
                  // render in full. Completed assistant messages collapse to
                  // just the lead with an inline "Show more" toggle.
                  if (msg.role === "user" || msg.streaming) {
                    return (
                      <div
                        dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }}
                      />
                    );
                  }
                  const { lead, rest } = splitLeadAndRest(msg.content);
                  const isExpanded = expandedMessages.has(i);
                  const visible = rest && isExpanded ? `${lead}\n\n${rest}` : lead;
                  return (
                    <>
                      <div
                        dangerouslySetInnerHTML={{ __html: formatMessage(visible) }}
                      />
                      {rest && (
                        <button
                          type="button"
                          className={styles.showMoreBtn}
                          onClick={() =>
                            setExpandedMessages((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i);
                              else next.add(i);
                              return next;
                            })
                          }
                        >
                          {isExpanded ? "Show less ↑" : "Show more ↓"}
                        </button>
                      )}
                    </>
                  );
                })()}
                {!msg.streaming && (msg.usedSlack || msg.usedHubspot || msg.usedSlab || msg.usedLinear || msg.usedCompetitor || msg.usedReddit) && (
                  <div className={styles.sourcePills}>
                    {msg.usedSlack && (
                      <span className={`${styles.pill} ${styles.pillSlack}`}>
                        <SlackIcon size={9} /> Slack
                      </span>
                    )}
                    {msg.usedSlab && (
                      <span className={`${styles.pill} ${styles.pillSlab}`}>
                        <SlabIcon size={9} /> Slab
                      </span>
                    )}
                    {msg.usedLinear && (
                      <span className={`${styles.pill} ${styles.pillLinear}`}>
                        <LinearIcon size={9} /> Linear
                      </span>
                    )}
                    {msg.usedHubspot && (
                      <span className={`${styles.pill} ${styles.pillHubspot}`}>
                        <HubspotIcon size={9} /> HubSpot
                      </span>
                    )}
                    {msg.usedCompetitor && (
                      <span className={`${styles.pill} ${styles.pillCompetitor}`}>
                        ⚔ Battle card
                      </span>
                    )}
                    {msg.usedReddit && (
                      <span className={`${styles.pill} ${styles.pillReddit}`}>
                        👤 Reddit signals
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className={styles.inputArea}>
          <textarea
            ref={inputRef}
            className={styles.userInput}
            placeholder="Ask a technical question, pricing, or talk track..."
            rows={1}
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
          />
          <button
            className={styles.sendBtn}
            onClick={() => sendMessage(input)}
            disabled={isLoading || !input.trim()}
          >
            <SendIcon />
          </button>
        </div>
      </main>

      {/* ── live call panel (right side, transcript-agnostic) ── */}
      <LiveCallPanel
        onAskAboutCard={(prompt) => {
          setInput(prompt);
          // Resize the textarea to fit the injected prompt and scroll into view.
          const el = inputRef.current;
          if (el) {
            el.focus();
            // defer so React commits the new value before we measure scrollHeight
            requestAnimationFrame(() => {
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 120) + "px";
              el.scrollIntoView({ behavior: "smooth", block: "nearest" });
            });
          }
        }}
      />
    </div>
  );
}
