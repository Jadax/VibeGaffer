VG.cache = {
  get(k) {
    try { const v = JSON.parse(localStorage.getItem("vg_" + k)); if (v && Date.now() - v.t < VG.CACHE_TTL) return v.d; } catch {}
    return null;
  },
  set(k, d) { try { localStorage.setItem("vg_" + k, JSON.stringify({ d, t: Date.now() })); } catch {} }
};

VG.PROXIES = [
  { fn: (url) => url, name: "direct" },
  { fn: (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url), name: "allorigins" },
  { fn: (url) => "https://corsproxy.io/?" + encodeURIComponent(url), name: "corsproxy" },
];
VG.proxyConsent = false;

VG.fetch = async (url, label) => {
  const c = VG.cache.get(url);
  if (c) return c;
  const setStatus = (t) => { const el = document.getElementById("status"); if (el) el.innerHTML = t; };
  setStatus('<span class="status-dot warning"></span> Fetching ' + (label || "data") + '...');
  let lastErr = null;
  for (const proxy of VG.PROXIES) {
    if (proxy.name !== "direct" && !VG.proxyConsent) {
      const approved = typeof window !== "undefined" && typeof window.confirm === "function"
        && window.confirm("The FPL API is not reachable directly. Allow a public CORS relay to receive this request? Team and league IDs may be visible to that relay.");
      if (!approved) break;
      VG.proxyConsent = true;
    }
    try {
      setStatus('<span class="status-dot warning"></span> Trying ' + proxy.name + '...');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(proxy.fn(url), { signal: ctrl.signal, cache: "no-cache" });
      clearTimeout(timer);
      if (!r.ok) { lastErr = new Error(proxy.name + " " + r.status); continue; }
      const j = await r.json();
      VG.cache.set(url, j);
      return j;
    } catch (e) { lastErr = e; }
  }
  setStatus('<span class="status-dot error"></span> ' + label + ' failed');
  throw new Error(label + ": " + (lastErr?.message || "all routes failed"));
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
    if (Number(p.minutes || 0) > 0 || Number(p.starts || 0) > 0) return;
    const prior = priors[String(p.code)];
    if (!prior || Number(prior.minutes || 0) < 90) return;
    Object.entries(prior).forEach(([key, value]) => {
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


