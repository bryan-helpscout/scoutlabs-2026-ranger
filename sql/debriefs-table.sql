-- BigQuery table DDL for Ranger meeting debriefs.
--
-- Run this ONCE in your target BigQuery dataset before pointing the app
-- at it via the BIGQUERY_PROJECT_ID / BIGQUERY_DATASET / BIGQUERY_TABLE
-- env vars.
--
-- Schema notes:
--   - Partitioned by DATE(generated_at) so time-range queries are cheap
--     (each call debrief only touches one day's partition).
--   - tone_signals / open_questions / risks are ARRAY<STRING> so you can
--     UNNEST them for topic-level analytics:
--       SELECT tone_signal, COUNT(*)
--       FROM `proj.ranger.debriefs`, UNNEST(tone_signals) AS tone_signal
--       WHERE tone_overall = 'positive' AND DATE(generated_at) >= '2026-01-01'
--       GROUP BY 1 ORDER BY 2 DESC;
--   - action_items / email_drafts are ARRAY<STRUCT<...>> so each action's
--     owner / priority is queryable without extra joins.
--   - inserted_at vs generated_at: generated_at is when the debrief was
--     synthesized; inserted_at is when BQ accepted the row. Useful for
--     detecting write lag or backfills.

CREATE TABLE IF NOT EXISTS `ranger.debriefs` (
  meeting_id              STRING NOT NULL OPTIONS(description="Opaque meeting identifier used by the transcript webhook."),
  prospect_name           STRING         OPTIONS(description="HubSpot company name if the AE had a prospect loaded, else null."),
  summary                 STRING         OPTIONS(description="2-4 sentence recap of the call."),

  close_score             INT64          OPTIONS(description="Sonnet's 0-100 close-likelihood estimate."),
  close_band              STRING         OPTIONS(description="'cold' | 'warm' | 'hot' | 'ready to close'"),
  close_rationale         STRING         OPTIONS(description="One-sentence justification for the score."),

  tone_overall            STRING         OPTIONS(description="'positive' | 'neutral' | 'cautious' | 'negative'"),
  tone_signals            ARRAY<STRING>  OPTIONS(description="Specific quotes/behaviors driving the tone assessment."),

  action_items            ARRAY<STRUCT<
    owner        STRING,   -- 'ae' | 'prospect' | 'team'
    description  STRING,
    priority     STRING,   -- 'high' | 'medium' | 'low'
    due_by       STRING    -- free-form ('this week', '2026-05-01', etc.) or null
  >>                                       OPTIONS(description="Structured follow-ups with owner/priority/due-by."),

  email_drafts            ARRAY<STRUCT<
    purpose      STRING,
    subject      STRING,
    body         STRING
  >>                                       OPTIONS(description="Ready-to-send email drafts the AE can copy."),

  next_call_prep          STRUCT<
    pain_points        ARRAY<STRING>,
    question_themes    ARRAY<STRUCT<
      theme            STRING,
      talking_point    STRING
    >>,
    recommended_focus  STRING
  >                                        OPTIONS(description="Synthesized 'where to focus the next call' guidance — rendered in the pre-read brief sidebar for the AE's prep. question_themes pairs each anticipated question type with a ready-to-use talk track."),

  open_questions          ARRAY<STRING>  OPTIONS(description="Prospect questions left unresolved on the call."),
  risks                   ARRAY<STRING>  OPTIONS(description="Deal risks surfaced by the call."),

  transcript_chunk_count  INT64          OPTIONS(description="Sanity: how many transcript chunks fed into the debrief."),
  generated_at            TIMESTAMP      OPTIONS(description="When Sonnet returned the debrief."),
  inserted_at             TIMESTAMP      DEFAULT CURRENT_TIMESTAMP()
                                         OPTIONS(description="When BigQuery accepted the row.")
)
PARTITION BY DATE(generated_at)
CLUSTER BY close_band, prospect_name
OPTIONS(
  description = "One row per Ranger post-call debrief. Written by the /api/meeting/debrief handler."
);
