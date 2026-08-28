VG.cache = {
  get(k) {
    try { const v = JSON.parse(localStorage.getItem("vg_" + k)); if (v && Date.now() - v.t < VG.CACHE_TTL) return v.d; } catch {}
    return null;
  },
  set(k, d) { try { localStorage.setItem("vg_" + k, JSON.stringify({ d, t: Date.now() })); } catch {} }
};

// Shared app-wide CORS relay (author-deployed Cloudflare Worker, see
// worker/src/shared-relay.js). This is what EVERY visitor uses automatically
// to load their personal FPL squad/league data — no per-user setup, no consent
// dialog. It only relays fantasy.premierleague.com/api/*.
VG.SHARED_RELAY = "https://vibegaffer-relay.sharma-tushant.workers.dev";

// Free public relays sit behind the shared relay as last resorts:
// api.cors.lol is fast but rate-limits repeat users; allorigins is flaky
// (522/timeouts); codetabs sputters; corsproxy.io now demands an API key.
VG.PROXIES = [
  { fn: (url) => url, name: "direct", timeout: 15000 },
  { fn: (url) => "https://api.cors.lol/?url=" + encodeURIComponent(url), name: "cors.lol", timeout: 20000 },
  { fn: (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url), name: "allorigins", timeout: 30000, retries: 1 },
  { fn: (url) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), name: "codetabs", timeout: 20000 },
  { fn: (url) => "https://corsproxy.io/?url=" + encodeURIComponent(url), name: "corsproxy", timeout: 15000 },
];

// Persist/read the user's own Worker URL. Appended with ?url=<encoded target>.
VG.proxyURL = () => {
  try { return (localStorage.getItem("vg_proxyURL") || "").trim().replace(/\/$/, ""); } catch { return ""; }
};
VG.setProxyURL = (url) => {
  try { localStorage.setItem("vg_proxyURL", (url || "").trim()); } catch {}
};

VG.proxyConsent = false;
// Concurrent fetches (loadSquad's Promise.all) must share ONE consent dialog,
// not race two of them.
VG._proxyConsentPromise = null;
VG.ensureProxyConsent = () => {
  if (VG.proxyConsent) return Promise.resolve(true);
  if (!VG._proxyConsentPromise) {
    VG._proxyConsentPromise = Promise.resolve(
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm("The FPL API is not reachable directly. Allow a public CORS relay to receive this request? Team and league IDs may be visible to that relay.")
        : false
    ).then(approved => {
      VG.proxyConsent = approved;
      return approved;
    }).finally(() => { VG._proxyConsentPromise = null; });
  }
  return VG._proxyConsentPromise;
};

// Ordered list of relays, most-reliable-first. The user's OWN worker (if set)
// is the top override; otherwise (and for all visitors by default) the shared
// app-wide relay is used automatically. Both need no consent.
VG._relayList = () => {
  const list = [];
  const own = VG.proxyURL();
  if (own) list.push({ fn: (url) => own + "/?url=" + encodeURIComponent(url), name: "worker", timeout: 25000, own: true });
  list.push({ fn: (url) => VG.SHARED_RELAY + "/?url=" + encodeURIComponent(url), name: "relay", timeout: 25000, own: true });
  return list.concat(VG.PROXIES);
};

VG.fetch = async (url, label) => {
  const c = VG.cache.get(url);
  if (c) return c;
  console.debug("[VG] fetch", label, "relays:", VG._relayList().map(r => r.name));
  const setStatus = (t) => { const el = document.getElementById("status"); if (el) el.innerHTML = t; };
  setStatus('<span class="status-dot warning"></span> Fetching ' + (label || "data") + '...');
  let lastErr = null;
  for (const proxy of VG._relayList()) {
    // The user's own Worker needs no consent; free public relays do.
    if (proxy.name !== "direct" && !proxy.own && !VG.proxyConsent) {
      const approved = await VG.ensureProxyConsent();
      if (!approved) break;
    }
    const attempts = 1 + (proxy.retries || 0);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (attempt > 0) setStatus('<span class="status-dot warning"></span> Retrying ' + proxy.name + '...');
        else setStatus('<span class="status-dot warning"></span> Trying ' + proxy.name + '...');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), proxy.timeout || 15000);
        const r = await fetch(proxy.fn(url), { signal: ctrl.signal, cache: "no-cache" });
        clearTimeout(timer);
        // 404 is authoritative: the FPL endpoint genuinely has no data for
        // this resource (e.g. picks don't exist pre-deadline). Retrying other
        // relays won't change that, and run()'s draft fallback keys on it — so
        // surface 404 immediately instead of exhausting the whole chain first
        // (which used to bury it under a generic "Failed to fetch").
        if (r.status === 404) {
          setStatus('<span class="status-dot error"></span> ' + label + ' not found (404)');
          throw new Error(label + ": 404");
        }
        if (!r.ok) { lastErr = new Error(proxy.name + " " + r.status); break; }
        const j = await r.json();
        VG.cache.set(url, j);
        return j;
      } catch (e) {
        // 404 must propagate immediately (it's authoritative), not be
        // swallowed by the relay-retry catch.
        if (e && /404/.test(String(e.message))) throw e;
        lastErr = e;
      }
    }
  }
  setStatus('<span class="status-dot error"></span> ' + label + ' failed');
  const msg = lastErr?.message || "all routes failed";
  let hint = "";
  try {
    // The shared relay is automatic, so if even it failed the page is almost
    // certainly running a stale cached index.html whose CSP predates it (the
    // free public relays are unreliable, so they aren't a useful fallback).
    const el = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const csp = (el && el.content) || "";
    if (csp && !csp.includes("workers.dev")) {
      hint = " — your page is an old cached version; hard-refresh (Ctrl+Shift+R) to load the CSP that allows the built-in relay";
    } else {
      hint = " — the built-in relay is unreachable right now; try again shortly, or paste your own Cloudflare Worker URL into the 'CORS Worker URL' box";
    }
  } catch (e) { /* ignore */ }
  throw new Error(label + ": " + msg + hint);
};

VG.loadBootstrap = async () => {
  // Prefer the generated compact payload; retain the full snapshot as a
  // backwards-compatible fallback while the next Actions refresh lands.
  try {
    const r = await fetch("data/bootstrap-lite.json", { cache: "no-cache" });
    if (r.ok) {
      const j = await r.json();
      if (j && Array.isArray(j.elements) && j.elements.length > 0 && Array.isArray(j.teams) && Array.isArray(j.events)) return j;
    }
  } catch (e) { console.warn("[VG] Compact bootstrap unavailable:", e.message); }
  try {
    const r = await fetch("data/bootstrap.json", { cache: "no-cache" });
    if (r.ok) {
      const j = await r.json();
      if (j && j.elements) return j;
    }
    console.warn("[VG] Local bootstrap returned", r.status);
  } catch (e) { console.warn("[VG] Local bootstrap failed:", e.message); }
  return VG.fetch(VG.FPL + "/bootstrap-static/", "bootstrap");
};

VG.loadFixtures = async () => {
  try {
    const r = await fetch("data/fixtures.json", { cache: "no-cache" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j.length > 0) return j;
    }
    console.warn("[VG] Local fixtures returned", r.status);
  } catch (e) { console.warn("[VG] Local fixtures failed:", e.message); }
  return VG.fetch(VG.FPL + "/fixtures/", "fixtures");
};

VG.loadOdds = async () => {
  try {
    const r = await fetch("data/odds.json", { cache: "no-cache" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j.length > 0) {
        VG.oddsData = j;
        return j;
      }
    }
  } catch (e) { console.warn("[VG] Odds data unavailable (optional):", e.message); }
  return [];
};

// Optional free historical FPL data, generated weekly by GitHub Actions.
VG.loadHistoryPriors = async () => {
  try {
    const r = await fetch("data/history-priors.json", { cache: "no-cache" });
    const j = r.ok ? await r.json() : null;
    return j?.players || {};
  } catch (e) { return {}; }
};

// Free Understat data (GitHub Actions): player xG/xA priors, team pressing
// stats, and per-fixture win/draw/loss forecasts. Optional enrichment.
VG.loadUnderstat = async () => {
  VG.understatLoaded = true;
  try {
    const r = await fetch("data/understat.json", { cache: "no-cache" });
    const j = r.ok ? await r.json() : null;
    if (j && j.players && j.teams) {
      VG.understat = j;
      Object.keys(j.players).forEach(pid => {
        const el = VG.players[pid];
        if (el) el.understat = j.players[pid];
      });
      return j;
    }
  } catch (e) { console.warn("[VG] Understat data unavailable (optional):", e.message); }
  VG.understat = null;
  return null;
};

// Load the bundled seasonal set-piece takers (optional — boosts xP when present).
VG.loadSetPieceData = async () => {
  try {
    const r = await fetch("data/setpieces.json", { cache: "no-cache" });
    if (r.ok) { const j = await r.json(); VG.loadSetPieces(j); return j; }
  } catch (e) { console.warn("[VG] set-piece data unavailable (optional):", e.message); }
  return null;
};

// Free per-player recent-form data (GitHub Actions, daily): last-5-GW starts
// and minutes, reduced from FPL's own element-summary endpoint. Season-total
// starts/minutes can't tell "nailed on for the last 5 GWs" apart from
// "started well in September, benched since" — this closes that gap.
// Empty (or entirely absent, e.g. pre-season before GW1) is a normal state:
// VG.computeFixtureXP falls back to the season-aggregate model untouched.
VG.loadRecentForm = async () => {
  VG.recentFormLoaded = true;
  try {
    const r = await fetch("data/recent-form.json", { cache: "no-cache" });
    const j = r.ok ? await r.json() : null;
    if (j && j.players) {
      VG.recentForm = j;
      Object.keys(j.players).forEach(pid => {
        const el = VG.players[pid];
        if (el) el.recentForm = j.players[pid];
      });
      // Flag how many rounds of recency data are actually available this
      // season (used by the recency-weighted projection blend to confidence-
      // scale its weight, and by the UI to label the signal).
      VG.recentFormMaxRounds = 0;
      Object.values(j.players).forEach(pf => { VG.recentFormMaxRounds = Math.max(VG.recentFormMaxRounds, pf.n || 0); });
      return j;
    }
  } catch (e) { console.warn("[VG] Recent-form data unavailable (optional):", e.message); }
  VG.recentForm = null;
  return null;
};

VG.applyHistoryPriors = (bootstrap, priors) => {
  if (!bootstrap?.elements || !priors) return bootstrap;
  bootstrap.elements.forEach(p => {
    const prior = priors[String(p.code)];
    if (!prior) return;
    // Transfer detection (v5.13): every player who was in the league last
    // season carries their previous club's franchise code. Attached to ALL
    // elements (not just debutants) so a summer move is visible regardless of
    // whether the player has PL minutes. VG.transferInfo compares this against
    // the element's current team_code.
    if (prior.team_code !== undefined && prior.team_code !== "") {
      p.priorTeamCode = String(prior.team_code);
    }
    if (Number(p.minutes || 0) > 0 || Number(p.starts || 0) > 0) return;
    if (Number(prior.minutes || 0) < 90) return;
    Object.entries(prior).forEach(([key, value]) => {
      if (key === "team_code") return;
      if (p[key] === undefined || Number(p[key] || 0) === 0) p[key] = value;
    });
  });
  return bootstrap;
};

VG.loadSquad = async (tid, gw) => {
  const [info, picks] = await Promise.all([
    VG.fetch(VG.FPL + "/entry/" + tid + "/", "team"),
    VG.fetch(VG.FPL + "/entry/" + tid + "/event/" + gw + "/picks/", "picks")
  ]);
  return { info, picks };
};

// The user's "primary" classic mini-league, auto-detected from their entry so
// the League tab needs no manual ID. Prefers the entry's own named league:
// skip the global "Overall" and per-gameweek system leagues, and any closed
// ones; fall back to the first real classic league by API order.
VG.primaryLeagueId = 0;
VG.detectPrimaryLeague = (info) => {
  try {
    const classic = (info && info.leagues && info.leagues.classic) || [];
    const isSystem = (l) => {
      const n = (l && (l.name || "")) || "";
      const s = (l && l.short_name) || "";
      return /^overall$/i.test(n) || /^overall$/i.test(s) || /^gameweek\s/i.test(n);
    };
    const pick = classic.find(l => l && l.id && !l.closed && !isSystem(l));
    if (pick && pick.id) VG.primaryLeagueId = pick.id;
  } catch (e) { /* non-fatal */ }
  return VG.primaryLeagueId;
};


