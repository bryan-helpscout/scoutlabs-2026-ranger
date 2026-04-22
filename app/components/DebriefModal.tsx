"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./CoPilot.module.css";

/**
 * Post-call debrief modal. Appears centered over the main window when the
 * AE clicks "Call ended" in the live-call panel. Content is identical to
 * what used to render inline in the panel, just given more breathing room
 * and a backdrop so it's treated as a distinct moment ("review, act,
 * dismiss") rather than a sidebar card.
 */

type DebriefTone = {
  overall: "positive" | "neutral" | "cautious" | "negative";
  signals: string[];
};

interface DebriefActionItem {
  owner: "ae" | "prospect" | "team";
  description: string;
  priority: "high" | "medium" | "low";
  dueBy?: string | null;
}

interface DebriefEmailDraft {
  purpose: string;
  subject: string;
  body: string;
}

export interface Debrief {
  meetingId: string;
  summary: string;
  tone: DebriefTone;
  closeLikelihood: {
    score: number;
    band: "cold" | "warm" | "hot" | "ready to close";
    rationale: string;
  };
  actionItems: DebriefActionItem[];
  emailDrafts: DebriefEmailDraft[];
  openQuestions: string[];
  risks: string[];
  generatedAt: string;
  transcriptChunkCount: number;
}

interface DebriefModalProps {
  debrief: Debrief;
  onClose: () => void;
  /** When the AE had a prospect loaded — shown in the header. */
  prospectName?: string | null;
}

function toneColor(overall: DebriefTone["overall"]): string {
  switch (overall) {
    case "positive": return "var(--green-600)";
    case "neutral":  return "var(--text-secondary)";
    case "cautious": return "var(--text-warning)";
    case "negative": return "var(--text-danger)";
  }
}

export default function DebriefModal({
  debrief,
  onClose,
  prospectName,
}: DebriefModalProps) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Esc-to-close — standard modal affordance. Only bind while mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyDraft = useCallback(async (draft: DebriefEmailDraft, idx: number) => {
    const text = `Subject: ${draft.subject}\n\n${draft.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((curr) => (curr === idx ? null : curr)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }, []);

  return (
    <div
      className={styles.modalBackdrop}
      onClick={(e) => {
        // Click-outside to close, but only when the click is on the backdrop
        // itself — not when it bubbles up from the dialog contents.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.modalDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="debrief-modal-title"
      >
        <header className={styles.modalHeader}>
          <div className={styles.modalHeaderText}>
            <h2 id="debrief-modal-title" className={styles.modalTitle}>
              Post-call debrief
            </h2>
            <div className={styles.modalSubtitle}>
              {prospectName ? `Prospect: ${prospectName} · ` : ""}
              {debrief.transcriptChunkCount} transcript chunks analyzed
            </div>
          </div>
          <button
            type="button"
            className={styles.modalCloseBtn}
            onClick={onClose}
            aria-label="Close debrief"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className={styles.modalBody}>
          {/* Top row: score + summary side by side on wide screens */}
          <div className={styles.debriefTopRow}>
            <div
              className={`${styles.lcpCard} ${styles.lcpDebriefScoreCard} ${styles[`debriefBand_${debrief.closeLikelihood.band.replace(/\s+/g, "_")}`] ?? ""}`}
            >
              <div className={styles.lcpDebriefScoreRow}>
                <div className={styles.lcpDebriefScore}>
                  {debrief.closeLikelihood.score}
                </div>
                <div>
                  <div className={styles.lcpDebriefScoreBand}>
                    {debrief.closeLikelihood.band}
                  </div>
                  <div className={styles.lcpDebriefScoreLabel}>
                    Close likelihood
                  </div>
                </div>
              </div>
              <div className={styles.lcpDebriefRationale}>
                {debrief.closeLikelihood.rationale}
              </div>
            </div>

            <div className={`${styles.lcpCard} ${styles.debriefSummaryCard}`}>
              <div className={styles.lcpCardHead}>
                <span
                  className={styles.lcpCardSource}
                  style={{ color: "var(--ranger-600)" }}
                >
                  Summary
                </span>
              </div>
              <div className={styles.lcpAnswerBody}>{debrief.summary}</div>
            </div>
          </div>

          {/* Tone */}
          <div className={styles.lcpCard}>
            <div className={styles.lcpCardHead}>
              <span
                className={styles.lcpCardSource}
                style={{ color: toneColor(debrief.tone.overall) }}
              >
                Tone · {debrief.tone.overall}
              </span>
            </div>
            {debrief.tone.signals.length > 0 && (
              <ul className={styles.lcpDebriefList}>
                {debrief.tone.signals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Two-column: action items + open questions/risks */}
          <div className={styles.debriefTwoCol}>
            {debrief.actionItems.length > 0 && (
              <div className={styles.lcpCard}>
                <div className={styles.lcpCardHead}>
                  <span className={styles.lcpCardSource} style={{ color: "var(--cobalt-600)" }}>
                    Action items
                  </span>
                </div>
                <ul className={styles.lcpDebriefList}>
                  {debrief.actionItems.map((a, i) => (
                    <li key={i}>
                      <span className={`${styles.lcpOwnerChip} ${styles[`owner_${a.owner}`]}`}>
                        {a.owner}
                      </span>
                      <span className={styles[`priority_${a.priority}`]}>
                        {a.description}
                      </span>
                      {a.dueBy && (
                        <span className={styles.lcpDebriefDue}> · due {a.dueBy}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.debriefStackedCol}>
              {debrief.openQuestions.length > 0 && (
                <div className={styles.lcpCard}>
                  <div className={styles.lcpCardHead}>
                    <span className={styles.lcpCardSource} style={{ color: "var(--text-warning)" }}>
                      Open questions
                    </span>
                  </div>
                  <ul className={styles.lcpDebriefList}>
                    {debrief.openQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              {debrief.risks.length > 0 && (
                <div className={styles.lcpCard}>
                  <div className={styles.lcpCardHead}>
                    <span className={styles.lcpCardSource} style={{ color: "var(--text-danger)" }}>
                      Risks
                    </span>
                  </div>
                  <ul className={styles.lcpDebriefList}>
                    {debrief.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Email drafts — full width */}
          {debrief.emailDrafts.length > 0 && (
            <div className={styles.lcpCard}>
              <div className={styles.lcpCardHead}>
                <span className={styles.lcpCardSource} style={{ color: "var(--cobalt-600)" }}>
                  Email drafts
                </span>
              </div>
              <div className={styles.lcpEmailDraftList}>
                {debrief.emailDrafts.map((d, i) => (
                  <details key={i} className={styles.lcpEmailDraft} open={i === 0}>
                    <summary className={styles.lcpEmailDraftSummary}>
                      <span className={styles.lcpEmailDraftPurpose}>{d.purpose}</span>
                      <button
                        type="button"
                        className={styles.lcpAskBtn}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          copyDraft(d, i);
                        }}
                      >
                        {copiedIdx === i ? "Copied ✓" : "Copy"}
                      </button>
                    </summary>
                    <div className={styles.lcpEmailDraftBody}>
                      <div className={styles.lcpEmailDraftSubject}>
                        <strong>Subject:</strong> {d.subject}
                      </div>
                      <div className={styles.lcpEmailDraftText}>{d.body}</div>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
