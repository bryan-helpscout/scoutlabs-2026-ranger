/**
 * Auth.js (formerly NextAuth) v5 configuration for Ranger.
 *
 * Google SSO only. Session strategy is JWT (stateless, no DB required).
 * An optional email-domain allowlist rejects users outside the allowed
 * orgs at sign-in time — critical for keeping prospect/customer data
 * scoped to internal employees.
 *
 * Env (set in .env.local / deploy env):
 *   AUTH_SECRET                — 32+ char random secret for JWT signing
 *   AUTH_GOOGLE_ID             — Google OAuth client ID
 *   AUTH_GOOGLE_SECRET         — Google OAuth client secret
 *   AUTH_ALLOWED_DOMAINS       — optional CSV of allowed email domains
 *                                (e.g. "helpscout.com"). Empty = allow all.
 *   AUTH_TRUST_HOST            — set to "true" on Vercel/proxied hosts
 *
 * Created separate from app/ so middleware.ts can import `auth` without
 * pulling the whole App Router surface into the edge runtime.
 */

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/** Parse a comma-separated env list into a lowercase Set for fast lookup. */
function parseDomainAllowlist(): Set<string> {
  const raw = process.env.AUTH_ALLOWED_DOMAINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    /**
     * Gate sign-ins on the configured domain allowlist. Returning false
     * sends the user to the error page with ?error=AccessDenied; the
     * login page renders a friendly explanation for this case.
     */
    async signIn({ user }) {
      const allow = parseDomainAllowlist();
      if (allow.size === 0) return true; // no allowlist = open
      const email = user.email?.toLowerCase() ?? "";
      const domain = email.split("@")[1];
      if (domain && allow.has(domain)) return true;
      console.warn(
        `[auth] rejected sign-in for ${email || "(no email)"} — not in AUTH_ALLOWED_DOMAINS`
      );
      return false;
    },
    /** Enrich the JWT + session with fields the app reads downstream. */
    async jwt({ token, profile, account }) {
      if (account && profile) {
        token.name = profile.name ?? token.name;
        token.email = profile.email ?? token.email;
        token.picture = (profile as { picture?: string }).picture ?? token.picture;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.name = (token.name as string) ?? session.user.name;
        session.user.email = (token.email as string) ?? session.user.email;
        session.user.image = (token.picture as string) ?? session.user.image;
      }
      return session;
    },
  },
});
