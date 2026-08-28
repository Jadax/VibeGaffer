# VibeGaffer CORS Worker

A tiny Cloudflare Worker that relays FPL API requests server-side and returns
them with permissive CORS headers, so the static VibeGaffer app can read a
user's personal entry/picks data. Free public CORS relays are unreliable;
this is our own on the free tier (~100k requests/day, no rate limiting).

## Why

The FPL API sends **no `Access-Control-Allow-Origin` header** for the
`/entry/{id}/` and `/entry/{id}/event/{gw}/picks/` endpoints. A browser on
`https://vibegaffer.astraiva.app` therefore cannot call them directly, and the
free relay ecosystem (allorigins, corsproxy.io, codetabs, cors.lol) is
intermittently dead or rate-limited. This worker removes that dependency for
the app's key "load my squad" path.

## Deploy (one-time, ~2 minutes)

### Option A — Dashboard (no CLI)
1. Go to <https://dash.cloudflare.com> -> **Workers & Pages** -> **Create** -> **Worker**.
2. Replace the default code with the contents of `src/cors-proxy.js`.
3. Click **Deploy**.
4. Copy your `*.workers.dev` URL (top of the page).

### Option B — Wrangler CLI
```bash
npm i -g wrangler
wrangler login
wrangler deploy        # run inside this worker/ folder
```

## Deployed

Live at **`https://vibegaffer-cors.sharma-tushant.workers.dev`** (account
`sharma-tushant`). Re-deploy after editing with `wrangler deploy` in this
folder.

## Wire it into VibeGaffer

Set the Worker URL in the VibeGaffer sidebar's **"CORS Worker URL"** box
(localStorage key `vg_proxyURL`), e.g.:

```
https://<your-worker>.workers.dev/?url=https%3A%2F%2Ffantasy.premierleague.com%2Fapi%2Fentry%2F2769173%2F
```

The app calls this URL first (passing `?url=<encoded target>`), with the free
public relays as fallback. Don't include the `?url=` part in the box — the app
appends it.

## Security

- Only relays `https://fantasy.premierleague.com/api/*` — anything else returns
  403. You can tighten this further (e.g. require the `url` to contain an entry
  ID you own) if you like.
- `Access-Control-Allow-Origin: *` is fine here because the underlying API is
  public, read-only, and unauthenticated. Team IDs are personally-identifying
  but public data (anyone can look up entry 2769173).

## Test

```bash
curl 'https://<your-worker>.workers.dev/?url=https%3A%2F%2Ffantasy.premierleague.com%2Fapi%2Fentry%2F2769173%2F'
```

Should return the entry JSON. If you get `blocked`, check the target URL.
