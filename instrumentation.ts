/**
 * Next.js startup hook — runs once per runtime (Node, Edge) at server start.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * We use it to neutralize Node 25's broken experimental `localStorage` stub
 * that throws `localStorage.getItem is not a function` at runtime unless
 * `--localstorage-file` is provided. The Anthropic SDK (and other libs) do
 * `typeof localStorage !== "undefined"` feature-detection and fall into the
 * broken path, which 500s every page render that constructs a client at
 * module scope. Removing the stub makes feature-detection correctly skip it.
 */
export async function register() {
  try {
    if (typeof globalThis.localStorage !== "undefined") {
      globalThis.localStorage.getItem("__probe");
    }
  } catch {
    try {
      // @ts-expect-error — intentionally removing the broken Node 25 stub
      delete globalThis.localStorage;
    } catch {
      // If delete fails (non-configurable), shadow it with a safe no-op.
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: undefined,
      });
    }
  }
}
