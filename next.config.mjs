import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Node 25 ships an experimental globalThis.localStorage that throws on use
// unless --localstorage-file is provided with a valid path. The Anthropic SDK
// feature-detects `typeof localStorage !== 'undefined'` and falls into the
// broken stub, which 500s any page render that ever constructs an Anthropic
// client at module scope. Remove the broken stub so libs cleanly skip it.
try {
  if (typeof globalThis.localStorage !== "undefined") {
    globalThis.localStorage.getItem("__probe");
  }
} catch {
  // @ts-expect-error — intentionally removing the broken Node 25 stub
  delete globalThis.localStorage;
}

// Load .env.local manually so vars are available to route handlers
// (needed on Node.js v25 where Next.js's own env loader doesn't propagate to workers)
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    const value = rest.join("=").trim();
    if (key && value && !process.env[key.trim()]) {
      process.env[key.trim()] = value;
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
