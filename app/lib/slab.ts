/**
 * Slab MCP client — calls hs-slab-mcp over HTTP/MCP protocol directly
 * from the Next.js server (which can reach the internal hostname).
 * This avoids needing Anthropic's API servers to resolve the internal DNS.
 */

const SLAB_MCP_URL = process.env.SLAB_MCP_URL ?? "https://hs-slab-mcp.nonprod.superscout.net/mcp";

// ── Unreachability cache ───────────────────────────────────────────────────
// The Slab host is on internal DNS. When the dev server is off-VPN (or
// running on a GitHub-hosted CI runner), fetches fail with ENOTFOUND on
// EVERY request — which buries real errors. Cache the "unreachable" state
// for 5 minutes after the first DNS failure so subsequent calls short-circuit
// cleanly. Reconnect to VPN and the cache expires naturally; no restart needed.
//
// Explicit opt-out: set SLAB_DISABLED=1 to silence this permanently.

const UNREACHABLE_TTL_MS = 5 * 60_000;
let unreachableUntil = 0;

function slabExplicitlyDisabled(): boolean {
  return process.env.SLAB_DISABLED === "1" || process.env.SLAB_DISABLED === "true";
}

function slabCurrentlyUnreachable(): boolean {
  return slabExplicitlyDisabled() || Date.now() < unreachableUntil;
}

/** Walk an Error's cause chain looking for DNS resolution failures. */
function isDnsFailure(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e; depth++) {
    const msg = (e as { message?: string; code?: string }).message ?? "";
    const code = (e as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|EAI_AGAIN/.test(msg)) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Mark Slab unreachable and log ONCE per TTL window. */
function markUnreachable(err: unknown): void {
  const now = Date.now();
  const wasReachable = now >= unreachableUntil;
  unreachableUntil = now + UNREACHABLE_TTL_MS;
  if (wasReachable) {
    console.info(
      `[slab] host appears unreachable (${(err as Error)?.message ?? "DNS failure"}). ` +
        `Skipping Slab fetches for ${UNREACHABLE_TTL_MS / 60_000} min — ` +
        `reconnect to VPN to restore, or set SLAB_DISABLED=1 to silence permanently.`
    );
  }
}

interface MCPResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function mcpRequest(
  sessionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(SLAB_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const text = await res.text();

  // Parse SSE envelope: "data: {...}"
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.result !== undefined) return parsed.result;
        if (parsed.error) throw new Error(parsed.error.message);
      } catch {
        // not JSON, skip
      }
    }
  }
  return null;
}

async function initSession(): Promise<string> {
  const res = await fetch(SLAB_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ranger", version: "1.0" },
      },
    }),
  });

  const sessionId = res.headers.get("mcp-session-id") ?? "";

  // Send initialized notification
  await fetch(SLAB_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });

  return sessionId;
}

export interface SlabSearchResult {
  title: string;
  type: string;
  id: string;
  snippet?: string;
}

export async function searchSlab(query: string, limit = 5): Promise<SlabSearchResult[]> {
  if (slabCurrentlyUnreachable()) return [];
  try {
    const sessionId = await initSession();

    const result = await mcpRequest(sessionId, "tools/call", {
      name: "slab_search",
      arguments: { query, first: limit, types: ["POST"] },
    }) as MCPResult;

    if (!result?.content) return [];

    const text = result.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    // Parse the text output: "[POST] Title (id: xxx)"
    return text
      .split("\n")
      .filter((l) => l.startsWith("["))
      .map((l) => {
        const match = l.match(/^\[(\w+)\]\s+(.+?)\s+\(id:\s*(\w+)\)/);
        if (!match) return null;
        return { type: match[1], title: match[2], id: match[3] };
      })
      .filter(Boolean) as SlabSearchResult[];
  } catch (err) {
    if (isDnsFailure(err)) markUnreachable(err);
    else console.error("[slab] search error:", err);
    return [];
  }
}

export async function getSlabPost(id: string): Promise<string> {
  if (slabCurrentlyUnreachable()) return "";
  try {
    const sessionId = await initSession();

    const result = await mcpRequest(sessionId, "tools/call", {
      name: "slab_get_post",
      arguments: { id },
    }) as MCPResult;

    if (!result?.content) return "";

    return result.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .slice(0, 2000); // cap at 2k chars to keep context manageable
  } catch (err) {
    if (isDnsFailure(err)) markUnreachable(err);
    else console.error("[slab] get post error:", err);
    return "";
  }
}
