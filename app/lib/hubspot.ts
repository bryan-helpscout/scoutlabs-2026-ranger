/**
 * HubSpot CRM REST client — called server-side using a Private App access
 * token (HUBSPOT_TOKEN). We do NOT use the HubSpot MCP server because that
 * endpoint requires a full OAuth 2.0 authorization-code flow; private-app
 * tokens are the 2-click path for a stand-alone app.
 *
 * Required Private App scopes:
 *   crm.objects.companies.read
 *   crm.objects.contacts.read
 *   crm.objects.deals.read
 *   crm.objects.owners.read
 *   crm.objects.calls.read      — for last-call engagement lookup
 *   crm.objects.meetings.read   — for last-meeting engagement lookup
 *
 * Create one at: app.hubspot.com → Settings → Integrations → Private Apps
 */

const HUBSPOT_API = "https://api.hubapi.com";

export interface ProspectData {
  found: boolean;
  /** HubSpot company ID — carried through so downstream callers (e.g. the
   *  prospect-route handler) can fetch engagements without a second lookup. */
  companyId?: string | null;
  /** Stable deal-stage identifier from HubSpot's pipeline config. Unlike the
   *  user-facing `dealStage` label this doesn't change when a portal admin
   *  renames a stage — so it's what the health-score calculation keys off. */
  dealStageId?: string | null;
  companyName?: string | null;
  dealStage?: string | null;
  dealValue?: string | null;
  /** Raw dollar amount for downstream scoring/serialization. `dealValue` is
   *  the formatted display string ("$45k"); this is the unrounded number. */
  dealAmount?: number | null;
  lastActivity?: string | null;
  /** ISO timestamp of the most-recent deal or company update — used for
   *  recency scoring. */
  lastActivityAt?: string | null;
  ownerName?: string | null;
  notes?: string | null;
  contactName?: string | null;
  contactTitle?: string | null;
  reason?: string;
}

/** One row in the "Active prospects" sidebar list. A trimmed-down
 *  `ProspectData` with a pre-computed health score + band. */
export interface ActiveProspect {
  companyId: string;
  companyName: string;
  contactName?: string | null;
  dealStage?: string | null;
  dealStageId?: string | null;
  /** Pipeline progress 0–1 (index of stage in pipeline / total stages).
   *  Passed to the health-score calculator; displayed as a mini bar. */
  stageProgress?: number | null;
  dealValue?: string | null;
  dealAmount?: number | null;
  lastActivity?: string | null;
  lastActivityAt?: string | null;
}

/** A HubSpot call or meeting engagement, normalized. Used as the "last call"
 *  fallback when Ranger hasn't generated a debrief yet for this prospect. */
export interface HubSpotLastCall {
  /** "call" or "meeting" — lets the UI label it accurately. */
  kind: "call" | "meeting";
  /** ISO timestamp of when the engagement occurred. */
  at: string;
  title?: string | null;
  /** Notes/body the rep logged. HTML is stripped. May be long — the UI
   *  truncates client-side. */
  body?: string | null;
  /** Duration in seconds (calls only). */
  durationSec?: number | null;
  /** "INBOUND" / "OUTBOUND" direction (calls only). */
  direction?: string | null;
}

interface HsSearchResult<T> {
  total: number;
  results: T[];
}

interface HsCompany {
  id: string;
  properties: {
    name?: string;
    domain?: string;
    notes_last_updated?: string;
    hs_lastmodifieddate?: string;
    hubspot_owner_id?: string;
  };
}

interface HsContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    jobtitle?: string;
    email?: string;
    company?: string;
    associatedcompanyid?: string;
  };
}

interface HsDeal {
  id: string;
  properties: {
    dealname?: string;
    dealstage?: string;
    amount?: string;
    hs_lastmodifieddate?: string;
    hubspot_owner_id?: string;
    closedate?: string;
  };
}

interface HsOwner {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

interface HsAssociations {
  // v4 associations API returns `toObjectId`, not `id`. Getting this wrong
  // makes every association silently come back empty.
  results: Array<{ toObjectId: number | string }>;
}

/** Low-level HubSpot fetch with Bearer auth. Returns null on any non-2xx. */
async function hs<T>(path: string, init?: RequestInit): Promise<T | null> {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`${HUBSPOT_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      // HubSpot usually responds in <1s — keep the UI snappy.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[hubspot] ${res.status} ${path}:`, await res.text().catch(() => ""));
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[hubspot] fetch failed ${path}:`, err);
    return null;
  }
}

function looksLikeEmail(s: string): boolean {
  return /.+@.+\..+/.test(s.trim());
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatUsd(amount?: string): string | null {
  if (!amount) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1000
    ? `$${Math.round(n / 1000)}k`
    : `$${n.toLocaleString("en-US")}`;
}

// ── lookups ────────────────────────────────────────────────────────────────

async function searchCompanyByName(name: string): Promise<HsCompany | null> {
  const body = {
    filterGroups: [
      {
        filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: name }],
      },
    ],
    properties: ["name", "domain", "hs_lastmodifieddate", "hubspot_owner_id"],
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    limit: 1,
  };
  const data = await hs<HsSearchResult<HsCompany>>("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data?.results?.[0] ?? null;
}

async function searchContactByEmail(email: string): Promise<HsContact | null> {
  const body = {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      },
    ],
    properties: ["firstname", "lastname", "jobtitle", "email", "associatedcompanyid", "company"],
    limit: 1,
  };
  const data = await hs<HsSearchResult<HsContact>>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data?.results?.[0] ?? null;
}

async function getCompany(id: string): Promise<HsCompany | null> {
  return hs<HsCompany>(
    `/crm/v3/objects/companies/${id}?properties=name,domain,hs_lastmodifieddate,hubspot_owner_id`
  );
}

/** Most recently modified deal associated with a company. */
async function getPrimaryDealForCompany(companyId: string): Promise<HsDeal | null> {
  const assoc = await hs<HsAssociations>(
    `/crm/v4/objects/companies/${companyId}/associations/deals?limit=10`
  );
  const dealIds = (assoc?.results ?? []).map((r) => String(r.toObjectId)).filter(Boolean);
  if (dealIds.length === 0) return null;

  // Batch-read deals with the properties we need, then pick the most recent.
  const body = {
    properties: ["dealname", "dealstage", "amount", "hs_lastmodifieddate", "hubspot_owner_id", "closedate"],
    inputs: dealIds.map((id) => ({ id })),
  };
  const data = await hs<{ results: HsDeal[] }>("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const deals = data?.results ?? [];
  if (deals.length === 0) return null;

  deals.sort((a, b) => {
    const da = new Date(a.properties.hs_lastmodifieddate ?? 0).getTime();
    const db = new Date(b.properties.hs_lastmodifieddate ?? 0).getTime();
    return db - da;
  });
  return deals[0];
}

/** Most recently modified contact associated with a company. */
async function getPrimaryContactForCompany(companyId: string): Promise<HsContact | null> {
  const assoc = await hs<HsAssociations>(
    `/crm/v4/objects/companies/${companyId}/associations/contacts?limit=5`
  );
  const first = assoc?.results?.[0];
  if (!first) return null;
  return hs<HsContact>(
    `/crm/v3/objects/contacts/${first.toObjectId}?properties=firstname,lastname,jobtitle,email`
  );
}

async function getOwner(id?: string): Promise<HsOwner | null> {
  if (!id) return null;
  return hs<HsOwner>(`/crm/v3/owners/${id}`);
}

/** Resolve a human-readable deal-stage label from the pipeline config. */
async function getDealStageLabel(stageId?: string): Promise<string | null> {
  if (!stageId) return null;
  const data = await hs<{ results: Array<{ stages: Array<{ id: string; label: string }> }> }>(
    "/crm/v3/pipelines/deals"
  );
  for (const pipeline of data?.results ?? []) {
    const match = pipeline.stages?.find((s) => s.id === stageId);
    if (match) return match.label;
  }
  return stageId; // fall back to the raw id so something shows up
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Look up a prospect in HubSpot by company name OR contact email, and return
 * the normalized shape used by the UI and the chat-route system prompt.
 */
export async function lookupProspect(input: string): Promise<ProspectData> {
  const query = input.trim();
  if (!query) return { found: false };
  if (!process.env.HUBSPOT_TOKEN) {
    return { found: false, reason: "hubspot_not_configured" };
  }

  let company: HsCompany | null = null;
  let contact: HsContact | null = null;

  if (looksLikeEmail(query)) {
    contact = await searchContactByEmail(query);
    const companyId = contact?.properties.associatedcompanyid;
    if (companyId) company = await getCompany(companyId);
  } else {
    company = await searchCompanyByName(query);
  }

  if (!company && !contact) return { found: false };

  const [deal, primaryContact, companyOwner] = await Promise.all([
    company ? getPrimaryDealForCompany(company.id) : Promise.resolve(null),
    company && !contact ? getPrimaryContactForCompany(company.id) : Promise.resolve(null),
    getOwner(company?.properties.hubspot_owner_id),
  ]);

  const resolvedContact = contact ?? primaryContact;
  const stageLabel = await getDealStageLabel(deal?.properties.dealstage);
  const dealOwner = deal
    ? await getOwner(deal.properties.hubspot_owner_id).catch(() => null)
    : null;

  const contactName = resolvedContact
    ? [resolvedContact.properties.firstname, resolvedContact.properties.lastname]
        .filter(Boolean)
        .join(" ") || null
    : null;

  const owner = dealOwner ?? companyOwner;
  const ownerName = owner
    ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email || null
    : null;

  const lastActivityIso =
    deal?.properties.hs_lastmodifieddate ?? company?.properties.hs_lastmodifieddate ?? null;
  const rawAmount = Number(deal?.properties.amount ?? NaN);

  return {
    found: true,
    companyId: company?.id ?? null,
    dealStageId: deal?.properties.dealstage ?? null,
    companyName: company?.properties.name ?? resolvedContact?.properties.company ?? null,
    dealStage: stageLabel ?? null,
    dealValue: formatUsd(deal?.properties.amount),
    dealAmount: Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : null,
    lastActivity: formatDate(lastActivityIso ?? undefined),
    lastActivityAt: lastActivityIso,
    ownerName,
    notes: deal?.properties.dealname ?? null,
    contactName,
    contactTitle: resolvedContact?.properties.jobtitle ?? null,
  };
}

// ── Active prospects list ──────────────────────────────────────────────────

/** Pipeline stage map: stageId → { label, progress 0–1 }. Cached per-process
 *  since pipelines rarely change and every active-prospect row queries it. */
let cachedStageMap: Map<string, { label: string; progress: number }> | null = null;
let cachedStageMapAt = 0;
const STAGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getStageMap(): Promise<Map<string, { label: string; progress: number }>> {
  if (cachedStageMap && Date.now() - cachedStageMapAt < STAGE_CACHE_TTL_MS) {
    return cachedStageMap;
  }
  const data = await hs<{
    results: Array<{
      stages: Array<{ id: string; label: string; displayOrder?: number; metadata?: { isClosed?: string } }>;
    }>;
  }>("/crm/v3/pipelines/deals");

  const map = new Map<string, { label: string; progress: number }>();
  for (const pipeline of data?.results ?? []) {
    const sorted = [...(pipeline.stages ?? [])].sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    );
    const total = Math.max(sorted.length - 1, 1);
    sorted.forEach((stage, i) => {
      map.set(stage.id, { label: stage.label, progress: i / total });
    });
  }
  cachedStageMap = map;
  cachedStageMapAt = Date.now();
  return map;
}

/** Return the set of stage IDs that are "closed" (won or lost) across every
 *  deal pipeline — so we can exclude them from the active list.
 *  We can't read `metadata.isClosed` from the list endpoint reliably in all
 *  portals; fall back to checking the label for "closed" / "won" / "lost". */
async function getClosedStageIds(): Promise<Set<string>> {
  const map = await getStageMap();
  const closed = new Set<string>();
  for (const [id, { label }] of map) {
    const l = label.toLowerCase();
    if (l.includes("closed") || l.includes("won") || l.includes("lost")) {
      closed.add(id);
    }
  }
  return closed;
}

/**
 * List up to `limit` active (open) deals — "anyone we're currently talking
 * with that we have yet to close." Any deal whose stage is NOT closed-won
 * or closed-lost qualifies, regardless of how recent the last activity
 * was. The caller (the API route) decides how to sort the result —
 * typically by computed health score DESC.
 *
 * Each row joins the deal with its primary company + primary contact.
 * We intentionally fetch deals (not companies) so the list reflects real
 * pipeline activity — a company with only an old closed-won deal doesn't
 * clutter the list.
 */
export async function listActiveProspects(limit = 20): Promise<ActiveProspect[]> {
  if (!process.env.HUBSPOT_TOKEN) return [];

  const closedIds = await getClosedStageIds();
  const stageMap = await getStageMap();

  // Ask for 2x + closed-bucket slack because we filter closed stages client-
  // side (HubSpot's `NOT_IN` on a CSV of IDs works but gets ugly when the
  // portal has many closed stages — cheaper to overfetch + filter).
  const overFetch = Math.min(limit * 2 + closedIds.size, 100);

  const body = {
    filterGroups: [
      {
        // At minimum, exclude deals with no stage (broken records).
        filters: [{ propertyName: "dealstage", operator: "HAS_PROPERTY" }],
      },
    ],
    properties: [
      "dealname",
      "dealstage",
      "amount",
      "hs_lastmodifieddate",
      "closedate",
      "hubspot_owner_id",
    ],
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    limit: overFetch,
  };

  const data = await hs<HsSearchResult<HsDeal>>("/crm/v3/objects/deals/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const open = (data?.results ?? []).filter((d) => {
    const sid = d.properties.dealstage;
    return sid && !closedIds.has(sid);
  });
  if (open.length === 0) return [];

  // Look up each deal's primary company + primary contact in parallel. We
  // cap concurrency implicitly by slicing to `limit` before the fan-out.
  const top = open.slice(0, limit);
  const rows = await Promise.all(
    top.map(async (deal): Promise<ActiveProspect | null> => {
      const companyAssoc = await hs<HsAssociations>(
        `/crm/v4/objects/deals/${deal.id}/associations/companies?limit=1`
      );
      const companyId = companyAssoc?.results?.[0]?.toObjectId;
      if (!companyId) return null;

      const [company, contactAssoc] = await Promise.all([
        getCompany(String(companyId)),
        hs<HsAssociations>(
          `/crm/v4/objects/deals/${deal.id}/associations/contacts?limit=1`
        ),
      ]);
      const contactId = contactAssoc?.results?.[0]?.toObjectId;
      const contact = contactId
        ? await hs<HsContact>(
            `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,jobtitle`
          )
        : null;

      const stageId = deal.properties.dealstage;
      const stageEntry = stageId ? stageMap.get(stageId) : null;
      const rawAmount = Number(deal.properties.amount ?? NaN);

      return {
        companyId: String(companyId),
        companyName: company?.properties.name ?? deal.properties.dealname ?? "(unnamed)",
        contactName: contact
          ? [contact.properties.firstname, contact.properties.lastname]
              .filter(Boolean)
              .join(" ") || null
          : null,
        dealStage: stageEntry?.label ?? null,
        dealStageId: stageId ?? null,
        stageProgress: stageEntry?.progress ?? null,
        dealValue: formatUsd(deal.properties.amount),
        dealAmount: Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : null,
        lastActivity: formatDate(deal.properties.hs_lastmodifieddate),
        lastActivityAt: deal.properties.hs_lastmodifieddate ?? null,
      };
    })
  );

  return rows.filter((r): r is ActiveProspect => r !== null);
}

// ── Engagements: last call / meeting for a company ────────────────────────

interface HsCall {
  id: string;
  properties: {
    hs_timestamp?: string;
    hs_call_title?: string;
    hs_call_body?: string;
    hs_call_duration?: string;
    hs_call_direction?: string;
    hs_createdate?: string;
  };
}

interface HsMeeting {
  id: string;
  properties: {
    hs_timestamp?: string;
    hs_meeting_title?: string;
    hs_meeting_body?: string;
    hs_meeting_start_time?: string;
    hs_meeting_end_time?: string;
    hs_createdate?: string;
  };
}

/** Strip HTML tags (HubSpot stores engagement bodies as HTML) and collapse
 *  whitespace. Cheap + safe for display — we're not trying to preserve
 *  formatting, just render the note text in a sidebar row. */
function stripHtml(s: string | undefined | null): string | null {
  if (!s) return null;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || null;
}

async function getLastCallRaw(companyId: string): Promise<HsCall | null> {
  const assoc = await hs<HsAssociations>(
    `/crm/v4/objects/companies/${companyId}/associations/calls?limit=10`
  );
  const ids = (assoc?.results ?? []).map((r) => String(r.toObjectId)).filter(Boolean);
  if (ids.length === 0) return null;

  const data = await hs<{ results: HsCall[] }>("/crm/v3/objects/calls/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: [
        "hs_timestamp",
        "hs_call_title",
        "hs_call_body",
        "hs_call_duration",
        "hs_call_direction",
        "hs_createdate",
      ],
      inputs: ids.map((id) => ({ id })),
    }),
  });
  const calls = data?.results ?? [];
  if (calls.length === 0) return null;
  calls.sort((a, b) => {
    const ta = new Date(a.properties.hs_timestamp ?? a.properties.hs_createdate ?? 0).getTime();
    const tb = new Date(b.properties.hs_timestamp ?? b.properties.hs_createdate ?? 0).getTime();
    return tb - ta;
  });
  return calls[0];
}

async function getLastMeetingRaw(companyId: string): Promise<HsMeeting | null> {
  const assoc = await hs<HsAssociations>(
    `/crm/v4/objects/companies/${companyId}/associations/meetings?limit=10`
  );
  const ids = (assoc?.results ?? []).map((r) => String(r.toObjectId)).filter(Boolean);
  if (ids.length === 0) return null;

  const data = await hs<{ results: HsMeeting[] }>("/crm/v3/objects/meetings/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: [
        "hs_timestamp",
        "hs_meeting_title",
        "hs_meeting_body",
        "hs_meeting_start_time",
        "hs_meeting_end_time",
        "hs_createdate",
      ],
      inputs: ids.map((id) => ({ id })),
    }),
  });
  const meetings = data?.results ?? [];
  if (meetings.length === 0) return null;
  meetings.sort((a, b) => {
    const ta = new Date(
      a.properties.hs_meeting_start_time ?? a.properties.hs_timestamp ?? 0
    ).getTime();
    const tb = new Date(
      b.properties.hs_meeting_start_time ?? b.properties.hs_timestamp ?? 0
    ).getTime();
    return tb - ta;
  });
  return meetings[0];
}

/**
 * Return the single most-recent call or meeting engagement logged against a
 * company, whichever is newer. Returns null when HubSpot has nothing
 * (unconfigured token / missing scopes / no engagements).
 *
 * Requires scopes: `crm.objects.calls.read` + `crm.objects.meetings.read`.
 * Missing scopes fail silently — `hs()` logs and returns null.
 */
export async function getLastCallForCompany(
  companyId: string
): Promise<HubSpotLastCall | null> {
  if (!process.env.HUBSPOT_TOKEN) return null;

  const [call, meeting] = await Promise.all([
    getLastCallRaw(companyId).catch(() => null),
    getLastMeetingRaw(companyId).catch(() => null),
  ]);

  const callAt = call?.properties.hs_timestamp ?? call?.properties.hs_createdate;
  const meetingAt =
    meeting?.properties.hs_meeting_start_time ??
    meeting?.properties.hs_timestamp ??
    meeting?.properties.hs_createdate;

  const callTs = callAt ? new Date(callAt).getTime() : 0;
  const meetingTs = meetingAt ? new Date(meetingAt).getTime() : 0;

  if (callTs === 0 && meetingTs === 0) return null;

  if (callTs >= meetingTs && call) {
    const dur = Number(call.properties.hs_call_duration ?? NaN);
    return {
      kind: "call",
      at: new Date(callTs).toISOString(),
      title: call.properties.hs_call_title ?? null,
      body: stripHtml(call.properties.hs_call_body),
      // HubSpot reports call duration in milliseconds; convert to seconds.
      durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur / 1000) : null,
      direction: call.properties.hs_call_direction ?? null,
    };
  }
  if (meeting) {
    const start = meeting.properties.hs_meeting_start_time
      ? new Date(meeting.properties.hs_meeting_start_time).getTime()
      : 0;
    const end = meeting.properties.hs_meeting_end_time
      ? new Date(meeting.properties.hs_meeting_end_time).getTime()
      : 0;
    const durationSec = start && end && end > start ? Math.round((end - start) / 1000) : null;
    return {
      kind: "meeting",
      at: new Date(meetingTs).toISOString(),
      title: meeting.properties.hs_meeting_title ?? null,
      body: stripHtml(meeting.properties.hs_meeting_body),
      durationSec,
      direction: null,
    };
  }
  return null;
}

/** Serialize prospect data into a compact block for the chat system prompt. */
export function formatProspectForPrompt(p: ProspectData): string {
  if (!p.found) return "";
  const lines = [
    `Company: ${p.companyName ?? "—"}`,
    p.dealStage && `Deal stage: ${p.dealStage}`,
    p.dealValue && `Deal value: ${p.dealValue}`,
    p.notes && `Deal: ${p.notes}`,
    p.ownerName && `Owner: ${p.ownerName}`,
    p.lastActivity && `Last activity: ${p.lastActivity}`,
    p.contactName &&
      `Primary contact: ${p.contactName}${p.contactTitle ? `, ${p.contactTitle}` : ""}`,
  ].filter(Boolean);
  return lines.join("\n");
}
