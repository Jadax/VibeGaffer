// VibeGaffer shared FPL relay — Cloudflare Worker
//
// Same allowlisted CORS proxy as the author's private worker (cors-proxy.js),
// but this one is shared app-wide so EVERY visitor can load their personal FPL
// squad/league data with ZERO setup and no consent dialog. The browser calls it
// directly from vibegaffer.astraiva.app; it relays to the FPL API server-side
// and returns the response with permissive CORS.
//
// It only ever relays https://fantasy.premierleague.com/api/* — everything else
// is rejected (403). Team/league IDs are FPL public data; they pass through
// Cloudflare request logs like any public relay, which the project has accepted.
//
// Deploy: `wrangler deploy` in worker/ with WRANGLER config for this worker, or
// via the Workers dashboard. Free-plan bound (~100k requests/day) is ample.
//
// Wire-in is done in docs/data.js via VG.SHARED_RELAY (no user action needed).

export default {
  async fetch(request) {
    // CORS preflight — browsers send this before the cross-origin GET.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders("*") });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response("missing ?url=", { status: 400, headers: corsHeaders("*") });
    }

    // Allowlist: only relay FPL API endpoints.
    const safe = target.startsWith("https://fantasy.premierleague.com/api/");
    if (!safe) {
      return new Response("blocked", { status: 403, headers: corsHeaders("*") });
    }

    let res;
    try {
      res = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; VibeGaffer/1.0)" },
      });
    } catch (e) {
      return new Response("upstream error: " + e.message, {
        status: 502,
        headers: corsHeaders("*"),
      });
    }

    const body = await res.text();
    const headers = corsHeaders("*");
    const ct = res.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);
    return new Response(body, { status: res.status, headers });
  },
};

function corsHeaders(origin) {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-cache",
  });
}
