/**
 * Direct Linear GraphQL search wrapper — called from the triage loop to
 * surface roadmap/in-flight issues when a prospect asks about timing.
 *
 * Uses `searchIssues` (full-text). Auth with personal API key is sent as the
 * raw Authorization header value (no "Bearer " prefix — Linear convention).
 */

export interface LinearSearchResult {
  identifier: string; // e.g. "ENG-1234"
  title: string;
  url: string;
  stateName: string;
  stateType: string; // "started" | "completed" | "unstarted" | "canceled" | "triage"
  projectName?: string;
  priority?: number;
}

const LINEAR_URL = "https://api.linear.app/graphql";

const SEARCH_QUERY = /* GraphQL */ `
  query RangerIssueSearch($term: String!, $first: Int!) {
    searchIssues(term: $term, first: $first) {
      nodes {
        identifier
        title
        url
        priority
        state { name type }
        project { name }
      }
    }
  }
`;

interface LinearNode {
  identifier: string;
  title: string;
  url: string;
  priority?: number;
  state?: { name?: string; type?: string };
  project?: { name?: string } | null;
}

export async function searchLinear(query: string, limit = 3): Promise<LinearSearchResult[]> {
  const key = process.env.LINEAR_API_KEY;
  if (!key || !query.trim()) return [];

  try {
    const res = await fetch(LINEAR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: key,
      },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { term: query, first: limit } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[linear-search] http", res.status, await res.text().catch(() => ""));
      return [];
    }
    const data = (await res.json()) as {
      data?: { searchIssues?: { nodes?: LinearNode[] } };
      errors?: Array<{ message: string }>;
    };
    if (data.errors?.length) {
      console.error("[linear-search] gql errors:", data.errors);
      return [];
    }
    const nodes = data.data?.searchIssues?.nodes ?? [];
    return nodes.map<LinearSearchResult>((n) => ({
      identifier: n.identifier,
      title: n.title,
      url: n.url,
      stateName: n.state?.name ?? "",
      stateType: n.state?.type ?? "",
      projectName: n.project?.name,
      priority: n.priority,
    }));
  } catch (err) {
    console.error("[linear-search] failed:", err);
    return [];
  }
}
