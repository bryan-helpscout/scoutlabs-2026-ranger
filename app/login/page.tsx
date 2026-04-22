import { signIn } from "@/auth";
import styles from "./login.module.css";

interface LoginPageProps {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}

/**
 * Sign-in landing page. Server component — the "Continue with Google"
 * button is a form that posts to Auth.js's signIn action.
 *
 * When a user hits a protected route without a session, the middleware
 * redirects here with ?callbackUrl=<original-url>, so after sign-in we
 * can return them to where they were going.
 *
 * If Auth.js rejected their sign-in (common cause: email outside the
 * AUTH_ALLOWED_DOMAINS allowlist), it redirects here with ?error=<reason>
 * and we surface a friendly message.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl ?? "/";
  const errorCode = params.error;

  // Auth.js returns "AccessDenied" when the signIn callback returns false
  // (the common case is our domain-allowlist rejection).
  const errorMessage =
    errorCode === "AccessDenied"
      ? "That Google account isn't on the allowed domain list. Try an internal Help Scout email, or ask an admin to add your domain."
      : errorCode
        ? `Sign-in failed: ${errorCode}. Please try again or contact an admin.`
        : null;

  return (
    <main className={styles.root}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <div className={styles.logoDot}>
            <svg width={18} height={18} viewBox="0 0 24 24" fill="white" aria-hidden>
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
            </svg>
          </div>
          <div>
            <div className={styles.logoText}>Ranger</div>
            <div className={styles.logoSub}>Help Scout sales co-pilot</div>
          </div>
        </div>

        <h1 className={styles.heading}>Sign in to continue</h1>
        <p className={styles.subheading}>
          Ranger surfaces internal Slack, Slab, HubSpot, and competitor intel
          during live sales calls. Sign in with your Google account to pick
          up where you left off.
        </p>

        {errorMessage && <div className={styles.error}>{errorMessage}</div>}

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl });
          }}
        >
          <button type="submit" className={styles.googleBtn}>
            <GoogleG />
            <span>Continue with Google</span>
          </button>
        </form>

        <div className={styles.footer}>
          Internal tool — session persists until you sign out.
        </div>
      </div>
    </main>
  );
}

/** Google's multi-color "G" logo, inlined SVG so we don't need a brand asset. */
function GoogleG() {
  return (
    <svg
      aria-hidden
      width={18}
      height={18}
      viewBox="0 0 48 48"
      style={{ flexShrink: 0 }}
    >
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  );
}
