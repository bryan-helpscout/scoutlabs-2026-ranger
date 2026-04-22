# Help Scout Sales Co-pilot

An AI-powered sales assistant that searches Slack history and HubSpot in real time to give AEs instant answers during sales calls.

## What it does

- **Slack search** — searches `#sales-opportunities`, `#t-customers`, `#t-self-service-workstream`, and `#t-integrations` for relevant past answers
- **HubSpot lookup** — enter a prospect's company name and it pulls deal stage, value, last activity, and contact info before answering
- **Product knowledge** — pricing, feature comparisons, objection handling, technical details — all baked in
- **Streaming responses** — answers stream in real time, no waiting for the full response

## Tech stack

- **Next.js 15** (App Router)
- **Anthropic SDK** with Claude Sonnet 4.6 (chat + competitor refresh) and Claude Haiku 4.5 (live-call triage)
- **Slack + HubSpot MCP servers** (via Anthropic's MCP support)
- **CSS Modules** — no external UI library, light/dark mode via CSS variables

## Local development

### 1. Install deps

```bash
npm install
```

### 2. Set up env vars

```bash
cp .env.example .env.local
```

Edit `.env.local` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

When prompted, add your environment variable:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Or add it in the Vercel dashboard under **Project → Settings → Environment Variables**.

That's it. The API key stays server-side — it's never exposed to the browser.

## Customizing

### Change the Slack channels

Edit `app/lib/constants.ts` → `SLACK_CHANNELS`. Channel IDs are hardcoded from your workspace.

### Change the system prompt

Edit `SYSTEM_PROMPT` in `app/lib/constants.ts`. This controls product knowledge, pricing, competitor positioning, etc.

### Add more MCP servers

Edit `MCP_SERVERS` in `app/lib/constants.ts`. Any Anthropic-compatible MCP server URL works.

## Project structure

```
app/
  api/
    chat/route.ts       ← streams Anthropic responses (Slack + HubSpot MCP)
    prospect/route.ts   ← HubSpot company lookup
  components/
    CoPilot.tsx         ← main UI component
    CoPilot.module.css  ← styles (CSS variables, dark mode)
  lib/
    constants.ts        ← system prompt, channel IDs, MCP config
  globals.css           ← design tokens + reset
  layout.tsx
  page.tsx
```
