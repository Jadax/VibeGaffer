// VibeGaffer v5.11.0 — pure static FPL analytics (GitHub Pages, no backend)
// Docs: README.md / AGENTS.md · Data: docs/data/*.json via GitHub Actions
const VG = {};

VG.FPL = "https://fantasy.premierleague.com/api";
VG.POSITIONS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
VG.POSITIONS_R = { GK: 1, DEF: 2, MID: 3, FWD: 4 };
VG.POS_TARGET = { 1: 2, 2: 5, 3: 5, 4: 3 };
VG.POS_SHIRT = { 1: "gk", 2: "def", 3: "mid", 4: "fwd" };
VG.CACHE_TTL = 1800000;
// Legal outfield shapes as [DEF, MID, FWD] — GK is always exactly 1
VG.FORMATIONS = [
  [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1]
];

// ── Shared helpers ────────────────────────────────────────────────────
// Escape API-derived strings before they reach innerHTML. Player names come
// from the FPL API, but league/manager/team names are chosen by other users
// and must never be trusted as markup.
VG.esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// Canonical player display name (web_name preferred, then second/first).
VG.playerName = (p) => p ? (p.web_name || p.second_name || p.first_name || "") : "";

// FDR -> colour used across every fixture-difficulty render (red hard, green easy).
VG.fdrColor = (fdr) => fdr <= 2 ? "#4ade80" : fdr >= 4 ? "#f87171" : "#94a3b8";

// Flags a player with a fitness concern: FPL chance_of_playing_next_round < 100,
// an injury news string, or a non-available status.
VG.hasFitnessFlag = (p) => {
  const chance = p.chance_of_playing_next_round;
  const hasNews = p.news && String(p.news).trim().length > 0;
  return (chance !== null && chance !== undefined && chance < 100) ||
         hasNews ||
         (p.status !== "a" && p.status !== "d");
};

// Injury filter: available or doubtful only (excludes injured/suspended/unavailable)
VG.isAvailable = (p) => {
  const data = VG.players[p.id];
  return !data || data.status === "a" || data.status === "d";
};

// Difficulty a team faces in a fixture, from that team's perspective
VG.fixtureFDR = (f, teamId) => {
  if (!f) return 3;
  return (f.team_h === teamId ? f.team_h_difficulty : f.team_a_difficulty) || 3;
};

// One-stop per-team fixture derivation. Use this instead of re-deriving
// isHome/oppId/oppName/fdr by hand at every call site.
VG.fixtureInfo = (f, teamId) => {
  if (!f || !teamId) return { isHome: false, oppId: null, oppName: "BLANK", fdr: 3 };
  const isHome = f.team_h === teamId;
  const oppId = isHome ? f.team_a : f.team_h;
  return {
    isHome,
    oppId,
    oppName: oppId ? (VG.teams[oppId]?.short_name || "?") : "?",
    fdr: VG.fixtureFDR(f, teamId)
  };
};

// All fixtures for one team within a single GW (usually one; two = DGW, zero = BGW)
VG.teamFixtures = (fixtures, gw, teamId) =>
  fixtures.filter(f => f.event === gw && (f.team_h === teamId || f.team_a === teamId));

// All fixtures in a gameweek (DGW/BGW detection, per-GW scans)
VG.fixturesForGW = (fixtures, gw) => fixtures.filter(f => f.event === gw);

// True when a player has played at least one minute (missing = not started)
VG.hasPlayed = (minutesMap, pid) => (minutesMap[pid] || 0) > 0;

// FPL's minimum legal starting-XI shape (GK>=1, DEF>=3, MID>=2, FWD>=1)
VG.formationLegal = (players) => {
  const count = pos => players.filter(p => p.positionId === pos).length;
  return count(1) >= 1 && count(2) >= 3 && count(3) >= 2 && count(4) >= 1;
};

// Squad members carrying a non-available status (injured/suspended/unavailable)
VG.countUnavailable = (squad) => {
  if (!squad) return 0;
  return squad.filter(p => {
    const data = VG.players[p.element || p.id];
    return data && data.status !== "a";
  }).length;
};

// Players with a fitness flag: FPL chance_of_playing_next_round < 100,
// a non-available status, or an injury news string. Sorted worst-first.
VG.injuryNews = () => {
  const out = [];
  Object.values(VG.players).forEach(p => {
    if (!VG.hasFitnessFlag(p)) return;
    const chance = p.chance_of_playing_next_round;
    out.push({
      id: p.id,
      name: VG.playerName(p),
      team: (VG.teams[p.team] || {}).short_name || "",
      position: VG.POSITIONS[p.element_type] || "?",
      chance: (chance === null || chance === undefined) ? 100 : +chance,
      status: p.status,
      news: p.news || ""
    });
  });
  out.sort((a, b) => a.chance - b.chance);
  return out;
};

// Top 2 non-GK captain candidates by xP key ("totalXP" or "gwXP")
VG.topCaptainCandidates = (starting, key = "totalXP") =>
  (starting || [])
    .filter(p => p.positionId !== 1)
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .slice(0, 2);

// Probability of reaching a count threshold when events follow a Poisson rate.
// Used for DEFCON, whose official two-point award is a match-level threshold.
VG.poissonAtLeast = (mean, threshold) => {
  if (mean <= 0 || threshold < 1) return threshold < 1 ? 1 : 0;
  let probabilityBelow = 0;
  let term = Math.exp(-mean);
  for (let k = 0; k < threshold; k++) {
    probabilityBelow += term;
    term *= mean / (k + 1);
  }
  return Math.max(0, Math.min(1, 1 - probabilityBelow));
};

// Team kit colors keyed by FPL short_name (robust to promotion/relegation;
// numeric IDs used to shift every season). Home = primary shirt, away = change.
VG.TEAM_COLORS = {
  ARS: { home: "#EF0107", away: "#FFFFFF" },
  AVL: { home: "#670E36", away: "#95BFE5" },
  BOU: { home: "#DA291C", away: "#1B1B1B" },
  BRE: { home: "#E30613", away: "#FFFFFF" },
  BHA: { home: "#0057B8", away: "#FFFFFF" },
  CHE: { home: "#034694", away: "#FFFFFF" },
  COV: { home: "#00A5DF", away: "#FFFFFF" },
  CRY: { home: "#1B458F", away: "#FDB913" },
  EVE: { home: "#003399", away: "#FFFFFF" },
  FUL: { home: "#FFFFFF", away: "#000000" },
  HUL: { home: "#F0A81E", away: "#000000" },
  IPS: { home: "#003399", away: "#FFFFFF" },
  LEE: { home: "#FFCD00", away: "#FFFFFF" },
  LIV: { home: "#C8102E", away: "#FFFFFF" },
  MCI: { home: "#6CABDD", away: "#1C2C5B" },
  MUN: { home: "#DA291C", away: "#FFFFFF" },
  NEW: { home: "#241F20", away: "#FFFFFF" },
  NFO: { home: "#DD0000", away: "#FFFFFF" },
  TOT: { home: "#132257", away: "#FFFFFF" },
  SUN: { home: "#EB172B", away: "#000000" }
};

// Home kit color for a player/team, by FPL short_name, with neutral fallback.
VG.teamColor = (teamRef) => {
  if (!teamRef) return "#38bdf8";
  const short = typeof teamRef === "string" ? teamRef : (VG.teams[teamRef] || {}).short_name;
  return (VG.TEAM_COLORS[short] && VG.TEAM_COLORS[short].home) || "#38bdf8";
};

// ── Transfer / new-club detection (v5.13) ──────────────────────────────
// A player whose previous-season club (priorTeamCode, attached from the free
// vaastav history-priors feed by applyHistoryPriors) differs from their current
// team_code changed clubs over the summer. Their old-club per-90 output was
// earned in a different attacking context, so the xP engine adjusts their
// projection toward the new club's attacking strength (see computeFixtureXP).
// Returns a null-safe object; missing priors (e.g. pre-season before the feed
// lands, or players not in the league last season) simply read as no move.
VG.transferInfo = (p) => {
  const none = { transferred: false, fromTeam: null, toTeam: null, fromCode: null, toCode: null, foreignLeague: "" };
  if (!p) return none;
  const cur = VG.teams[p.team];
  const toCode = cur ? String(cur.code) : "";
  const priorCode = p.priorTeamCode != null && p.priorTeamCode !== "" ? String(p.priorTeamCode) : "";
  const us = p.understat;
  const foreignLeague = us && us.league && us.league !== "EPL" ? us.league : "";
  if (!priorCode) {
    // No prior feed for this player — a foreign-signing label from understat
    // still counts as a meaningful "new to the league" signal, but it's NOT a
    // club change.
    return { transferred: false, fromTeam: null, toTeam: cur || null, fromCode: null, toCode, foreignLeague };
  }
  const fromTeam = VG.teamByCode[priorCode] || null;
  const transferred = !!fromTeam && fromTeam.id !== p.team;
  return {
    transferred,
    fromTeam: transferred ? fromTeam : null,
    toTeam: cur || null,
    fromCode: priorCode,
    toCode,
    foreignLeague
  };
};

// HTML chip for a transfer, e.g. "NEW CLUB · MCI → ARS". Empty when the player
// did not change clubs. Used in Compare, Differentials, Player Profile and the
// briefing's market watch.
VG.transferBadge = (t) => {
  if (!t || !t.transferred) return "";
  const fromShort = (t.fromTeam && t.fromTeam.short_name) || "?";
  const toShort = (t.toTeam && t.toTeam.short_name) || "?";
  return `<span style="background:rgba(251,191,36,0.12);color:#fbbf24;padding:1px 6px;border-radius:4px;font-size:0.65rem;white-space:nowrap;">NEW CLUB · ${VG.esc(fromShort)} → ${VG.esc(toShort)}</span>`;
};

// Label for a foreign-league prior ("LA LIGA PRIOR" etc). Empty for EPL priors.
VG.foreignLeagueLabel = (league) => {
  if (!league) return "";
  const names = { La_liga: "LA LIGA", Bundesliga: "BUNDESLIGA", Serie_A: "SERIE A", Ligue_1: "LIGUE 1" };
  return names[league] || String(league).toUpperCase();
};

// ── Fixture congestion / European rotation risk (v5.14) ──────────────
// Teams in European competition (CL/EL/ECL) play midweek fixtures that don't
// appear in the FPL fixture list.  When a team's PL fixtures are spaced < 5
// days apart, a midweek European match almost certainly occurred, increasing
// rotation risk.  Heavy-rotator managers (historically Guardiola, Arteta,
// Slot, Emery, Postecoglou) apply an extra penalty in congested weeks.
VG.HEAVY_ROTATORS = new Set(["MCI", "ARS", "LIV", "CHE", "AVL", "TOT", "BHA", "NEW"]);
VG.fixtureGapDays = (fixtures, teamId, gw) => {
  if (!fixtures || !teamId) return 14;
  const prevGW = [];
  const nextGW = [];
  fixtures.forEach(f => {
    if (f.event < gw && (f.team_h === teamId || f.team_a === teamId)) prevGW.push(f);
    if (f.event === gw && (f.team_h === teamId || f.team_a === teamId)) nextGW.push(f);
  });
  if (prevGW.length === 0 || nextGW.length === 0) return 14;
  const prev = prevGW[prevGW.length - 1];
  const nxt = nextGW[0];
  const prevDate = prev.kickoff_time ? new Date(prev.kickoff_time) : null;
  const nxtDate = nxt.kickoff_time ? new Date(nxt.kickoff_time) : null;
  if (!prevDate || !nxtDate) return 14;
  return (nxtDate - prevDate) / 864e5;
};
VG.congestionMultiplier = (fixtures, teamId, gw) => {
  const gap = VG.fixtureGapDays(fixtures, teamId, gw);
  if (gap >= 7) return 1.0;
  if (gap < 4) return VG.HEAVY_ROTATORS.has(String(teamId)) ? 0.82 : 0.88;
  if (gap < 5) return VG.HEAVY_ROTATORS.has(String(teamId)) ? 0.88 : 0.93;
  return 0.97;
};

VG.buildMaps = (data) => {
  VG.players = {};
  VG.teams = {};
  VG.teamByCode = {};
  data.elements.forEach(p => {
    VG.players[p.id] = p;
  });
  data.teams.forEach(t => { VG.teams[t.id] = t; });

  // Stable franchise-code -> team map (v5.13). FPL's element `team_code` and
  // team `code` are the same stable club code across seasons, so this powers
  // transfer detection: a player whose priorTeamCode (last season's club code,
  // from history-priors) differs from their current team_code changed clubs.
  data.teams.forEach(t => { VG.teamByCode[String(t.code)] = t; });

  // Pre-season FPL clears detailed strengths. Build a season-agnostic prior
  // from the API's own 1-5 team rating, including promoted clubs.
  data.teams.forEach(t => {
    if (t.strength_defence_home === 0 || t.strength_overall_home === 0) {
      const rating = Math.max(1, Math.min(5, Number(t.strength) || 3));
      const base = 1000 + (rating - 3) * 100;
      t.strength_attack_home = base + 40;
      t.strength_attack_away = base - 10;
      t.strength_defence_home = base + 30;
      t.strength_defence_away = base - 20;
      t.strength_overall_home = base + 30;
      t.strength_overall_away = base - 20;
    }
  });

  // Snapshot the clean strength scale BEFORE any Elo drift can mutate it, so
  // VG.computeTeamElo always seeds from the same base. This keeps the Elo
  // blend idempotent: repeat calls re-derive the same drift instead of
  // compounding it onto an already-drifted seed (a real v5.10 bug once a
  // second caller — e.g. the defensive-outlook view — recomputed Elo).
  data.teams.forEach(t => {
    t._eloBase = {
      attH: Number(t.strength_attack_home) || 0,
      attA: Number(t.strength_attack_away) || 0,
      defH: Number(t.strength_defence_home) || 0,
      defA: Number(t.strength_defence_away) || 0,
      rating: Math.max(1, Math.min(5, Number(t.strength) || 3))
    };
  });

  VG.gwData = data.events;
  VG.currentGW = data.events.find(e => e.is_current)?.id || data.events.find(e => e.is_next)?.id || 1;
};

// ── Season-adaptive Elo team strength (v5.10) ───────────────────────────
// Idea borrowed from fpl-dataset / fpl-predict's live Elo ratings and the
// OpenFPL arXiv write-up (arXiv:2508.09992). FPL's own strength_* fields are
// a pre-season snapshot that stays static all year (and is all-zeros before
// GW1), so "who is actually good right now" never reaches the xP engine. This
// derives attack/defence Elo from finished fixtures (team_h_score/team_a_score,
// present once a match completes) and blends the drift back into the strength
// fields VG.computeFixtureXP already reads.
//
// Pre-season (no finished fixtures) the blend weight is 0, so the engine is
// byte-identical to the buildMaps fallback. The blend ramps up to 0.85 as
// games are played, so week one only nudges the ratings while mid-season the
// results fully re-rank the league.
VG.computeTeamElo = (fixtures) => {
  const fx = fixtures || VG.allFixtures || [];
  if (!VG.teams) return null;

  // Seed from the same 1000-scale the buildMaps fallback and computeFixtureXP
  // expect. The base snapshot is taken in buildMaps BEFORE drift is ever
  // written back, so recomputation is idempotent (no compounding).
  const seed = {};
  Object.values(VG.teams).forEach(t => {
    const b = t._eloBase;
    const rating = b ? b.rating : Math.max(1, Math.min(5, Number(t.strength) || 3));
    const base = 1000 + (rating - 3) * 100;
    seed[t.id] = {
      attH: (b && b.attH) || base + 40,
      attA: (b && b.attA) || base - 10,
      defH: (b && b.defH) || base + 30,
      defA: (b && b.defA) || base - 20
    };
  });

  // Independent attack & defence Elo per team, seeded from the same scale.
  const elo = {};
  Object.keys(seed).forEach(id => {
    elo[id] = {
      att: (seed[id].attH + seed[id].attA) / 2,
      def: (seed[id].defH + seed[id].defA) / 2,
      played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0
    };
  });

  const HOME_ADV = 60; // Elo points of home advantage
  const obs = (gd) => 1 / (1 + Math.exp(-gd * 0.25)); // logistic of goal diff → 0..1
  const expect = (mine, theirs) => 1 / (1 + Math.pow(10, (theirs - mine) / 400));

  // Sort chronologically so Elo evolves in match order.
  const finished = fx
    .filter(f => f && f.finished && f.team_h_score != null && f.team_a_score != null)
    .sort((a, b) => (a.event || 0) - (b.event || 0) || (a.id || 0) - (b.id || 0));

  finished.forEach(f => {
    const H = f.team_h, A = f.team_a;
    const eH = elo[H], eA = elo[A];
    if (!eH || !eA) return;
    const hs = f.team_h_score, as = f.team_a_score;
    const gd = hs - as;
    // Expected goals-scored share for each side.
    const expH = expect(eH.att + HOME_ADV, eA.def);
    const expA = expect(eA.att, eH.def + HOME_ADV);
    // Observed share, shaped by the actual margin (wins count more than draws).
    const obsH = obs(gd), obsA = 1 - obsH;
    // Margin-scaled K: bigger wins move ratings more, capped.
    const K = 36 * (1 + Math.min(1, Math.abs(gd) / 4));
    eH.att += K * (obsH - expH);
    eA.def -= K * (obsH - expH); // conceding a beating drops your defence
    eA.att += K * (obsA - expA);
    eH.def -= K * (obsA - expA);
    eH.played++; eA.played++;
    eH.gf += hs; eH.ga += as; eA.gf += as; eA.ga += hs;
    if (gd > 0) { eH.w++; eA.l++; } else if (gd < 0) { eA.w++; eH.l++; } else { eH.d++; eA.d++; }
  });

  // Blend Elo drift back into the strength fields, weighting by games played.
  const weight = (n) => Math.min(0.85, n / 8); // 0 pre-season → 0.85 after 8
  const rows = Object.values(VG.teams).map(t => {
    const id = t.id;
    const s = seed[id], e = elo[id];
    if (!s || !e) return null;
    const w = weight(e.played);
    const driftAtt = e.att - (s.attH + s.attA) / 2;
    const driftDef = e.def - (s.defH + s.defA) / 2;
    // Only mutate the shared strength fields once results exist. At weight 0
    // the seed's overall formula ((attH+defH)/2) differs from buildMaps'
    // base+30, so writing back would silently change values with zero games.
    if (w > 0) {
      t.strength_attack_home = +(s.attH + w * driftAtt).toFixed(0);
      t.strength_attack_away = +(s.attA + w * driftAtt).toFixed(0);
      t.strength_defence_home = +(s.defH + w * driftDef).toFixed(0);
      t.strength_defence_away = +(s.defA + w * driftDef).toFixed(0);
      t.strength_overall_home = +(((s.attH + s.defH) / 2 + w * (driftAtt + driftDef) / 2)).toFixed(0);
      t.strength_overall_away = +(((s.attA + s.defA) / 2 + w * (driftAtt + driftDef) / 2)).toFixed(0);
    }
    t.elo = { att: e.att, def: e.def, played: e.played, weight: w };
    return {
      id, short: t.short_name,
      name: t.name,
      att: +e.att.toFixed(0), def: +e.def.toFixed(0),
      overall: +((e.att + e.def) / 2).toFixed(0),
      played: e.played, w: e.w, d: e.d, l: e.l, gf: e.gf, ga: e.ga,
      weight: +w.toFixed(2), source: e.played > 0 ? "elo" : "seed"
    };
  }).filter(Boolean);
  rows.sort((a, b) => b.overall - a.overall);
  rows.forEach((r, i) => { r.rank = i + 1; });
  VG.teamElo = rows;
  return rows;
};

// HTML for the Fixtures-tab Elo table: live attack/defence/overall Elo with
// W-D-L, goal record and the blend weight (so users see how much of the rating
// is results-driven vs API seed). Renders empty pre-season (weight 0).
VG.eloRatingsHTML = (rows) => {
  if (!rows || rows.length === 0 || rows.every(r => r.played === 0)) return "";
  const bar = (eloVal, col) => {
    const w = Math.max(4, Math.min(100, 45 + (eloVal - 1000) / 3));
    return `<span style="display:inline-block;width:56px;height:6px;background:#1e293b;border-radius:3px;vertical-align:middle;margin-right:6px;"><span style="display:block;height:6px;width:${w}%;background:${col};border-radius:3px;"></span></span><span style="color:${col};font-weight:700;font-size:0.8rem;">${eloVal}</span>`;
  };
  let html = '<div class="ticker-scroll"><table class="ticker-table"><thead><tr><th>#</th><th>Team</th><th>Attack Elo</th><th>Defence Elo</th><th>Overall</th><th>W-D-L</th><th>GF/GA</th><th>Blend</th></tr></thead><tbody>';
  rows.forEach(r => {
    const color = r.played > 0 ? "#a78bfa" : "#64748b";
    html += `<tr>
      <td style="color:#94a3b8;">${r.rank}</td>
      <td class="ticker-team"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${VG.esc(VG.teamColor(r.short))};margin-right:6px;"></span>${VG.esc(r.short)}</td>
      <td>${bar(r.att, color)}</td>
      <td>${bar(r.def, color)}</td>
      <td>${bar(r.overall, r.played > 0 ? "#00ff87" : "#64748b")}</td>
      <td style="font-size:0.75rem;color:#94a3b8;">${r.played > 0 ? `${r.w}-${r.d}-${r.l}` : "–"}</td>
      <td style="font-size:0.75rem;color:#94a3b8;">${r.played > 0 ? `${r.gf}/${r.ga}` : "–"}</td>
      <td style="font-size:0.7rem;color:#64748b;">${(r.weight * 100).toFixed(0)}% results</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  return html;
};

// Total gameweeks in a season (FPL always runs 38 rounds).
VG.SEASON_GW_COUNT = 38;

// How many gameweeks remain from `gw` onwards (inclusive). Clamps horizons
// near the end of the season so a "12 GW" projection isn't requested when
// only 6 remain (those weeks don't exist — projections would silently be
// short or, pre-season, inflated by the nGWs multiplier fallback).
VG.remainingGWs = (gw) => Math.max(0, VG.SEASON_GW_COUNT - (gw || 1) + 1);

// Clamp a requested horizon to the GWs actually left in the season.
VG.clampHorizon = (nGWs, startGW) => Math.max(1, Math.min(nGWs || 1, VG.remainingGWs(startGW)));

// ── Recency factors (OpenFPL-style 1/3/5-match windows, v5.8) ────────────
// FPL Review's "Massive Data Model" and OpenFPL (arXiv 2508.09992, MIT)
// both find that *recent* output beats season aggregates: a 5-GW window that
// ends in October is a poor predictor of GW30 output. VG.loadRecentForm()
// (optional, daily-fetched from FPL's own element-summary) supplies per-round
// aggregates over the last 1/3/5 GWs. This helper reduces them to the shape
// the xP engine needs and confidence-scales the blend weight from the number
// of rounds actually on record. Returns null when there is nothing usable.
VG._recencyFactors = (p) => {
  const recent = p && p.recentForm;
  if (!recent) return null;
  const rounds = recent.n || recent.gws5 || 0;
  if (rounds < 2) return null; // 1 round is noise, not signal

  // Prefer the 1/3/5 windowed structure (v5.8 fetcher); fall back to the
  // legacy v5.7 starts5/gws5/mins5 fields for older data files.
  const s1 = recent.s1, s3 = recent.s3, s5 = recent.s5;
  const hasWindows = !!(s1 && s3 && s5);

  // Confidence scale 0.4..1.0: more recent rounds = stronger evidence.
  const wRounds = Math.min(rounds, 5) / 5;

  let startsRate, mins, xgi90, pts90;
  if (hasWindows) {
    // Availability: last-5 window, same semantics as the v5.7 rotation-risk
    // signal (starts ÷ games on record) so nothing regresses.
    startsRate = s5.mins > 0 ? s5.starts / 5 : 0;
    mins = s5.mins || s3.mins;
    // Output: use the last-3 window for a balance between noise (1 GW) and
    // staleness (5 GW), per the OpenFPL finding that 3-match windows carry
    // most of the predictive signal. Per-90 from FPL's own xGI/points.
    const mins3 = s3.mins || 90;
    xgi90 = mins >= 60 ? (s3.xgi || 0) * 90 / mins3 : 0;
    pts90 = mins >= 60 ? (s3.pts || 0) * 90 / mins3 : 0;
  } else {
    startsRate = recent.starts5 / Math.max(rounds, 1);
    mins = recent.mins5 || 0;
    xgi90 = 0; pts90 = 0; // legacy file carries no points, availability only
  }

  const weight = 0.30 + 0.20 * wRounds; // 0.38 (2 GWs) → 0.50 (5+ GWs)
  return { weight, rounds, startsRate, mins, xgi90, pts90 };
};

// ── xP Engine: enhanced with xG/xA, form trends, opponent defense ──────

// Match win/lose probabilities for a fixture. Prefers the free Understat
// forecast (covers every fixture, no API key), then The-Odds-API h2h odds
// (optional ODDS_API_KEY). Returns { win, lose, oppWin, source } or null so
// the xP engine never needs to know where probabilities came from.
VG._matchWinProbs = (teamId, oppTeamId) => {
  if (!teamId || !oppTeamId) return null;
  const thisTeam = VG.teams[teamId];
  const oppTeam = VG.teams[oppTeamId];
  if (!thisTeam || !oppTeam) return null;
  const tShort = thisTeam.short_name;
  const oShort = oppTeam.short_name;

  // 1. Understat forecast — free, per-fixture w/d/l probabilities.
  const us = VG.understat;
  if (us && Array.isArray(us.fixtures)) {
    let best = null;
    const nowMs = Date.now();
    us.fixtures.forEach(f => {
      const samePair = (f.home === tShort && f.away === oShort) ||
                       (f.away === tShort && f.home === oShort);
      if (!samePair || !f.forecast) return;
      const t = Date.parse(f.datetime);
      const dist = isNaN(t) ? Infinity : Math.abs(t - nowMs);
      if (!best || dist < best.dist) best = { f, dist };
    });
    if (best) {
      const w = parseFloat(best.f.forecast.w || 0);
      const d = parseFloat(best.f.forecast.d || 0);
      const l = parseFloat(best.f.forecast.l || 0);
      const total = w + d + l;
      if (total > 0) {
        const isHome = best.f.home === tShort;
        const win = (isHome ? w : l) / total;
        const lose = (isHome ? l : w) / total;
        return { win, lose, oppWin: (isHome ? l : w) / total, source: "understat" };
      }
    }
  }

  // 2. Bookmaker h2h odds (optional, requires ODDS_API_KEY)
  if (VG.oddsData && VG.oddsData.length > 0) {
    const matchOdds = VG.oddsData.find(o =>
      (o.home === tShort && o.away === oShort) ||
      (o.away === tShort && o.home === oShort)
    );
    if (matchOdds && matchOdds.h2h) {
      const h = matchOdds.h2h.home || 3.0;
      const d = matchOdds.h2h.draw || 3.0;
      const a = matchOdds.h2h.away || 3.0;
      const rawH = 1 / h, rawD = 1 / d, rawA = 1 / a;
      const total = rawH + rawD + rawA;
      const pH = rawH / total, pD = rawD / total, pA = rawA / total;
      const isThisHome = matchOdds.home === tShort;
      const win = isThisHome ? pH : pA;
      const lose = isThisHome ? pA : pH;
      return { win, lose, oppWin: isThisHome ? pA : pH, source: "bookmaker" };
    }
  }
  return null;
};

VG.computeFixtureXP = (pid, oppTeamId, isHome, fdr) => {
  const p = VG.players[pid];
  if (!p) return { xp: 0, mins: 0, cs: 0, goal: 0, assist: 0, bonus: 0 };

  // Transfer / new-club context (v5.13): a player who changed clubs this
  // summer carries last season's per-90 output, but their role, service and
  // attacking environment all moved with them. Detected from the prior-season
  // club code attached by applyHistoryPriors (free vaastav feed).
  const transfer = VG.transferInfo(p);

  const pos = p.element_type;
  const mins = parseInt(p.minutes || "0");
  const starts = parseInt(p.starts || "0");
  const goals = parseInt(p.goals_scored || "0");
  const assists = parseInt(p.assists || "0");
  const cleanSheets = parseInt(p.clean_sheets || "0");
  const saves = parseInt(p.saves || "0");
  const bonus = parseInt(p.bonus || "0");
  const yellows = parseInt(p.yellow_cards || "0");
  const reds = parseInt(p.red_cards || "0");
  const ownGoals = parseInt(p.own_goals || "0");
  const penMiss = parseInt(p.penalties_missed || "0");
  const ppg = parseFloat(p.points_per_game || "0");
  const form = parseFloat(p.form || "0");
  const bps = parseInt(p.bps || "0");

  // ICT components (position-specific for bonus prediction)
  const influence = parseFloat(p.influence || "0");
  const creativity = parseFloat(p.creativity || "0");
  const threat = parseFloat(p.threat || "0");

  // xG/xA from FPL API
  const xG = parseFloat(p.expected_goals || "0");
  const xA = parseFloat(p.expected_assists || "0");
  const xGI = parseFloat(p.expected_goal_involvements || "0");
  const xGC = parseFloat(p.expected_goals_conceded || "0");

  // Pre-computed per-90 rates from FPL (more accurate than manual calculation)
  const xGPer90API = parseFloat(p.expected_goals_per_90 || "0");
  const xAPer90API = parseFloat(p.expected_assists_per_90 || "0");
  const csPer90API = parseFloat(p.clean_sheets_per_90 || "0");
  const defConPer90 = parseFloat(p.defensive_contribution_per_90 || "0");

  // FPL's own expected points signals
  const epNext = parseFloat(p.ep_next || "0");
  const valueForm = parseFloat(p.value_form || "0");

  // Minutes probability — start-rate model using last season data
  const seasonGames = 38;
  const gamesPlayed = starts || Math.max(1, Math.ceil(mins / 80));

  // Start rate: how often the player started when available
  // GKs almost always start when in squad; outfield players vary more
  let startRate;
  if (pos === 1) {
    // GK: starts are more binary — either #1 or backup
    startRate = starts >= 30 ? 0.95 : starts >= 15 ? 0.75 : starts >= 5 ? 0.40 : 0.15;
  } else {
    // Outfield: use actual start rate with floor for small samples
    const effectiveGames = Math.max(gamesPlayed, 5);
    startRate = Math.min(1.0, starts / Math.max(effectiveGames, 1));
  }

  // Recency blend: a season-total start rate can't tell "nailed on for the
  // last 5 GWs" apart from "started well in September, benched since" — both
  // can carry the same season aggregate. VG.loadRecentForm() (optional,
  // github-actions-fetched, absent pre-season) supplies per-round windows;
  // blend the recent starts rate in with a weight that scales with how many
  // recent GWs are actually on record (2 of 5 is weaker evidence than 5 of 5).
  const recency = VG._recencyFactors(p);
  if (recency) {
    const recentRate = recency.startsRate;
    const recentWeight = recency.weight;
    startRate = recentRate * recentWeight + startRate * (1 - recentWeight);
  }

  // Blend start rate with avg minutes per start (substitution pattern)
  // High start rate + high avg mins = nailed starter
  // High start rate + low avg mins = early sub risk
  const minsPerStart = starts > 0 ? mins / starts : 0;
  const subRisk = minsPerStart < 60 ? 0.12 : minsPerStart < 75 ? 0.06 : 0;
  let minsProb = startRate * (1 - subRisk);

  // Floor for players with data, fallback for no data
  if (mins < 90 || starts === 0) {
    minsProb = Math.max(minsProb, 0.30);
  }
  minsProb = Math.max(0.15, Math.min(0.97, minsProb));

  // Confidence adjustment: low sample = regress toward league average.
  // Three-phase early-season model (FPL Prophet pattern): GW1-3 are heavily
  // prior-reliant (ep_next, season averages); GW4-5 is hybrid; GW6+ is full
  // in-season.  This prevents a single lucky/unlucky GW1 from dominating.
  const gw = VG._projGW || 1;
  let dataConfidence = Math.min(1.0, gamesPlayed / Math.max(seasonGames * 0.5, 10));
  if (gw <= 3) dataConfidence = Math.min(dataConfidence, 0.30);
  else if (gw <= 5) dataConfidence = Math.min(dataConfidence, 0.55);
  const confidenceMult = 0.5 + 0.5 * dataConfidence;
  const leagueAvgMinsProb = 0.72; // ~72% of starters play 60+ mins
  minsProb = minsProb * confidenceMult + leagueAvgMinsProb * (1 - confidenceMult);
  const chance = p.chance_of_playing_next_round;
  const availability = chance !== null && chance !== undefined
    ? Math.max(0, Math.min(1, Number(chance) / 100))
    : p.status === "d" ? 0.75 : 1;
  minsProb *= availability;

  // ── European rotation / fixture congestion penalty (v5.14) ──
  // Midweek European fixtures (CL/EL/ECL) reduce start probability. Detected
  // from short PL fixture gaps (<5 days), which signal midweek congestion.
  minsProb *= VG.congestionMultiplier(VG.allFixtures, p.team, VG._projGW || 1);

  // ── Per-90 rates: prefer FPL pre-computed per-90, fall back to manual ──
  const nineties = mins > 0 ? mins / 90 : 1;
  const xGPer90 = xGPer90API > 0 ? xGPer90API : xG / Math.max(nineties, 0.1);
  const xAPer90 = xAPer90API > 0 ? xAPer90API : xA / Math.max(nineties, 0.1);
  const goalsPer90 = goals / nineties;
  const assistsPer90 = assists / nineties;

  // Understat real xG/xA prior (last completed season, or current season in
  // season), attached to the element by loadUnderstat. Independent xG source.
  const usP = p.understat;
  const realXGPer90 = usP && usP.time > 0 ? (usP.xG || 0) * 90 / usP.time : 0;
  const realXAPer90 = usP && usP.time > 0 ? (usP.xA || 0) * 90 / usP.time : 0;

  // Blend: 60% FPL xG/xA + 40% actual; swap in the Understat prior when present
  let projGoalsPer90Raw, projAssistsPer90Raw;
  if (realXGPer90 > 0 || realXAPer90 > 0) {
    projGoalsPer90Raw = 0.45 * xGPer90 + 0.35 * realXGPer90 + 0.20 * goalsPer90;
    projAssistsPer90Raw = 0.45 * xAPer90 + 0.35 * realXAPer90 + 0.20 * assistsPer90;
  } else {
    projGoalsPer90Raw = 0.6 * xGPer90 + 0.4 * goalsPer90;
    projAssistsPer90Raw = 0.6 * xAPer90 + 0.4 * assistsPer90;
  }

  // ── Recency-weighted output blend (v5.8, OpenFPL/FPL Review pattern) ──
  // Season aggregates can't tell "8 goals in the last 3 GWs" from "8 goals
  // by November". When per-round history is available, nudge the per-90
  // projection toward the player's last-3-GW xGI rate — a strong predictor
  // of near-term output — clamped to avoid letting one hot window dominate.
  // Weight is confidence-scaled by rounds on record via _recencyFactors.
  if (recency && recency.xgi90 > 0 && (projGoalsPer90Raw + projAssistsPer90Raw) > 0.05) {
    const seasonXGI90 = projGoalsPer90Raw + projAssistsPer90Raw;
    const ratio = Math.min(Math.max(recency.xgi90 / seasonXGI90, 0.70), 1.40);
    const nudge = 1 + (ratio - 1) * recency.weight;
    projGoalsPer90Raw *= nudge;
    projAssistsPer90Raw *= nudge;
  }

  const csRate = cleanSheets / Math.max(gamesPlayed, 1);
  const savesPerGame = saves / Math.max(gamesPlayed, 1);
  const bonusPerGame = bonus / Math.max(gamesPlayed, 1);
  const yellowsPerGame = yellows / Math.max(gamesPlayed, 1);
  const redsPerGame = reds / Math.max(gamesPlayed, 1);
  const ownGoalsPerGame = ownGoals / Math.max(gamesPlayed, 1);
  const penMissPerGame = penMiss / Math.max(gamesPlayed, 1);
  const bpsPerGame = bps / Math.max(gamesPlayed, 1);

  // ── Enhanced form: exponential weighting to amplify hot/cold streaks ──
  const formVsPPG = ppg > 0 ? form / ppg : 1.0;
  const epNextSignal = epNext > 0 && ppg > 0 ? Math.min(epNext / ppg, 1.5) : 1.0;
  const valueFormBoost = valueForm > 0 ? Math.min(1.0 + valueForm * 0.02, 1.15) : 1.0;
  // Exponential form: hot streaks (form/ppg > 1) amplified, cold streaks penalized more
  const expForm = formVsPPG > 1.0 ? Math.pow(formVsPPG, 1.3) : Math.pow(formVsPPG, 0.7);
  // Three-phase form blend: early-season leans on FPL's own ep_next (which
  // already bakes in fixtures, ICT and form).  Once 5+ GWs of data exist,
  // revert to the standard 60/25/15 split.
  const epWeight = gw <= 3 ? 0.45 : gw <= 5 ? 0.35 : 0.25;
  const formWeight = gw <= 3 ? 0.40 : gw <= 5 ? 0.50 : 0.60;
  const vfWeight = 1.0 - epWeight - formWeight;
  const rawTrend = formWeight * expForm + epWeight * epNextSignal + vfWeight * valueFormBoost;
  const trendMult = Math.min(Math.max(0.80 + 0.20 * rawTrend, 0.70), 1.30);

  // ── Fixture difficulty multipliers ──
  const fdrMult = { 1: 1.35, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.65 };
  const attMult = fdrMult[fdr] || 1.0;
  const defMult = fdrMult[6 - (fdr || 3)] || 1.0;

  // ── Odds adjustment: free Understat forecast, else bookmaker h2h ──
  let oddsAttMult = 1.0;
  let oddsDefMult = 1.0;
  let oddsCSMult = 1.0;
  const probs = VG._matchWinProbs(p.team, oppTeamId);
  if (probs) {
    // Attack boost: favorite gets up to 1.15x, underdog gets 0.88x
    oddsAttMult = 0.88 + 0.27 * probs.win;
    // Defense penalty: underdog concedes more
    oddsDefMult = 0.88 + 0.27 * probs.lose;
    // Clean sheet: lower if high-scoring game expected (both teams dangerous)
    const bothDangerous = (probs.win > 0.40 && probs.oppWin > 0.30) ||
                          (probs.oppWin > 0.40 && probs.win > 0.30);
    oddsCSMult = bothDangerous ? 0.85 : (probs.win > 0.55 ? 1.10 : 1.0);
    // Clamp all
    oddsAttMult = Math.max(0.80, Math.min(1.20, oddsAttMult));
    oddsDefMult = Math.max(0.80, Math.min(1.20, oddsDefMult));
    oddsCSMult = Math.max(0.75, Math.min(1.15, oddsCSMult));
  }

  // ── Position-specific team strength (attack vs defence, not just overall) ──
  const teamId = p.team;
  const team = VG.teams[teamId];
  const opp = VG.teams[oppTeamId];
  let attStrMult = 1.0;
  let defStrMult = 1.0;
  let oppDefStr = 1.0;
  let oppAttStr = 1.0;
  if (team && opp) {
    // Attacking: team's attack vs opponent's defence
    const teamAtt = isHome ? team.strength_attack_home : team.strength_attack_away;
    const oppDef = isHome ? opp.strength_defence_away : opp.strength_defence_home;
    attStrMult = Math.min(Math.max(0.80 + 0.15 * ((teamAtt - oppDef) / 100), 0.65), 1.35);

    // Defensive: team's defence vs opponent's attack
    const teamDef = isHome ? team.strength_defence_home : team.strength_defence_away;
    const oppAtt = isHome ? opp.strength_attack_away : opp.strength_attack_home;
    defStrMult = Math.min(Math.max(0.80 + 0.15 * ((teamDef - oppAtt) / 100), 0.65), 1.35);

    // Opponent defensive strength (for clean sheets / goals conceded)
    const oppDefAvg = (opp.strength_defence_home + opp.strength_defence_away) / 2;
    oppDefStr = Math.min(Math.max(0.70 + 0.30 * ((oppDefAvg - 1000) / 200), 0.5), 1.3);

    // Opponent attacking strength (for clean sheet penalty)
    const oppAttAvg = (opp.strength_attack_home + opp.strength_attack_away) / 2;
    oppAttStr = Math.min(Math.max(0.70 + 0.30 * ((oppAttAvg - 1000) / 200), 0.5), 1.3);
  }

  // ── New-club attacking context (v5.13) ──
  // A transferred player's per-90 output was produced at their OLD club. When
  // the new club attacks significantly stronger (weaker) than the old one,
  // nudge the projection toward the new environment. Uses the same 1000-scale
  // attack strength the engine already trusts; a +170 swing ≈ +10% output.
  // Falls back to the league average (1000) when the old club is no longer in
  // the league (relegated) or the prior club is unknown (foreign signing).
  let newClubMult = 1.0;
  if (transfer.transferred) {
    const avgAtt = (t) => t
      ? ((Number(t.strength_attack_home) || 0) + (Number(t.strength_attack_away) || 0)) / 2
      : 1000;
    const newAtt = avgAtt(team);
    const oldAtt = transfer.fromTeam ? avgAtt(VG.teams[transfer.fromTeam.id]) : 1000;
    if (newAtt > 0 && oldAtt > 0) {
      newClubMult = Math.min(Math.max(1 + (newAtt - oldAtt) / 1700, 0.80), 1.20);
    }
  }

  // ── Projected rates ──
  // Transferred players get the new-club context multiplier plus a small
  // confidence dampen: last season's per-90 rates were earned in a different
  // system/role, so they are a weaker signal for the new environment.
  const transferConf = transfer.transferred ? 0.92 : 1.0;
  const projGoalsPer90 = projGoalsPer90Raw * attMult * attStrMult * trendMult * confidenceMult * newClubMult * transferConf + 0.05 * (1 - confidenceMult);
  const projAssistsPer90 = projAssistsPer90Raw * attMult * attStrMult * trendMult * confidenceMult * newClubMult * transferConf + 0.03 * (1 - confidenceMult);

  // ── Clean sheet: use opponent defence strength + API cs_per_90 + xGC ──
  const baseCSPos = { 1: 0.35, 2: 0.30, 3: 0.08, 4: 0 };
  const baseCS = (baseCSPos[pos] || 0) * defMult * defStrMult;
  const xGCPerGame = xGC / Math.max(gamesPlayed, 1);
  const xGCImpact = Math.max(0.5, 1.0 - xGCPerGame * 0.05);
  const csRatePer90 = csPer90API > 0 ? csPer90API : csRate;
  // Apply opponent defensive weakness: weak defence = easier clean sheet
  // Apply opponent attacking strength: strong attack = harder clean sheet
  const oppDefFactor = (oppDefStr + (1.6 - oppAttStr)) / 2;
  const projCS = Math.min(Math.max(
    baseCS * confidenceMult * xGCImpact * oppDefFactor * oddsCSMult
    + csRatePer90 * confidenceMult * defMult * oppDefFactor * oddsCSMult,
    0), 0.70);

  // ── Goal / assist probability ──
  const homeBoost = pos === 2 ? 1.18 : pos === 1 ? 1.12 : 1.15;
  const sp = VG.setPieceRole(pid);
  // Set-piece premium (v5.5, FFHUB/FFS idea): penalty takers get a real goal
  // bump (clean shot on goal), FK/corner takers a smaller assist bump.
  const penBoost = sp && sp.pen ? 1.28 : 1.0;
  const spAssistBoost = sp && (sp.fk || sp.cor) ? 1.15 : 1.0;
  const projGoals = Math.min(projGoalsPer90 * (isHome ? homeBoost : 1.0) * oddsAttMult * penBoost, 0.85);
  const projAssists = Math.min(projAssistsPer90 * (isHome ? homeBoost : 1.0) * oddsAttMult * spAssistBoost, 0.85);

  // ── Bonus: use BPS (strongest predictor) + position-specific ICT + xGI ──
  const bpsPerGameNorm = bpsPerGame / 40;
  const influencePerGame = influence / Math.max(gamesPlayed, 1);
  const creativityPerGame = creativity / Math.max(gamesPlayed, 1);
  const threatPerGame = threat / Math.max(gamesPlayed, 1);
  let ictBonus = 0;
  if (pos === 1 || pos === 2) {
    ictBonus = Math.min(influencePerGame / 30, 0.3);
  } else if (pos === 3 || pos === 4) {
    ictBonus = Math.min((influencePerGame + creativityPerGame) / 60, 0.3);
  } else {
    ictBonus = Math.min((threatPerGame + creativityPerGame) / 60, 0.3);
  }
  const xGIPerGame = xGI / Math.max(gamesPlayed, 1);
  const xgiBonus = Math.min(xGIPerGame / 0.7, 0.3);
  const bonusBase = bonusPerGame * confidenceMult;
  const projBonus = Math.min(bonusBase + bpsPerGameNorm * 0.5 + ictBonus + xgiBonus + (pos === 3 || pos === 4 ? 0.10 : 0.05), 0.70);

  // ── FPL scoring ──
  const GOAL_PTS = { 1: 6, 2: 6, 3: 5, 4: 4 };
  const ASSIST_PTS = 3;
  const CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
  const APPEARANCE_PTS = 2;

  // ── DEFCON: probability of reaching FPL's match-level threshold ──
  let defconXP = 0;
  if (pos === 2) {
    if (defConPer90 > 0) {
      defconXP = 2 * VG.poissonAtLeast(defConPer90 * minsProb, 10);
    } else {
      defconXP = 0;
    }
  } else if (pos === 3) {
    if (defConPer90 > 0) {
      defconXP = 2 * VG.poissonAtLeast(defConPer90 * minsProb, 12);
    } else {
      defconXP = 0;
    }
  }

  // ── xP calculation per fixture ──
  const xpAppearance = minsProb * APPEARANCE_PTS;
  const xpCS = projCS * (CS_PTS[pos] || 0);
  const xpGoals = projGoals * (GOAL_PTS[pos] || 4);
  const xpAssists = projAssists * ASSIST_PTS;
  const xpBonus = projBonus * 1.5;
  const xpSaves = pos === 1 ? Math.min(savesPerGame / 3, 1.0) * 3 * defMult * confidenceMult : 0;
  const xpDEFCON = defconXP * 2;
  const xpNegative = minsProb * (yellowsPerGame * 1 + redsPerGame * 3 + ownGoalsPerGame * 2 + penMissPerGame * 2);

  const modelXP = xpAppearance + xpCS + xpGoals + xpAssists + xpBonus + xpSaves + xpDEFCON - xpNegative;
  // New-to-Premier-League players (new signings / promoted-team squads) have
  // no FPL history to regress toward. Detection: zero PL minutes/starts and
  // no xG/xA on record. FPL still supplies an ep_next prior, and Understat
  // may carry their previous-league xG/xA — both are legitimately stronger
  // signals for a debutant than a season-aggregate model can produce.
  const noPremierLeagueHistory = mins === 0 && starts === 0 && xG === 0 && xA === 0;
  let totalXP = modelXP;
  let newSigningPrior = 0;
  if (noPremierLeagueHistory) {
    // Weight FPL's ep_next heavily (it already encodes their expected role),
    // blended with our own model estimate. Understat previous-league priors
    // have already flowed in via projGoalsPer90Raw when present, so the model
    // half is not a blind guess for foreign signings.
    const epPrior = epNext > 0 ? epNext : 0;
    newSigningPrior = epPrior;
    if (epPrior > 0) {
      totalXP = 0.5 * modelXP + 0.5 * epPrior;
    } else if (realXGPer90 > 0 || realXAPer90 > 0) {
      // Understat-only prior: keep the model but flag the lower confidence.
      totalXP = modelXP;
    }
  }
  const totalXPFinal = Math.max(totalXP, 0.1);

  return {
    xp: totalXPFinal,
    // Expected minutes for this fixture (FPL Review xMins idea): minsProb is
    // the P(play 60+) — the cleanest single availability signal to surface.
    xMins: +((minsProb * 90) || 0).toFixed(1),
    minsProb,
    isNew: noPremierLeagueHistory,
    priorSignal: noPremierLeagueHistory ? (newSigningPrior > 0 ? "ep_next" : "understat") : "",
    // v5.13: transfer / new-club context for this fixture. A transferred player
    // is flagged so the UI can label them (NEW CLUB badge) and so multi-GW
    // aggregation can report the move. foreignLeague carries the source league
    // of an understat prior when it is NOT the EPL (foreign signing).
    transferred: transfer.transferred,
    fromTeam: transfer.fromTeam ? transfer.fromTeam.short_name : null,
    toTeam: transfer.toTeam ? transfer.toTeam.short_name : null,
    foreignLeague: transfer.foreignLeague,
    csProb: projCS,
    goalProb: projGoals,
    assistProb: projAssists,
    bonusProb: projBonus,
    defconProb: defconXP,
    fdr,
    xpComponents: {
      xpAppearance: +xpAppearance.toFixed(4),
      xpCS: +xpCS.toFixed(4),
      xpGoals: +xpGoals.toFixed(4),
      xpAssists: +xpAssists.toFixed(4),
      xpBonus: +xpBonus.toFixed(4),
      xpSaves: +xpSaves.toFixed(4),
      xpDEFCON: +xpDEFCON.toFixed(4),
      xpNegative: +xpNegative.toFixed(4)
    }
  };
};

// xG regression flag: Understat xG vs actual FPL goals (borrowed from FPL
// Ratings' DUE/OVER and FFHUB's expected-vs-actual). Goals running ahead of
// chances (diff >= +0.2/90) = "over" (likely to regress); goals lagging
// chances (diff <= -0.2/90) = "due" (regression should push goals up).
VG.getRegressionFlag = (pid) => {
  const p = VG.players[pid];
  if (!p || !p.understat || !(p.understat.time > 0)) return null;
  const xG90 = (p.understat.xG || 0) * 90 / p.understat.time;
  const mins = parseInt(p.minutes || "0");
  const goals90 = mins > 0 ? (parseInt(p.goals_scored || "0") * 90) / mins : 0;
  const diff = goals90 - xG90;
  const flag = diff >= 0.2 ? "over" : diff <= -0.2 ? "due" : "stable";
  return { flag, diff90: +diff.toFixed(2), xG90: +xG90.toFixed(2), goals90: +goals90.toFixed(2) };
};

// HTML badge for a regression flag: green DUE (goals should come) / red OVER
// (running hot, likely to regress) / grey stable. null/stable → empty string.
VG.regressionBadge = (reg) => {
  if (!reg || reg.flag === "stable") return "";
  const d = reg.diff90.toFixed(2);
  const prefix = d.startsWith("-") ? "" : "+";
  if (reg.flag === "due") return `<span style="background:rgba(0,255,135,0.12);color:#00ff87;padding:1px 6px;border-radius:4px;font-size:0.65rem;white-space:nowrap;">DUE ${prefix}${d}</span>`;
  return `<span style="background:rgba(239,68,68,0.12);color:#ef4444;padding:1px 6px;border-radius:4px;font-size:0.65rem;white-space:nowrap;">OVER ${prefix}${d}</span>`;
};

// ── Set-piece xP boost (v5.5) ─────────────────────────────────────────
// Idea borrowed from FFHUB "Set Piece Takers" / FFS. Penalty/FK/corner
// takers carry extra goal/assist upside. Dataset ships as data/setpieces.json
// (seasonal — update each year; a player not listed gets no boost).
VG.setPieces = { teams: {} };
VG.loadSetPieces = (sp) => {
  if (!sp || !sp.teams) return;
  VG.setPieces = { teams: sp.teams || {} };
};
// Returns {pen, fk, cor} booleans for a player id. Defensive: unknown → none.
VG.setPieceRole = (pid) => {
  const p = VG.players[pid];
  if (!p) return { pen: false, fk: false, cor: false };
  const team = VG.setPieces.teams[(VG.teams[p.team] || {}).short_name || ""];
  if (!team) return { pen: false, fk: false, cor: false };
  const nm = String(VG.playerName(p) || "").trim().toLowerCase();
  const hit = arr => (arr || []).some(n => String(n).trim().toLowerCase() === nm);
  return { pen: hit(team.pen), fk: hit(team.fk), cor: hit(team.cor) };
};

// Compact "P/F/C" badge string for a set-piece role object (empty when none).
VG.setPieceBadge = (sp) => {
  if (!sp) return "";
  return [sp.pen && "P", sp.fk && "F", sp.cor && "C"].filter(Boolean).join(" ");
};

// Effective Ownership (v5.5) — ownership weighted by how "captain-popular" a
// player is. Real EO (FFix/FPL Review) = ownership + captain-share because a
// captained player's points count double. The free FPL API gives no global
// captain-share feed, so we estimate captain-share from xP prominence: the
// top-xP captain candidates in a position attract a modelled share. This
// surfaces TEMPLATE (high EO) vs DIFFERENTIAL (low EO) far better than raw
// ownership alone.
VG.computeEffectiveOwnership = (allXP) => {
  // Rank every player by totalXP within their position to model captain appeal.
  const capPool = allXP.filter(p => p.positionId !== 1).slice().sort((a, b) => b.totalXP - a.totalXP);
  const capScores = {};
  capPool.forEach((p, i) => {
    if (i >= 20) return; // beyond top-20 captains the modelled share -> ~0
    // Rough captain-share curve: ~6% for the very top pick, decaying fast.
    capScores[p.id] = Math.max(0, 0.06 - i * 0.0028);
  });
  return {
    pool: capPool.slice(0, 12),
    forPlayer(p) {
      const own = p.ownership || 0;
      const cap = capScores[p.id] || 0;
      const eo = own * (1 + cap);
      return { eo: +eo.toFixed(1), own, capShare: +(cap * 100).toFixed(1) };
    }
  };
};

// ── Market tags: Buy / Hold / Sell (v5.8) ─────────────────────────────
// Idea borrowed from FFix's buy/hold/sell and FPL Review's momentum flags.
// Combines the recency signals (1/3/5-GW xGI + starts, from _recencyFactors),
// xG regression (DUE/OVER), ownership and value to label what to do with a
// player. Pure function of the allXP info object — easy to unit-test.
VG.getMarketTag = (p) => {
  if (!p) return { tag: "hold", reason: "-", tone: "gray" };
  const rec = p.recency;
  const reg = p.regression;
  const own = p.ownership || 0;
  const value = p.xpPerPrice || 0;

  // Sell: cooling output (recent xGI well below season) OR over-performing
  // (xG regression OVER) AND not a steal at the price.
  if (rec && rec.xgi90 > 0 && p.totalXP > 0) {
    // Estimate season xGI/90 from the same blend the engine uses.
    const seasonXGI = (p.xG + p.xA || p.xGI) || 0.5;
    const cold = rec.xgi90 < seasonXGI * 0.75;
    const hot = rec.xgi90 > seasonXGI * 1.25;
    if (cold && own >= 10) return { tag: "sell", reason: "recent xGI below season rate, output cooling", tone: "red" };
    if (cold && value < 0.5) return { tag: "sell", reason: "cooling output + weak xP/£m", tone: "red" };
    if (hot && value > 0.8) return { tag: "buy", reason: "recency boost + strong value", tone: "green" };
  }
  if (reg && reg.flag === "over" && own >= 15 && value < 0.6) {
    return { tag: "sell", reason: "xG running hot, regression likely, expensive", tone: "red" };
  }
  if (reg && reg.flag === "due" && value > 0.7) {
    return { tag: "buy", reason: "xG due, goals lagging chances, cheap", tone: "green" };
  }
  if (p.isNew && p.priorSignal === "ep_next" && value > 0.8) {
    return { tag: "buy", reason: "new to PL with a strong FPL prior", tone: "green" };
  }
  if (value > 0.85 && own < 20) {
    return { tag: "buy", reason: "high xP/£m with low ownership", tone: "green" };
  }
  if (value < 0.35 && own >= 5) {
    return { tag: "sell", reason: "poor xP/£m for the price", tone: "red" };
  }
  return { tag: "hold", reason: "steady projection", tone: "gray" };
};

// HTML badge for a market tag (empty when hold — clean UI).
VG.marketBadge = (tag) => {
  if (!tag || tag.tag === "hold") return "";
  const bg = tag.tone === "green" ? "rgba(0,255,135,0.12)" : "rgba(239,68,68,0.12)";
  const fg = tag.tone === "green" ? "#00ff87" : "#ef4444";
  const label = tag.tag === "buy" ? "BUY" : "SELL";
  return `<span title="${VG.esc(tag.reason)}" style="background:${bg};color:${fg};padding:1px 6px;border-radius:4px;font-size:0.65rem;white-space:nowrap;font-weight:600;">${label}</span>`;
};

// ── Watchlist (v5.8, FFix/FPL Review idea) ────────────────────────────
// localStorage-backed list of player IDs the user is monitoring. Never
// touches the network; the toggle is used by delegated UI handlers in the
// Compare/Differentials tables and the Strategy-tab watchlist panel.
VG.watchlist = () => {
  if (!VG._watchlist) {
    try { VG._watchlist = JSON.parse(localStorage.getItem("vg_watchlist") || "[]"); }
    catch (e) { VG._watchlist = []; }
  }
  return VG._watchlist;
};
VG.toggleWatch = (pid) => {
  const list = VG.watchlist();
  const i = list.indexOf(pid);
  if (i >= 0) list.splice(i, 1); else list.push(pid);
  VG._watchlist = list;
  try { localStorage.setItem("vg_watchlist", JSON.stringify(list)); } catch (e) {}
  return list;
};
VG.isWatched = (pid) => VG.watchlist().indexOf(pid) >= 0;
// Small "☆ / ★" toggle button for table rows.
VG.watchToggle = (p) => {
  const w = VG.isWatched(p.id);
  const label = w ? '★' : '☆';
  const color = w ? '#fbbf24' : '#475569';
  return `<span data-action="watch-toggle" data-player-id="${p.id}" title="${w ? 'Remove from watchlist' : 'Add to watchlist'}" style="cursor:pointer;color:${color};font-size:0.9rem;">${label}</span>`;
};

// ── Monte Carlo Gameweek distribution (v5.5) ──────────────────────────
// Idea borrowed from FPL Review / FFix solver. Instead of a single xP number,
// sample each starter's actual points from a Poisson distribution centred on
// their per-GW projection (captain doubled), sum, and repeat to build a real
// GW-points distribution with ceiling/floor and a green-arrow probability.
// Small iterations by default — cheap on the main thread.
VG.mcPoisson = (lambda) => {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
};
VG.perGWProjection = (p, fixtures, gw) => {
  if (!p || !fixtures) return p && p.gwXP ? p.gwXP : (p ? p.totalXP : 0);
  const proj = VG.computePlayerGWProjection(p, gw, fixtures);
  return proj ? (proj.gwXP || 0) : 0;
};
// Per-player expected-goals-equivalent (lambda) for a starting XI, captain
// multiplier applied. Shared by VG.mcGWDistribution (single-squad variance)
// and VG.simulateLeagueRace (cross-squad race simulation) so both draw from
// the exact same model.
VG._mcLambdas = (starting, fixtures, gw) => {
  const starters = (starting || []).filter(s => s && (s.positionId || s.element_type));
  return starters.map(s => {
    const lam = VG.perGWProjection(s, fixtures, gw) || 0;
    const mult = s.isCaptain ? Math.max(s.multiplier || 1, 2) : (s.multiplier || 1);
    return lam * mult;
  });
};
// One random total-points draw for a starting XI, given precomputed lambdas.
VG._mcDrawTotal = (lambdas) => {
  let t = 0;
  for (const lam of lambdas) t += VG.mcPoisson(lam);
  return t;
};
// Returns distribution over a starting XI for a GW.
// `starting` entries carry {id, positionId, isCaptain, multiplier, teamId}.
VG.mcGWDistribution = (starting, fixtures, gw, iterations) => {
  iterations = iterations || 3000;
  const starters = (starting || []).filter(s => s && (s.positionId || s.element_type));
  if (starters.length === 0) return { mean: 0, sd: 0, p10: 0, p90: 0, median: 0, samples: [], n: 0 };
  const lambdas = VG._mcLambdas(starting, fixtures, gw);
  const samples = [];
  for (let it = 0; it < iterations; it++) {
    let t = 0;
    for (const lam of lambdas) t += VG.mcPoisson(lam);
    samples.push(t);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((s, x) => s + (x - mean) * (x - mean), 0) / samples.length);
  const at = f => samples[Math.max(0, Math.min(samples.length - 1, Math.floor(f * samples.length)))];
  return { mean: +mean.toFixed(1), sd: +sd.toFixed(1), p10: at(0.10), p90: at(0.90), median: at(0.5), samples, n: iterations };
};
VG.greenArrowProb = (dist, target) => {
  if (!dist || !dist.samples || !dist.samples.length) return 0;
  let over = 0;
  for (const x of dist.samples) if (x >= target) over++;
  return +((over / dist.samples.length) * 100).toFixed(1);
};
// Worst/best/first-choice check used by MC badge.
VG.mcRange = (dist) => ({
  floor: dist.p10,
  ceiling: dist.p90,
  band: +(dist.p90 - dist.p10).toFixed(1)
});

// ── Mini-League Race Simulator (v5.7) ──────────────────────────────────
// Idea borrowed from FPL Pulse's league race probability feature, built
// entirely on data VG.analyzeLeague already fetches (no extra API calls).
// For every squad (the fetched top-N of a classic league), draws this GW's
// score via the same Poisson model as VG.mcGWDistribution, adds it to their
// season total-to-date, and ranks across iterations to estimate P(finish
// top of the league this GW) and P(top 3). Squads are simulated
// independently — correlation between rivals sharing the same player is not
// modelled, a standard first-order approximation for this kind of tool.
VG.simulateLeagueRace = (squads, fixtures, gw, iterations) => {
  iterations = iterations || 1500;
  const valid = (squads || []).filter(sq => sq.picks && sq.picks.length > 0);
  if (valid.length < 2) return null;

  const entrants = valid.map(sq => {
    const starting = sq.picks.filter(p => p.multiplier >= 1);
    return { entry: sq.entry, name: sq.teamName, priorTotal: sq.totalPoints, lambdas: VG._mcLambdas(starting, fixtures, gw) };
  });

  const wins = {}, top3 = {}, gwScores = {};
  entrants.forEach(e => { wins[e.entry] = 0; top3[e.entry] = 0; gwScores[e.entry] = []; });

  for (let it = 0; it < iterations; it++) {
    const draw = entrants.map(e => {
      const gwScore = VG._mcDrawTotal(e.lambdas);
      gwScores[e.entry].push(gwScore);
      return { entry: e.entry, total: e.priorTotal + gwScore };
    });
    draw.sort((a, b) => b.total - a.total);
    wins[draw[0].entry]++;
    draw.slice(0, Math.min(3, draw.length)).forEach(d => top3[d.entry]++);
  }

  return entrants.map(e => {
    const scores = gwScores[e.entry].slice().sort((a, b) => a - b);
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    const at = f => scores[Math.max(0, Math.min(scores.length - 1, Math.floor(f * scores.length)))];
    return {
      entry: e.entry, name: e.name, priorTotal: e.priorTotal,
      gwMean: +mean.toFixed(1), gwFloor: at(0.1), gwCeiling: at(0.9),
      winProb: +((wins[e.entry] / iterations) * 100).toFixed(1),
      top3Prob: +((top3[e.entry] / iterations) * 100).toFixed(1)
    };
  }).sort((a, b) => b.winProb - a.winProb);
};

// ── What-If race scenarios (v5.8) ─────────────────────────────────────
// Idea borrowed from FFix's "what if" transfer explorer. Given the league
// squads already fetched, clone "your" squad, apply a hypothetical change
// (bring a player in, drop one out, or switch the captain), then re-run the
// Monte Carlo race against the same rivals. Rival scores are drawn ONCE and
// reused for both baseline and scenario — only your own squad's draw changes
// — so the resulting win-probability delta is attributable to the change
// alone, not simulation noise. Returns { baseline, scenario } shaped like
// simulateLeagueRace rows, or null when there's nothing to simulate.
VG.simulateRaceScenario = (squads, fixtures, gw, iterations, scenario) => {
  if (!scenario) return null;
  const myEntry = VG.currentTeamId;
  if (!myEntry) return null;
  iterations = iterations || 1500;

  const valid = (squads || []).filter(sq => sq.picks && sq.picks.length > 0);
  if (valid.length < 2) return null;
  const mine = valid.find(sq => sq.entry === myEntry);
  if (!mine) return null;

  // Clone the fetched squads so we never mutate analyzeLeague's data.
  const modified = valid.map(sq => ({
    entry: sq.entry, teamName: sq.teamName, totalPoints: sq.totalPoints,
    picks: (sq.picks || []).map(p => ({ ...p }))
  }));
  const mineMod = modified.find(sq => sq.entry === myEntry);

  const allXP = VG.allXP || [];
  const byId = {};
  allXP.forEach(p => { byId[p.id] = p; });

  // 1. Captain change: pick a different captain from the same squad.
  if (scenario.captainId) {
    const newCap = mineMod.picks.find(p => (p.id === scenario.captainId) || (p.element === scenario.captainId));
    if (newCap) {
      mineMod.picks.forEach(p => { p.isCaptain = false; p.multiplier = 1; });
      newCap.isCaptain = true;
      newCap.multiplier = 2;
    }
  }

  // 2. Transfer in: add `scenario.addId`, optionally dropping `scenario.dropId`
  //    (default: the squad's lowest-xP player in the same position, else the
  //    lowest-xP non-GK starter). Replacement keeps squad size constant so the
  //    shared-draw comparison stays apples-to-apples.
  if (scenario.addId) {
    const present = mineMod.picks.some(p => (p.id === scenario.addId) || (p.element === scenario.addId));
    if (!present) {
      const addXP = byId[scenario.addId];
      if (addXP) {
        const added = { ...addXP, element: addXP.id, isCaptain: false, multiplier: 1 };
        let dropIdx = -1;
        if (scenario.dropId) {
          dropIdx = mineMod.picks.findIndex(p => (p.id === scenario.dropId) || (p.element === scenario.dropId));
        }
        if (dropIdx < 0) {
          const candidates = mineMod.picks
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => (p.positionId || 0) === added.positionId)
            .sort((a, b) => (byId[a.p.id]?.totalXP || 0) - (byId[b.p.id]?.totalXP || 0));
          if (candidates.length) dropIdx = candidates[0].i;
          else {
            const fallback = mineMod.picks
              .map((p, i) => ({ p, i }))
              .filter(({ p }) => (p.positionId || 0) !== 1 && p.multiplier >= 1)
              .sort((a, b) => (byId[a.p.id]?.totalXP || 0) - (byId[b.p.id]?.totalXP || 0));
            if (fallback.length) dropIdx = fallback[0].i;
          }
        }
        if (dropIdx >= 0) mineMod.picks.splice(dropIdx, 1);
        mineMod.picks.push(added);
      }
    }
  }

  // Precompute lambdas for every entrant, baseline and scenario.
  const prep = sq => ({
    entry: sq.entry, name: sq.teamName, priorTotal: sq.totalPoints,
    lambdas: VG._mcLambdas(sq.picks.filter(p => p.multiplier >= 1), fixtures, gw)
  });
  const baseEntrants = valid.map(prep);
  const scenEntrants = modified.map(prep);

  const wins = { base: {}, scen: {} };
  const gwScores = { base: {}, scen: {} };
  baseEntrants.forEach(e => { wins.base[e.entry] = 0; wins.scen[e.entry] = 0; gwScores.base[e.entry] = []; gwScores.scen[e.entry] = []; });

  // Shared-draw Monte Carlo: rivals get the SAME score in both runs; only
  // your own squad's draw changes. Deltas are therefore change-attributable.
  for (let it = 0; it < iterations; it++) {
    const baseDraw = [], scenDraw = [];
    baseEntrants.forEach(e => {
      const rivalScore = VG._mcDrawTotal(e.lambdas);
      gwScores.base[e.entry].push(rivalScore);
      baseDraw.push({ entry: e.entry, total: e.priorTotal + rivalScore });
      if (e.entry === myEntry) {
        const scenScore = VG._mcDrawTotal(scenEntrants.find(s => s.entry === myEntry).lambdas);
        gwScores.scen[e.entry].push(scenScore);
        scenDraw.push({ entry: e.entry, total: e.priorTotal + scenScore });
      } else {
        gwScores.scen[e.entry].push(rivalScore);
        scenDraw.push({ entry: e.entry, total: e.priorTotal + rivalScore });
      }
    });
    baseDraw.sort((a, b) => b.total - a.total);
    scenDraw.sort((a, b) => b.total - a.total);
    wins.base[baseDraw[0].entry]++;
    wins.scen[scenDraw[0].entry]++;
  }

  const row = (winsMap, scoresMap) => baseEntrants.map(e => {
    const scores = scoresMap[e.entry].slice().sort((a, b) => a - b);
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    const at = f => scores[Math.max(0, Math.min(scores.length - 1, Math.floor(f * scores.length)))];
    return {
      entry: e.entry, name: e.name, priorTotal: e.priorTotal,
      gwMean: +mean.toFixed(1), gwFloor: at(0.1), gwCeiling: at(0.9),
      winProb: +((winsMap[e.entry] / iterations) * 100).toFixed(1),
      top3Prob: null
    };
  }).find(r => r.entry === myEntry);

  const baseline = row(wins.base, gwScores.base);
  const scenarioRow = row(wins.scen, gwScores.scen);
  if (!baseline || !scenarioRow) return null;
  return { baseline, scenario: scenarioRow };
};

// Delta in probability points between baseline and scenario (0 if equal).
VG.raceScenarioDelta = (squads, fixtures, gw, iterations, scenario) => {
  const r = VG.simulateRaceScenario(squads, fixtures, gw, iterations, scenario);
  if (!r) return null;
  const delta = +(r.scenario.winProb - r.baseline.winProb).toFixed(1);
  return { ...r, delta };
};
// Idea borrowed from Ben Crellin's FPL planner / FFHub calendars. A full-season
// grid of double (2 fixtures) and blank (0 fixtures) gameweeks per team, plus
// per-GW chip-window scoring for a squad.
VG.buildSeasonPlanner = (fixtures) => {
  const gwMap = {};
  (fixtures || []).forEach(f => {
    const ev = f.event;
    if (!gwMap[ev]) gwMap[ev] = {
      count: 0,
      teams: {},
      dgwTeams: [], bgwTeams: []
    };
    gwMap[ev].count++;
    gwMap[ev].teams[f.team_h] = (gwMap[ev].teams[f.team_h] || 0) + 1;
    gwMap[ev].teams[f.team_a] = (gwMap[ev].teams[f.team_a] || 0) + 1;
  });
  const out = Object.keys(gwMap).map(ev => {
    const g = gwMap[ev];
    const gws = parseInt(ev);
    g.dgwTeams = Object.keys(g.teams).filter(t => g.teams[t] >= 2).map(Number);
    g.bgwTeams = Object.keys(g.teams).filter(t => g.teams[t] === 0).map(Number);
    return { gw: gws, fixtureCount: g.count, dgwTeams: g.dgwTeams, bgwTeams: g.bgwTeams };
  }).sort((a, b) => a.gw - b.gw);
  return out;
};
// Build a per-team row: {teamId, short, fixtures: [{gw, n}]} — n=2 DGW, 0 blank.
VG.teamSeasonRow = (planner, teamId, fromGW, nGWs) => {
  const short = (VG.teams[teamId] || {}).short_name || teamId;
  const cells = [];
  const end = fromGW + nGWs;
  planner.forEach(p => {
    if (p.gw < fromGW || p.gw >= end) return;
    let n = 1;
    if (p.dgwTeams.includes(teamId)) n = 2;
    else if (p.bgwTeams.includes(teamId)) n = 0;
    cells.push({ gw: p.gw, n });
  });
  return { teamId, short, cells };
};

// ── Approximate rank impact of a transfer (v5.5) ──────────────────────
// Idea borrowed from "AI transfer / rank" tools (FFHub AI Transfers). Maps a
// projected points gain over the horizon to an approximate overall-rank move.
// The mapping is a rough global model — presented as an estimate, not gospel.
VG.estimateRankImpact = (ptDelta, context) => {
  const totalPlayers = context && context.totalPlayers ? context.totalPlayers : 8000000;
  if (!ptDelta || Math.abs(ptDelta) < 0.1) return { pts: 0, rankDelta: 0, caution: true };
  // Near-mean managers score ~±2.5 pts around the league average per GW; a
  // 1-pt gain over ~5 GWs ≈ ~0.9% of the FINISHED field, scaled non-linearly
  // so big swings matter less at the very top.
  const gwAdj = (context && context.nGWs) ? context.nGWs : 5;
  const share = Math.abs(ptDelta) * 0.018 / Math.max(1, gwAdj / 5);
  const raw = Math.min(share, 1.0);
  const rankDelta = Math.round(totalPlayers * raw * 0.45);
  return {
    pts: +ptDelta.toFixed(1),
    rankDelta: ptDelta >= 0 ? -rankDelta : rankDelta,
    direction: ptDelta >= 0 ? "gain" : "loss",
    caution: true
  };
};

VG.computeMultiGWXP = (pid, startGW, nGWs, fixtures) => {
  const p = VG.players[pid];
  if (!p) return { totalXP: 0, gwDetails: [], info: {} };

  // Clamp the horizon to the GWs actually left in the season (v5.8): near
  // the end of the season a 12-GW request can only cover 6 remaining weeks.
  nGWs = VG.clampHorizon(nGWs, startGW);

  const teamId = p.team;
  const upcoming = fixtures.filter(f =>
    (f.team_h === teamId || f.team_a === teamId) && f.event >= startGW && f.event < startGW + nGWs
  );

  let totalXP = 0;
  const gwDetails = [];
  const aggComponents = { xpAppearance: 0, xpCS: 0, xpGoals: 0, xpAssists: 0, xpBonus: 0, xpSaves: 0, xpDEFCON: 0, xpNegative: 0 };

  if (upcoming.length === 0) {
    // Pre-season / no fixtures: use best available signal, scaled to the
    // number of GWs actually remaining in the season (not the raw request).
    const ppg = parseFloat(p.points_per_game || "0");
    const form = parseFloat(p.form || "0");
    const epNext = parseFloat(p.ep_next || "0");
    const valueForm = parseFloat(p.value_form || "0");
    // ep_next is FPL's own xP — best signal when available
    const base = epNext > 0 ? epNext : Math.max(ppg, form, 1.0);
    // value_form bonus: high value form = undervalued
    const vfBonus = valueForm > 0 ? 1.0 + valueForm * 0.01 : 1.0;
    totalXP = nGWs * base * 0.6 * vfBonus;
  } else {
    upcoming.forEach(f => {
      const info = VG.fixtureInfo(f, teamId);
      VG._projGW = f.event;
      const res = VG.computeFixtureXP(pid, info.oppId, info.isHome, info.fdr);
      res.gw = f.event;
      res.opponent = info.oppName;
      res.venue = info.isHome ? "H" : "A";
      gwDetails.push(res);
      totalXP += res.xp;
      if (res.xpComponents) {
        Object.keys(aggComponents).forEach(k => { aggComponents[k] += res.xpComponents[k] || 0; });
      }
    });
  }

  const price = p.now_cost / 10;
  const xG = parseFloat(p.expected_goals || "0");
  const xA = parseFloat(p.expected_assists || "0");
  const xGI = parseFloat(p.expected_goal_involvements || "0");
  const form = parseFloat(p.form || "0");
  const ppg = parseFloat(p.points_per_game || "0");
  const formVsPPG = ppg > 0 ? form / ppg : 1.0;
  const epNext = parseFloat(p.ep_next || "0");
  const bps = parseInt(p.bps || "0");
  const defConPer90 = parseFloat(p.defensive_contribution_per_90 || "0");
  const us = p.understat;
  const recency = VG._recencyFactors(p);

  return {
    totalXP: +totalXP.toFixed(2),
    xpComponents: aggComponents,
    gwDetails,
    info: {
      id: pid,
      name: VG.playerName(p),
      fullName: p.first_name + " " + p.second_name,
      position: VG.POSITIONS[p.element_type],
      positionId: p.element_type,
      teamId,
      teamName: VG.teams[teamId]?.short_name || "",
      price,
      form: Math.max(form, ppg, 0),
      totalPoints: parseInt(p.total_points || "0"),
      ict: parseFloat(p.ict_index || "0"),
      ownership: parseFloat(p.selected_by_percent || "0"),
      xpPerPrice: 0,
      totalXP: +totalXP.toFixed(2),
      xG: +xG.toFixed(2),
      xA: +xA.toFixed(2),
      xGI: +xGI.toFixed(2),
      realXG: +(us?.xG || 0),
      realXA: +(us?.xA || 0),
      realXG90: us && us.time > 0 ? +((us.xG || 0) * 90 / us.time).toFixed(2) : 0,
      regression: VG.getRegressionFlag(pid),
      trend: +formVsPPG.toFixed(2),
      epNext,
      bps,
      defconPer90: +defConPer90.toFixed(2),
      status: p.status,
      news: p.news || "",
      // v5.8: expected minutes (FPL Review xMins idea) — mean over the
      // horizon's fixtures; surfaced so rotation risk is visible at a glance.
      xMins: gwDetails.length > 0
        ? +(gwDetails.reduce((s, d) => s + (d.xMins || 0), 0) / gwDetails.length).toFixed(1)
        : 0,
      // v5.8: new-to-PL flag + the prior signal that was used (ep_next or
      // understat). Surfaces debutants/promoted players in the UI.
      isNew: gwDetails.some(d => d.isNew),
      priorSignal: (gwDetails.find(d => d.priorSignal) || {}).priorSignal || "",
      // v5.13: transfer context (NEW CLUB badge) + foreign-league prior label.
      transferred: gwDetails.some(d => d.transferred),
      fromTeam: (gwDetails.find(d => d.transferred) || {}).fromTeam || null,
      toTeam: (gwDetails.find(d => d.transferred) || {}).toTeam || null,
      foreignLeague: (gwDetails.find(d => d.foreignLeague) || {}).foreignLeague || "",
      recency: recency ? { rounds: recency.rounds, xgi90: +recency.xgi90.toFixed(2), pts90: +recency.pts90.toFixed(2) } : null
    }
  };
};

VG.computeAllXP = (startGW, nGWs, fixtures) => {
  const results = [];
  Object.values(VG.players).forEach(p => {
    if ((p.status !== "a" && p.status !== "d") || p.now_cost <= 0) return;
    const xp = VG.computeMultiGWXP(p.id, startGW, nGWs, fixtures);
    xp.info.xpPerPrice = +(xp.totalXP / Math.max(xp.info.price, 4.0)).toFixed(2);
    xp.info.xpComponents = xp.xpComponents;
    xp.info.setPiece = VG.setPieceRole(p.id);
    results.push(xp.info);
  });
  results.sort((a, b) => b.totalXP - a.totalXP);
  // Effective ownership pass — needs the sorted full pool for captain-share model.
  const eo = VG.computeEffectiveOwnership(results);
  results.forEach(p => {
    const r = eo.forPlayer(p);
    p.eo = r.eo;
    p.capShare = r.capShare;
  });
  return results;
};

// ── Per-GW Picks: best XI + formation for a single gameweek ──────────────
VG.computePlayerGWProjection = (player, gw, fixtures) => {
  if (!player || !Array.isArray(fixtures)) {
    return { gwXP: 0, fixtureCount: 0, opponents: [], oppName: "BLANK", venue: "-", fdr: 0 };
  }

  const teamFixtures = VG.teamFixtures(fixtures, gw, player.teamId);
  if (teamFixtures.length === 0) {
    return { gwXP: 0, fixtureCount: 0, opponents: [], oppName: "BLANK", venue: "-", fdr: 0 };
  }

  let gwXP = 0;
  const opponents = [];
  const venues = [];
  const difficulties = [];

  teamFixtures.forEach(f => {
    const info = VG.fixtureInfo(f, player.teamId);
    const projection = VG.computeFixtureXP(player.id, info.oppId, info.isHome, info.fdr);
    gwXP += projection.xp || 0;
    opponents.push(info.oppName);
    venues.push(info.isHome ? "H" : "A");
    difficulties.push(info.fdr);
  });

  return {
    gwXP: +gwXP.toFixed(2),
    fixtureCount: teamFixtures.length,
    opponents,
    oppName: opponents.join(" + "),
    venue: venues.every(v => v === venues[0]) ? venues[0] : "H/A",
    fdr: +(difficulties.reduce((sum, value) => sum + value, 0) / difficulties.length).toFixed(1)
  };
};

// Pick the highest-scoring legal XI from a 15-man squad, ranking by `key`
// (totalXP for horizon-wide picks, gwXP for a single gameweek).
// Returns the bench unsorted — callers order it to taste.
VG.pickBestXI = (squad, key = "totalXP") => {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  squad.forEach(p => { if (byPos[p.positionId]) byPos[p.positionId].push(p); });
  Object.values(byPos).forEach(arr => arr.sort((a, b) => (b[key] || 0) - (a[key] || 0)));

  let formation = null, startingXP = -Infinity;
  VG.FORMATIONS.forEach(([defN, midN, fwdN]) => {
    if (!byPos[1].length || byPos[2].length < defN || byPos[3].length < midN || byPos[4].length < fwdN) return;
    let xp = byPos[1][0][key] || 0;
    for (let i = 0; i < defN; i++) xp += byPos[2][i][key] || 0;
    for (let i = 0; i < midN; i++) xp += byPos[3][i][key] || 0;
    for (let i = 0; i < fwdN; i++) xp += byPos[4][i][key] || 0;
    if (xp > startingXP) { startingXP = xp; formation = { DEF: defN, MID: midN, FWD: fwdN }; }
  });
  if (!formation) { formation = { DEF: 4, MID: 4, FWD: 2 }; startingXP = 0; }

  const starting = [];
  const bench = [];
  if (byPos[1][0]) starting.push(byPos[1][0]);
  if (byPos[1][1]) bench.push(byPos[1][1]);
  [2, 3, 4].forEach(pos => {
    const n = formation[VG.POSITIONS[pos]];
    byPos[pos].forEach((p, i) => { if (i < n) starting.push(p); else bench.push(p); });
  });
  while (starting.length < 11 && bench.length > 0) starting.push(bench.shift());

  return { formation, starting: starting.slice(0, 11), bench, byPos, startingXP };
};

VG.emptyDraftResult = (budget) => ({
  mode: "draft", squad: [], starting: [], bench: [],
  formation: { DEF: 4, MID: 4, FWD: 2 },
  totalCost: 0, budgetRemaining: budget, totalXP: 0, benchXP: 0,
  gotCap: [], gwPicks: []
});

// Tally how many squad members face easy (FDR<=2) / hard (FDR>=4) fixtures in a GW
VG.countFixtureDifficulty = (squad, fixtures, gw) => {
  const gwFix = VG.fixturesForGW(fixtures, gw);
  let easy = 0, hard = 0;
  squad.forEach(p => {
    const tid = p.teamId;
    const f = gwFix.find(fi => fi.team_h === tid || fi.team_a === tid);
    if (!f) return;
    const fdr = VG.fixtureFDR(f, tid);
    if (fdr <= 2) easy++;
    if (fdr >= 4) hard++;
  });
  return { easy, hard };
};

VG.computePerGWPicks = (squad, gw, fixtures) => {
  // Compute single-GW xP for each squad member
  const gwXP = squad.map(p => {
    const data = VG.players[p.id];
    if (!data) return { ...p, gwXP: 0, gwOpp: "", gwVenue: "", gwFDR: 3 };
    const projection = VG.computePlayerGWProjection(p, gw, fixtures);
    return {
      ...p,
      gwXP: projection.gwXP,
      gwOpp: projection.oppName,
      gwVenue: projection.venue,
      gwFDR: projection.fdr,
      fixtureCount: projection.fixtureCount
    };
  });

  const { formation: bestFormation, starting, bench } = VG.pickBestXI(gwXP, "gwXP");

  const cap = [...starting].filter(p => p.positionId !== 1).sort((a, b) => b.gwXP - a.gwXP);
  const gwTotalXP = +starting.reduce((s, p) => s + (p.gwXP || 0), 0).toFixed(2);
  const gwBenchXP = +bench.reduce((s, p) => s + (p.gwXP || 0), 0).toFixed(2);

  return {
    gw,
    formation: bestFormation,
    starting: starting.slice(0, 11),
    bench: bench.slice(0, 4),
    gwTotalXP,
    gwBenchXP,
    gotCap: cap.slice(0, 2),
    dgwPlayers: gwXP.filter(p => {
      const f = VG.teamFixtures(fixtures, gw, p.teamId);
      return f.length >= 2;
    }).map(p => p.id)
  };
};

// ── Optimizer: maximize total xP within budget ──────────────────────────
VG.optimizeDraft = (players, budget = 100, fixtures = [], startGW = 1, nGWs = 12) => {
  const target = VG.POS_TARGET;
  let bestSquad = null, bestStrategyXP = -1, bestSpent = 0;

  // Try multiple starting strategies to find global optimum
  const strategies = ['value', 'xp', 'mixed'];
  
  for (const strategy of strategies) {
    const squad = [];
    let spent = 0;
    const clubCounts = {};
    const inSquad = new Set();

    const addPlayer = (p) => {
      squad.push({ ...p });
      spent += p.price;
      clubCounts[p.teamId] = (clubCounts[p.teamId] || 0) + 1;
      inSquad.add(p.id);
    };


    // Phase 1a: Seed with must-have premiums (highest xP per position)
    // This ensures expensive captains like Haaland/Saka aren't priced out by budget reserve
    // For MIDs, seed top 2 (e.g. Saka + Bruno) since they're captain-viable
    const seeds = [];
    [1, 2, 3, 4].forEach(function(pos) {
      const candidates = players.filter(function(p) { return p.positionId === pos && !inSquad.has(p.id) && VG.isAvailable(p); })
        .sort(function(a, b) { return b.totalXP - a.totalXP; });
      seeds.push(candidates[0]);
      if (pos === 3 && candidates[1]) seeds.push(candidates[1]);
    });
    seeds.filter(Boolean).forEach(function(p) {
      const slotsLeft = 15 - squad.length - 1;
      const reserve = slotsLeft * 3.5;
      if (spent + p.price + reserve <= budget + 0.1 && (clubCounts[p.teamId] || 0) < 3) {
        addPlayer(p);
      }
    });

    // Phase 1b: Fill remaining slots in a single value-sorted pass (all positions together)
    // This ensures premium MIDs like Bruno aren't excluded just because DEFs are filled first
    let byValue;
    if (strategy === 'value') {
      byValue = players.filter(VG.isAvailable).sort((a, b) => (b._sortBy || b.xpPerPrice) - (a._sortBy || a.xpPerPrice));
    } else if (strategy === 'xp') {
      byValue = players.filter(VG.isAvailable).sort((a, b) => b.totalXP - a.totalXP);
    } else { // mixed
      byValue = players.filter(VG.isAvailable).sort((a, b) => {
        const scoreA = (a._sortBy || a.xpPerPrice) * 0.5 + (a.totalXP / 10) * 0.5;
        const scoreB = (b._sortBy || b.xpPerPrice) * 0.5 + (b.totalXP / 10) * 0.5;
        return scoreB - scoreA;
      });
    }

    // Compute minimum cost per remaining position for budget safety
    const minCostPerPos = { 1: 4.0, 2: 4.0, 3: 4.5, 4: 4.5 };
    const posNeeded1b = {};
    [1, 2, 3, 4].forEach(pos => {
      const need = target[pos] - squad.filter(s => s.positionId === pos).length;
      if (need > 0) posNeeded1b[pos] = need;
    });

    for (const p of byValue) {
      const posKey = p.positionId;
      if (!posNeeded1b[posKey] || posNeeded1b[posKey] <= 0) continue;
      if (inSquad.has(p.id)) continue;
      if ((clubCounts[p.teamId] || 0) >= 3) continue;
      // Reserve minimum cost for all remaining unfilled position slots
      let reserveForOthers = 0;
      Object.keys(posNeeded1b).forEach(function(pk) {
        const pid = parseInt(pk);
        const extra = pid === posKey ? posNeeded1b[pk] - 1 : posNeeded1b[pk];
        reserveForOthers += extra * (minCostPerPos[pid] || 4.0);
      });
      if (spent + p.price + reserveForOthers > budget + 0.1) continue;
      addPlayer(p);
      posNeeded1b[posKey]--;
      if (posNeeded1b[posKey] <= 0) delete posNeeded1b[posKey];
    }

    // Phase 2: Fill remaining slots with cheapest available (no reserve, just budget)
    if (squad.length < 15) {
      const posNeeded2 = {};
      [1, 2, 3, 4].forEach(pos => {
        const need = target[pos] - squad.filter(s => s.positionId === pos).length;
        if (need > 0) posNeeded2[pos] = need;
      });
      const fillers = players.filter(VG.isAvailable).sort((a, b) => a.price - b.price);
      for (const p of fillers) {
        if (squad.length >= 15) break;
        if (inSquad.has(p.id)) continue;
        if (!posNeeded2[p.positionId]) continue;
        if ((clubCounts[p.teamId] || 0) >= 3) continue;
        if (spent + p.price > budget + 0.1) continue;
        addPlayer(p);
        posNeeded2[p.positionId]--;
        if (posNeeded2[p.positionId] <= 0) delete posNeeded2[p.positionId];
      }
    }

    // Phase 3: Aggressively upgrade with remaining budget
    const remaining = () => +(budget - spent).toFixed(1);
    for (let pass = 0; pass < 12; pass++) {
      if (remaining() < 0.1) break;
      let improved = false;
      const indices = Array.from({ length: squad.length }, (_, i) => i);
      indices.sort((a, b) => squad[a].totalXP - squad[b].totalXP);
      for (const i of indices) {
        if (remaining() < 0.1) break;
        const cur = squad[i];
        let bestCand = null, bestGain = 0;
        for (const p of players) {
          if (inSquad.has(p.id) || !VG.isAvailable(p)) continue;
          if (p.positionId !== cur.positionId) continue;
          const costDiff = +(p.price - cur.price).toFixed(1);
          if (costDiff <= 0 || costDiff > remaining()) continue;
          if ((clubCounts[p.teamId] || 0) >= 3 && p.teamId !== cur.teamId) continue;
          const gain = p.totalXP - cur.totalXP;
          if (gain > bestGain) { bestGain = gain; bestCand = p; }
        }
        if (bestCand && bestGain > 0) {
          const costDiff = +(bestCand.price - cur.price).toFixed(1);
          inSquad.delete(cur.id);
          inSquad.add(bestCand.id);
          if (bestCand.teamId !== cur.teamId) {
            clubCounts[cur.teamId] = (clubCounts[cur.teamId] || 1) - 1;
            clubCounts[bestCand.teamId] = (clubCounts[bestCand.teamId] || 0) + 1;
          }
          squad[i] = { ...bestCand };
          spent += costDiff;
          improved = true;
        }
      }
      if (!improved) break;
    }

    // Phase 4: Cross-position rebalancing via iterative best-swap
    // For each pair of squad players, find the best replacement pair that improves total xP
    // Protect top-xP player in each position (captain candidates)
    const topByPos = {};
    squad.forEach(function(p) {
      if (!topByPos[p.positionId] || p.totalXP > topByPos[p.positionId].totalXP) {
        topByPos[p.positionId] = p;
      }
    });
    const protectedIds = new Set(Object.values(topByPos).map(function(p) { return p.id; }));

    for (let pass = 0; pass < 3; pass++) {
      let bestMove = null, bestNetGain = 0;
      for (let i = 0; i < squad.length; i++) {
        for (let j = i + 1; j < squad.length; j++) {
          const sA = squad[i], sB = squad[j];
          // Don't swap out the top-xP player in each position (captain candidates)
          if (protectedIds.has(sA.id) || protectedIds.has(sB.id)) continue;
          // Find best replacement for sA in same position
          let bestA = null, bestAGain = -Infinity;
          for (const p of players) {
            if (inSquad.has(p.id) || !VG.isAvailable(p)) continue;
            if (p.positionId !== sA.positionId) continue;
            if ((clubCounts[p.teamId] || 0) >= 3 && p.teamId !== sA.teamId) continue;
            const gain = p.totalXP - sA.totalXP;
            if (gain > bestAGain) { bestAGain = gain; bestA = { p, gain: gain }; }
          }
          if (!bestA) continue;
          // Find best replacement for sB in same position, fitting remaining budget
          for (const p of players) {
            if (inSquad.has(p.id) || p.id === bestA.p.id || !VG.isAvailable(p)) continue;
            if (p.positionId !== sB.positionId) continue;
            if ((clubCounts[p.teamId] || 0) >= 3 && p.teamId !== sB.teamId) continue;
            const costDiffB = +(p.price - sB.price).toFixed(1);
            const totalCost = +(bestA.p.price - sA.price + costDiffB).toFixed(1);
            if (totalCost > remaining()) continue;
            const netGain = bestAGain + (p.totalXP - sB.totalXP);
            if (netGain > bestNetGain) {
              bestNetGain = netGain;
              bestMove = { i, j, newA: bestA.p, newB: p };
            }
          }
        }
      }
      if (bestMove && bestNetGain > 0.5) {
        const { i, j, newA, newB } = bestMove;
        const sA = squad[i], sB = squad[j];
        const costDiff = +(newA.price - sA.price + newB.price - sB.price).toFixed(1);
        clubCounts[sA.teamId] = (clubCounts[sA.teamId] || 1) - 1;
        clubCounts[sB.teamId] = (clubCounts[sB.teamId] || 1) - 1;
        inSquad.delete(sA.id);
        inSquad.delete(sB.id);
        inSquad.add(newA.id);
        inSquad.add(newB.id);
        clubCounts[newA.teamId] = (clubCounts[newA.teamId] || 0) + 1;
        clubCounts[newB.teamId] = (clubCounts[newB.teamId] || 0) + 1;
        squad[i] = { ...newA };
        squad[j] = { ...newB };
        spent = +(spent + costDiff).toFixed(1);
      } else {
        break;
      }
    }

    // Phase 5: deterministic best-improvement single-player local search
    for (let iter = 0; iter < 50; iter++) {
      let bestSwap = null;
      for (let idx = 0; idx < squad.length; idx++) {
        const cur = squad[idx];
        for (const cand of players) {
          if (cand.id === cur.id || inSquad.has(cand.id) || !VG.isAvailable(cand)) continue;
          if (cand.positionId !== cur.positionId) continue;
          if (cand.teamId !== cur.teamId && (clubCounts[cand.teamId] || 0) >= 3) continue;
          const costDiff = +(cand.price - cur.price).toFixed(1);
          if (costDiff > remaining()) continue;
          const gain = cand.totalXP - cur.totalXP;
          if (gain <= 0) continue;
          if (!bestSwap || gain > bestSwap.gain || (gain === bestSwap.gain && costDiff < bestSwap.costDiff)) {
            bestSwap = { idx, cur, cand, costDiff, gain };
          }
        }
      }
      if (!bestSwap) break;

      const { idx, cur, cand, costDiff } = bestSwap;
      if (cand.teamId !== cur.teamId) {
        clubCounts[cur.teamId] = (clubCounts[cur.teamId] || 1) - 1;
        clubCounts[cand.teamId] = (clubCounts[cand.teamId] || 0) + 1;
      }
      inSquad.delete(cur.id);
      inSquad.add(cand.id);
      squad[idx] = { ...cand };
      spent = +(spent + costDiff).toFixed(1);
    }

    // Evaluate this squad's total XP
    const totalXP = squad.reduce((s, p) => s + p.totalXP, 0);
    if (totalXP > bestStrategyXP && squad.length === 15) {
      bestStrategyXP = totalXP;
      bestSquad = [...squad];
      bestSpent = spent;
    }
  }

  const squad = bestSquad;
  if (!squad || squad.length < 11) return VG.emptyDraftResult(budget);
  const spent = bestSpent;

  const { formation: bestFormation, starting, bench } = VG.pickBestXI(squad, "totalXP");
  bench.sort((a, b) => a.positionId - b.positionId || b.totalXP - a.totalXP);

  // Per-GW picks: best XI/formation/captain for each GW in the horizon
  const gwPicks = [];
  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    gwPicks.push(VG.computePerGWPicks(squad, gw, fixtures));
  }

  const totalXP = +gwPicks.reduce((s, g) => s + g.gwTotalXP, 0).toFixed(1);
  const benchXP = +gwPicks.reduce((s, g) => s + g.gwBenchXP, 0).toFixed(1);

  return {
    mode: "draft",
    squad, starting: gwPicks[0]?.starting || starting.slice(0, 11), bench: gwPicks[0]?.bench || bench.slice(0, 4),
    formation: gwPicks[0]?.formation || bestFormation,
    totalCost: +spent.toFixed(1), budgetRemaining: +(budget - spent).toFixed(1),
    totalXP, benchXP,
    gotCap: gwPicks[0]?.gotCap || [...starting].filter(p => p.positionId !== 1).sort((a, b) => b.totalXP - a.totalXP).slice(0, 2),
    gwPicks
  };
};

// ── ILP Solver: globally optimal squad via HiGHS WebAssembly ──────────
// Uses highs-js (HiGHS C++ solver compiled to WASM) from CDN.
// Falls back to greedy optimizer if WASM fails to load.
VG._highsReady = null;
VG._highsLoading = false;

VG._loadHighs = async () => {
  if (VG._highsReady) return VG._highsReady;
  if (VG._highsLoading) return null;
  VG._highsLoading = true;
  // highs-js is an Emscripten MODULARIZE build: it publishes `window.Module`,
  // not `window.Highs`. Reading the wrong global made every ILP solve throw
  // and silently drop to the greedy fallback.
  const highsFactory = () => window.Module || window.Highs;
  try {
    // Load highs-js from CDN — no build step needed
    if (typeof highsFactory() !== 'function') {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/highs.js';
      script.integrity = 'sha384-TuRRrTGgc1fvxkUfyHE5NU0JOtUfCV9LzQ6nLhIGaGFtv37yuaq6d9SGfWDnZEYC';
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      document.head.appendChild(script);
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('highs.js failed to load'));
        setTimeout(() => reject(new Error('highs.js load timed out')), 8000);
      });
    }
    if (typeof highsFactory() !== 'function') throw new Error('highs-js exposed no factory');
    const highs = await highsFactory()({
      locateFile: (file) => 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/' + file
    });
    VG._highsReady = highs;
    VG._highsLoading = false;
    return highs;
  } catch (e) {
    console.warn('[VG] HiGHS WASM load failed, using greedy fallback:', e.message);
    VG._highsLoading = false;
    return null;
  }
};

VG.optimizeDraftILP = async (players, budget = 100, fixtures = [], startGW = 1, nGWs = 12) => {
  const highs = await VG._loadHighs();
  if (!highs) {
    // Fallback to greedy
    return VG.optimizeDraft(players, budget, fixtures, startGW, nGWs);
  }

  const target = VG.POS_TARGET;
  const n = players.length;
  if (n === 0) {
    return { mode: "draft", squad: [], starting: [], bench: [], formation: { DEF: 4, MID: 4, FWD: 2 }, totalCost: 0, budgetRemaining: budget, totalXP: 0, benchXP: 0, gotCap: [], gwPicks: [] };
  }

  // Build CPLEX .lp problem
  // Variables: x0, x1, ..., x_{n-1} — binary (0 or 1) for each player
  let lp = 'Maximize\n obj:';
  const terms = [];
  for (let i = 0; i < n; i++) {
    const xp = players[i].totalXP || 0;
    if (xp > 0) terms.push(xp + ' x' + i);
  }
  lp += ' ' + terms.join(' + ');

  lp += '\nSubject To\n';

  // Constraint 1: exactly 15 players
  const allVars = [];
  for (let i = 0; i < n; i++) allVars.push('x' + i);
  lp += ' squad: ' + allVars.join(' + ') + ' = 15\n';

  // Constraint 2: exact FPL squad composition (2 GK, 5 DEF, 5 MID, 3 FWD)
  [1, 2, 3, 4].forEach(pos => {
    const posVars = [];
    for (let i = 0; i < n; i++) {
      if (players[i].positionId === pos) posVars.push('x' + i);
    }
    if (posVars.length === 0) return;
    const posExpr = posVars.join(' + ');
    lp += ' pos' + pos + '_exact: ' + posExpr + ' = ' + target[pos] + '\n';
  });

  // Constraint 3: budget
  const budgetTerms = [];
  for (let i = 0; i < n; i++) {
    const price = players[i].price || 0;
    if (price > 0) budgetTerms.push(price + ' x' + i);
  }
  lp += ' budget: ' + budgetTerms.join(' + ') + ' <= ' + budget + '\n';

  // Constraint 4: max 3 per team
  const teamIds = new Set(players.map(p => p.teamId));
  teamIds.forEach(tid => {
    const teamVars = [];
    for (let i = 0; i < n; i++) {
      if (players[i].teamId === tid) teamVars.push('x' + i);
    }
    if (teamVars.length > 3) {
      lp += ' team' + tid + ': ' + teamVars.join(' + ') + ' <= 3\n';
    }
  });

  // Bounds + Binary
  lp += 'Bounds\n';
  for (let i = 0; i < n; i++) lp += ' 0 <= x' + i + ' <= 1\n';
  lp += 'Binary\n';
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % 20 === 0) lp += '\n';
    lp += ' x' + i;
  }
  lp += '\nEnd\n';

  try {
    const sol = highs.solve(lp, { presolve: 'on' });
    if (!sol || sol.Status !== 'Optimal') {
      console.warn('[VG] ILP status:', sol?.Status, '- falling back to greedy');
      return VG.optimizeDraft(players, budget, fixtures, startGW, nGWs);
    }

    // Extract selected players
    const selected = [];
    for (let i = 0; i < n; i++) {
      const col = sol.Columns['x' + i];
      if (col && col.Primal > 0.5) {
        selected.push({ ...players[i] });
      }
    }

    if (selected.length < 11) {
      console.warn('[VG] ILP selected only', selected.length, 'players - falling back');
      return VG.optimizeDraft(players, budget, fixtures, startGW, nGWs);
    }

    const spent = selected.reduce((s, p) => s + (p.price || 0), 0);

    // Select starting XI: best formation
    const { formation: bestFormation, starting, bench } = VG.pickBestXI(selected, "totalXP");
    bench.sort((a, b) => a.positionId - b.positionId || b.totalXP - a.totalXP);

    // Per-GW picks
    const gwPicks = [];
    for (let gw = startGW; gw < startGW + nGWs; gw++) {
      gwPicks.push(VG.computePerGWPicks(selected, gw, fixtures));
    }

    const totalXP = +gwPicks.reduce((s, g) => s + g.gwTotalXP, 0).toFixed(1);
    const benchXP = +gwPicks.reduce((s, g) => s + g.gwBenchXP, 0).toFixed(1);

    return {
      mode: "draft",
      squad: selected,
      starting: gwPicks[0]?.starting || starting.slice(0, 11),
      bench: gwPicks[0]?.bench || bench.slice(0, 4),
      formation: gwPicks[0]?.formation || bestFormation,
      totalCost: +spent.toFixed(1),
      budgetRemaining: +(budget - spent).toFixed(1),
      totalXP, benchXP,
      gotCap: gwPicks[0]?.gotCap || [...starting].filter(p => p.positionId !== 1).sort((a, b) => b.totalXP - a.totalXP).slice(0, 2),
      gwPicks,
      solver: "ILP"
    };
  } catch (e) {
    console.warn('[VG] ILP solve failed:', e.message, '- falling back to greedy');
    return VG.optimizeDraft(players, budget, fixtures, startGW, nGWs);
  }
};
VG.STRATEGIES = {
  balanced: { name: "Balanced", desc: "Maximize total xP within budget", icon: "⚖️" },
  premium: { name: "Premium Heavy", desc: "Stack elite players, accept weaker bench", icon: "💎" },
  value: { name: "Best Value", desc: "Maximize xP per £m, find hidden gems", icon: "💰" }
};

VG.optimizeStrategies = (players, budget = 100, fixtures = [], startGW = 1, nGWs = 12) => {
  const results = {};

  // Balanced: standard optimizer — sorts by xpPerPrice, upgrades by totalXP
  results.balanced = VG.optimizeDraft(players, budget, fixtures, startGW, nGWs);

  // Premium Heavy: sort by totalXP (not xpPerPrice) — picks best players first, accepts premium stack
  const premiumPlayers = players.map(p => ({
    ...p,
    _sortBy: p.totalXP * 1.3
  }));
  results.premium = VG.optimizeDraft(premiumPlayers, budget, fixtures, startGW, nGWs);
  results.premium.strategy = "premium";

  // Best Value: cap max price at £8m, force cheap build, sort by xpPerPrice
  const maxPrice = 8;
  const valuePlayers = players.filter(p => p.price <= maxPrice).map(p => ({
    ...p,
    _sortBy: p.xpPerPrice * 1.5
  }));
  results.value = VG.optimizeDraft(valuePlayers, budget, fixtures, startGW, nGWs);
  results.value.strategy = "value";

  return results;
};

VG.optimizeTransfers = (currentSquad, players, bank, freeTransfers, startGW, nGWs) => {
  startGW = startGW || 1;
  nGWs = nGWs || 5;

  const currentIds = new Set(currentSquad.map(p => p.element));
  const candidates = [];

  currentSquad.forEach(sp => {
    const pid = sp.element;
    const cXP = players.find(p => p.id === pid);
    const cPrice = (sp.selling_price || sp.now_cost || 0) / 10;
    if (!cXP) return;
    const pos = cXP.positionId;
    const upgrades = players.filter(p =>
      p.id !== pid && !currentIds.has(p.id) && VG.isAvailable(p) &&
      p.positionId === pos &&
      p.price <= cPrice + bank + 0.1 &&
      p.totalXP > cXP.totalXP + 1.0
    ).sort((a, b) => (b.totalXP - b.price) - (a.totalXP - a.price));

    if (upgrades.length > 0) {
        const best = upgrades[0];
        const gain = best.totalXP - cXP.totalXP;
        const cost = +(best.price - cPrice).toFixed(1);

        // Break-even analysis: linear approximation using per-GW average gain
        const gwAvgGain = +(gain / nGWs).toFixed(2);
        const breakEvenGWs = gwAvgGain > 0 ? Math.ceil(4.0 / gwAvgGain) : null;
        const breaksEven = breakEvenGWs !== null && breakEvenGWs <= nGWs;

        candidates.push({
          out: { id: pid, name: sp.web_name || "?", position: VG.POSITIONS[pos], price: cPrice, totalXP: cXP.totalXP },
          in: { id: best.id, name: best.name, position: best.position, price: best.price, totalXP: best.totalXP },
          gain, cost, netGain: gain,
          breakEvenGWs, breaksEven, gwAvgGain
        });
      }
  });

  candidates.sort((a, b) => b.netGain - a.netGain);

  // Phase 1: Only use free transfers (no hits)
  const outPlayers = [];
  const inPlayers = [];
  let spent = 0;
  const usedIds = new Set();      // incoming ids already selected
  const soldIds = new Set();      // outgoing ids already sold

  for (const c of candidates) {
    if (outPlayers.length >= freeTransfers) break;
    if (usedIds.has(c.in.id)) continue;
    if (spent + c.cost > bank + 0.1) continue;
    outPlayers.push(c.out);
    inPlayers.push(c.in);
    spent += c.cost;
    usedIds.add(c.in.id);
    soldIds.add(c.out.id);
  }

  // Phase 2: Consider hits with break-even analysis
  // A hit is worth it if the cumulative per-GW gain recovers 4 pts within the horizon
  const hitCandidates = [];
  for (const c of candidates) {
    if (usedIds.has(c.in.id)) continue;
    if (soldIds.has(c.out.id)) continue; // Don't sell the same player twice
    if (!c.breaksEven) continue; // Never breaks even within horizon
    if (c.gwAvgGain < 1.5) continue; // Too small per-GW gain
    hitCandidates.push(c);
  }

  let hitTransfers = 0;
  const hitDetails = [];
  for (const c of hitCandidates) {
    if (spent + c.cost > bank + 0.1) continue;
    outPlayers.push(c.out);
    inPlayers.push(c.in);
    spent += c.cost;
    usedIds.add(c.in.id);
    soldIds.add(c.out.id);
    hitTransfers++;
    hitDetails.push({ name: c.in.name, breakEvenGWs: c.breakEvenGWs, gwAvgGain: c.gwAvgGain });
  }

  const hits = hitTransfers * 4;

  return {
    mode: "transfer", transfersIn: inPlayers, transfersOut: outPlayers,
    hitCost: hits, recommendedTransfers: outPlayers.length,
    freeTransfersUsed: Math.min(outPlayers.length, freeTransfers),
    hitDetails,
    hitWarning: hits > 0
      ? `${hitTransfers} hit(s) = -${hits} pts. Break-even: ${hitDetails.map(h => `${h.name} in ~${h.breakEvenGWs} GWs (${h.gwAvgGain} pts/GW)`).join('; ')}.`
      : null
  };
};

// ── Chip Engine: multi-GW lookahead with DGW/BGW detection ──────────────
VG.evaluateChips = (squad, gwPicks, fixtures) => {
  if (!gwPicks || gwPicks.length === 0) {
    return {
      triple_captain: { recommend: false, reason: "No GW data", bestGW: null, score: 0 },
      bench_boost: { recommend: false, reason: "No GW data", bestGW: null, score: 0 },
      wildcard: { recommend: false, reason: "No GW data", bestGW: null, score: 0 },
      free_hit: { recommend: false, reason: "No GW data", bestGW: null, score: 0 },
      gwScores: []
    };
  }

  const gwScores = gwPicks.map(gp => {
    const gw = gp.gw;
    const gwFix = VG.fixturesForGW(fixtures, gw);

    // DGW/BGW detection
    const teamFixCount = {};
    gwFix.forEach(f => {
      teamFixCount[f.team_h] = (teamFixCount[f.team_h] || 0) + 1;
      teamFixCount[f.team_a] = (teamFixCount[f.team_a] || 0) + 1;
    });
    const dgwTeams = Object.entries(teamFixCount).filter(([, c]) => c >= 2).map(([t]) => parseInt(t));
    const isDGW = dgwTeams.length > 0;
    const isBGW = gwFix.length < 10;

    // Captain analysis
    const cap = gp.gotCap?.[0];
    const capGWXP = cap?.gwXP || 0;
    const capIsDGW = cap ? dgwTeams.includes(cap.teamId) : false;
    const capFDR = cap?.gwFDR || 3;

    // Bench analysis
    const benchXP = gp.gwBenchXP || 0;
    const benchDGWCount = gp.bench?.filter(p => dgwTeams.includes(p.teamId)).length || 0;
    const benchAvgXP = gp.bench?.length > 0 ? benchXP / gp.bench.length : 0;

    // ── TC Score ──
    // TC is ONLY good on DGW. Non-DGW TC is almost always a waste.
    // Score: captain_xP * multiplier, where non-DGW gets a 0.15x penalty
    let tcScore = 0;
    if (cap) {
      tcScore = capGWXP * 10;
      if (capIsDGW) {
        // DGW captain: excellent TC window
        tcScore *= 2.5;
        if (capFDR <= 2) tcScore *= 1.5;
        else if (capFDR <= 3) tcScore *= 1.2;
      } else {
        // Non-DGW: heavily penalized — almost never play TC here
        tcScore *= 0.15;
        // Only exception: absurdly high single-GW xP (8.5+) against weak opponent
        if (capGWXP >= 8.5 && capFDR <= 2) tcScore = 60;
        else if (capGWXP >= 9.0 && capFDR <= 3) tcScore = 55;
      }
    }

    // ── BB Score ──
    // BB is ONLY good on DGW when bench players also have doubles.
    // Non-DGW BB is almost never worth it — you only get 4 extra playing slots.
    let bbScore = 0;
    if (benchDGWCount >= 2) {
      // Multiple bench players have DGW — ideal BB
      bbScore = benchXP * 3.5;
      if (benchAvgXP >= 5) bbScore *= 1.4;
    } else if (benchDGWCount === 1) {
      // One bench player has DGW — decent but not ideal
      bbScore = benchXP * 1.8;
    }
    // Non-DGW: bbScore stays 0 — never play BB on a normal GW

    // ── WC Score ──
    // WC should only be recommended when there are actual squad problems:
    // - Many injuries/unavailable players (3+)
    // - Many players with very tough fixtures (7+ with FDR 4-5)
    // Mild early-season value (GW3-6) when form data emerges
    let wcScore = 0;
    // Count injured/unavailable/doubtful players
    const injuredCount = squad.filter(p => {
      const data = VG.players[p.id];
      return data && data.status !== "a";
    }).length;
    // Count players with tough fixtures this GW
    const badFixCount = squad.filter(p => {
      const f = VG.teamFixtures(fixtures, gw, p.teamId)[0];
      if (!f) return false;
      return VG.fixtureFDR(f, p.teamId) >= 4;
    }).length;

    // Injuries are the strongest WC trigger
    if (injuredCount >= 4) wcScore += injuredCount * 15;
    else if (injuredCount >= 3) wcScore += injuredCount * 10;
    // Many tough fixtures — but only if really extreme
    if (badFixCount >= 8) wcScore += (badFixCount - 7) * 10;
    // Mild early-season WC value (react to GW1-3 data, but don't overvalue it)
    if (gw >= 3 && gw <= 5) wcScore += 10;

    // ── FH Score ──
    // FH is valuable on BGW (blanking teams) or large DGW (loading up)
    let fhScore = 0;
    if (isBGW) {
      const blankingTeams = Object.keys(VG.teams).map(Number).filter(t => !teamFixCount[t] || teamFixCount[t] === 0);
      fhScore = 40 + blankingTeams.length * 8;
    }
    if (isDGW && dgwTeams.length >= 6) {
      fhScore = Math.max(fhScore, 25 + dgwTeams.length * 5);
    }

    return {
      gw,
      isDGW, isBGW, dgwTeams,
      tcScore: +tcScore.toFixed(1),
      bbScore: +bbScore.toFixed(1),
      wcScore: +wcScore.toFixed(1),
      fhScore: +fhScore.toFixed(1),
      capName: cap?.name || "",
      capGWXP,
      capIsDGW,
      capFDR,
      benchXP,
      benchDGWCount,
      injuredCount,
      badFixCount
    };
  });

  // Find best GW for each chip
  const bestGW = (key) => gwScores.reduce((best, g) => g[key] > best[key] ? g : best, gwScores[0]);
  const tcBest = bestGW("tcScore");
  const bbBest = bestGW("bbScore");
  const wcBest = bestGW("wcScore");
  const fhBest = bestGW("fhScore");

  // Thresholds for recommendation — conservative: only recommend with strong trigger
  const TC_THRESHOLD = 80;
  const BB_THRESHOLD = 80;
  const WC_THRESHOLD = 50;
  const FH_THRESHOLD = 35;

  return {
    triple_captain: {
      recommend: tcBest.tcScore >= TC_THRESHOLD,
      bestGW: tcBest.gw,
      score: tcBest.tcScore,
      reason: tcBest.tcScore >= TC_THRESHOLD
        ? `GW${tcBest.gw}: ${tcBest.capName} ${tcBest.capIsDGW ? "(DGW!) " : ""}xP ${tcBest.capGWXP.toFixed(1)} · FDR ${tcBest.capFDR}`
        : `No DGW trigger, save for a Double Gameweek`,
      tip: tcBest.tcScore >= TC_THRESHOLD
        ? "Double Gameweek captain, high ceiling play"
        : "TC doubles your captain's points. Only play when your captain has TWO fixtures (DGW) against weak opponents. Classic timing: GW36-37."
    },
    bench_boost: {
      recommend: bbBest.bbScore >= BB_THRESHOLD,
      bestGW: bbBest.gw,
      score: bbBest.bbScore,
      reason: bbBest.bbScore >= BB_THRESHOLD
        ? `GW${bbBest.gw}: Bench xP ${bbBest.benchXP.toFixed(1)}${bbBest.benchDGWCount >= 2 ? ` · ${bbBest.benchDGWCount} DGW players` : ""}`
        : `No DGW bench coverage, save for a Double Gameweek`,
      tip: bbBest.bbScore >= BB_THRESHOLD
        ? "Multiple bench players have double fixtures, ideal BB window"
        : "BB is best in DGW when bench players play twice. Classic sequence: WC → BB → FH → TC. New rule: must use one chip in first half."
    },
    wildcard: {
      recommend: wcBest.wcScore >= WC_THRESHOLD,
      bestGW: wcBest.gw,
      score: wcBest.wcScore,
      reason: wcBest.wcScore >= WC_THRESHOLD
        ? `GW${wcBest.gw}: ${wcBest.injuredCount >= 3 ? wcBest.injuredCount + ' injuries' : wcBest.badFixCount >= 8 ? wcBest.badFixCount + ' tough fixtures' : 'Squad needs restructuring'}`
        : `Squad looks healthy, hold WC for later`,
      tip: wcBest.wcScore >= WC_THRESHOLD
        ? "Significant squad issues detected, WC can fix multiple problems at once"
        : "Save WC until you have 3+ injuries or a run of tough fixtures. Use it to set up for BB. Classic: WC early to fix mistakes, or WC GW32 to prepare for DGW run."
    },
    free_hit: {
      recommend: fhBest.fhScore >= FH_THRESHOLD,
      bestGW: fhBest.gw,
      score: fhBest.fhScore,
      reason: fhBest.fhScore >= FH_THRESHOLD
        ? `GW${fhBest.gw}: ${fhBest.isBGW ? "Blank GW, many teams out" : `DGW with ${fhBest.dgwTeams?.length || 0} double teams`}`
        : `No BGW/DGW trigger, save for a Blank Gameweek`,
      tip: fhBest.fhScore >= FH_THRESHOLD
        ? "Blank Gameweek, use FH to field 11 without hits"
        : "FH lets you pick any 15 players for one week. Best on BGWs. Also powerful in GW38 for differential sprint to win mini-league."
    },
    gwScores
  };
};

// ── Team Strength Ratings (v5.4) ───────────────────────────────────────
// Free Understat npxG/npxGA priors -> per-team attack/defence/overall
// strength indices (100 = league average), 1-20 ranks, and a 1-5 rating
// (5 = elite). Borrowed pattern from FFHUB's sortable attack/defence FDR
// ranks, LiveFPL team ratings and FPL Copilot live team strength.
VG.computeTeamRatings = () => {
  const us = VG.understat;
  if (!us || !us.teams || Object.keys(us.teams).length < 4) return null;
  const entries = Object.entries(us.teams).map(([id, t]) => ({
    id,
    npxg90: Number(t.npxg90) || 0,
    npxga90: Number(t.npxga90) || 0,
    ppda: Number(t.ppda) || 0,
    deep: Number(t.deep) || 0
  }));
  const avg = (key) => {
    const vals = entries.map(e => e[key]).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const avgAtt = avg("npxg90");
  const avgDef = avg("npxga90");
  const rows = entries.map(e => {
    const attIdx = avgAtt > 0 ? (e.npxg90 / avgAtt) * 100 : 100;
    const defIdx = avgDef > 0 && e.npxga90 > 0 ? (avgDef / e.npxga90) * 100 : 100;
    const overallIdx = (attIdx + defIdx) / 2;
    const rating = Math.max(1, Math.min(5, Math.round((overallIdx - 100) / 12 + 3)));
    return {
      id: e.id,
      name: VG.teams[e.id] ? VG.teams[e.id].name : String(e.id),
      short: VG.teams[e.id] ? VG.teams[e.id].short_name : String(e.id),
      npxg90: e.npxg90,
      npxga90: e.npxga90,
      ppda: e.ppda,
      deep: e.deep,
      attIdx: +attIdx.toFixed(0),
      defIdx: +defIdx.toFixed(0),
      overallIdx: +overallIdx.toFixed(0),
      rating
    };
  });
  const rank = (key, outKey) => {
    rows.slice().sort((a, b) => b[key] - a[key]).forEach((r, i) => { r[outKey] = i + 1; });
  };
  rank("attIdx", "attRank");
  rank("defIdx", "defRank");
  rank("overallIdx", "overallRank");
  rows.sort((a, b) => a.overallRank - b.overallRank);
  return rows;
};

// Per-team, per-GW fixture rows for a horizon — shared by the fixture ticker
// and the swing analyser so both never drift apart (two copies used to exist).
VG.teamFixtureRow = (teamId, startGW, nGWs, fixtures) => {
  const row = [];
  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    const f = VG.teamFixtures(fixtures, gw, teamId)[0];
    row.push(f ? VG.fixtureInfo(f, teamId) : null);
  }
  return row;
};

VG.buildFixtureTicker = (startGW, nGWs, fixtures) => {
  const ticker = {};
  Object.values(VG.teams).forEach(t => {
    const row = { name: t.short_name || t.name, id: t.id, fdr: [] };
    VG.teamFixtureRow(t.id, startGW, nGWs, fixtures).forEach((info, i) => {
      const gw = startGW + i;
      row.fdr.push(info
        ? { gw, fdr: info.fdr, opp: info.oppName, isHome: info.isHome }
        : { gw, fdr: 0, opp: "", isHome: false });
    });
    ticker[t.id] = row;
  });
  return ticker;
};

// ── Fixture Swing Analysis: detect easy/hard runs ─────────────────────
VG.analyzeFixtureSwings = (startGW, nGWs, fixtures) => {
  const swings = [];
  Object.values(VG.teams).forEach(t => {
    const fdrs = [];
    const fixtures_list = [];
    VG.teamFixtureRow(t.id, startGW, nGWs, fixtures).forEach((info, i) => {
      const gw = startGW + i;
      if (info) {
        fdrs.push(info.fdr);
        fixtures_list.push({ gw, fdr: info.fdr, opp: info.oppName, isHome: info.isHome });
      } else {
        fdrs.push(0);
        fixtures_list.push({ gw, fdr: 0, opp: "BLANK", isHome: false });
      }
    });
    const validFdrs = fdrs.filter(f => f > 0);
    const avgFDR = validFdrs.length > 0 ? validFdrs.reduce((a, b) => a + b, 0) / validFdrs.length : 3;
    // Detect runs: 3+ consecutive FDR <= 2 = easy run, 3+ consecutive FDR >= 4 = hard run
    let easyRun = 0, hardRun = 0, maxEasy = 0, maxHard = 0;
    let easyStart = -1, hardStart = -1;
    let currentEasyStart = -1, currentHardStart = -1;
    fdrs.forEach((f, i) => {
      if (f > 0 && f <= 2) {
        if (easyRun === 0) currentEasyStart = i;
        easyRun++;
        hardRun = 0;
        if (easyRun > maxEasy) { maxEasy = easyRun; easyStart = currentEasyStart; }
      } else if (f >= 4) {
        if (hardRun === 0) currentHardStart = i;
        hardRun++;
        easyRun = 0;
        if (hardRun > maxHard) { maxHard = hardRun; hardStart = currentHardStart; }
      } else {
        easyRun = 0;
        hardRun = 0;
      }
    });
    swings.push({
      id: t.id,
      name: t.short_name || t.name,
      avgFDR: +avgFDR.toFixed(2),
      fixtures: fixtures_list,
      maxEasyRun: maxEasy,
      maxHardRun: maxHard,
      easyRunGWs: maxEasy >= 3 ? `${startGW + easyStart}-${startGW + easyStart + maxEasy - 1}` : null,
      hardRunGWs: maxHard >= 3 ? `${startGW + hardStart}-${startGW + hardStart + maxHard - 1}` : null
    });
  });
  swings.sort((a, b) => a.avgFDR - b.avgFDR);
  return swings;
};

// ── Captain Rotation Planner ────────────────────────────────────────
// For each GW in the horizon, find the top captain candidates with their
// fixture info, xP, and FDR — so users can plan captain rotation
VG.computeCaptainRotation = (squad, allXP, fixtures, startGW, nGWs) => {
  if (!squad || squad.length < 11 || !allXP || allXP.length === 0) return null;

  const squadIds = new Set(squad.map(p => p.element || p.id));
  const squadXP = allXP.filter(p => squadIds.has(p.id) && p.positionId !== 1);
  const rotation = [];

  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    const candidates = squadXP.map(p => {
      const projection = VG.computePlayerGWProjection(p, gw, fixtures);
      return {
        ...p,
        fdr: projection.fdr,
        oppName: projection.oppName,
        isHome: projection.venue === "H",
        venue: projection.venue,
        fixtureCount: projection.fixtureCount,
        gwXP: projection.gwXP
      };
    }).sort((a, b) => b.gwXP - a.gwXP);

    rotation.push({
      gw,
      top3: candidates.slice(0, 3),
      dgw: candidates.some(p => p.fixtureCount >= 2)
    });
  }
  return rotation;
};

// ── Transfer Roadmap ───────────────────────────────────────────────
// Analyzes squad fixtures across the horizon and recommends transfers per GW
VG.computeTransferRoadmap = (squad, allXP, fixtures, startGW, nGWs) => {
  if (!squad || squad.length < 11 || !allXP || allXP.length === 0 || !fixtures || fixtures.length === 0) return null;

  const roadmap = [];
  const squadIds = new Set(squad.map(p => p.element || p.id));
  const squadXP = allXP.filter(p => squadIds.has(p.id));

  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    const gwData = { gw, players: [], problems: [], recommendations: [] };

    // Analyze each squad player's fixture
    squad.forEach(sp => {
      const pid = sp.element || sp.id;
      const xp = squadXP.find(p => p.id === pid);
      if (!xp) return;
      const info = VG.fixtureInfo(VG.teamFixtures(fixtures, gw, xp.teamId)[0], xp.teamId);
      const gwXP = xp.gwXP || (xp.totalXP / Math.max(nGWs, 1));

      const infoObj = { name: xp.name, position: xp.position, teamId: xp.teamId, fdr: info.fdr, oppName: info.oppName, isHome: info.isHome, gwXP, id: pid, price: xp.price, totalXP: xp.totalXP };
      gwData.players.push(infoObj);

      if (info.fdr >= 4 || info.fdr === 0) {
        gwData.problems.push(infoObj);
      }
    });

    // For each problem player, find the best replacement
    gwData.problems.forEach(prob => {
      const posId = VG.POSITIONS_R[prob.position];
      const upgrades = allXP.filter(p =>
        !squadIds.has(p.id) &&
        p.positionId === posId &&
        p.totalXP > prob.totalXP * 0.9
      ).sort((a, b) => (b.totalXP / b.price) - (a.totalXP / a.price));

      if (upgrades.length > 0) {
        const best = upgrades[0];
        const bestInfo = VG.fixtureInfo(VG.teamFixtures(fixtures, gw, best.teamId)[0], best.teamId);

        gwData.recommendations.push({
          out: prob.name, outFDR: prob.fdr, outOpp: prob.oppName,
          in: best.name, inFDR: bestInfo.fdr, inOpp: bestInfo.oppName, inPrice: best.price, inXP: best.totalXP,
          gain: +(best.totalXP - prob.totalXP).toFixed(1)
        });
      }
    });

    gwData.recommendations.sort((a, b) => b.gain - a.gain);
    roadmap.push(gwData);
  }

  return roadmap;
};

// ── Multi-Week Transfer Planner ────────────────────────────────────────
// Simulates squad across N GWs, identifies weakest players each week,
// finds best replacements, and schedules transfers week-by-week.
// Only recommends hits if cumulative xP gain exceeds hit cost.
VG.computeTransferPlan = (squad, allXP, fixtures, startGW, nGWs, bank) => {
  if (!squad || squad.length < 11 || !allXP || allXP.length === 0 || !fixtures || fixtures.length === 0) return null;

  bank = bank || 0;

  // Build per-GW xP maps for all players
  const allXPMap = {};
  allXP.forEach(p => { allXPMap[p.id] = p; });

  // Current squad as mutable set
  let currentSquadIds = new Set(squad.map(p => p.element || p.id));
  let currentSquadPrices = {};
  squad.forEach(p => { currentSquadPrices[p.element || p.id] = (p.selling_price || p.now_cost || 0) / 10; });
  let remainingBank = bank;

  // Pre-compute per-GW xP for every player
  const perGWXP = {}; // { gw: { pid: gwXP } }
  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    perGWXP[gw] = {};
    allXP.forEach(p => {
      const details = p.gwDetails || [];
      const gwD = details.find(d => d.gw === gw);
      perGWXP[gw][p.id] = gwD ? gwD.xp : (p.totalXP / Math.max(nGWs, 1));
    });
  }

  const schedule = [];
  let totalHits = 0;
  let totalGainFromHits = 0;
  const usedIds = new Set();

  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    const gwTransfer = { gw, transfers: [], hitCost: 0, squadXP: 0 };

    // Compute each squad player's GW xP (using per-GW detail, not average)
    const squadGWXP = [];
    currentSquadIds.forEach(pid => {
      const xp = perGWXP[gw][pid] || 0;
      const info = allXPMap[pid];
      if (!info) return;
      const fInfo = VG.fixtureInfo(VG.teamFixtures(fixtures, gw, info.teamId)[0], info.teamId);
      squadGWXP.push({ id: pid, xp, price: currentSquadPrices[pid] || info.price, positionId: info.positionId, position: info.position, name: info.name, teamId: info.teamId, totalXP: info.totalXP, fdr: fInfo.fdr, oppName: fInfo.oppName, isHome: fInfo.isHome });
    });

    // Only evaluate starters (top 11 by xP) for replacement — bench upgrades rarely matter
    squadGWXP.sort((a, b) => b.xp - a.xp);
    const starters = squadGWXP.slice(0, 11);
    const weakStarters = starters.slice(-4); // Bottom 4 starters are replacement candidates

    gwTransfer.squadXP = +starters.reduce((s, p) => s + p.xp, 0).toFixed(2);

    // Find transfers for weak starters
    const transferOpts = [];
    for (const weak of weakStarters) {
      if (weak.xp < 1.0) continue; // Skip very low-xP placeholders

      const candidates = allXP.filter(p =>
        !currentSquadIds.has(p.id) && !usedIds.has(p.id) &&
        p.positionId === weak.positionId && VG.isAvailable(p) &&
        p.price <= weak.price + remainingBank + 0.5
      );

      for (const cand of candidates) {
        // Compute cumulative xP gain from this GW to end of horizon
        let cumGain = 0;
        for (let g = gw; g < startGW + nGWs; g++) {
          const oldXP = perGWXP[g][weak.id] || 0;
          const newDetail = (cand.gwDetails || []).find(d => d.gw === g);
          const newXP = newDetail ? newDetail.xp : (cand.totalXP / Math.max(nGWs, 1));
          cumGain += newXP - oldXP;
        }
        const cost = +(cand.price - weak.price).toFixed(1);

        if (cumGain > 1.0) { // Minimum 1 xP gain to consider
          transferOpts.push({ out: weak, in: cand, cost, cumGain });
        }
      }
    }

    // Sort by cumulative xP gain (best first)
    transferOpts.sort((a, b) => b.cumGain - a.cumGain);

    // Apply transfers: one free transfer is always available per GW (matches FPL
    // rollover behaviour of 1 FT/week); any further transfer this GW is a hit.
    const freeLeft = 1;

    let gwHitCost = 0;
    for (const opt of transferOpts) {
      if (gwTransfer.transfers.length >= 5) break; // Max 5 transfers per GW
      if (opt.cost > remainingBank + 0.1) continue;
      if (usedIds.has(opt.in.id)) continue;
      if (currentSquadIds.has(opt.in.id)) continue;

      if (gwTransfer.transfers.length < freeLeft) {
        // Free transfer
        gwTransfer.transfers.push({ ...opt, isHit: false });
      } else if (opt.cumGain > 4.0) {
        // Hit is worth it: cumulative gain exceeds 4 pts
        gwHitCost += 4;
        totalHits += 4;
        totalGainFromHits += opt.cumGain;
        gwTransfer.transfers.push({ ...opt, isHit: true });
      } else {
        continue; // Skip, not worth a hit
      }

      // Apply the transfer
      currentSquadIds.delete(opt.out.id);
      currentSquadIds.add(opt.in.id);
      currentSquadPrices[opt.in.id] = opt.in.price;
      remainingBank = +(remainingBank - opt.cost).toFixed(1);
      usedIds.add(opt.in.id);
    }

    gwTransfer.hitCost = gwHitCost;
    schedule.push(gwTransfer);
  }

  // Summary
  const totalSquadXP = schedule.reduce((s, g) => s + g.squadXP, 0);
  const totalTransfers = schedule.reduce((s, g) => s + g.transfers.length, 0);
  const netGain = +(totalGainFromHits - totalHits).toFixed(2);
  const freeTransfersUsed = schedule.reduce((s, g) => s + g.transfers.filter(t => !t.isHit).length, 0);

  return {
    schedule,
    summary: {
      totalSquadXP: +totalSquadXP.toFixed(2),
      totalTransfers,
      totalHits,
      netGainFromHits: netGain,
      freeTransfersUsed,
      avgSquadXP: +(totalSquadXP / nGWs).toFixed(2)
    }
  };
};

// ── Price Change Risk ─────────────────────────────────────────────────
// Single source of truth for price-movement classification.
// Reads the real live-API top-level fields (`transfers_in_event` /
// `transfers_out_event`) with a `stats.*` fallback for synthetic data.
// Classic community thresholds: ~10.5k net in = rise trigger.
VG.predictPriceChanges = (liveData) => {
  if (!liveData || !liveData.elements) return [];
  const RISE = 10500, LIKELY_RISE = 7000, FALL = 5600, LIKELY_FALL = 4000;
  const out = [];
  liveData.elements.forEach(el => {
    const tIn = (el.transfers_in_event ?? el.stats?.transfers_in ?? 0);
    const tOut = (el.transfers_out_event ?? el.stats?.transfers_out ?? 0);
    const net = tIn - tOut;
    let risk = "stable";
    if (net >= RISE) risk = "rising";
    else if (net >= LIKELY_RISE) risk = "likely_rise";
    else if (net <= -FALL) risk = "falling";
    else if (net <= -LIKELY_FALL) risk = "likely_fall";
    if (risk === "stable") return;
    const p = VG.players[el.id];
    const name = p ? (p.web_name || p.second_name) : ("#" + el.id);
    const pos = p ? VG.POSITIONS[p.element_type] : "?";
    const price = p ? (p.now_cost / 10) : 0;
    out.push({ id: el.id, name, position: pos, price, net, risk, pct: +(Math.abs(net) / RISE).toFixed(2) });
  });
  return out.sort((a, b) => b.pct - a.pct);
};

VG.getPriceRisk = async () => {
  const data = VG.bootstrapData;
  if (!data) return [];
  try {
    const live = await VG.fetch(VG.FPL + "/event/" + VG.currentGW + "/live/", "live");
    return VG.predictPriceChanges(live).map(m => {
      const p = data.elements.find(e => e.id === m.id);
      return { id: m.id, name: p ? (p.first_name + " " + p.second_name) : m.name, pos: m.position, price: m.price, net: m.net, risk: m.risk };
    });
  } catch (e) {
    console.warn("[VG] Price risk failed:", e);
    return [];
  }
};

// ── Mini-League Analyzer ────────────────────────────────────────────────
VG.analyzeLeague = async (leagueId, currentGW, fixtures) => {
  if (!leagueId) return null;
  try {
    const data = await VG.fetch(VG.FPL + "/leagues-classic/" + leagueId + "/standings/", "league_" + leagueId);
    if (!data || !data.league || !data.standings) return null;

    const leagueName = data.league.name || "Mini-League";
    const entries = data.standings.results || [];
    if (entries.length === 0) return null;

    // Fetch squads for top 10 managers (API limit)
    const topEntries = entries.slice(0, 10);
    const squads = [];
    const gw = currentGW || VG.currentGW || 1;

    for (const entry of topEntries) {
      try {
        const picksData = await VG.fetch(VG.FPL + "/entry/" + entry.entry + "/event/" + gw + "/picks/", "picks_" + entry.entry);
        if (picksData && picksData.picks) {
          squads.push({
            entry: entry.entry,
            name: entry.player_name || entry.entry_name,
            teamName: entry.entry_name,
            rank: entry.rank,
            totalPoints: entry.total || entry.total_points || 0,
            gwPoints: picksData.entry_history ? picksData.entry_history.points : 0,
            picks: picksData.picks.map(p => {
              const playerInfo = VG.players[p.element];
              return {
                element: p.element,
                id: p.element,
                positionId: playerInfo ? playerInfo.element_type : 0,
                name: playerInfo ? (playerInfo.web_name || playerInfo.second_name) : "Unknown",
                position: playerInfo ? VG.POSITIONS[playerInfo.element_type] : "?",
                teamId: playerInfo ? playerInfo.team : 0,
                multiplier: p.multiplier || 1,
                isCaptain: p.is_captain || p.multiplier > 1
              };
            })
          });
        }
      } catch (e) {
        // Skip entries with no data
      }
    }

    // Ownership analysis across league
    const playerCounts = {};
    let totalSquads = squads.length;
    squads.forEach(sq => {
      sq.picks.forEach(p => {
        if (!playerCounts[p.element]) {
          playerCounts[p.element] = { count: 0, captains: 0, name: p.name, position: p.position, teamId: p.teamId };
        }
        playerCounts[p.element].count++;
        if (p.isCaptain) playerCounts[p.element].captains++;
      });
    });

    // Build ownership data
    const ownership = Object.entries(playerCounts)
      .map(([pid, info]) => ({
        id: parseInt(pid),
        name: info.name,
        position: info.position,
        teamId: info.teamId,
        count: info.count,
        captains: info.captains,
        ownershipPct: totalSquads > 0 ? +((info.count / totalSquads) * 100).toFixed(1) : 0
      }))
      .sort((a, b) => b.ownershipPct - a.ownershipPct);

    // Template: players with >= 30% ownership in league
    const templateIds = new Set(ownership.filter(p => p.ownershipPct >= 30).map(p => p.id));

    // My squad players
    const mySquad = VG.currentResult?.squad || [];
    const myIds = new Set(mySquad.map(p => p.element || p.id));

    // Differentials (in my squad but < 20% in league)
    const differentials = ownership.filter(p => myIds.has(p.id) && p.ownershipPct < 20);

    // Outliers (in league top squads but not in mine)
    const outliers = ownership.filter(p => !myIds.has(p.id) && p.ownershipPct >= 40);

    // Missing from league (in my squad but 0% in league)
    const uniquePicks = ownership.filter(p => myIds.has(p.id) && p.count === 1);

    // Race to the top: Monte Carlo win probability among the fetched squads
    // for this GW, using data already on hand — no extra API calls.
    const myEntry = VG.currentTeamId || 0;
    const race = VG.simulateLeagueRace(squads, fixtures || VG.allFixtures || [], gw, 1500);
    const raceSimulation = race ? {
      entrants: race,
      you: myEntry ? race.find(r => r.entry === myEntry) || null : null,
      sampleSize: squads.length
    } : null;

    return {
      leagueName,
      totalSquads,
      fetchedSquads: squads.length,
      ownership: ownership.slice(0, 30),
      templateIds: [...templateIds],
      differentials,
      outliers,
      uniquePicks,
      raceSimulation,
      // Raw squad objects (entry/picks/multipliers) — consumed by the
      // What-If race scenarios (v5.8); everything else uses the mapped view.
      rawSquads: squads,
      squads: squads.map(s => ({
        name: s.teamName,
        rank: s.rank,
        totalPoints: s.totalPoints,
        gwPoints: s.gwPoints,
        squadSize: s.picks.length,
        captain: s.picks.find(p => p.isCaptain)?.name || "?"
      }))
    };
  } catch (e) {
    console.warn("[VG] League analysis failed:", e);
    return null;
  }
};

// ── Render Engine ─────────────────────────────────────────────────────
VG.render = {};

// ── Full-season FDR planner grid (v5.8, Ben Crellin planner idea) ────
// A single view of every team's fixtures across the whole season: cell shows
// the opponent's difficulty (FDR 1-5, colour-coded) and DGWs/BGWs are marked
// with the fixture count. Built on VG.buildSeasonPlanner + VG.teamSeasonRow
// (which previously had no live caller). Optionally highlights one team's
// row when teamId is given. Returns HTML.
VG.render.seasonPlanner = (fixtures, fromGW, nGWs, teamId) => {
  const planner = VG.buildSeasonPlanner(fixtures || []);
  if (!planner.length) return "";
  const teams = Object.values(VG.teams).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  fromGW = fromGW || 1;
  nGWs = nGWs || 38;
  const end = Math.min(fromGW + nGWs, 39);

  // Fixture lookup per (teamId, gw): {oppId, isHome, fdr} for cell rendering.
  const fxIndex = {};
  (fixtures || []).forEach(f => {
    if (!f.event || f.event < fromGW || f.event >= end) return;
    (["team_h", "team_a"]).forEach(side => {
      const tid = f[side];
      const isHome = side === "team_h";
      const oppId = isHome ? f.team_a : f.team_h;
      const opp = VG.teams[oppId];
      const key = tid + ":" + f.event;
      fxIndex[key] = {
        oppId, isHome,
        fdr: VG.fixtureFDR(f, tid),
        oppShort: opp ? opp.short_name : "?"
      };
    });
  });

  let html = '<div class="data-table" style="overflow-x:auto;"><table style="font-size:0.6rem;border-collapse:collapse;">';
  html += '<tr><th style="text-align:left;position:sticky;left:0;background:#0b1120;">Team</th>';
  for (let g = fromGW; g < end; g++) {
    html += `<th style="text-align:center;">GW${g}</th>`;
  }
  html += '</tr>';

  teams.forEach(t => {
    const row = VG.teamSeasonRow(planner, t.id, fromGW, end - fromGW);
    const isTeam = teamId && t.id === teamId;
    html += `<tr${isTeam ? ' style="background:rgba(0,255,135,0.05);"' : ''}>`;
    html += `<td style="text-align:left;position:sticky;left:0;background:#0b1120;color:${isTeam ? '#00ff87' : '#e2e8f0'};font-weight:${isTeam ? 700 : 400};">${VG.esc(t.short_name)}</td>`;
    const cellMap = {};
    row.cells.forEach(c => { cellMap[c.gw] = c.n; });
    for (let g = fromGW; g < end; g++) {
      const n = cellMap[g];
      const fx = fxIndex[t.id + ":" + g];
      let cell;
      if (n === undefined) {
        cell = '<td style="text-align:center;color:#1e293b;background:#0f172a;" title="No fixture this GW">&middot;</td>';
      } else if (n === 0) {
        cell = '<td style="text-align:center;background:rgba(239,68,68,0.18);color:#ef4444;font-weight:700;" title="Blank gameweek">BGW</td>';
      } else if (n === 2) {
        cell = `<td style="text-align:center;background:rgba(0,255,135,0.18);color:#00ff87;font-weight:700;" title="Double gameweek, two fixtures">DGW ${fx ? VG.esc(fx.oppShort) : ''}</td>`;
      } else if (fx) {
        const c = VG.fdrColor(fx.fdr);
        const mark = fx.isHome ? '' : 'A';
        cell = `<td style="text-align:center;color:${c};background:${c}14;" title="${VG.esc(fx.oppShort)}${fx.isHome ? ' (H)' : ' (A)'} · FDR ${fx.fdr}">${VG.esc(fx.oppShort)}${mark}</td>`;
      } else {
        cell = '<td style="text-align:center;color:#475569;">-</td>';
      }
      html += cell;
    }
    html += '</tr>';
  });
  html += '</table></div>';
  return html;
};

// Watchlist panel for the Strategy tab: watched players with live xP/value/
// recency/market signals + remove buttons. Also a quick-add dropdown so the
// list is editable without hunting through other tabs. Rendered via
// VG.render.tips so it refreshes with every squad re-analysis.
VG.render.watchlist = (allXP) => {
  const list = VG.watchlist();
  const ids = new Set(list);
  const watched = allXP.filter(p => ids.has(p.id));
  const quickAdd = allXP
    .filter(p => !ids.has(p.id) && p.position !== "GK")
    .slice(0, 400)
    .map(p => `<option value="${p.id}">${VG.esc(p.name)} · ${VG.esc(p.teamName)} £${p.price.toFixed(1)}m (${p.totalXP.toFixed(1)} xP)</option>`)
    .join("");
  let html = `<div class="tips-section"><div class="tips-section-header">👀 Watchlist <span style="font-weight:400;color:#475569;font-size:0.65rem;">(${list.length} players, monitors value changes each refresh)</span></div>`;
  if (quickAdd) {
    html += `<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;">`;
    html += `<select id="watchAdd" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px 8px;font-size:0.68rem;flex:1;max-width:420px;"><option value="">+ add a player to watch…</option>${quickAdd}</select>`;
    html += `<button data-action="watch-add" style="background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:0.68rem;cursor:pointer;">Add</button>`;
    html += `</div>`;
  }
  if (watched.length === 0) {
    html += `<p style="color:#475569;font-size:0.7rem;">Add players with the ☆ button in the Compare or Differentials tabs, or use the dropdown above. Watchlist persists in your browser.</p>`;
  } else {
    html += `<table class="data-table" style="font-size:0.7rem;"><tr><th></th><th>Player</th><th>Pos</th><th>Team</th><th>Price</th><th>xP</th><th>xP/£m</th><th>xMins</th><th>Recency</th><th>xG Reg</th><th>Market</th><th></th></tr>`;
    watched.forEach(p => {
      const market = VG.marketBadge(VG.getMarketTag(p));
      const rec = p.recency ? `${p.recency.xgi90.toFixed(2)} xGI/90` : '-';
      html += `<tr><td>${VG.watchToggle(p)}</td><td style="color:#e2e8f0;font-weight:600;">${VG.esc(p.name)}</td><td>${VG.esc(p.position)}</td><td>${VG.esc(p.teamName)}</td><td>£${p.price.toFixed(1)}m</td><td style="color:#00ff87;">${(p.totalXP || 0).toFixed(1)}</td><td>${(p.xpPerPrice || 0).toFixed(2)}</td><td>${(p.xMins || 0).toFixed(0)}</td><td style="color:#a78bfa;">${rec}</td><td>${VG.regressionBadge(p.regression)}</td><td>${market || '-'}</td><td><span data-action="watch-remove" data-player-id="${p.id}" title="Remove" style="cursor:pointer;color:#ef4444;font-size:0.85rem;">✕</span></td></tr>`;
    });
    html += `</table>`;
  }
  html += `</div>`;
  return html;
};
VG.render.teamRatings = (ratings) => {
  if (!ratings || !ratings.length) return '<p style="color:#475569;font-size:0.8rem;">Team strength data unavailable (Understat priors not fetched yet).</p>';
  const ratingColor = { 1: "#ef4444", 2: "#fb923c", 3: "#64748b", 4: "#86efac", 5: "#22c55e" };
  const bar = idx => {
    const w = Math.max(4, Math.min(100, 50 + (idx - 100) / 2));
    const col = idx >= 105 ? "#22c55e" : idx >= 100 ? "#86efac" : idx >= 95 ? "#fb923c" : "#ef4444";
    return `<span style="display:inline-block;width:56px;height:6px;background:#1e293b;border-radius:3px;vertical-align:middle;margin-right:6px;"><span style="display:block;height:6px;width:${w}%;background:${col};border-radius:3px;"></span></span><span style="color:${col};font-weight:700;font-size:0.8rem;">${idx}</span>`;
  };
  let html = '<div class="ticker-scroll"><table class="ticker-table"><thead><tr><th>Team</th><th>Attack (npxG/90)</th><th>Defence (npxGA/90)</th><th>Overall</th><th>Rating</th><th>Press (PPDA)</th></tr></thead><tbody>';
  ratings.forEach(r => {
    const teamColor = VG.teamColor(r.short);
    html += `<tr>
      <td class="ticker-team"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${VG.esc(teamColor)};margin-right:6px;"></span>${VG.esc(r.short)}</td>
      <td>${bar(r.attIdx)} <span style="font-size:0.7rem;color:#64748b;">#${r.attRank}</span></td>
      <td>${bar(r.defIdx)} <span style="font-size:0.7rem;color:#64748b;">#${r.defRank}</span></td>
      <td>${bar(r.overallIdx)} <span style="font-size:0.7rem;color:#64748b;">#${r.overallRank}</span></td>
      <td><span class="fdr-chip" style="background:${ratingColor[r.rating]}20;color:${ratingColor[r.rating]};border:1px solid ${ratingColor[r.rating]}40">${r.rating}/5</span></td>
      <td style="font-size:0.75rem;color:#94a3b8;">${r.ppda ? r.ppda.toFixed(1) : "–"}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  return html;
};

VG.render.pitch = (result) => {
  const starting = result.starting || [];
  // Divide by the horizon actually used, not a hardcoded 12
  const nGWs = Math.max(result.gwPicks?.length || VG.currentHorizon || 1, 1);
  const gotCap = result.gotCap || [];
  // Build from GK up
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  starting.forEach(p => byPos[p.positionId].push(p));
  Object.values(byPos).forEach(arr => arr.sort((a, b) => b.totalXP - a.totalXP));

  // Row order: FWD, MID, DEF, GK (top to bottom)
  const rowDefs = [
    { pos: 4, label: "FWD", y: 18 },
    { pos: 3, label: "MID", y: 37 },
    { pos: 2, label: "DEF", y: 56 },
    { pos: 1, label: "GK", y: 75 }
  ];

  let html = '<div class="pitch-container"><div class="pitch-surface">';
  // Pitch markings
  html += '<div class="pitch-markings"><div class="pitch-hl"></div><div class="pitch-circle"></div><div class="pitch-dot"></div>';
  html += '<div class="pitch-pen top"></div><div class="pitch-pen bottom"></div>';
  html += '<div class="pitch-six top"></div><div class="pitch-six bottom"></div>';
  html += '<div class="pitch-arc top"></div><div class="pitch-arc bottom"></div></div>';

  rowDefs.forEach(rd => {
    const players = byPos[rd.pos];
    if (players.length === 0) return;
    const n = players.length;
    players.forEach((p, i) => {
      const xPct = n === 1 ? 50 : 12 + 76 * i / (n - 1);
      const teamColor = { home: VG.teamColor(p.teamId), away: "#FFFFFF" };
      const isCaptain = gotCap.length > 0 && p.id === gotCap[0].id;
      const isVice = gotCap.length > 1 && p.id === gotCap[1].id;
      html += `<div class="player-card ${VG.POS_SHIRT[p.positionId]}" style="left:${xPct}%;top:${rd.y}%;" data-pid="${p.id}">`;
      html += `<div class="player-shirt" style="background:${teamColor.home};color:${teamColor.away};">`;
      html += `<div class="player-number">${VG.esc(p.positionId === 1 ? VG.teams[p.teamId]?.short_name || "GK" : (VG.players[p.id]?.shirt_number || ""))}</div>`;
      html += '</div>';
      html += `<div class="player-info">`;
      html += `<div class="player-name">${VG.esc(p.name)}</div>`;
      html += `<div class="player-meta">${VG.esc(p.teamName)} · £${p.price.toFixed(1)}m</div>`;
      html += `<div class="player-xp">${(p.totalXP / nGWs).toFixed(1)} xP/GW</div>`;
      html += '</div>';
      if (isCaptain) html += '<div class="captain-badge">C</div>';
      if (isVice) html += '<div class="vice-badge">V</div>';
      html += '</div>';
    });
  });

  html += '</div></div>';
  return html;
};

VG.render.bench = (bench) => {
  if (!bench.length) return "";
  let html = '<div class="bench-section"><div class="bench-label">SUBSTITUTES</div><div class="bench-grid">';
  bench.forEach((p, i) => {
    const teamColor = { home: VG.teamColor(p.teamId), away: "#FFFFFF" };
    html += `<div class="bench-card ${VG.POS_SHIRT[p.positionId]}">`;
    html += `<div class="bench-position">${VG.POSITIONS[p.positionId]}${i + 1}</div>`;
    html += `<div class="bench-shirt" style="background:${teamColor.home};color:${teamColor.away};">${VG.esc(VG.teams[p.teamId]?.short_name || "")}</div>`;
    html += `<div class="bench-name">${VG.esc(p.name)}</div>`;
    html += `<div class="bench-details">£${p.price.toFixed(1)}m · ${(p.totalXP || 0).toFixed(1)} xP</div>`;
    html += '</div>';
  });
  html += '</div></div>';
  return html;
};

// ── Rate My Team (v5.8, FPL Review / FFix "Rate My Team" idea) ───────
// A transparent, component-scored team rating so advice is explainable:
//   25% raw xP strength vs the field, 20% rotation risk (starter xMins),
//   20% formation/positional balance, 20% budget efficiency, 15% captaincy
//    quality vs the best available captain in-squad. Pure function — easy to
//    unit-test. Returns { score, grade, gradeColor, components, advice }.
VG.rateMyTeam = (result, allXP, fixtures, gw) => {
  if (!result || !result.squad || !result.squad.length) return null;
  const squad = result.squad;
  const starting = result.starting || squad.slice(0, 11);
  const byId = {};
  (allXP || []).forEach(p => { byId[p.id] = p; });

  // 1. xP strength vs the field (25%).
  const squadXP = squad.reduce((s, p) => s + (p.totalXP || 0), 0);
  const fieldAvg = (allXP && allXP.length ? allXP.slice(0, Math.floor(allXP.length * 0.3)).reduce((s, p) => s + p.totalXP, 0) / Math.max(1, Math.floor(allXP.length * 0.3)) : 30) * 15;
  const xpScore = Math.min(100, (squadXP / Math.max(fieldAvg, 1)) * 100);

  // 2. Rotation risk — average xMins across starters (20%).
  let xMinsSum = 0, xMinsN = 0;
  starting.forEach(p => {
    const xp = byId[p.id];
    if (xp && xp.xMins > 0) { xMinsSum += xp.xMins; xMinsN++; }
  });
  const avgXMins = xMinsN ? xMinsSum / xMinsN : 75;
  const rotScore = Math.max(0, Math.min(100, (avgXMins / 90) * 100));

  // 3. Formation/positional balance (20%): legal shapes score, double-position
  //    errors score poorly, bench must have a GK + at least one of each other.
  const posCount = { 1: 0, 2: 0, 3: 0, 4: 0 };
  squad.forEach(p => { if (posCount[p.positionId] !== undefined) posCount[p.positionId]++; });
  let formScore = 60;
  if (posCount[1] >= 1 && posCount[2] >= 3 && posCount[3] >= 2 && posCount[4] >= 1) formScore = 100;
  else if (posCount[1] >= 1 && posCount[2] >= 2 && posCount[3] >= 2 && posCount[4] >= 1) formScore = 85;
  if (posCount[1] === 0) formScore = 20;
  if (posCount[1] > 2) formScore -= 15;

  // 4. Budget efficiency (20%): bank + average value.
  const bank = result.budgetRemaining || 0;
  const avgValue = squad.reduce((s, p) => s + (p.xpPerPrice || 0), 0) / Math.max(squad.length, 1);
  const budgetScore = Math.max(0, Math.min(100,
    50 * Math.min(1, bank / 2.0) + 50 * Math.min(1, avgValue / 0.65)
  ));

  // 5. Captaincy quality (15%): captain's per-GW xP vs the best non-GK option.
  const cap = (result.gotCap || [])[0];
  const nonGK = squad.filter(p => (p.positionId || 0) !== 1).slice().sort((a, b) => (byId[b.id]?.totalXP || 0) - (byId[a.id]?.totalXP || 0));
  const bestCapXP = nonGK.length ? byId[nonGK[0].id]?.totalXP || 0 : 0;
  const capXP = cap ? byId[cap.id]?.totalXP || cap.totalXP || 0 : 0;
  const capScore = bestCapXP > 0 ? Math.min(100, (capXP / bestCapXP) * 100) : 70;

  // 6. Efficiency Score (FPL Prophet pattern): mean_xP / coefficient of
  //    variation across the starting XI.  Penalises volatile scorers who
  //    haul one week and blank the next — a lower-floor squad scores less
  //    even if the mean is the same.
  const gwXPs = starting.map(p => {
    const xp = byId[p.id];
    return xp ? (xp.gwXP || xp.totalXP || 0) : 0;
  });
  const gwMean = gwXPs.length ? gwXPs.reduce((a, b) => a + b, 0) / gwXPs.length : 0;
  const gwVar = gwXPs.length > 1 ? gwXPs.reduce((s, v) => s + (v - gwMean) ** 2, 0) / gwXPs.length : 0;
  const gwSD = Math.sqrt(gwVar);
  const cv = gwMean > 0 ? gwSD / gwMean : 1.0;
  const effScore = Math.max(0, Math.min(100, (1 - Math.min(cv, 1.5) / 1.5) * 100));

  const score = Math.round(0.25 * xpScore + 0.20 * rotScore + 0.15 * formScore + 0.20 * budgetScore + 0.15 * capScore + 0.05 * effScore);
  const grade = score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : score >= 50 ? "D" : "F";
  const gradeColor = score >= 80 ? "#00ff87" : score >= 60 ? "#fbbf24" : "#ef4444";

  const advice = [];
  if (rotScore < 60) advice.push("Rotation risk is high: several starters project under 60 minutes. Prioritise nailed players.");
  if (bank > 2.0) advice.push(`£${bank.toFixed(1)}m idle in the bank. Upgrade a mid-range pick to a premium.`);
  if (bank < 0.1) advice.push("Budget fully deployed with no headroom: any premium move needs a sale first.");
  if (capScore < 85) advice.push("Captaincy could be improved: your squad holds a stronger option than the current captain.");
  if (formScore < 90) advice.push("Positional balance is off: aim for at least one GK, three DEF, two MID and one FWD.");
  if (xpScore < 80) advice.push("Squad xP is below the top-third of the player pool: consider wildcard or targeted upgrades.");
  if (effScore < 50) advice.push("High variance in your starting XI — you have many boom-or-bust picks. Consider more consistent scorers for a higher floor.");
  if (!advice.length) advice.push("Strong, balanced squad. Maintain and monitor for injuries.");

  return {
    score, grade, gradeColor,
    components: [
      { label: "xP strength", score: Math.round(xpScore), note: `${squadXP.toFixed(0)} total` },
      { label: "Rotation risk", score: Math.round(rotScore), note: `avg ${avgXMins.toFixed(0)} min` },
      { label: "Formation", score: Math.round(formScore), note: `${posCount[2]}-${posCount[3]}-${posCount[4]}` },
      { label: "Budget", score: Math.round(budgetScore), note: `£${bank.toFixed(1)}m bank` },
      { label: "Captaincy", score: Math.round(capScore), note: cap ? cap.name : "none" },
      { label: "Efficiency", score: Math.round(effScore), note: `CV ${cv.toFixed(2)}` }
    ],
    advice
  };
};

// Rate My Team panel HTML for the Squad tab.
VG.render.rateMyTeam = (result, allXP, fixtures, gw) => {
  const r = VG.rateMyTeam(result, allXP, fixtures, gw);
  if (!r) return "";
  let html = `<div style="margin:14px 0;padding:14px;border:1px solid rgba(251,191,36,0.3);border-radius:12px;background:rgba(251,191,36,0.04);">`;
  html += `<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">`;
  html += `<span style="font-size:0.72rem;color:#fbbf24;font-weight:700;text-transform:uppercase;">⭐ Rate My Team</span>`;
  html += `<span style="font-size:1.6rem;font-weight:800;color:${r.gradeColor};">${r.grade}</span>`;
  html += `<span style="font-size:0.8rem;color:#94a3b8;">${r.score}/100</span>`;
  html += `</div>`;
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:10px;">`;
  r.components.forEach(c => {
    const color = c.score >= 80 ? "#00ff87" : c.score >= 55 ? "#fbbf24" : "#ef4444";
    html += `<div style="background:rgba(30,41,59,0.5);border-radius:8px;padding:8px 10px;font-size:0.66rem;">`;
    html += `<div style="color:#64748b;">${c.label}</div>`;
    html += `<div style="color:${color};font-weight:700;font-size:0.8rem;">${c.score}<span style="font-weight:400;color:#64748b;">/100</span></div>`;
    html += `<div style="color:#94a3b8;">${VG.esc(c.note)}</div>`;
    html += `</div>`;
  });
  html += `</div>`;
  html += `<ul style="margin:10px 0 0;padding-left:18px;font-size:0.68rem;color:#94a3b8;line-height:1.7;">`;
  r.advice.forEach(a => { html += `<li>${VG.esc(a)}</li>`; });
  html += `</ul></div>`;
  return html;
};

VG.render.metrics = (result, extraMetric) => {
  const metrics = [
    { label: "FORMATION", value: `${result.formation.DEF}-${result.formation.MID}-${result.formation.FWD}`, color: "#00ff87" },
    { label: "SQUAD VALUE", value: `£${result.totalCost.toFixed(1)}m`, color: "#06b6d4" },
    { label: "BANK", value: `£${result.budgetRemaining.toFixed(1)}m`, color: result.budgetRemaining > 0.5 ? "#fbbf24" : "#666" },
    { label: "TOTAL xP", value: result.totalXP.toFixed(1), color: "#00ff87" },
    ...(extraMetric ? [extraMetric] : []),
  ];
  return '<div class="metrics-row">' + metrics.map(m =>
    `<div class="metric"><div class="metric-label">${m.label}</div>` +
    `<div class="metric-value" style="color:${m.color}">${m.value}</div>` +
    (m.sub ? `<div class="metric-sub" style="color:#94a3b8;font-size:0.62rem;line-height:1.4;">${m.sub}</div>` : "") +
    `</div>`
  ).join('') + '</div>';
};

// Monte Carlo GW projection metric (v5.5, FPL Review/FFix idea). Samples the
// starting XI's GW points (captain doubled) for a real points distribution.
VG.render.gwProjection = (starting, fixtures, gw, captainId) => {
  if (!starting || !starting.length) return null;
  const withCap = starting.map(p => {
    const isCap = captainId != null && (p.id === captainId || p.element === captainId);
    return {
      ...p, element_type: p.element_type || p.positionId,
      isCaptain: isCap || !!p.isCaptain,
      multiplier: (isCap || p.isCaptain) ? Math.max(p.multiplier || 1, 2) : 1
    };
  });
  const dist = VG.mcGWDistribution(withCap, fixtures, gw, 4000);
  if (!dist.n) return null;
  const range = VG.mcRange(dist);
  const explain = (withCap.find(p => p.isCaptain) ? "captain doubled" : "multiplicators applied");
  return {
    label: "GW" + gw + " xP PROJECTION",
    value: `${dist.mean} ± ${dist.sd}`,
    color: "#a78bfa",
    sub: `90% band ${range.floor}-${range.ceiling} pts (${explain})`
  };
};

// ── Player Profile (v5.6, FPL Review/FFHub player-profile idea) ───────
// Rich one-screen profile per player: form trend, Understat xG, regression,
// EO, set-piece role, fixture run, value, and captain blank-risk.
VG.playerProfileHTML = (p, fixtures, gw) => {
  if (!p) return "";
  const sp = p.setPiece || {};
  const spBadge = VG.setPieceBadge(sp);
  const reg = p.regression;
  const roleTxt = spBadge.trim() ? `<span style="color:#fbbf24;font-weight:600;">${VG.esc(spBadge)}</span>` : '-';
  // Fixture run over next 5 GWs
  const row = VG.teamFixtureRow(p.teamId, gw, 5, fixtures);
  const easy = row.filter(r => r && r.fdr <= 2).length;
  const hard = row.filter(r => r && r.fdr >= 4).length;
  const run = row.map(r => r ? `<span style="color:${VG.fdrColor(r.fdr)};font-weight:600;">${VG.esc(r.oppName)}${r.isHome ? '' : '(A)'}</span>` : `<span style="color:#334155;">BYE</span>`).join(' ');
  const trend = p.form != null && p.ppg ? (p.form / p.ppg).toFixed(2) : "-";
  const market = VG.marketBadge(VG.getMarketTag(p));
  const newBadge = p.isNew
    ? `<span style="background:rgba(96,165,250,0.12);color:#60a5fa;padding:1px 6px;border-radius:4px;font-size:0.62rem;white-space:nowrap;">NEW TO PL · ${p.priorSignal === 'ep_next' ? 'FPL PRIOR' : (p.foreignLeague ? VG.foreignLeagueLabel(p.foreignLeague) + ' PRIOR' : 'UNDERSTAT PRIOR')}</span>`
    : '';
  const transferBadge = p.transferred ? VG.transferBadge({ transferred: true, fromTeam: p.fromTeam ? { short_name: p.fromTeam } : null, toTeam: p.toTeam ? { short_name: p.toTeam } : null }) : '';
  const recLine = p.recency
    ? `<div style="margin-top:4px;">Recency (last ${p.recency.rounds} GWs): <b style="color:#a78bfa;">${p.recency.xgi90.toFixed(2)} xGI/90</b> · <b style="color:#00ff87;">${p.recency.pts90.toFixed(2)} pts/90</b></div>`
    : '';
  return `<div class="profile-panel" style="margin-top:8px;font-size:0.7rem;line-height:1.7;color:#94a3b8;">`
    + `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;">`
    + `<div>Form/PPG trend: <b style="color:${p.trend >= 1.05 ? '#00ff87' : p.trend <= 0.95 ? '#ef4444' : '#e2e8f0'};">${p.trend >= 1.05 ? '🔥' : p.trend <= 0.95 ? '❄️' : ''} ${p.trend != null ? p.trend : '-'}</b></div>`
    + `<div>Real xG/90: <b style="color:#a78bfa;">${(p.realXG90 || 0).toFixed(2)}</b></div>`
    + `<div>xG Reg: ${VG.regressionBadge(reg) || '<span style="color:#475569;">stable</span>'}</div>`
    + `<div>EO: <b style="color:#a78bfa;">${(p.eo || 0).toFixed(1)}</b> (own ${(p.ownership || 0).toFixed(1)}%)</div>`
    + `<div>Set-pieces: ${roleTxt}</div>`
    + `<div>xP/£m: <b style="color:#00ff87;">${(p.xpPerPrice || 0).toFixed(2)}</b></div>`
    + `<div>xMins: <b style="color:${(p.xMins || 0) >= 80 ? '#00ff87' : (p.xMins || 0) >= 60 ? '#fbbf24' : '#ef4444'};">${(p.xMins || 0).toFixed(0)}</b> expected minutes</div>`
    + `<div>Market: ${market || '<span style="color:#475569;">Hold</span>'}</div>`
    + `</div>`
    + (newBadge ? `<div style="margin-top:6px;">${newBadge}</div>` : '')
    + (transferBadge ? `<div style="margin-top:4px;">${transferBadge}</div>` : '')
    + recLine
    + `<div style="margin-top:6px;">Next 5 fixtures: <span style="color:#64748b;">${run}</span></div>`
    + `<div style="margin-top:4px;">Run quality: ${easy} easy · ${hard} hard ${hard >= 3 ? '<span style="color:#ef4444;">sell/hold risk</span>' : easy >= 3 ? '<span style="color:#00ff87;">strong window</span>' : ''}</div>`
    + `<div style="margin-top:4px;"><b style="color:#e2e8f0;">${VG.esc(p.name)}</b> · £${p.price.toFixed(1)}m · ${p.position} · ${VG.esc(p.teamName)} · ${p.totalPoints || 0} pts</div>`
    + `</div>`;
};

// ── Live Rank tracker (v5.6, LiveFPL/FFHub idea) ─────────────────────
// Fetches the user's actual FPL overall rank + GW points + team name from the
// public entry endpoint and renders a slim "where you stand" card. Cached.
VG.fetchTeamRank = async (teamId, gw) => {
  if (!teamId || teamId <= 0) return null;
  const cache = VG._rankCache || {};
  const key = teamId + ":" + gw;
  if (cache[key] && Date.now() - cache[key].t < 5 * 60 * 1000) return cache[key].d;
  try {
    const info = await VG.fetch(VG.FPL + "/entry/" + teamId + "/", "teamrank");
    const ev = info && info.current_event ? info.current_event : gw;
    let gwPts = 0, name = null, overallRank = null;
    if (info) {
      name = (info.player_first_name || "") + " " + (info.player_last_name || "");
      const hist = info.history || [];
      const cur = hist.find(h => h.event === ev) || hist[hist.length - 1];
      if (cur) { gwPts = cur.points || 0; overallRank = cur.overall_rank == null ? null : cur.overall_rank; }
      else { overallRank = info.summary_overall_rank; }
    }
    const d = { name, gwPts, overallRank, ev };
    if (info) VG._rankCache = Object.assign(cache, { [key]: { d, t: Date.now() } });
    return d;
  } catch (e) {
    console.warn("[VG] rank:", e);
    return null;
  }
};

// ── Team News feed (v5.6) — grouped injury/fitness news by team ──────
VG.teamNewsFeed = () => {
  const byTeam = {};
  Object.values(VG.players).forEach(p => {
    if (!VG.hasFitnessFlag(p)) return;
    const chance = p.chance_of_playing_next_round;
    const t = (VG.teams[p.team] || {}).short_name || p.team;
    if (!byTeam[t]) byTeam[t] = [];
    byTeam[t].push({
      name: VG.playerName(p),
      chance: chance === null || chance === undefined ? 100 : Number(chance),
      news: p.news || ""
    });
  });
  Object.keys(byTeam).forEach(t => byTeam[t].sort((a, b) => a.chance - b.chance));
  return byTeam;
};

// DGW/BGW-aware Chip EV calendar (v5.6, Ben Crellin idea). Scores each chip
// per GW using the squad's DGW/BGW exposure (complements evaluateChips).
VG.chipCalendar = (squad, planner) => {
  return (planner || []).map(p => {
    // Squad DGW coverage: how many owned teams double this GW.
    let dgwHits = 0, bgwHits = 0;
    squad.forEach(sp => {
      const tid = sp.teamId;
      if (p.dgwTeams.includes(tid)) dgwHits++;
      if (p.bgwTeams.includes(tid)) bgwHits++;
    });
    // Triple captain EV: best when many captaining options double.
    const tc = dgwHits >= 2 ? 80 + dgwHits * 5 : 30;
    // Bench boost EV: doubles on the bench too.
    const bb = dgwHits >= 3 ? 75 + dgwHits * 4 : 20;
    // Free hit EV: biggest on blank-heavy weeks.
    const fh = p.bgwTeams.length >= 8 ? 90 : p.bgwTeams.length >= 5 ? 60 : 20;
    // Wildcard EV: strong when your squad has many blanks + run-in window.
    const wc = bgwHits >= 2 && (p.gw >= 28 && p.gw <= 34) ? 70 : bgwHits >= 2 ? 50 : 15;
    return { gw: p.gw, dgw: p.dgwTeams.length, bgw: p.bgwTeams.length, tc, bb, fh, wc };
  }).filter(c => c.dgw > 0 || c.bgw > 0 || c.tc >= 60);
};

VG.render.chipCalendar = (cal) => {
  if (!cal || !cal.length) return '<div style="font-size:0.6rem;color:#475569;">Chip windows appear once DGW/BGW are known (after postponements).</div>';
  const best = (c, k) => c[k] >= 70 ? `<b style="color:#00ff87;">${c[k]}</b>` : c[k] >= 50 ? `<b style="color:#fbbf24;">${c[k]}</b>` : `${c[k]}`;
  let h = '<table class="data-table" style="font-size:0.68rem;"><tr><th>GW</th><th>DGW</th><th>BGW</th><th>Triple C</th><th>Bench Boost</th><th>Free Hit</th><th>Wildcard</th></tr>';
  cal.forEach(c => {
    h += `<tr><td style="color:#e2e8f0;font-weight:600;">GW${c.gw}</td><td>${c.dgw ? '<span style="color:#00ff87;">+' + c.dgw + '</span>' : '–'}</td><td>${c.bgw ? '<span style="color:#ef4444;">' + c.bgw + '</span>' : '–'}</td><td>${best(c, 'tc')}</td><td>${best(c, 'bb')}</td><td>${best(c, 'fh')}</td><td>${best(c, 'wc')}</td></tr>`;
  });
  h += '</table>';
  return h;
};

VG.render.chipCard = (label, color, advice) => {
  const active = advice.recommend ? " active" : "";
  const textColor = advice.recommend ? "#00ff87" : "#555";
  const bestGWText = advice.bestGW ? `Best: GW${advice.bestGW}` : "";
  const scoreBar = advice.score > 0 ? `<div class="chip-score-bar"><div class="chip-score-fill" style="width:${Math.min(advice.score / 1.2, 100)}%;background:${advice.recommend ? color : '#334155'}"></div></div>` : '';
  return `<div class="chip${active}" style="border-color:${advice.recommend ? color : 'rgba(255,255,255,0.06)'}">
    <div class="chip-header"><div class="chip-label" style="color:${color}">${label}</div><div class="chip-action" style="color:${textColor}">${advice.recommend ? "PLAY" : "Hold"}</div></div>
    <div class="chip-reason">${VG.esc(advice.reason)}</div>
    ${scoreBar}
    <div class="chip-timing" style="color:#64748b;">${bestGWText}</div>
    ${advice.tip ? `<div class="chip-tip" style="color:#94a3b8;font-size:0.65rem;margin-top:4px;font-style:italic;">💡 ${VG.esc(advice.tip)}</div>` : ''}
  </div>`;
};

VG.render.ticker = (ticker, startGW, nGWs) => {
  const fdrColors = { 1: "#22c55e", 2: "#86efac", 3: "#64748b", 4: "#fb923c", 5: "#ef4444", 0: "#1e293b" };
  let html = '<div class="ticker-scroll"><table class="ticker-table"><thead><tr><th></th>';
  for (let gw = startGW; gw < startGW + nGWs; gw++) html += `<th>GW${gw}</th>`;
  html += '</tr></thead><tbody>';
  Object.entries(ticker).forEach(([, row]) => {
    html += `<tr><td class="ticker-team">${VG.esc(row.name)}</td>`;
    row.fdr.forEach(cell => {
      const bg = fdrColors[cell.fdr] || "#334155";
      html += `<td><div class="fdr-chip" style="background:${bg}20;color:${bg};border:1px solid ${bg}40">${cell.fdr > 0 ? VG.esc(cell.opp) + (cell.isHome ? " (H)" : " (A)") : "–"}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
};

// ── Lineup Intelligence: optimal bench/start suggestions ───────────────
VG.computeLineupAdvice = (squad, allXP, fixtures, gw) => {
  if (!squad || squad.length < 11 || !allXP || !fixtures) return null;
  const players = squad.map(p => {
    const xp = allXP.find(a => a.id === (p.element || p.id));
    if (!xp) return null;
    const projection = VG.computePlayerGWProjection(xp, gw, fixtures);
    const data = VG.players[xp.id];
    const status = data ? data.status : 'a';
    const minutes = parseInt(data?.minutes || '0');
    const starts = parseInt(data?.starts || '0');
    const isNailed = starts >= 25 && minutes > 2000;
    const isDoubtful = status === 'd' || status === 'u';
    return {
      ...xp,
      totalXP: projection.gwXP,
      gwXP: projection.gwXP,
      fixtureCount: projection.fixtureCount,
      fdr: projection.fdr,
      oppName: projection.oppName,
      isHome: projection.venue,
      status,
      isNailed,
      isDoubtful
    };
  }).filter(Boolean);

  // `totalXP` was overwritten above with this GW's projection, so rank on it
  const { formation: bestFmt, starting, bench, byPos, startingXP: bestScore } =
    VG.pickBestXI(players, "totalXP");
  if (!starting.length) return null;

  bench.sort((a, b) => (a.positionId === 1 ? -1 : b.positionId === 1 ? 1 : b.totalXP - a.totalXP));
  const bestPicks = { starting, bench, formation: bestFmt };

  // Generate per-player start/bench reasoning
  const reasoning = bestPicks.starting.map(p => {
    const reasons = [];
    if (p.isDoubtful) reasons.push('⚠ Doubtful, monitor team news');
    if (!p.isNailed && p.fdr >= 4) reasons.push('Tough fixture, rotation risk');
    if (p.fdr <= 2) reasons.push('Excellent fixture, attack/clean sheet opportunity');
    if (p.totalXP >= 7) reasons.push(`High projected return (${p.totalXP.toFixed(1)} xP)`);
    if (p.totalXP < 3) reasons.push('Low xP projection, consider benching');
    if (reasons.length === 0) reasons.push('Solid pick based on xP projection');
    return { name: p.name, position: p.position, totalXP: p.totalXP, fdr: p.fdr, oppName: p.oppName, isHome: p.isHome, reasons, positionId: p.positionId };
  });

  const benchReasoning = bestPicks.bench.map(p => {
    const reasons = [];
    if (p.fdr >= 4) reasons.push(`Tough fixture (FDR ${p.fdr}), benched`);
    if (p.totalXP < 4) reasons.push(`Lower xP (${p.totalXP.toFixed(1)}) than starters`);
    if (p.isDoubtful) reasons.push('Doubtful, risk of 0 minutes');
    if (p.fdr <= 2) reasons.push(`Easy fixture (FDR ${p.fdr}), could haul from bench`);
    if (reasons.length === 0) reasons.push('Bench option, monitor for rotation');
    return { name: p.name, position: p.position, totalXP: p.totalXP, fdr: p.fdr, oppName: p.oppName, isHome: p.isHome, reasons, positionId: p.positionId };
  });

  // Formation comparison
  const altFormations = VG.FORMATIONS
    .map(([DEF, MID, FWD]) => ({ DEF, MID, FWD }))
    .filter(f => f.DEF !== bestFmt.DEF || f.MID !== bestFmt.MID || f.FWD !== bestFmt.FWD)
    .slice(0, 3).map(f => {
    const d = byPos[2].length >= f.DEF ? byPos[2].slice(0, f.DEF) : [];
    const m = byPos[3].length >= f.MID ? byPos[3].slice(0, f.MID) : [];
    const fw = byPos[4].length >= f.FWD ? byPos[4].slice(0, f.FWD) : [];
    if (d.length < f.DEF || m.length < f.MID || fw.length < f.FWD) return null;
    return { formation: `${f.DEF}-${f.MID}-${f.FWD}`, xP: [...d, ...m, ...fw].reduce((s, p) => s + p.totalXP, 0) };
  }).filter(Boolean);

  return {
    formation: `${bestFmt.DEF}-${bestFmt.MID}-${bestFmt.FWD}`,
    starting: reasoning,
    bench: benchReasoning,
    altFormations,
    totalXP: bestScore.toFixed(1)
  };
};

VG.getCaptainReasoning = (cap, fixtures, gw, vice) => {
  if (!cap) return { summary: 'No captain selected', details: [] };
  const reasons = [];
  if (cap.isDoubtful || cap.status === 'd' || cap.status === 'u') reasons.push('⚠ Doubtful, have a VC ready');
  if (cap.fdr <= 2) reasons.push(`Easy fixture (FDR ${cap.fdr}), high scoring potential`);
  if (cap.fdr >= 4) reasons.push(`Tough fixture (FDR ${cap.fdr}), consider alternatives`);
  if (cap.gwXP >= 7) reasons.push(`Elite projection (${cap.gwXP.toFixed(1)} xP): premium captaincy`);
  if (cap.gwXP >= 5 && cap.gwXP < 7) reasons.push(`Strong projection (${cap.gwXP.toFixed(1)} xP): solid captaincy`);
  if (cap.gwXP < 5) reasons.push(`Modest projection (${cap.gwXP.toFixed(1)} xP): look for a better option`);
  if (cap.positionId === 4) reasons.push('Forward: highest ceiling position for captaincy');
  if (cap.positionId === 3 && (cap.price || 0) >= 9) reasons.push('Premium midfielder: consistent point scorer');
  if (cap.positionId === 1 || cap.positionId === 2) reasons.push('Defender/GK captain is very high variance');

  // Blank probability (P: fails to play 60+ mins) + vice-captain EV (v5.3)
  const blank = VG.computeBlankProbability(cap, fixtures, gw);
  if (blank.pBlank >= 0.30) reasons.push(`⚠ High blank risk (${(blank.pBlank * 100).toFixed(0)}%): ${blank.reasons[0] || 'rotation risk'}`);
  else if (blank.pBlank >= 0.15) reasons.push(`Moderate blank risk (${(blank.pBlank * 100).toFixed(0)}%): ${blank.reasons[0] || 'rotation risk'}`);
  else reasons.push(`Low blank risk (${(blank.pBlank * 100).toFixed(0)}%): ${blank.reasons[0] || 'secure minutes'}`);

  const vcEV = VG.computeViceCaptainEV(cap, vice, fixtures, gw);
  if (vcEV >= 1.0) reasons.push(`💡 Strong VC insurance: a quality vice-captain adds ~${vcEV.toFixed(1)} EV`);
  else if (vcEV >= 0.5) reasons.push(`Decent VC insurance (${vcEV.toFixed(1)} EV): pick a low-blank-risk backup`);

  const venue = cap.isHome === 'H'
    ? 'at home'
    : cap.isHome === 'A'
      ? 'away'
      : cap.isHome === 'H/A'
        ? 'across home and away fixtures'
        : 'without a scheduled fixture';
  const summary = `${cap.name} (${cap.position}) ${venue} vs ${cap.oppName} (FDR ${cap.fdr}) · ${cap.gwXP.toFixed(1)} xP · blank ${(blank.pBlank * 100).toFixed(0)}%`;
  return { summary, details: reasons, blank, viceCaptainEV: vcEV };
};

VG.getSquadAnalysis = (result, fixtures, gw) => {
  if (!result || !result.squad) return null;
  const squad = result.squad;
  const weaknesses = [];
  const strengths = [];

  // Budget distribution analysis
  const byCost = { premium: 0, mid: 0, budget: 0 };
  squad.forEach(p => {
    const cost = p.price || 0;
    if (cost >= 9) byCost.premium++;
    else if (cost >= 6) byCost.mid++;
    else byCost.budget++;
  });
  strengths.push(`Budget: ${byCost.premium} premium, ${byCost.mid} mid-range, ${byCost.budget} budget picks`);
  if (byCost.premium >= 4) strengths.push('Multiple premium assets: high ceiling');
  if (byCost.budget >= 8) weaknesses.push('Budget-heavy: may lack consistent haul potential');

  // Team distribution
  const teamCount = {};
  squad.forEach(p => { teamCount[p.teamName] = (teamCount[p.teamName] || 0) + 1; });
  const maxTeam = Object.entries(teamCount).sort((a, b) => b[1] - a[1])[0];
  if (maxTeam && maxTeam[1] >= 3) strengths.push(`Triple-up on ${maxTeam[0]}: strong fixture alignment`);
  if (maxTeam && maxTeam[1] >= 4) weaknesses.push(`4 players from ${maxTeam[0]}: overexposed`);

  // Fixture difficulty
  const { easy: easyFix, hard: hardFix } = VG.countFixtureDifficulty(squad, fixtures, gw);
  if (easyFix >= 6) strengths.push(`${easyFix} players with great fixtures (FDR 1-2)`);
  if (hardFix >= 4) weaknesses.push(`${hardFix} players with tough fixtures (FDR 4-5)`);

  // Captain quality
  if (result.gotCap?.length >= 1) {
    const c = result.gotCap[0];
    if (c.gwXP >= 7) strengths.push(`Captain ${c.name} has elite projection (${c.gwXP.toFixed(1)} xP)`);
  }

  // Formation balance
  const formation = result.formation;
  if (formation) {
    const fwdCount = formation.FWD || 0;
    if (fwdCount >= 3) strengths.push('3-forward formation: aggressive attacking setup');
    if (fwdCount <= 1) weaknesses.push('Only 1 forward: limits attacking ceiling');
  }

  return { strengths, weaknesses };
};

// ── Strategy Tips: championship wisdom ──────────────────────────────────
VG.TIPS = [
  {
    category: "Core Strategy",
    icon: "🏆",
    tips: [
      { title: "Avoid Points Hits", text: "2025/26 champion Erik Ibsen did not take a single points hit all season. \"Better to play a player with a bad fixture than take a hit. It's mathematically never the right call.\"", source: "Erik Ibsen (2025/26 Champion)" },
      { title: "Master Rolling Transfers", text: "Ibsen made zero transfers in 15 out of 38 gameweeks, rolling his free transfers. This gave him 2 free transfers in 8 GWs and 3 in 3 GWs for \"big moves\" to restructure his squad.", source: "Erik Ibsen" },
      { title: "Balance Template vs Differentials", text: "The \"template\" squad has high-ownership players: safe, but limited upside. Top players hunt low-ownership differentials in mid-to-late season to jump up ranks.", source: "General wisdom" },
      { title: "Stay Adaptable", text: "2023/24 champion Jonas Sand Labakk was struggling early and decisively used his Wildcard in GW8. \"You need to think for yourself. You can't let others make all the decisions for you.\"", source: "Jonas Sand Labakk (2023/24 Champion)" }
    ]
  },
  {
    category: "Player Selection",
    icon: "⚽",
    tips: [
      { title: "Invest in Starting Players", text: "Ibsen stresses having 15 regular starters. He strongly advises against picking non-playing \"bench fillers\" just to save money. Every player should get minutes.", source: "Erik Ibsen" },
      { title: "Goalkeeper Rotation", text: "Ibsen experimented with two premium keepers (Raya and Pickford) and rotated them based on fixtures. A rotating GK pair can outperform a single premium pick.", source: "Erik Ibsen" },
      { title: "Captaincy is King", text: "Champion Lovro Budisin scored 29.1% of his total points from his captain, nearly 8% more than the previous season's winner. Captain choice is the single biggest lever.", source: "Lovro Budisin (2024/25 Champion)" },
      { title: "Don't Rely on a Single God", text: "Budisin went almost the entire season without Haaland, allowing him to have multiple captaincy options like Salah, Palmer, and Son. Flexibility beats rigidity.", source: "Lovro Budisin" },
      { title: "Hunt for Value Picks", text: "Budisin chose Isak and Chris Wood. Their combined price (£14.5m) was £0.5m cheaper than Haaland alone, yet they outperformed him as the season's top forwards.", source: "Lovro Budisin" }
    ]
  },
  {
    category: "Chip Strategy",
    icon: "🃏",
    tips: [
      { title: "Classic Chip Sequence", text: "The championship-winning sequence: Wildcard → Bench Boost → Free Hit → Triple Captain, typically around GW32-38 when BGW/DGW clusters appear.", source: "Elite FPL strategy" },
      { title: "Wildcard Timing", text: "Use when your squad needs a major overhaul. Fix early mistakes (like Ibsen did in GW2), reverse bad form (like Labakk in GW8), or prepare for DGWs.", source: "Multiple champions" },
      { title: "Bench Boost in DGW", text: "Classic strategy: Play Bench Boost during a Double Gameweek when all 15 players have fixtures. With new rules forcing one chip in the first half, GW1 is a viable alternative.", source: "FPL experts" },
      { title: "Free Hit for BGWs", text: "Make unlimited free transfers for a single gameweek. Cover Blank Gameweeks when multiple teams have no fixture. Also powerful for GW38 differential sprint.", source: "FPL experts" },
      { title: "Triple Captain in DGW", text: "Play during a Double Gameweek on an in-form player with two favorable fixtures. Never waste it on a single fixture. The upside isn't there.", source: "FPL experts" }
    ]
  },
  {
    category: "Season Timeline",
    icon: "⏰",
    tips: [
      { title: "Early Season (GW1-4)", text: "Be very conservative with transfers for the first 3-4 weeks. Wait for enough data before making critical adjustments. Roll your transfers if possible.", source: "Elite FPL strategy" },
      { title: "Mid-Season (GW15-30)", text: "This is where rank gains happen. Plan around BGW/DGW clusters. Use your Wildcard to set up for the Bench Boost, then Free Hit through the Blank.", source: "Elite FPL strategy" },
      { title: "End of Season (GW36-38)", text: "GW37 is prime for TC or BB. GW38: Use Free Hit to load up on differentials for a final sprint to win your mini-league.", source: "Elite FPL strategy" }
    ]
  },
  {
    category: "Mindset",
    icon: "💎",
    tips: [
      { title: "Patience Beats Recklessness", text: "FPL is a marathon, not a sprint. Patience and discipline will almost always outperform reckless, short-term moves.", source: "General wisdom" },
      { title: "Trust Your Gut", text: "Budisin makes his own decisions right before the deadline and trusts his instincts. Data informs, but intuition decides.", source: "Lovro Budisin" },
      { title: "Avoid Points Hits", text: "It's almost always better to roll your transfer. The math doesn't lie: a 4-point hit needs to outperform by 4+ points to break even.", source: "Multiple champions" }
    ]
  }
];

VG.render.tips = (result, allXP, fixtures, gw) => {
  let html = '';

  // ── Watchlist (v5.8, FFix/FPL Review idea) — players you're monitoring ──
  // localStorage-backed so it survives reloads. Render always (even with no
  // squad analysed yet) so the Strategy tab is useful from first load.
  if (allXP && allXP.length) {
    html += VG.render.watchlist(allXP);
  }

  // ── Dynamic: Your Squad Analysis ──
  if (result && allXP) {
    const tips = [];
    const squad = result.squad || [];
    const gwPicks = result.gwPicks || [];
    const chipAdvice = result.chipAdvice || {};

    // Squad strengths and weaknesses
    const analysis = VG.getSquadAnalysis(result, fixtures, gw);
    if (analysis) {
      html += `<div class="tips-section">`;
      html += `<div class="tips-section-header">📊 Squad DNA: Strengths & Weaknesses</div>`;
      html += `<div class="tips-dna" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">`;
      if (analysis.strengths.length > 0) {
        html += `<div style="background:rgba(0,255,135,0.04);border-radius:8px;padding:10px;">`;
        html += `<div style="color:#00ff87;font-size:0.65rem;font-weight:700;text-transform:uppercase;margin-bottom:4px;">✅ Strengths</div>`;
        analysis.strengths.forEach(s => {
          html += `<div style="font-size:0.7rem;color:#94a3b8;margin-top:3px;">▸ ${VG.esc(s)}</div>`;
        });
        html += `</div>`;
      }
      if (analysis.weaknesses.length > 0) {
        html += `<div style="background:rgba(239,68,68,0.04);border-radius:8px;padding:10px;">`;
        html += `<div style="color:#ef4444;font-size:0.65rem;font-weight:700;text-transform:uppercase;margin-bottom:4px;">⚠ Risks</div>`;
        analysis.weaknesses.forEach(s => {
          html += `<div style="font-size:0.7rem;color:#94a3b8;margin-top:3px;">▸ ${VG.esc(s)}</div>`;
        });
        html += `</div>`;
      }
      html += `</div></div>`;
    }

    // Injury & Availability Watch (FPL fitness flags + news)
    const injuryWatch = VG.injuryNews().slice(0, 12);
    if (injuryWatch.length > 0) {
      html += `<div class="tips-section">`;
      html += `<div class="tips-section-header">🩹 Injury & Availability Watch</div>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">`;
      injuryWatch.forEach(p => {
        const chanceColor = p.chance < 50 ? '#ef4444' : p.chance < 100 ? '#fbbf24' : '#475569';
        html += `<div style="flex:0 0 auto;min-width:180px;background:rgba(30,41,59,0.5);border-radius:8px;padding:8px 10px;font-size:0.68rem;">`;
        html += `<div style="display:flex;justify-content:space-between;gap:8px;">`;
        html += `<span style="color:#e2e8f0;font-weight:600;">${VG.esc(p.name)}</span>`;
        html += `<span style="color:${chanceColor};font-weight:700;">${p.chance < 100 ? p.chance + '%' : VG.esc(p.status || 'risk')}</span>`;
        html += `</div>`;
        html += `<div style="color:#64748b;margin-top:2px;">${VG.esc(p.team)} · ${VG.esc(p.position)}</div>`;
        if (p.news) html += `<div style="color:#94a3b8;margin-top:3px;">${VG.esc(p.news)}</div>`;
        html += `</div>`;
      });
      html += `</div></div>`;
    }

    // Captain analysis
    if (result.gotCap?.length >= 1) {
      const c = result.gotCap[0];
      const capXP = c.gwXP || c.totalXP || 0;
      const gwTotal = result.gwTotalXP || result.gwPicks?.[0]?.gwTotalXP || 0;
      const capShare = gwTotal > 0 ? ((capXP / gwTotal) * 100).toFixed(0) : '?';
      tips.push({
        title: `Captain: ${c.name} (${capXP.toFixed(1)} xP)`,
        text: `Your captain contributes ~${capShare}% of GW${gw} expected points. ${capXP >= 6 ? 'Strong pick, this is a premium captaincy.' : capXP >= 4 ? 'Decent pick, consider alternatives if fixtures worsen.' : 'Weak pick, look for a better option in your squad or via transfer.'}`,
        source: 'VibeGaffer Analysis'
      });
    }

    // Injury/doubtful count
    const injuredCount = VG.countUnavailable(squad);
    if (injuredCount >= 3) {
      tips.push({
        title: `${injuredCount} Injured/Doubtful Players`,
        text: `Your squad has ${injuredCount} players with injury concerns. This is a wildcard trigger: consider using WC to replace them before they lose value.`,
        source: 'VibeGaffer Analysis'
      });
    } else if (injuredCount >= 1) {
      tips.push({
        title: `${injuredCount} Injury Concern(s)`,
        text: `Monitor ${injuredCount} player(s) before the deadline. If they're confirmed out, use your free transfer rather than taking a hit.`,
        source: 'VibeGaffer Analysis'
      });
    }

    // Fixture difficulty
    const hardFixtures = VG.countFixtureDifficulty(squad, fixtures, gw).hard;
    if (hardFixtures >= 6) {
      tips.push({
        title: `${hardFixtures} Players with Hard Fixtures (FDR 4-5)`,
        text: `Over half your squad faces tough opponents this gameweek. If this persists into next GW, consider rolling transfers or using a Wildcard.`,
        source: 'VibeGaffer Analysis'
      });
    }

    // Budget analysis
    if (result.budgetRemaining !== undefined) {
      const bank = result.budgetRemaining;
      if (bank >= 2.0) {
        tips.push({
          title: `£${bank.toFixed(1)}m in the Bank`,
          text: `You have significant budget flexibility. Consider upgrading a mid-range player to a premium for higher ceiling, especially if they have easy fixtures ahead.`,
          source: 'VibeGaffer Analysis'
        });
      } else if (bank < 0.1) {
        tips.push({
          title: 'Budget Fully Utilized',
          text: 'No room for upgrades without selling. If you want to bring in a premium, you\'ll need to downgrade elsewhere first.',
          source: 'VibeGaffer Analysis'
        });
      }
    }

    // Chip recommendations
    if (chipAdvice.triple_captain?.recommend) {
      tips.push({
        title: `TC Window: GW${chipAdvice.triple_captain.bestGW}`,
        text: chipAdvice.triple_captain.reason,
        source: 'Chip Analysis'
      });
    }
    if (chipAdvice.bench_boost?.recommend) {
      tips.push({
        title: `BB Window: GW${chipAdvice.bench_boost.bestGW}`,
        text: chipAdvice.bench_boost.reason,
        source: 'Chip Analysis'
      });
    }
    if (chipAdvice.wildcard?.recommend) {
      tips.push({
        title: `WC Recommended: GW${chipAdvice.wildcard.bestGW}`,
        text: chipAdvice.wildcard.reason,
        source: 'Chip Analysis'
      });
    }

    // Differential opportunity
    const owned = new Set(squad.map(p => p.element || p.id));
    const template = allXP.filter(p => (p.ownership || 0) >= 30 && p.totalXP >= 25);
    const missing = template.filter(p => !owned.has(p.id));
    if (missing.length >= 3) {
      tips.push({
        title: `Missing ${missing.length} Template Players`,
        text: `You're missing popular high-xP picks: ${missing.slice(0, 3).map(p => p.name).join(', ')}. These are highly owned, so if they score well you'll lose rank. Consider whether your differentials can compensate.`,
        source: 'VibeGaffer Analysis'
      });
    }

    if (tips.length > 0) {
      html += `<div class="tips-section">`;
      html += `<div class="tips-section-header">📊 Your Squad Analysis</div>`;
      tips.forEach(tip => {
        html += `<div class="tip-card" style="border-left:3px solid #00ff87;">`;
        html += `<div class="tip-title">${VG.esc(tip.title)}</div>`;
        html += `<div class="tip-text">${VG.esc(tip.text)}</div>`;
        html += `<div class="tip-source">${VG.esc(tip.source)}</div>`;
        html += `</div>`;
      });
      html += `</div>`;
    }
  }

  // ── Team News feed (v5.6) — grouped injury/fitness by team ─────────
  {
    const byTeam = VG.teamNewsFeed();
    const teamKeys = Object.keys(byTeam);
    if (teamKeys.length > 0) {
      html += `<div class="tips-section"><div class="tips-section-header">🩹 Team News & Injuries (by team)</div>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:10px;">`;
      teamKeys.forEach(team => {
        const players = byTeam[team].slice(0, 5);
        html += `<div style="flex:0 0 auto;width:230px;background:rgba(30,41,59,0.5);border-left:3px solid #64748b;border-radius:8px;padding:8px 10px;font-size:0.68rem;">`;
        html += `<div style="color:#a78bfa;font-weight:700;margin-bottom:4px;">${VG.esc(team)}</div>`;
        players.forEach(p => {
          const c = p.chance < 50 ? '#ef4444' : p.chance < 100 ? '#fbbf24' : '#475569';
          html += `<div style="color:#e2e8f0;font-weight:500;">${VG.esc(p.name)} <span style="color:${c};">${p.chance < 100 ? p.chance + '%' : ''}</span></div>`;
          if (p.news) html += `<div style="color:#94a3b8;font-size:0.62rem;margin-left:6px;">${VG.esc(p.news)}</div>`;
        });
        html += `</div>`;
      });
      html += `</div></div>`;
    }
  }

  // ── DGW/BGW-aware Chip EV Calendar (v5.6, Ben Crellin idea) ────────
  const planner = result && VG.buildSeasonPlanner ? VG.buildSeasonPlanner(fixtures || VG.allFixtures) : [];
  if (planner && planner.length && result && result.squad) {
    const chipCal = VG.chipCalendar(result.squad, planner);
    html += `<div class="tips-section"><div class="tips-section-header">💎 Chip EV Calendar <span style="font-weight:400;color:#475569;font-size:0.65rem;">(DGW/BGW-aware)</span></div>`;
    html += VG.render.chipCalendar(chipCal);
    html += `<div style="font-size:0.6rem;color:#475569;margin-top:4px;">Scores 0-100 per GW; 70+ = strong window, 50-70 = decent. Windows populate automatically once DGW/BGW are confirmed after postponements.</div></div>`;
  }

  // ── Static championship tips ──
  VG.TIPS.forEach(section => {
    html += `<div class="tips-section">`;
    html += `<div class="tips-section-header">${section.icon} ${VG.esc(section.category)}</div>`;
    section.tips.forEach(tip => {
      html += `<div class="tip-card">`;
      html += `<div class="tip-title">${VG.esc(tip.title)}</div>`;
      html += `<div class="tip-text">${VG.esc(tip.text)}</div>`;
      html += `<div class="tip-source">${VG.esc(tip.source)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  });
  return html;
};

// ── Live Gameweek Intelligence (v5.3) ──────────────────────────────────
VG.loadLive = async (gw) => {
  try {
    return await VG.fetch(VG.FPL + "/event/" + gw + "/live/", "live GW" + gw);
  } catch (e) {
    console.warn("[VG] Live data failed:", e.message);
    return null;
  }
};

// Compute live points from authoritative `explain` blocks (excludes provisional bonus)
VG.computeLivePoints = (liveData) => {
  if (!liveData || !liveData.elements) return {};
  const pts = {};
  liveData.elements.forEach(el => {
    let total = 0;
    (el.explain || []).forEach(fx => (fx.stats || []).forEach(st => { total += st.points || 0; }));
    pts[el.id] = total;
  });
  return pts;
};

// Predict bonus points from live BPS (top-3 per fixture, official tie-break rules)
VG.predictBonus = (liveData, fixtures, gw) => {
  if (!liveData || !liveData.elements) return {};
  const gwFix = VG.fixturesForGW(fixtures, gw);
  const bonus = {};
  gwFix.forEach(f => {
    const inFix = [];
    liveData.elements.forEach(el => {
      (el.explain || []).forEach(fx => {
        if (fx.fixture === f.id) {
          const mins = el.stats.minutes || 0;
          if (mins > 0) inFix.push({ id: el.id, bps: el.stats.bps || 0 });
        }
      });
    });
    if (inFix.length < 1) return;
    inFix.sort((a, b) => b.bps - a.bps);
    const rank3 = inFix.slice(0, 3);
    // Tie-break: tied 1st → both 3, next 1; tied 2nd → both 2; tied 3rd → both 1
    const ptsByRank = [3, 2, 1];
    let award = [];
    if (rank3.length === 1) award = [3];
    else if (rank3[0].bps === rank3[1].bps) {
      award = rank3.length >= 3 && rank3[0].bps === rank3[2].bps ? [3, 3, 3] : [3, 3, 1];
    } else if (rank3.length >= 3 && rank3[1].bps === rank3[2].bps) {
      award = [3, 2, 2];
    } else {
      award = rank3.map((_, i) => ptsByRank[i]);
    }
    rank3.forEach((p, i) => { if (award[i] !== undefined && award[i] > 0) bonus[p.id] = (bonus[p.id] || 0) + award[i]; });
  });
  return bonus;
};

// Simulate FPL auto-subs: a starter who plays 0 mins is replaced by the first
// bench player (priority order) who played AND keeps the formation legal.
// `liveMinutes` = map of playerId → minutes played.
VG.simulateAutoSubs = (starting, bench, liveMinutes) => {
  if (!starting || !bench) return { starting, subs: [] };
  liveMinutes = liveMinutes || {};
  let adjusted = [...starting];
  const benchPool = [...bench];
  const subs = [];
  const outIds = new Set();

  adjusted.forEach(p => {
    const pid = p.element || p.id;
    if (!VG.hasPlayed(liveMinutes, pid)) outIds.add(pid);
  });

  for (const outPid of outIds) {
    const out = adjusted.find(p => (p.element || p.id) === outPid);
    if (!out) continue;
    for (let i = 0; i < benchPool.length; i++) {
      const sub = benchPool[i];
      const subPid = sub.element || sub.id;
      if (!VG.hasPlayed(liveMinutes, subPid)) continue;
      const temp = adjusted.filter(p => (p.element || p.id) !== outPid).concat([sub]);
      if (!VG.formationLegal(temp)) continue;
      adjusted = temp;
      benchPool.splice(i, 1);
      subs.push({ out: outPid, in: subPid });
      break;
    }
  }
  return { starting: adjusted, subs };
};

// Captain blank probability: P(fails to play 60+ minutes this GW)
VG.computeBlankProbability = (cap, fixtures, gw) => {
  if (!cap) return { pBlank: 0.3, reasons: [] };
  const reasons = [];
  let p = 0.05; // base rate
  const data = VG.players[cap.id];
  if (data) {
    const starts = parseInt(data.starts || "0");
    const minutes = parseInt(data.minutes || "0");
    if (starts >= 30 && minutes >= 2600) { p += 0.01; reasons.push("Nailed starter (30+ starts)"); }
    else if (starts >= 25 && minutes >= 2000) { p += 0.05; reasons.push("Regular starter"); }
    else if (starts >= 15) { p += 0.10; reasons.push("Rotation risk: partial starter"); }
    else { p += 0.20; reasons.push("Not a nailed starter, high rotation risk"); }
    if (data.status === "d") { p += 0.25; reasons.push("⚠ Doubtful (status=d)"); }
    if (data.status === "u") { p += 0.30; reasons.push("⚠ Unavailable risk"); }
    // FPL fitness flag: chance_of_playing_next_round (null when not flagged)
    const chance = data.chance_of_playing_next_round;
    if (chance !== null && chance !== undefined && chance < 100) {
      const pMiss = Math.max(0, Math.min(1, (100 - Number(chance)) / 100));
      if (pMiss > 0.1) {
        p += Math.min(0.35, pMiss * 0.6);
        reasons.push(chance + "% chance to play this GW (FPL fitness flag)");
      }
    }
  }
  const gwFix = VG.teamFixtures(fixtures, gw, cap.teamId);
  gwFix.forEach(f => {
    const isHome = f.team_h === cap.teamId;
    const oppId = isHome ? f.team_a : f.team_h;
    const opp = VG.teams[oppId];
    const oppStr = opp ? (isHome ? opp.strength_overall_away : opp.strength_overall_home) : 1100;
    if (!isHome && oppStr >= 1150) { p += 0.06; reasons.push("Away vs strong side, minutes risk"); }
    if (isHome && oppStr <= 1000) { p -= 0.03; reasons.push("Home vs weak side, locked minutes"); }
  });
  const yellows = parseInt(data?.yellow_cards || "0");
  const games = Math.max(1, parseInt(data?.starts || "0"));
  if (games > 0 && yellows / games > 0.15) { p += 0.03; reasons.push("Card risk"); }
  p = Math.max(0.03, Math.min(0.5, p));
  return { pBlank: +p.toFixed(2), reasons };
};

// Vice-captain EV: every 10% of captain blank = +1.4 EV from the right VC.
// Discounted by the VC's own blank probability — insurance is worthless if
// the VC also blanks.
VG.computeViceCaptainEV = (captain, vice, fixtures, gw) => {
  if (!captain || !vice) return 0;
  const { pBlank: capBlank } = VG.computeBlankProbability(captain, fixtures, gw);
  const { pBlank: vcBlank } = VG.computeBlankProbability(vice, fixtures, gw);
  const vcXP = vice.gwXP || vice.totalXP || 0;
  return +(1.4 * (capBlank / 0.10) * (1 - vcBlank) * Math.min(vcXP / 5, 1.5)).toFixed(2);
};

// Differential matrix zones (ownership vs xP/£m)
VG.getDifferentialZone = (p) => {
  const own = p.ownership || 0;
  const value = p.xpPerPrice || 0;
  const highValue = value >= 2.0;
  if (own < 15 && highValue) return { zone: "gold", label: "Differential Gold", color: "#00ff87" };
  if (own >= 15 && highValue) return { zone: "anchor", label: "Template Anchor", color: "#3b82f6" };
  if (own < 15 && !highValue) return { zone: "wait", label: "Wait & See", color: "#fbbf24" };
  return { zone: "trap", label: "Trap Zone", color: "#ef4444" };
};

// Build the full Live tab panel: team live points, bonus projections,
// auto-sub simulation, and price-change velocity.
VG.renderLive = async (gw, teamId) => {
  const live = await VG.loadLive(gw);
  if (!live || !live.elements || live.elements.length === 0) {
    return '<p style="color:#475569;">No live data available for GW' + gw + '. Live tracking activates when gameweeks are in progress.</p>';
  }

  const livePts = VG.computeLivePoints(live);
  const liveMins = {};
  live.elements.forEach(el => { liveMins[el.id] = el.stats.minutes || 0; });
  const bonus = VG.predictBonus(live, VG.allFixtures, gw);
  const priceMoves = VG.predictPriceChanges(live);
  const gwFixtures = VG.fixturesForGW(VG.allFixtures, gw);
  let playedFixtures = 0;
  gwFixtures.forEach(f => { if (f.finished || f.finished_provisional) playedFixtures++; });

  let html = '';
  html += `<div class="chip-sequence">`;
  html += `<div class="chip-card"><div class="chip-label">GW${gw} Status</div><div class="chip-score" style="color:#60a5fa;font-size:0.8rem;">${playedFixtures}/${gwFixtures.length}</div><div class="chip-advice">fixtures finished</div></div>`;
  html += `<div class="chip-card"><div class="chip-label">Live Points</div><div class="chip-score" style="color:#00ff87;">${live.elements.reduce((s, el) => s + (livePts[el.id] || 0), 0)}</div><div class="chip-advice">all players tracked</div></div>`;
  html += `<div class="chip-card"><div class="chip-label">Price Movers</div><div class="chip-score" style="color:#fbbf24;">${priceMoves.length}</div><div class="chip-advice">rising / falling</div></div>`;
  html += `</div>`;

  // ── Your team (only if teamId provided) ──
  if (teamId > 0) {
    try {
      const picksData = await VG.fetch(VG.FPL + "/entry/" + teamId + "/event/" + gw + "/picks/", "livepicks");
      if (picksData && picksData.picks) {
        const squadPicks = picksData.picks.map(p => {
          const info = VG.players[p.element];
          return {
            element: p.element, id: p.element,
            positionId: info ? info.element_type : 0,
            position: info ? VG.POSITIONS[info.element_type] : "?",
            name: info ? (info.web_name || info.second_name) : ("#" + p.element),
            teamId: info ? info.team : 0,
            isCaptain: !!p.is_captain, isVice: !!p.is_vice_captain,
            multiplier: p.multiplier || 1
          };
        });
        const starting = squadPicks.filter(p => p.multiplier >= 1);
        const bench = squadPicks.filter(p => p.multiplier === 0);
        const cap = squadPicks.find(p => p.isCaptain);
        const vc = squadPicks.find(p => p.isVice);

        const subResult = VG.simulateAutoSubs(starting, bench, liveMins);
        // Points: starters ×multiplier; auto-subbed bench players count at 1×
        let startPts = 0;
        subResult.starting.forEach(p => {
          const mult = (cap && p.isCaptain) ? Math.max(p.multiplier, 1) : p.multiplier;
          startPts += (livePts[p.id] || 0) * Math.max(mult, 1);
        });
        let benchPts = 0;
        bench.forEach(p => {
          if (liveMins[p.id] > 0) benchPts += (livePts[p.id] || 0);
        });
        const total = startPts + benchPts;
        const bp = (cap && bonus[cap.id]) ? bonus[cap.id] * Math.max(cap.multiplier, 1) : 0;

        html += `<div style="margin-top:16px;"><div class="section-title" style="font-size:0.8rem;color:#00ff87;">Your Team · Live GW${gw}</div>`;
        html += `<div class="chip-sequence">`;
        html += `<div class="chip-card"><div class="chip-label">Your Points</div><div class="chip-score" style="color:#00ff87;">${total}</div><div class="chip-advice">starting XI × multiplier</div></div>`;
        html += `<div class="chip-card"><div class="chip-label">Bonus Proj.</div><div class="chip-score" style="color:#fbbf24;">${bonus[cap?.id] ? "+" + bp : "+0"}</div><div class="chip-advice">from live BPS</div></div>`;
        html += `<div class="chip-card"><div class="chip-label">Auto-subs</div><div class="chip-score" style="color:#60a5fa;">${subResult.subs.length}</div><div class="chip-advice">bench players in</div></div>`;
        html += `</div>`;

        html += `<table class="data-table" style="font-size:0.72rem;margin-top:10px;"><tr><th>Player</th><th>Pos</th><th>Mins</th><th>Points</th><th>Bonus</th><th>Status</th></tr>`;
        const all = [...subResult.starting, ...bench];
        all.forEach(p => {
          const isBench = bench.includes(p);
          const playedNow = liveMins[p.id] > 0;
          const pts = (livePts[p.id] || 0) * (p.isCaptain ? Math.max(p.multiplier, 1) : 1);
          const st = !isBench
            ? (playedNow ? '<span style="color:#00ff87;">● playing</span>' : '<span style="color:#ef4444;">● 0 mins, sub risk</span>')
            : (playedNow ? '<span style="color:#60a5fa;">● on bench (played)</span>' : '<span style="color:#334155;">● bench</span>');
          html += `<tr><td style="color:#e2e8f0;">${p.isCaptain ? '(C) ' : p.isVice ? '(VC) ' : ''}${VG.esc(p.name)}</td><td>${p.position}</td><td>${liveMins[p.id] ?? 0}'</td><td style="color:#00ff87;">${pts}</td><td style="color:#fbbf24;">${bonus[p.id] ? '+' + bonus[p.id] : '-'}</td><td>${st}</td></tr>`;
        });
        html += `</table>`;
        if (subResult.subs.length > 0) {
          html += `<div style="margin-top:8px;font-size:0.72rem;color:#60a5fa;">Auto-sub simulation: ${subResult.subs.map(s => `${VG.esc(VG.players[s.out]?.web_name || s.out)} → ${VG.esc(VG.players[s.in]?.web_name || s.in)}`).join(' · ')}</div>`;
        }
        html += `</div>`;
      }
    } catch (e) {
      console.warn("[VG] Live team:", e);
    }
  }

  // ── Price change velocity ──
  if (priceMoves.length > 0) {
    html += `<div style="margin-top:16px;"><div class="section-title" style="font-size:0.8rem;">Price Change Velocity</div>`;
    html += '<div class="price-grid"><div><div class="section-title" style="font-size:0.7rem;color:#00ff87;">Risers</div>';
    const rising = priceMoves.filter(r => r.net > 0).slice(0, 8);
    if (!rising.length) html += '<p style="color:#334155;">No clear risers</p>';
    rising.forEach(r => html += `<div class="price-card"><div><div class="name">${VG.esc(r.name)}</div><div class="detail">${VG.esc(r.position)} · £${r.price.toFixed(1)}m</div></div><span class="risk-badge rise">${r.risk === "rising" ? "rising" : "likely rise"}</span></div>`);
    html += '</div><div><div class="section-title" style="font-size:0.7rem;color:#ef4444;">Fallers</div>';
    const falling = priceMoves.filter(r => r.net < 0).slice(0, 8);
    if (!falling.length) html += '<p style="color:#334155;">No clear fallers</p>';
    falling.forEach(r => html += `<div class="price-card"><div><div class="name">${VG.esc(r.name)}</div><div class="detail">${VG.esc(r.position)} · £${r.price.toFixed(1)}m</div></div><span class="risk-badge fall">${r.risk === "falling" ? "falling" : "likely fall"}</span></div>`);
    html += '</div></div></div>';
  }

  // ── Bonus projections league ──
  const bonusRows = Object.entries(bonus)
    .map(([id, pts]) => {
      const p = VG.players[id];
      return { id: +id, pts, name: p ? (p.web_name || p.second_name) : id, pos: p ? VG.POSITIONS[p.element_type] : "?" };
    })
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 12);
  if (bonusRows.length > 0) {
    html += `<div style="margin-top:16px;"><div class="section-title" style="font-size:0.8rem;">Projected Bonus (live BPS)</div>`;
    html += '<table class="data-table" style="font-size:0.72rem;"><tr><th>Player</th><th>Pos</th><th>Bonus</th></tr>';
    bonusRows.forEach(r => html += `<tr><td style="color:#e2e8f0;">${VG.esc(r.name)}</td><td>${r.pos}</td><td style="color:#fbbf24;">+${r.pts}</td></tr>`);
    html += '</table></div>';
  }

  return html;
};

// ═════════════════════════════════════════════════════════════════════════
// v5.12 — One-stop-shop layer (borrowed patterns, per Borrowing Policy)
//  · GW Briefing        — LazyFPL / fpl.team pre-deadline advisor
//  · Predicted Lineups  — fpl.team / FFScout projected-XI idea
//  · Defensive Outlook  — FFHub / FFix clean-sheet + xGC probabilities
//  · Form-vs-Fixtures   — FFix / FFScout scatter classic
// All pure functions of data already loaded (players, fixtures, allXP,
// recent form), so they run instantly and stay testable in CI.
// ═════════════════════════════════════════════════════════════════════════

// ── Roll-the-transfer / banking strategy (fpl-predict idea) ─────────────
// Projects the squad's xP over the next `horizon` GWs under two paths:
//  spend — swap the cheapest squad player for the single best affordable
//          upgrade this GW, then run the same auto-picked XI/captains;
//  roll  — bank the free transfer and keep the squad as-is.
// Both paths use computePerGWPicks per GW, so lineup + captain choices
// auto-adapt. The difference is the clean "spend or bank" signal.
VG.rollValue = (squad, allXP, fixtures, gw, horizon, bank) => {
  if (!squad || !squad.length || !Array.isArray(allXP)) return null;
  const byId = {};
  allXP.forEach(p => { byId[p.id] = p; });
  const own = squad.map(p => byId[p.id] || p).filter(p => p.id);
  const ownIds = new Set(own.map(p => p.id));
  const h = Math.max(1, Math.min(6, Math.round(horizon || 5)));
  const gwList = [...new Set((fixtures || []).map(f => f.event).filter(g => g && g >= gw && g < gw + h))];
  const project = (ids) => gwList.reduce((sum, g) => {
    const picks = VG.computePerGWPicks(ids.map(id => byId[id]).filter(Boolean), g, fixtures);
    return sum + (picks ? picks.gwTotalXP : 0);
  }, 0);

  const rollXP = project([...ownIds]);

  let transfer = null;
  let spendXP = rollXP;
  const cheapest = own.slice().sort((a, b) => (a.price || 99) - (b.price || 99))[0];
  if (cheapest) {
    const spendable = (cheapest.price || 0) + (bank || 0);
    const best = allXP
      .filter(p => !ownIds.has(p.id) && (p.price || 99) <= spendable + 0.1 && VG.isAvailable(p))
      .sort((a, b) => (b.totalXP || 0) - (a.totalXP || 0))[0];
    if (best) {
      spendXP = project([...ownIds].filter(id => id !== cheapest.id).concat([best.id]));
      transfer = {
        outId: cheapest.id, inId: best.id,
        outName: cheapest.name || VG.playerName(cheapest),
        inName: best.name || VG.playerName(best),
        outPrice: +(cheapest.price || 0).toFixed(1),
        inPrice: +(best.price || 0).toFixed(1),
        inXP: +(best.totalXP || 0).toFixed(1)
      };
    }
  }
  const gain = +(spendXP - rollXP).toFixed(1);
  return {
    rollXP: +rollXP.toFixed(1),
    spendXP: +spendXP.toFixed(1),
    gain,
    transfer,
    call: !transfer
      ? "no affordable upgrade in budget"
      : gain > 4 ? "worth spending the transfer now"
      : gain > 1 ? "marginal, either is fine"
      : "roll the transfer and bank it"
  };
};

// ── GW Briefing (LazyFPL / fpl.team pre-deadline advisor) ───────────────
// One screen that pulls together everything worth checking before a
// deadline: your likely starters' fixture outlook, captain + VC verdicts,
// the best single transfer (with the roll-vs-spend call), a chip hint,
// market/price-risk flags and an injury watch — all from already-computed
// inputs, so it renders instantly and is fully unit-testable.
VG.buildBriefing = (result, allXP, fixtures, gw) => {
  if (!result || !result.squad || !Array.isArray(allXP)) return null;
  const squad = result.squad;
  const byId = {};
  allXP.forEach(p => { byId[p.id] = p; });

  const starting = (result.starting && result.starting.length >= 11 ? result.starting
    : (result.gwPicks && result.gwPicks[0] && result.gwPicks[0].starting) || squad.slice(0, 11));
  const bench = (result.bench && result.bench.length >= 4 ? result.bench
    : (result.gwPicks && result.gwPicks[0] && result.gwPicks[0].bench) || squad.slice(11, 15));

  const project = (p) => {
    const g = VG.computePlayerGWProjection(p, gw, fixtures);
    return Object.assign({}, p, { gwXP: g.gwXP, oppName: g.oppName, venue: g.venue, isHome: g.venue, fdr: g.fdr, fixtureCount: g.fixtureCount });
  };

  // 1) Next-GW outlook across likely starters.
  const proj = starting.slice(0, 11).map(project);
  const scheduled = proj.filter(x => x.fixtureCount > 0);
  const avgFDR = scheduled.length ? +((scheduled.reduce((s, x) => s + (x.fdr || 0), 0)) / scheduled.length).toFixed(2) : null;
  const outlook = {
    avgFDR,
    blanks: proj.filter(x => x.fixtureCount === 0).length,
    doubles: proj.filter(x => x.fixtureCount >= 2).length,
    easy: scheduled.filter(x => (x.fdr || 0) <= 2).length,
    hard: scheduled.filter(x => (x.fdr || 0) >= 4).length
  };

  // 2) Captain + vice verdicts (fresh per-GW projection for reasoning).
  const ranked = proj.filter(x => (x.positionId || 0) !== 1).sort((a, b) => (b.gwXP || 0) - (a.gwXP || 0));
  const cap = ranked[0] || null;
  const vice = ranked[1] || null;
  const capReason = cap ? VG.getCaptainReasoning(cap, fixtures, gw, vice || undefined) : null;
  const captain = cap ? {
    name: cap.name || VG.playerName(cap),
    gwXP: +(cap.gwXP || 0).toFixed(1),
    summary: capReason ? capReason.summary : "",
    details: capReason ? capReason.details : [],
    blank: capReason ? capReason.blank : null
  } : null;
  const viceInfo = vice ? { name: vice.name || VG.playerName(vice), gwXP: +(vice.gwXP || 0).toFixed(1) } : null;

  // 3) Transfer: optimizer output in transfer mode, else the roll-value
  //    "single best upgrade" suggestion (draft squads have no transfers yet).
  const optTx = result.transfersIn && result.transfersIn.length
    ? { out: (result.transfersOut && result.transfersOut[0]) || null, in: result.transfersIn[0], source: "optimizer" }
    : null;
  const roll = VG.rollValue(squad, allXP, fixtures, gw, VG.currentHorizon || 5, result.budgetRemaining || 0);
  const transfer = optTx ? optTx : (roll && roll.transfer ? {
    out: { id: roll.transfer.outId, name: roll.transfer.outName },
    in: { id: roll.transfer.inId, name: roll.transfer.inName, xp: roll.transfer.inXP },
    source: "roll-value"
  } : null);

  // 4) Chip hint from the optimizer's chip advice (object keyed by chip name).
  let chipHint = null;
  const ca = result.chipAdvice;
  if (ca && typeof ca === "object") {
    const chips = ["triple_captain", "bench_boost", "wildcard", "free_hit"];
    const best = chips.reduce((a, k) => (ca[k] && (ca[k].score || 0) > ((a && a.score) || 0)) ? ca[k] : a, null);
    if (best && best.recommend) {
      chipHint = { label: (best.label || best.chip || "").replace(/_/g, " ").toUpperCase(), advice: best.reason || best.advice || "" };
    }
  }

  // 5) Market / price-risk flags for the squad, plus any summer-transfer/new-
  //    club context (v5.13) so a signing's new-environment upside is visible.
  const market = squad.map(p => {
    const e = byId[p.id];
    if (!e) return null;
    const tag = VG.getMarketTag(e);
    return { id: e.id, name: e.name || VG.playerName(e), tag, badge: VG.marketBadge(tag) || null, transferBadge: VG.transferBadge({ transferred: e.transferred, fromTeam: e.fromTeam ? { short_name: e.fromTeam } : null, toTeam: e.toTeam ? { short_name: e.toTeam } : null }), foreignLabel: e.foreignLeague ? VG.foreignLeagueLabel(e.foreignLeague) : "" };
  }).filter(Boolean);

  // 6) Injury / availability watch (raw player fields).
  const injuries = squad.map(p => {
    const pl = VG.players[p.id] || p;
    const chance = pl.chance_of_playing_next_round;
    const flagged = VG.hasFitnessFlag(pl) || (chance !== null && chance !== undefined && chance < 100) || /[du]/.test(pl.status || "");
    if (!flagged) return null;
    return {
      name: pl.web_name || pl.second_name || pl.name || p.name || VG.playerName(p),
      team: (VG.teams[pl.team] && VG.teams[pl.team].short_name) || (p.teamName || "?"),
      chance: (chance === null || chance === undefined) ? null : chance,
      news: pl.news || ""
    };
  }).filter(Boolean);

  // 7) Bench concern: does the best bench player outscore the worst starter?
  const startersSorted = proj.slice().sort((a, b) => (b.gwXP || 0) - (a.gwXP || 0));
  const worstStarter = startersSorted[startersSorted.length - 1];
  const bestBench = bench.slice(0, 4).map(project).slice().sort((a, b) => (b.gwXP || 0) - (a.gwXP || 0))[0];
  let benchConcern = null;
  if (worstStarter && bestBench && (bestBench.gwXP || 0) > (worstStarter.gwXP || 0) + 0.5) {
    benchConcern = {
      note: `${bestBench.name || VG.playerName(bestBench)} (${bestBench.gwXP.toFixed(1)} xP) outscores your weakest starter ${worstStarter.name || VG.playerName(worstStarter)} (${worstStarter.gwXP.toFixed(1)} xP).`,
      worstStarter: worstStarter.name || VG.playerName(worstStarter),
      bestBench: bestBench.name || VG.playerName(bestBench)
    };
  }

  return { gw, outlook, captain, vice: viceInfo, transfer, roll, chipHint, market, injuries, benchConcern };
};

VG.render.briefing = (b) => {
  if (!b) return "";
  let html = '';
  // Outlook strip
  let fdrTone = '';
  if (b.outlook && b.outlook.avgFDR !== null && b.outlook.avgFDR !== undefined) {
    fdrTone = b.outlook.avgFDR <= 2.4 ? "#00ff87" : b.outlook.avgFDR <= 3.2 ? "#fbbf24" : "#ef4444";
  }
  html += '<div class="briefing-outlook">';
  html += `<div class="metric"><div class="name">Avg FDR (XI)</div><div class="value" style="color:${fdrTone};">${b.outlook ? b.outlook.avgFDR : "—"}</div></div>`;
  html += `<div class="metric"><div class="name">Easy (FDR ≤ 2)</div><div class="value">${b.outlook ? b.outlook.easy : 0}</div></div>`;
  html += `<div class="metric"><div class="name">Tough (FDR ≥ 4)</div><div class="value">${b.outlook ? b.outlook.hard : 0}</div></div>`;
  if (b.outlook && b.outlook.doubles > 0) html += `<div class="metric"><div class="name">DGWs</div><div class="value" style="color:#00ff87;">${b.outlook.doubles}</div></div>`;
  if (b.outlook && b.outlook.blanks > 0) html += `<div class="metric"><div class="name">Blanks</div><div class="value" style="color:#ef4444;">${b.outlook.blanks}</div></div>`;
  html += '</div>';

  // Captain + VC
  if (b.captain) {
    html += '<div class="briefing-card"><div class="section-title">Captain</div>';
    html += `<div class="briefing-row"><span style="color:#e2e8f0;font-weight:600;">${VG.esc(b.captain.name)}</span> <span style="color:#00ff87;">${b.captain.gwXP.toFixed(1)} xP</span></div>`;
    if (b.captain.summary) html += `<div style="font-size:0.78rem;color:#94a3b8;margin-top:4px;">${VG.esc(b.captain.summary)}</div>`;
    if (b.vice) html += `<div style="font-size:0.78rem;color:#94a3b8;margin-top:4px;">VC: ${VG.esc(b.vice.name)} (${b.vice.gwXP.toFixed(1)} xP)</div>`;
    (b.captain.details || []).forEach(d => html += `<div style="font-size:0.75rem;color:#64748b;margin-top:2px;">· ${VG.esc(d)}</div>`);
    html += '</div>';
  }

  // Transfer + roll/spend call
  if (b.transfer) {
    html += '<div class="briefing-card"><div class="section-title">Transfer' + (b.transfer.source === "optimizer" ? ' <span style="font-weight:400;color:#475569;">(optimizer)</span>' : '') + '</div>';
    html += `<div style="color:#e2e8f0;">${VG.esc(b.transfer.out ? b.transfer.out.name : "?")} → <span style="color:#00ff87;font-weight:600;">${VG.esc(b.transfer.in.name)}</span>${b.transfer.in.xp ? ` <span style="color:#94a3b8;">(${b.transfer.in.xp} xP)</span>` : ""}</div>`;
    if (b.roll) {
      html += `<div style="font-size:0.75rem;color:#64748b;margin-top:4px;">Roll vs spend: roll ${b.roll.rollXP} xP · spend ${b.roll.spendXP} xP (${b.roll.gain >= 0 ? "+" : ""}${b.roll.gain}). ${VG.esc(b.roll.call)}</div>`;
    }
    html += '</div>';
  } else if (b.roll && b.roll.call) {
    html += '<div class="briefing-card"><div class="section-title">Transfer</div><div style="font-size:0.78rem;color:#64748b;">' + VG.esc(b.roll.call) + '</div></div>';
  }

  // Chip hint
  if (b.chipHint && b.chipHint.label) {
    html += '<div class="briefing-card"><div class="section-title">Chip</div>';
    html += `<div style="color:#e2e8f0;">${VG.esc(b.chipHint.label)}</div>`;
    if (b.chipHint.advice) html += `<div style="font-size:0.78rem;color:#64748b;margin-top:4px;">${VG.esc(b.chipHint.advice)}</div>`;
    html += '</div>';
  }

  // Market flags
  if (b.market && b.market.length) {
    html += '<div class="briefing-card"><div class="section-title">Price risk</div><div class="briefing-tags">';
    b.market.forEach(m => html += `<span class="chip">${VG.esc(m.name)} ${m.badge || ""} ${m.transferBadge || ""}${m.foreignLabel ? '<span style="color:#60a5fa;font-size:0.6rem;"> ' + VG.esc(m.foreignLabel) + '</span>' : ''}</span>`);
    html += '</div></div>';
  }

  // Injury & availability
  html += '<div class="briefing-card"><div class="section-title" style="color:' + (b.injuries && b.injuries.length ? '#fbbf24;' : '#00ff87;') + '">Injury & availability</div>';
  if (b.injuries && b.injuries.length) {
    b.injuries.forEach(i => html += `<div style="font-size:0.78rem;color:#64748b;margin-top:3px;">${VG.esc(i.name)} (${VG.esc(i.team)})${i.chance !== null ? ` · ${i.chance}% chance` : ""}${i.news ? ` · ${VG.esc(i.news)}` : ""}</div>`);
  } else {
    html += '<div style="font-size:0.78rem;color:#64748b;">No squad flags.</div>';
  }
  html += '</div>';

  // Bench concern
  if (b.benchConcern) {
    html += '<div class="briefing-card"><div class="section-title">Bench</div><div style="font-size:0.78rem;color:#94a3b8;">' + VG.esc(b.benchConcern.note) + '</div></div>';
  }

  return html;
};

// ── Predicted lineups for all 20 teams (fpl.team / FFScout idea) ─────────
// Uses the SAME minutes-probability signal as the xP engine (computeFixtureXP
// xMins, which blends start rate + recency + availability + confidence) to
// project each team's most likely XI. A small fix-up pass guarantees the
// classic minimums (4 DEF / 3 MID / 1 FWD) while otherwise trusting xMins,
// so a back-five team keeps 5 defenders if that is genuinely the likely
// lineup. Pre-season (fewer than 2 recorded rounds) renders a notice.
VG.predictedLineups = (gw, fixtures) => {
  const dataRounds = VG.recentFormMaxRounds || 0;
  const rows = Object.values(VG.teams).map(t => {
    const players = Object.values(VG.players).filter(p => p.team === t.id && VG.isAvailable(p));
    if (!players.length) return null;
    const tfs = VG.teamFixtures(fixtures, gw, t.id);
    const scored = players.map(p => {
      let xm = 0;
      if (tfs.length) {
        const isHome = tfs[0].team_h === t.id;
        const oppId = isHome ? tfs[0].team_a : tfs[0].team_h;
        xm = VG.computeFixtureXP(p.id, oppId, isHome, VG.fixtureFDR(tfs[0], t.id)).xMins || 0;
      }
      return { p, xm };
    }).sort((a, b) => b.xm - a.xm);

    const gks = scored.filter(s => s.p.element_type === 1);
    const outfield = scored.filter(s => s.p.element_type !== 1);
    const gk = gks[0] || null;
    const gk2 = gks[1] || null;
    const gkRisk = !!(gk2 && gk2.xm >= 45 && gk.xm - gk2.xm < 45);

    // Default 4-3-3; promote/demote to hit the minimums while favouring
    // whoever actually projects to play. The XI is the projected GK plus the
    // ten outfielders who project for the most minutes.
    const xi = (gk ? [gk] : []).concat(outfield.slice(0, 10));
    const count = (pos) => xi.filter(s => s.p.element_type === pos).length;
    const promote = (pos, min) => {
      // Only demote a position that holds surplus above its own minimum, so
      // fixing one minimum never breaks another (e.g. adding a FWD must not
      // drop DEF below 4).
      const mins = { 1: 1, 2: 4, 3: 3, 4: 1 };
      let guard = 0;
      while (count(pos) < min && guard++ < 12) {
        const repl = outfield.find(s => s.p.element_type === pos && !xi.includes(s));
        if (!repl) break;
        const weak = [...xi].sort((a, b) => a.xm - b.xm).find(s => {
          const c = s.p.element_type;
          return c !== 1 && count(c) > mins[c];
        });
        if (!weak) break;
        xi[xi.indexOf(weak)] = repl;
      }
    };
    promote(2, 4);
    promote(3, 3);
    promote(4, 1);

    const xiIds = new Set(xi.map(s => s.p.id));
    const bench = outfield.filter(s => !xiIds.has(s.p.id)).slice(0, 4);
    const flagged = xi.filter(s => s.xm > 0 && s.xm < 68).map(s => s.p.id);
    const benchPress = bench.filter(s => s.xm >= 82).map(s => s.p.id);

    return {
      teamId: t.id,
      short: t.short_name,
      name: t.name,
      formation: `${count(2)}-${count(3)}-${count(4)}`,
      xi: [...xi].sort((a, b) => a.p.element_type - b.p.element_type || b.xm - a.xm).map(s => ({
        id: s.p.id,
        name: s.p.web_name || s.p.second_name || s.p.first_name,
        pos: VG.POSITIONS[s.p.element_type],
        xm: Math.round(s.xm),
        rotation: flagged.includes(s.p.id)
      })),
      bench: bench.map(s => ({
        id: s.p.id,
        name: s.p.web_name || s.p.second_name || s.p.first_name,
        pos: VG.POSITIONS[s.p.element_type],
        xm: Math.round(s.xm),
        pressing: benchPress.includes(s.p.id)
      })),
      gkRisk,
      fixture: tfs.length ? (tfs[0].team_h === t.id ? `vs ${(VG.teams[tfs[0].team_a] || {}).short_name || "?"}` : `@ ${(VG.teams[tfs[0].team_h] || {}).short_name || "?"}`) : "BLANK",
      fixtureCount: tfs.length
    };
  }).filter(Boolean);
  return { gw, dataRounds, rows };
};

VG.render.predictedLineups = (data) => {
  if (!data) return "";
  if (data.dataRounds < 2) {
    return `<div style="color:#64748b;font-size:0.78rem;">Predicted lineups unlock once GW2+ results are in (they need the 1/3/5-round recency windows). Current data covers ${data.dataRounds} round${data.dataRounds === 1 ? "" : "s"}.</div>`;
  }
  let html = '<div class="pl-grid">';
  data.rows.forEach(r => {
    html += '<div class="pl-card">';
    html += `<div class="pl-head"><span style="color:#e2e8f0;font-weight:600;">${VG.esc(r.short)}</span> <span style="color:#64748b;font-size:0.7rem;">${VG.esc(r.fixture)} · ${r.formation}${r.gkRisk ? ' <span style="color:#fbbf24;">⚠ GK rotation</span>' : ""}</span></div>`;
    r.xi.forEach(s => {
      const flag = s.rotation ? '<span style="color:#fbbf24;" title="Rotation risk">▲</span>' : '';
      html += `<div class="pl-player" style="display:flex;justify-content:space-between;font-size:0.72rem;color:#94a3b8;"><span>${VG.esc(s.pos)} ${VG.esc(s.name)} ${flag}</span><span>${s.xm}′</span></div>`;
    });
    if (r.bench.length) {
      html += `<div style="font-size:0.65rem;color:#475569;margin-top:6px;">Bench: ${r.bench.map(b => `${VG.esc(b.name)} (${b.xm}′${b.pressing ? " · pressing" : ""})`).join(", ")}</div>`;
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
};

// ── Clean-sheet / xGC outlook (FFHub / FFix metric) ──────────────────────
// A display-only Poisson model on the same 1000-scale Elo/strength numbers
// the engine uses. For each team's next fixture: xGF and xGC for both sides,
// P(clean sheet) = e^(-xGC conceded). Sorted by P(CS) so "who do I back to
// keep a clean sheet" is one glance. Recomputation is safe because Elo is
// idempotent (seeds from the buildMaps base snapshot).
VG.teamDefensiveOutlook = (gw, fixtures) => {
  const eloRows = VG.computeTeamElo(fixtures) || [];
  const elo = {};
  eloRows.forEach(r => { elo[r.id] = r; });
  const teamRows = Object.values(VG.teams).map(t => {
    const tfs = VG.teamFixtures(fixtures, gw, t.id);
    if (!tfs.length) return null;
    const f = tfs[0];
    const isHome = f.team_h === t.id;
    const oppId = isHome ? f.team_a : f.team_h;
    const opp = VG.teams[oppId];
    const me = elo[t.id] || {};
    const them = elo[oppId] || {};
    const meAtt = me.att || 1000, meDef = me.def || 1000;
    const themAtt = them.att || 1000, themDef = them.def || 1000;
    const homeAdj = isHome ? 0.22 : -0.22;
    const xgf = Math.min(3.2, Math.max(0.25, 1.35 + (meAtt - themDef) / 300 + homeAdj));
    const xgc = Math.min(3.2, Math.max(0.25, 1.35 + (themAtt - meDef) / 300 - homeAdj));
    const cs = Math.exp(-xgc);
    return {
      teamId: t.id, short: t.short_name,
      opp: opp ? opp.short_name : "?", venue: isHome ? "H" : "A",
      xgf: +xgf.toFixed(2), xgc: +xgc.toFixed(2),
      cs: +cs.toFixed(3), csPct: +(cs * 100).toFixed(1),
      fixtureCount: tfs.length
    };
  }).filter(Boolean);
  teamRows.sort((a, b) => b.cs - a.cs);
  teamRows.forEach((r, i) => { r.rank = i + 1; });
  return teamRows;
};

VG.render.teamDefensiveOutlook = (rows) => {
  if (!rows || !rows.length) return "";
  let html = '<table class="data-table" style="font-size:0.72rem;"><tr><th>#</th><th>Team</th><th>Next</th><th>xGF</th><th>xGC</th><th>P(CS)</th></tr>';
  rows.forEach(r => {
    const tone = r.csPct >= 40 ? "#00ff87" : r.csPct >= 25 ? "#fbbf24" : "#94a3b8";
    html += `<tr><td>${r.rank}</td><td style="color:#e2e8f0;">${VG.esc(r.short)}</td><td>${r.venue === "H" ? "vs" : "@"} ${VG.esc(r.opp)}${r.fixtureCount > 1 ? ' <span style="color:#00ff87;">DGW</span>' : ""}</td><td>${r.xgf}</td><td>${r.xgc}</td><td style="color:${tone};font-weight:600;">${r.csPct}%</td></tr>`;
  });
  html += '</table>';
  return html;
};

// ── Form vs Fixture Difficulty scatter (FFix / FFScout classic) ──────────
// X-axis = the player's next-GW fixture difficulty (FDR 1-5; a blank counts
// as the worst, 5). Y-axis = FPL form. Points coloured by position. The data
// builder is pure (testable); the renderer is a thin Chart.js wrapper.
VG.formFixturesData = (allXP, fixtures, gw) => {
  const datasets = { GK: [], DEF: [], MID: [], FWD: [] };
  (allXP || []).forEach(p => {
    const label = VG.POSITIONS[p.positionId] || "MID";
    const fx = VG.teamFixtures(fixtures, gw, p.teamId);
    let fdr = 5;
    if (fx.length) fdr = VG.fixtureFDR(fx[0], p.teamId);
    const form = +parseFloat(p.form || "0").toFixed(1);
    datasets[label].push({ x: fdr, y: form, id: p.id, name: p.name });
  });
  return datasets;
};

VG.render.formFixturesChart = (canvasId, allXP, fixtures, gw) => {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return;
  const datasets = VG.formFixturesData(allXP, fixtures, gw);
  const colors = { GK: '#06b6d4', DEF: '#22c55e', MID: '#a78bfa', FWD: '#fbbf24' };
  const ds = Object.keys(datasets).map(label => ({
    label,
    data: datasets[label],
    backgroundColor: colors[label] + "aa",
    borderColor: colors[label],
    pointRadius: 3
  }));
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas, {
    type: 'scatter',
    data: { datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: {
          min: 1, max: 5, title: { display: true, text: 'Fixture difficulty (next GW)', color: '#64748b', font: { size: 10 } },
          ticks: { stepSize: 1, color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          title: { display: true, text: 'Form (last 5)', color: '#64748b', font: { size: 10 } },
          ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' }
        }
      },
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.raw.name || ''} (FDR ${ctx.raw.x}, form ${ctx.raw.y})` } }
      }
    }
  });
};
