/**
 * Route protection for Ranger.
 *
 * Auth.js v5's `auth()` export works as a middleware wrapper — it runs the
 * session check and augments `req` with `req.auth`. We then explicitly
 * allow-list routes that authenticate via a DIFFERENT mechanism:
 *
 *   /api/auth/*              — Auth.js own handlers
 *   /api/slack/command       — Slack HMAC signature verified inside the route
 *   /api/zoom/events         — Zoom HMAC signature verified inside the route
 *   /api/transcript/ingest   — accepts either a valid session OR a matching
 *                              "Authorization: Bearer $RANGER_INGEST_TOKEN"
 *                              header (so the caption watcher can POST
 *                              without a browser session)
 *   /login                   — the sign-in page itself
 *
 * Everything else under / or /api requires a signed-in session.
 */

import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const path = req.nextUrl.pathname;

  // Routes that authenticate by some mechanism other than the session cookie.
  const openRoutes = [
    "/login",
    "/api/auth", // Auth.js sign-in/sign-out/callback/session endpoints
    "/api/slack/command", // Slack signing-secret verified inside
    "/api/zoom/events", // Zoom secret-token verified inside
  ];
  if (openRoutes.some((p) => path === p || path.startsWith(p + "/"))) return;

  // Transcript ingest: allow either a valid session cookie (browser-driven
  // paste ingest) OR a shared-secret bearer token (caption watcher script).
  if (path === "/api/transcript/ingest") {
    const token = process.env.RANGER_INGEST_TOKEN;
    const header = req.headers.get("authorization") ?? "";
    if (token && header === `Bearer ${token}`) return;
    if (req.auth) return;
    return NextResponse.json(
      { error: "unauthorized — send Authorization: Bearer $RANGER_INGEST_TOKEN or sign in" },
      { status: 401 }
    );
  }

  // Default: require a session. Unauthed UI routes redirect to /login with
  // a callbackUrl so the user returns to where they started. Unauthed API
  // calls get a 401 JSON body.
  if (!req.auth) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }
});

export const config = {
  // Match everything except Next's static assets. Any route match falls
  // through to the handler above, which decides what to do.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)",
  ],
};
