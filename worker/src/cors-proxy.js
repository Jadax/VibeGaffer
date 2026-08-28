// VibeGaffer FPL data relay — Cloudflare Worker
//
// The FPL API does not send Access-Control-Allow-Origin, so a browser on a
// different origin (e.g. your static GitHub Pages site) cannot read the
// entry/picks endpoints directly. Free public CORS relays are unreliable
// (rate-limited, dead, or now key-gated), so this tiny worker relays those
// requests server-side and returns them with permissive CORS.
//
// This is a feature-no-blame reliability layer, not tech debt: it is the same
// intent as the app's built-in proxy chain but under our control (free tier,
// ~100k requests/day, no rate-limit roulette).
//
// Deploy (choose ONE):
//   1. Dashboard:  https://dash.cloudflare.com -> Workers & Pages -> Create
//      Worker -> paste this file's body -> Deploy. Grab the workers.dev URL.
//   2. CLI:        `npm i -g wrangler` then `wrangler deploy` in this folder.
// After deploying, set the Worker URL in VibeGaffer's sidebar ("CORS Worker
// URL" box) or localStorage key `vg_proxyURL`, e.g.
//   https://<your-worker>.workers.dev/?url=<encoded target>
// The app uses it first, with the free public relays as fallback.

export default {
  async fetch(request) {
    // CORS preflight — required by some Strict-Transport/OWASP setups.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders("*"),
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response("missing ?url=", { status: 400, headers: corsHeaders("*") });
    }

    // Allowlist: only relay FPL API endpoints (+ the one public upstream the
    // app falls back to health-checking). Everything else is rejected.
    const safe = target.startsWith("https://fantasy.premierleague.com/api/");
    if (!safe) {
      return new Response("blocked", { status: 403, headers: corsHeaders("*") });
    }

    let res;
    try {
      res = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; VibeGaffer/1.0)",
        },
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
    return new Response(body, {
      status: res.status,
      headers,
    });
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
