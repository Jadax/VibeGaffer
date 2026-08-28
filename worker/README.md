# VibeGaffer CORS Workers

Tiny Cloudflare Workers that relay FPL API requests server-side and return
them with permissive CORS headers, so the static VibeGaffer app can read a
user's personal entry/picks data. Free public CORS relays are unreliable;
these are our own on the free tier (~100k requests/day, no rate limiting).

## Why

The FPL API sends **no `Access-Control-Allow-Origin` header** for the
`/entry/{id}/` and `/entry/{id}/event/{gw}/picks/` endpoints. A browser on
`https://vibegaffer.astraiva.app` therefore cannot call them directly, and the
free relay ecosystem (allorigins, corsproxy.io, codetabs, cors.lol) is
intermittently dead or rate-limited. This removes that dependency for the
app's key "load my squad" path.

## Two workers

- **`vibegaffer-relay`** (`src/shared-relay.js`) — the **shared app-wide**
  relay. Every visitor uses it automatically (no setup, no consent dialog) via
  `VG.SHARED_RELAY` in `docs/data.js`. Wired in the browser by the app; no user
  action needed.
- **`vibegaffer-cors`** (`src/cors-proxy.js`) — the **author's private**
  override, set via the sidebar "CORS Worker URL" box (localStorage
  `vg_proxyURL`). Tried before the shared relay if set.

Both are identical allowlisted CORS proxies for `https://fantasy.premierleague.com/api/*`.

## Deploy (one-time, ~2 minutes each)

### Option A — Dashboard (no CLI)
1. Go to <https://dash.cloudflare.com> -> **Workers & Pages** -> **Create** -> **Worker**.
2. Replace the default code with the contents of the relevant `src/*.js`.
3. Click **Deploy**.
4. Copy your `*.workers.dev` URL (top of the page).

### Option B — Wrangler CLI
```bash
npm i -g wrangler
wrangler login
wrangler deploy                         # vibegaffer-cors (uses wrangler.toml)
wrangler deploy -c wrangler.shared.toml # vibegaffer-relay (shared)
```

## Deployed

- Shared app-wide relay: **`https://vibegaffer-relay.sharma-tushant.workers.dev`**
- Author private override: **`https://vibegaffer-cors.sharma-tushant.workers.dev`**

(both account `sharma-tushant`)

## Wire into VibeGaffer

**Everyone** is covered by the shared relay automatically — nothing to do. The
author (or anyone who prefers to self-host) can optionally set their own Worker
URL in the sidebar's **"CORS Worker URL"** box (localStorage `vg_proxyURL`); it
is tried first, with the shared relay and free relays behind it. Don't include
the `?url=` part in the box — the app appends it.

## Security

- Only relays `https://fantasy.premierleague.com/api/*` — anything else returns
  403.
- `Access-Control-Allow-Origin: *` is fine here because the underlying API is
  public, read-only, and unauthenticated. Team IDs are personally-identifying
  but public data (anyone can look up entry 2769173).

## Test

```bash
curl 'https://vibegaffer-relay.sharma-tushant.workers.dev/?url=https%3A%2F%2Ffantasy.premierleague.com%2Fapi%2Fentry%2F2769173%2F'
```

Should return the entry JSON. If you get `blocked`, check the target URL.

