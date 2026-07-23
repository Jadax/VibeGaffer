const VG = {};

VG.FPL = "https://fantasy.premierleague.com/api";
VG.POSITIONS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
VG.POS_TARGET = { 1: 2, 2: 5, 3: 5, 4: 3 };
VG.POS_SHIRT = { 1: "gk", 2: "def", 3: "mid", 4: "fwd" };
VG.CACHE_TTL = 1800000;

VG.TEAM_COLORS = {
  1: { home: "#EF0107", away: "#FFFFFF" },
  2: { home: "#DA291C", away: "#FFFFFF" },
  3: { home: "#003090", away: "#FFFFFF" },
  4: { home: "#6C1D45", away: "#FFFFFF" },
  5: { home: "#0057B8", away: "#FDB913" },
  6: { home: "#FBEE23", away: "#000000" },
  7: { home: "#C8102E", away: "#FFFFFF" },
  8: { home: "#FDB913", away: "#1B1B1B" },
  9: { home: "#EE2737", away: "#FFFFFF" },
  10: { home: "#003399", away: "#FFFFFF" },
  11: { home: "#6CABDD", away: "#1C2C5B" },
  12: { home: "#0057B8", away: "#FFFFFF" },
  13: { home: "#00B2A9", away: "#FFFFFF" },
  14: { home: "#003090", away: "#FFFFFF" },
  15: { home: "#003090", away: "#FBEE23" },
  16: { home: "#EE2737", away: "#FFFFFF" },
  17: { home: "#132257", away: "#FFFFFF" },
  18: { home: "#FFFFFF", away: "#DB0007" },
  19: { home: "#7A263A", away: "#FFFFFF" },
  20: { home: "#FDB913", away: "#000000" }
};

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

VG.fetch = async (url, label) => {
  const c = VG.cache.get(url);
  if (c) return c;
  const setStatus = (t) => { const el = document.getElementById("status"); if (el) el.innerHTML = t; };
  setStatus('<span class="status-dot warning"></span> Fetching ' + (label || "data") + '...');
  let lastErr = null;
  for (const proxy of VG.PROXIES) {
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

VG.loadSquad = async (tid, gw) => {
  const [info, picks] = await Promise.all([
    VG.fetch(VG.FPL + "/entry/" + tid + "/", "team"),
    VG.fetch(VG.FPL + "/entry/" + tid + "/event/" + gw + "/picks/", "picks")
  ]);
  return { info, picks };
};

VG.buildMaps = (data) => {
  VG.players = {};
  VG.playersByTeam = {};
  VG.teams = {};
  data.elements.forEach(p => {
    VG.players[p.id] = p;
    if (!VG.playersByTeam[p.team]) VG.playersByTeam[p.team] = [];
    VG.playersByTeam[p.team].push(p.id);
  });
  data.teams.forEach(t => { VG.teams[t.id] = t; });
  VG.gwData = data.events;
  VG.currentGW = data.events.find(e => e.is_current)?.id || data.events.find(e => e.is_next)?.id || 1;
};

// ── xP Engine: proper FPL scoring model ──────────────────────────────────
VG.computeFixtureXP = (pid, oppTeamId, isHome, fdr) => {
  const p = VG.players[pid];
  if (!p) return { xp: 0, mins: 0, cs: 0, goal: 0, assist: 0, bonus: 0 };

  const pos = p.element_type;
  const price = p.now_cost / 10;
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
  const totalPts = parseInt(p.total_points || "0");
  const ppg = parseFloat(p.points_per_game || "0");
  const form = parseFloat(p.form || "0");
  const ict = parseFloat(p.ict_index || "0");
  const influence = parseFloat(p.influence || "0");
  const creativity = parseFloat(p.creativity || "0");
  const threat = parseFloat(p.threat || "0");

  // Minutes probability
  const gamesPlayed = starts || Math.max(1, Math.ceil(mins / 80));
  const avgMins = gamesPlayed > 0 ? mins / gamesPlayed : 0;
  let minsProb;
  if (mins < 90 || starts === 0) {
    minsProb = 0.3;
  } else if (avgMins >= 85) {
    minsProb = 0.92;
  } else if (avgMins >= 70) {
    minsProb = 0.80;
  } else if (avgMins >= 55) {
    minsProb = 0.65;
  } else {
    minsProb = 0.45;
  }

  // Confidence adjustment: more data = more reliable
  const seasonGames = 38;
  const dataConfidence = Math.min(1.0, gamesPlayed / Math.max(seasonGames * 0.5, 10));
  const confidenceMult = 0.5 + 0.5 * dataConfidence;

  // Per-90 rates
  const nineties = mins > 0 ? mins / 90 : 1;
  const goalsPer90 = goals / nineties;
  const assistsPer90 = assists / nineties;
  const csRate = cleanSheets / Math.max(gamesPlayed, 1);
  const savesPerGame = saves / Math.max(gamesPlayed, 1);
  const bonusPerGame = bonus / Math.max(gamesPlayed, 1);
  const yellowsPerGame = yellows / Math.max(gamesPlayed, 1);
  const redsPerGame = reds / Math.max(gamesPlayed, 1);
  const ownGoalsPerGame = ownGoals / Math.max(gamesPlayed, 1);
  const penMissPerGame = penMiss / Math.max(gamesPlayed, 1);

  // Fixture difficulty multipliers
  const fdrMult = { 1: 1.35, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.65 };
  const attMult = fdrMult[fdr] || 1.0;
  const defMult = fdrMult[6 - (fdr || 3)] || 1.0;

  // Team strength adjustment
  const teamId = p.team;
  const team = VG.teams[teamId];
  const opp = VG.teams[oppTeamId];
  let teamStrMult = 1.0;
  if (team && opp) {
    const teamStr = (team.strength_overall_home + team.strength_overall_away) / 2;
    const oppStr = (opp.strength_overall_home + opp.strength_overall_away) / 2;
    teamStrMult = 0.85 + 0.30 * ((teamStr - oppStr + 3) / 6);
  }

  // Projected rates (blend historical + form-adjusted)
  const projGoalsPer90 = goalsPer90 * attMult * teamStrMult * confidenceMult + 0.05 * (1 - confidenceMult);
  const projAssistsPer90 = assistsPer90 * attMult * teamStrMult * confidenceMult + 0.03 * (1 - confidenceMult);

  // Clean sheet probability by position and FDR
  const baseCSPos = { 1: 0.35, 2: 0.30, 3: 0.08, 4: 0 };
  const baseCS = (baseCSPos[pos] || 0) * defMult * teamStrMult;
  const projCS = Math.min(Math.max(baseCS * confidenceMult + csRate * confidenceMult * defMult, 0), 0.70);

  // Goal probability (per fixture)
  const projGoals = Math.min(projGoalsPer90 * (isHome ? 1.10 : 1.0), 0.85);
  // Assist probability (per fixture)
  const projAssists = Math.min(projAssistsPer90 * (isHome ? 1.10 : 1.0), 0.85);

  // Bonus probability (rough: based on ICT + form)
  const projBonus = Math.min(bonusPerGame * confidenceMult + (pos === 3 || pos === 4 ? 0.15 : 0.08), 1.0);

  // FPL scoring
  const GOAL_PTS = { 1: 6, 2: 6, 3: 5, 4: 4 };
  const ASSIST_PTS = 3;
  const CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
  const APPEARANCE_PTS = 2; // 60+ mins

  // xP calculation per fixture
  const xpAppearance = minsProb * APPEARANCE_PTS;
  const xpCS = projCS * (CS_PTS[pos] || 0);
  const xpGoals = projGoals * (GOAL_PTS[pos] || 4);
  const xpAssists = projAssists * ASSIST_PTS;
  const xpBonus = projBonus * 1.5; // avg ~1.5 pts from bonus when awarded
  const xpSaves = pos === 1 ? Math.min(savesPerGame / 3, 1.0) * 3 * defMult * confidenceMult : 0;
  const xpNegative = minsProb * (yellowsPerGame * 1 + redsPerGame * 3 + ownGoalsPerGame * 2 + penMissPerGame * 2);

  const totalXP = xpAppearance + xpCS + xpGoals + xpAssists + xpBonus + xpSaves - xpNegative;

  return {
    xp: Math.max(totalXP, 0.1),
    minsProb,
    csProb: projCS,
    goalProb: projGoals,
    assistProb: projAssists,
    bonusProb: projBonus,
    fdr,
    xpComponents: { xpAppearance, xpCS, xpGoals, xpAssists, xpBonus, xpSaves, xpNegative }
  };
};

VG.computeMultiGWXP = (pid, startGW, nGWs, fixtures) => {
  const p = VG.players[pid];
  if (!p) return { totalXP: 0, gwDetails: [], info: {} };

  const teamId = p.team;
  const upcoming = fixtures.filter(f =>
    (f.team_h === teamId || f.team_a === teamId) && f.event >= startGW && f.event < startGW + nGWs
  );

  let totalXP = 0;
  const gwDetails = [];

  if (upcoming.length === 0) {
    // Pre-season / no fixtures: estimate from form and ppg
    const ppg = parseFloat(p.points_per_game || "0");
    const form = parseFloat(p.form || "0");
    totalXP = nGWs * Math.max(ppg, form, 1.0) * 0.6;
  } else {
    upcoming.forEach(f => {
      const isHome = f.team_h === teamId;
      const oppId = isHome ? f.team_a : f.team_h;
      const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
      const res = VG.computeFixtureXP(pid, oppId, isHome, fdr || 3);
      res.gw = f.event;
      res.opponent = VG.teams[oppId]?.short_name || "?";
      res.venue = isHome ? "H" : "A";
      gwDetails.push(res);
      totalXP += res.xp;
    });
  }

  const price = p.now_cost / 10;
  return {
    totalXP: +totalXP.toFixed(2),
    gwDetails,
    info: {
      id: pid,
      name: p.web_name || p.second_name || p.first_name,
      fullName: p.first_name + " " + p.second_name,
      position: VG.POSITIONS[p.element_type],
      positionId: p.element_type,
      teamId,
      teamName: VG.teams[teamId]?.short_name || "",
      price,
      form: Math.max(parseFloat(p.form || "0"), parseFloat(p.points_per_game || "0"), 0),
      totalPoints: parseInt(p.total_points || "0"),
      ict: parseFloat(p.ict_index || "0"),
      ownership: parseFloat(p.selected_by_percent || "0"),
      xpPerPrice: 0,
      totalXP: +totalXP.toFixed(2),
      status: p.status,
      news: p.news || ""
    }
  };
};

VG.computeAllXP = (startGW, nGWs, fixtures) => {
  const results = [];
  Object.values(VG.players).forEach(p => {
    if (p.status !== "a" || p.now_cost <= 0) return;
    const xp = VG.computeMultiGWXP(p.id, startGW, nGWs, fixtures);
    xp.info.xpPerPrice = +(xp.totalXP / Math.max(xp.info.price, 4.0)).toFixed(2);
    results.push(xp.info);
  });
  return results.sort((a, b) => b.totalXP - a.totalXP);
};

// ── Optimizer: maximize total xP within budget ──────────────────────────
VG.optimizeDraft = (players, budget = 100) => {
  const target = { 1: 2, 2: 5, 3: 5, 4: 3 };
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

  const canAdd = (p, posOverride) => {
    const pos = posOverride || p.positionId;
    if (inSquad.has(p.id)) return false;
    const posCount = squad.filter(s => s.positionId === pos).length;
    if (posCount >= (target[pos] || 0)) return false;
    if ((clubCounts[p.teamId] || 0) >= 3) return false;
    if (spent + p.price > budget + 0.1) return false;
    return true;
  };

  // Phase 1: Fill all 15 slots — pick top-value player at each position
  const byValue = [...players].sort((a, b) => b.xpPerPrice - a.xpPerPrice);
  [1, 2, 3, 4].forEach(pos => {
    for (const p of byValue) {
      if (squad.filter(s => s.positionId === pos).length >= target[pos]) break;
      if (p.positionId !== pos) continue;
      if (inSquad.has(p.id)) continue;
      if ((clubCounts[p.teamId] || 0) >= 3) continue;
      if (spent + p.price > budget + 0.1) continue;
      addPlayer(p);
    }
  });

  // Phase 2: Fill any remaining slots
  if (squad.length < 15) {
    for (const p of byValue) {
      if (squad.length >= 15) break;
      if (inSquad.has(p.id)) continue;
      if ((clubCounts[p.teamId] || 0) >= 3) continue;
      if (spent + p.price > budget + 0.1) continue;
      addPlayer(p);
    }
  }

  // Phase 3: Aggressively upgrade with remaining budget — maximize total xP
  const remaining = () => +(budget - spent).toFixed(1);
  for (let pass = 0; pass < 8; pass++) {
    if (remaining() < 0.1) break;
    let improved = false;
    // Sort squad by totalXP ascending (upgrade cheapest/weakest first)
    const indices = Array.from({ length: squad.length }, (_, i) => i);
    indices.sort((a, b) => squad[a].totalXP - squad[b].totalXP);
    for (const i of indices) {
      if (remaining() < 0.1) break;
      const cur = squad[i];
      let bestCand = null, bestGain = 0;
      for (const p of players) {
        if (inSquad.has(p.id)) continue;
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

  // Select starting XI: pick the highest xP player at each position for the formation
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  squad.forEach(p => byPos[p.positionId].push(p));
  Object.values(byPos).forEach(arr => arr.sort((a, b) => b.totalXP - a.totalXP));

  // Choose best formation (1-3-5-1, 1-4-4-1, 1-5-3-1, 1-4-3-2, 1-3-4-2)
  const formations = [
    [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1]
  ];
  let bestFormation = null, bestTotalXP = 0;
  formations.forEach(([defN, midN, fwdN]) => {
    if (byPos[2].length < defN || byPos[3].length < midN || byPos[4].length < fwdN) return;
    let xp = 0;
    xp += byPos[1][0].totalXP;
    for (let i = 0; i < defN; i++) xp += byPos[2][i].totalXP;
    for (let i = 0; i < midN; i++) xp += byPos[3][i].totalXP;
    for (let i = 0; i < fwdN; i++) xp += byPos[4][i].totalXP;
    if (xp > bestTotalXP) { bestTotalXP = xp; bestFormation = { DEF: defN, MID: midN, FWD: fwdN }; }
  });
  if (!bestFormation) bestFormation = { DEF: 4, MID: 4, FWD: 2 };

  const starting = [];
  const bench = [];
  starting.push(byPos[1][0]);
  if (byPos[1][1]) bench.push(byPos[1][1]);

  [2, 3, 4].forEach(pos => {
    const n = bestFormation[VG.POSITIONS[pos]];
    byPos[pos].forEach((p, i) => {
      if (i < n) starting.push(p); else bench.push(p);
    });
  });

  // Ensure 11 starters
  while (starting.length < 11 && bench.length > 0) starting.push(bench.shift());
  bench.sort((a, b) => a.positionId - b.positionId || b.totalXP - a.totalXP);

  const totalXP = +starting.reduce((s, p) => s + (p.totalXP || 0), 0).toFixed(1);
  const benchXP = +bench.reduce((s, p) => s + (p.totalXP || 0), 0).toFixed(1);

  return {
    mode: "draft",
    squad, starting: starting.slice(0, 11), bench: bench.slice(0, 4),
    formation: bestFormation,
    totalCost: +spent.toFixed(1), budgetRemaining: +(budget - spent).toFixed(1),
    totalXP, benchXP,
    gotCap: [...starting].filter(p => p.positionId !== 1).sort((a, b) => b.totalXP - a.totalXP).slice(0, 2)
  };
};

VG.optimizeTransfers = (currentSquad, players, bank, freeTransfers) => {
  const currentIds = new Set(currentSquad.map(p => p.element));
  const outPlayers = [];
  const inPlayers = [];

  currentSquad.forEach(sp => {
    const pid = sp.element;
    const cXP = players.find(p => p.id === pid);
    const cPrice = (sp.selling_price || sp.now_cost || 0) / 10;
    if (!cXP) return;
    const pos = cXP.positionId;
    const candidates = players.filter(p =>
      p.id !== pid && !currentIds.has(p.id) &&
      p.positionId === pos &&
      p.price <= cPrice + bank + 0.1 &&
      p.totalXP > cXP.totalXP + 0.5
    ).sort((a, b) => b.totalXP - a.totalXP);

    if (candidates.length > 0) {
      const best = candidates[0];
      if (best.totalXP > cXP.totalXP + 1.0) {
        outPlayers.push({ id: pid, name: sp.web_name || "?", position: VG.POSITIONS[pos], price: cPrice });
        inPlayers.push({ id: best.id, name: best.name, position: best.position, price: best.price, totalXP: best.totalXP });
        bank -= (best.price - cPrice);
        currentIds.delete(pid);
        currentIds.add(best.id);
      }
    }
  });

  const nTransfers = Math.min(inPlayers.length, freeTransfers + 1);
  const hits = Math.max(0, nTransfers - freeTransfers) * 4;

  return {
    mode: "transfer", transfersIn: inPlayers.slice(0, nTransfers), transfersOut: outPlayers.slice(0, nTransfers),
    hitCost: hits, recommendedTransfers: nTransfers
  };
};

// ── Chip Advice ───────────────────────────────────────────────────────
VG.evaluateChips = (starting, bench, gw, fixtures) => {
  const capXP = Math.max(...starting.map(p => p.totalXP || 0), 0);
  const benchXP = bench.reduce((s, p) => s + (p.totalXP || 0), 0);
  const gwFix = fixtures.filter(f => f.event === gw);
  const teamCounts = {};
  gwFix.forEach(f => { teamCounts[f.team_h] = (teamCounts[f.team_h] || 0) + 1; teamCounts[f.team_a] = (teamCounts[f.team_a] || 0) + 1; });
  const isDGW = Object.values(teamCounts).some(c => c >= 2);
  const isBGW = gwFix.length === 0;
  return {
    triple_captain: { recommend: capXP >= 12.0 || isDGW, reason: "Cap xP " + capXP.toFixed(1) + (isDGW ? " + DGW" : "") },
    bench_boost: { recommend: benchXP >= 12.0, reason: "Bench xP " + benchXP.toFixed(1) },
    free_hit: { recommend: isBGW, reason: isBGW ? "Blank GW" : "No trigger" },
    wildcard: { recommend: false, reason: "Hold" }
  };
};

// ── Fixture Ticker ────────────────────────────────────────────────────
VG.buildFixtureTicker = (startGW, nGWs, fixtures) => {
  const ticker = {};
  Object.values(VG.teams).forEach(t => {
    const row = { name: t.short_name || t.name, id: t.id, fdr: [] };
    for (let gw = startGW; gw < startGW + nGWs; gw++) {
      const f = fixtures.find(fi => fi.event === gw && (fi.team_h === t.id || fi.team_a === t.id));
      if (f) {
        const isHome = f.team_h === t.id;
        const oppId = isHome ? f.team_a : f.team_h;
        row.fdr.push({ gw, fdr: isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3), opp: VG.teams[oppId]?.short_name || "", isHome });
      } else {
        row.fdr.push({ gw, fdr: 0, opp: "", isHome: false });
      }
    }
    ticker[t.id] = row;
  });
  return ticker;
};

// ── Price Change Risk ─────────────────────────────────────────────────
VG.getPriceRisk = async () => {
  const data = VG.bootstrapData;
  if (!data) return [];
  try {
    const live = await VG.fetch(VG.FPL + "/event/" + VG.currentGW + "/live/", "live");
    if (!live || !live.elements) return [];
    const liveMap = {};
    live.elements.forEach(e => { liveMap[e.id] = e; });
    return data.elements.filter(p => liveMap[p.id]).map(p => {
      const l = liveMap[p.id];
      const net = (l.transfers_in_event || 0) - (l.transfers_out_event || 0);
      let risk = "stable";
      if (net >= 10500) risk = "rising";
      else if (net >= 7000) risk = "likely_rise";
      else if (net <= -5600) risk = "falling";
      else if (net <= -4000) risk = "likely_fall";
      return { id: p.id, name: p.first_name + " " + p.second_name, pos: VG.POSITIONS[p.element_type], price: p.now_cost / 10, net, risk };
    });
  } catch (e) {
    console.warn("[VG] Price risk failed:", e);
    return [];
  }
};

// ── Render Engine ─────────────────────────────────────────────────────
VG.render = {};

VG.render.pitch = (result) => {
  const starting = result.starting || [];
  const gotCap = result.gotCap || [];
  const rows = [];
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
      const teamColor = VG.TEAM_COLORS[p.teamId] || { home: "#555", away: "#fff" };
      const isCaptain = gotCap.length > 0 && p.id === gotCap[0].id;
      const isVice = gotCap.length > 1 && p.id === gotCap[1].id;
      html += `<div class="player-card ${VG.POS_SHIRT[p.positionId]}" style="left:${xPct}%;top:${rd.y}%;" data-pid="${p.id}">`;
      html += `<div class="player-shirt" style="background:${teamColor.home};color:${teamColor.away};">`;
      html += `<div class="player-number">${p.positionId === 1 ? VG.teams[p.teamId]?.short_name || "GK" : (VG.players[p.id]?.shirt_number || "")}</div>`;
      html += '</div>';
      html += `<div class="player-info">`;
      html += `<div class="player-name">${p.name}</div>`;
      html += `<div class="player-meta">${p.teamName} · £${p.price.toFixed(1)}m</div>`;
      html += `<div class="player-xp">${(p.totalXP / 12).toFixed(1)} xP/GW</div>`;
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
    const teamColor = VG.TEAM_COLORS[p.teamId] || { home: "#555", away: "#fff" };
    html += `<div class="bench-card ${VG.POS_SHIRT[p.positionId]}">`;
    html += `<div class="bench-position">${VG.POSITIONS[p.positionId]}${i + 1}</div>`;
    html += `<div class="bench-shirt" style="background:${teamColor.home};color:${teamColor.away};">${VG.teams[p.teamId]?.short_name || ""}</div>`;
    html += `<div class="bench-name">${p.name}</div>`;
    html += `<div class="bench-details">£${p.price.toFixed(1)}m · ${(p.totalXP || 0).toFixed(1)} xP</div>`;
    html += '</div>';
  });
  html += '</div></div>';
  return html;
};

VG.render.metrics = (result) => {
  const metrics = [
    { label: "FORMATION", value: `${result.formation.DEF}-${result.formation.MID}-${result.formation.FWD}`, color: "#00ff87" },
    { label: "SQUAD VALUE", value: `£${result.totalCost.toFixed(1)}m`, color: "#06b6d4" },
    { label: "BANK", value: `£${result.budgetRemaining.toFixed(1)}m`, color: result.budgetRemaining > 0.5 ? "#fbbf24" : "#666" },
    { label: "TOTAL xP", value: result.totalXP.toFixed(1), color: "#00ff87" },
  ];
  return '<div class="metrics-row">' + metrics.map(m =>
    `<div class="metric"><div class="metric-label">${m.label}</div><div class="metric-value" style="color:${m.color}">${m.value}</div></div>`
  ).join('') + '</div>';
};

VG.render.metricCard = (label, value, color) =>
  `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value" style="color:${color}">${value}</div></div>`;

VG.render.chipCard = (label, color, advice) => {
  const active = advice.recommend ? " active" : "";
  const textColor = advice.recommend ? "#00ff87" : "#555";
  return `<div class="chip${active}" style="border-color:${advice.recommend ? color : 'rgba(255,255,255,0.06)'}">
    <div class="chip-label" style="color:${color}">${label}</div>
    <div class="chip-action" style="color:${textColor}">${advice.recommend ? "PLAY" : "Hold"}</div>
    <div class="chip-reason">${advice.reason}</div></div>`;
};

VG.render.ticker = (ticker, startGW, nGWs) => {
  const fdrColors = { 1: "#22c55e", 2: "#86efac", 3: "#64748b", 4: "#fb923c", 5: "#ef4444", 0: "#1e293b" };
  let html = '<div class="ticker-scroll"><table class="ticker-table"><thead><tr><th></th>';
  for (let gw = startGW; gw < startGW + nGWs; gw++) html += `<th>GW${gw}</th>`;
  html += '</tr></thead><tbody>';
  Object.entries(ticker).forEach(([, row]) => {
    html += `<tr><td class="ticker-team">${row.name}</td>`;
    row.fdr.forEach(cell => {
      const bg = fdrColors[cell.fdr] || "#334155";
      html += `<td><div class="fdr-chip" style="background:${bg}20;color:${bg};border:1px solid ${bg}40">${cell.fdr > 0 ? cell.opp + (cell.isHome ? " (H)" : " (A)") : "–"}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
};
