/**
 * Post-call debrief shape. Produced by Sonnet given the full meeting
 * transcript + shared chat context (product facts, competitor battle
 * cards, HubSpot prospect, etc.). Rendered inline in the live-call panel
 * after the AE hits "End & debrief".
 */

export type ToneOverall = "positive" | "neutral" | "cautious" | "negative";

export type CloseBand = "cold" | "warm" | "hot" | "ready to close";

export interface DebriefTone {
  overall: ToneOverall;
  /** Specific signals (quotes, behavior patterns) that drove the assessment. */
  signals: string[];
}

export interface DebriefCloseLikelihood {
  /** 0–100. */
  score: number;
  band: CloseBand;
  /** One-sentence explanation the AE can skim. */
  rationale: string;
}

export interface DebriefActionItem {
  /** Who's expected to do this next. */
  owner: "ae" | "prospect" | "team";
  description: string;
  priority: "high" | "medium" | "low";
  /** If a specific commitment was made in the call ("by Friday", "next week"). */
  dueBy?: string | null;
}

export interface DebriefEmailDraft {
  /** One-line purpose ("Follow-up with SAML setup guide") so the AE can pick
   *  the right draft without reading all of them. */
  purpose: string;
  subject: string;
  /** Plain text, editable. The AE copies and pastes into their email client. */
  body: string;
}

/** Synthesized guidance for the AE's NEXT call with this prospect, based on
 *  what was said in THIS call plus any prior-call context. Rendered in the
 *  pre-read brief sidebar as the "here's what to focus on" callout. */
export interface DebriefNextCallPrep {
  /** 2–4 specific customer pain points surfaced in the transcript. */
  painPoints: string[];
  /** 2–4 question themes the prospect is likely to raise on the NEXT call,
   *  each paired with a ready-to-use talking point the AE can paraphrase. */
  questionThemes: Array<{
    /** Short phrase describing the question type ("SSO compliance setup",
     *  "Migration timeline", "Reference customers at our size"). */
    theme: string;
    /** 1–2 sentences the AE can say in response. Should cite specific product
     *  facts / prior-call commitments / concrete numbers when possible. */
    talkingPoint: string;
  }>;
  /** 2–3 sentences telling the AE where to focus the NEXT call — what to
   *  lead with, what to avoid re-explaining, the winning move. */
  recommendedFocus: string;
}

export interface MeetingDebrief {
  meetingId: string;
  /** 2–4 sentence recap of what was discussed. */
  summary: string;
  tone: DebriefTone;
  closeLikelihood: DebriefCloseLikelihood;
  actionItems: DebriefActionItem[];
  emailDrafts: DebriefEmailDraft[];
  /** Synthesized "here's where to focus the next call" guidance. */
  nextCallPrep: DebriefNextCallPrep;
  /** Prospect questions that weren't fully resolved on the call. */
  openQuestions: string[];
  /** Deal risks surfaced in the call — competitor evaluations, budget
   *  concerns, timing constraints, etc. */
  risks: string[];
  generatedAt: string;
  /** For sanity — how much transcript did we analyze? */
  transcriptChunkCount: number;
}
