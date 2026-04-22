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
 *
 * Create one at: app.hubspot.com → Settings → Integrations → Private Apps
 */

const HUBSPOT_API = "https://api.hubapi.com";

export interface ProspectData {
  found: boolean;
  companyName?: string | null;
  dealStage?: string | null;
  dealValue?: string | null;
  lastActivity?: string | null;
  ownerName?: string | null;
  notes?: string | null;
  contactName?: string | null;
  contactTitle?: string | null;
  reason?: string;
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

  return {
    found: true,
    companyName: company?.properties.name ?? resolvedContact?.properties.company ?? null,
    dealStage: stageLabel ?? null,
    dealValue: formatUsd(deal?.properties.amount),
    lastActivity: formatDate(
      deal?.properties.hs_lastmodifieddate ?? company?.properties.hs_lastmodifieddate
    ),
    ownerName,
    notes: deal?.properties.dealname ?? null,
    contactName,
    contactTitle: resolvedContact?.properties.jobtitle ?? null,
  };
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
