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

  // Pre-season fallback: estimate team strengths from 2025/26 final standings
  // FPL API uses ~600-1000 range; 800 = average team
  const fallbackStrengths = {
    'Arsenal':     { att_h: 1200, att_a: 1150, def_h: 1250, def_a: 1200, ov_h: 1230, ov_a: 1180 },
    'Man City':    { att_h: 1170, att_a: 1120, def_h: 1130, def_a: 1080, ov_h: 1150, ov_a: 1100 },
    'Liverpool':   { att_h: 1170, att_a: 1120, def_h: 1150, def_a: 1100, ov_h: 1160, ov_a: 1110 },
    'Chelsea':     { att_h: 1130, att_a: 1080, def_h: 1090, def_a: 1040, ov_h: 1110, ov_a: 1060 },
    'Aston Villa': { att_h: 1100, att_a: 1050, def_h: 1080, def_a: 1030, ov_h: 1090, ov_a: 1040 },
    'Newcastle':   { att_h: 1100, att_a: 1050, def_h: 1110, def_a: 1060, ov_h: 1100, ov_a: 1050 },
    'Brighton':    { att_h: 1080, att_a: 1030, def_h: 1050, def_a: 1000, ov_h: 1070, ov_a: 1020 },
    'Bournemouth': { att_h: 1050, att_a: 1000, def_h: 1030, def_a: 980,  ov_h: 1040, ov_a: 990  },
    'Crystal Palace':{ att_h: 1030, att_a: 980,  def_h: 1050, def_a: 1000, ov_h: 1040, ov_a: 990  },
    'Fulham':      { att_h: 1020, att_a: 970,  def_h: 1020, def_a: 970,  ov_h: 1020, ov_a: 970  },
    'Brentford':   { att_h: 1020, att_a: 970,  def_h: 1000, def_a: 950,  ov_h: 1010, ov_a: 960  },
    'Man Utd':     { att_h: 1070, att_a: 1020, def_h: 1000, def_a: 950,  ov_h: 1040, ov_a: 990  },
    'Tottenham':   { att_h: 1070, att_a: 1020, def_h: 980,  def_a: 930,  ov_h: 1030, ov_a: 980  },
    'Wolves':      { att_h: 980,  att_a: 930,  def_h: 950,  def_a: 900,  ov_h: 970,  ov_a: 920  },
    'West Ham':    { att_h: 1000, att_a: 950,  def_h: 950,  def_a: 900,  ov_h: 980,  ov_a: 930  },
    'Everton':     { att_h: 950,  att_a: 900,  def_h: 980,  def_a: 930,  ov_h: 960,  ov_a: 910  },
    'Nottm Forest':{ att_h: 1000, att_a: 950,  def_h: 1020, def_a: 970,  ov_h: 1010, ov_a: 960  },
    'Leeds':       { att_h: 950,  att_a: 900,  def_h: 920,  def_a: 870,  ov_h: 940,  ov_a: 890  },
    'Burnley':     { att_h: 910,  att_a: 860,  def_h: 920,  def_a: 870,  ov_h: 910,  ov_a: 860  },
    'Sunderland':  { att_h: 910,  att_a: 860,  def_h: 900,  def_a: 850,  ov_h: 910,  ov_a: 860  }
  };

  data.teams.forEach(t => {
    if (t.strength_defence_home === 0 || t.strength_overall_home === 0) {
      const fb = fallbackStrengths[t.name];
      if (fb) {
        t.strength_attack_home = fb.att_h;
        t.strength_attack_away = fb.att_a;
        t.strength_defence_home = fb.def_h;
        t.strength_defence_away = fb.def_a;
        t.strength_overall_home = fb.ov_h;
        t.strength_overall_away = fb.ov_a;
      } else {
        // Default for any unknown team
        t.strength_attack_home = 1100;
        t.strength_attack_away = 1050;
        t.strength_defence_home = 1100;
        t.strength_defence_away = 1050;
        t.strength_overall_home = 1100;
        t.strength_overall_away = 1050;
      }
    }
  });

  VG.gwData = data.events;
  VG.currentGW = data.events.find(e => e.is_current)?.id || data.events.find(e => e.is_next)?.id || 1;
};

// ── xP Engine: enhanced with xG/xA, form trends, opponent defense ──────
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

  // Confidence adjustment
  const seasonGames = 38;
  const dataConfidence = Math.min(1.0, gamesPlayed / Math.max(seasonGames * 0.5, 10));
  const confidenceMult = 0.5 + 0.5 * dataConfidence;

  // ── Per-90 rates: prefer FPL pre-computed per-90, fall back to manual ──
  const nineties = mins > 0 ? mins / 90 : 1;
  const xGPer90 = xGPer90API > 0 ? xGPer90API : xG / Math.max(nineties, 0.1);
  const xAPer90 = xAPer90API > 0 ? xAPer90API : xA / Math.max(nineties, 0.1);
  const goalsPer90 = goals / nineties;
  const assistsPer90 = assists / nineties;

  // Blend: 60% xG/xA + 40% actual
  const projGoalsPer90Raw = 0.6 * xGPer90 + 0.4 * goalsPer90;
  const projAssistsPer90Raw = 0.6 * xAPer90 + 0.4 * assistsPer90;

  const csRate = cleanSheets / Math.max(gamesPlayed, 1);
  const savesPerGame = saves / Math.max(gamesPlayed, 1);
  const bonusPerGame = bonus / Math.max(gamesPlayed, 1);
  const yellowsPerGame = yellows / Math.max(gamesPlayed, 1);
  const redsPerGame = reds / Math.max(gamesPlayed, 1);
  const ownGoalsPerGame = ownGoals / Math.max(gamesPlayed, 1);
  const penMissPerGame = penMiss / Math.max(gamesPlayed, 1);
  const bpsPerGame = bps / Math.max(gamesPlayed, 1);

  // ── Enhanced form: blend form/ppg trend with ep_next signal ──
  const formVsPPG = ppg > 0 ? form / ppg : 1.0;
  const epNextSignal = epNext > 0 && ppg > 0 ? Math.min(epNext / ppg, 1.5) : 1.0;
  const valueFormBoost = valueForm > 0 ? Math.min(1.0 + valueForm * 0.02, 1.15) : 1.0;
  // 60% form trend + 25% FPL ep_next + 15% value form
  const rawTrend = 0.6 * formVsPPG + 0.25 * epNextSignal + 0.15 * valueFormBoost;
  const trendMult = Math.min(Math.max(0.80 + 0.20 * rawTrend, 0.70), 1.30);

  // ── Fixture difficulty multipliers ──
  const fdrMult = { 1: 1.35, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.65 };
  const attMult = fdrMult[fdr] || 1.0;
  const defMult = fdrMult[6 - (fdr || 3)] || 1.0;

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

  // ── Projected rates ──
  const projGoalsPer90 = projGoalsPer90Raw * attMult * attStrMult * trendMult * confidenceMult + 0.05 * (1 - confidenceMult);
  const projAssistsPer90 = projAssistsPer90Raw * attMult * attStrMult * trendMult * confidenceMult + 0.03 * (1 - confidenceMult);

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
    baseCS * confidenceMult * xGCImpact * oppDefFactor
    + csRatePer90 * confidenceMult * defMult * oppDefFactor,
    0), 0.70);

  // ── Goal / assist probability ──
  const homeBoost = 1.15;
  const projGoals = Math.min(projGoalsPer90 * (isHome ? homeBoost : 1.0), 0.85);
  const projAssists = Math.min(projAssistsPer90 * (isHome ? homeBoost : 1.0), 0.85);

  // ── Bonus: use BPS (strongest predictor) + position-specific ICT + xGI ──
  const bpsPerGameNorm = bpsPerGame / 40;
  const influencePerGame = influence / Math.max(gamesPlayed, 1);
  const creativityPerGame = creativity / Math.max(gamesPlayed, 1);
  const threatPerGame = threat / Math.max(gamesPlayed, 1);
  let ictBonus = 0;
  if (pos === 1 || pos === 2) {
    ictBonus = Math.min(influencePerGame / 30, 0.3);
  } else if (pos === 3) {
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

  // ── DEFCON: use API defensive_contribution_per_90 when available ──
  let defconXP = 0;
  if (pos === 2) {
    if (defConPer90 > 0) {
      const dcPerFixture = defConPer90 * (mins / 90);
      defconXP = Math.min(dcPerFixture / 6, 2.5) * minsProb * confidenceMult * defMult * defStrMult;
    } else {
      const defconBase = 1.1;
      const teamDefStr = team ? ((team.strength_defence_home + team.strength_defence_away) / 2 / 800) : 0.8;
      defconXP = defconBase * teamDefStr * minsProb * confidenceMult * defMult;
    }
  } else if (pos === 3) {
    if (defConPer90 > 0) {
      const dcPerFixture = defConPer90 * (mins / 90);
      defconXP = Math.min(dcPerFixture / 8, 1.5) * minsProb * confidenceMult * defMult;
    } else {
      defconXP = 0.4 * minsProb * confidenceMult * defMult;
    }
  }

  // ── Captain ceiling bonus ──
  const captainBonus = (pos === 4) ? 1.15 : (pos === 3) ? (price > 9 ? 1.18 : 1.08) : 1.0;

  // ── xP calculation per fixture ──
  const xpAppearance = minsProb * APPEARANCE_PTS;
  const xpCS = projCS * (CS_PTS[pos] || 0);
  const xpGoals = projGoals * (GOAL_PTS[pos] || 4);
  const xpAssists = projAssists * ASSIST_PTS;
  const xpBonus = projBonus * 1.5;
  const xpSaves = pos === 1 ? Math.min(savesPerGame / 3, 1.0) * 3 * defMult * confidenceMult : 0;
  const xpDEFCON = defconXP * 2;
  const xpNegative = minsProb * (yellowsPerGame * 1 + redsPerGame * 3 + ownGoalsPerGame * 2 + penMissPerGame * 2);

  const totalXP = (xpAppearance + xpCS + xpGoals + xpAssists + xpBonus + xpSaves + xpDEFCON - xpNegative) * captainBonus;

  return {
    xp: Math.max(totalXP, 0.1),
    minsProb,
    csProb: projCS,
    goalProb: projGoals,
    assistProb: projAssists,
    bonusProb: projBonus,
    defconProb: defconXP,
    fdr,
    xpComponents: { xpAppearance, xpCS, xpGoals, xpAssists, xpBonus, xpSaves, xpDEFCON, xpNegative }
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
  const aggComponents = { xpAppearance: 0, xpCS: 0, xpGoals: 0, xpAssists: 0, xpBonus: 0, xpSaves: 0, xpDEFCON: 0, xpNegative: 0 };

  if (upcoming.length === 0) {
    // Pre-season / no fixtures: use best available signal
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
      const isHome = f.team_h === teamId;
      const oppId = isHome ? f.team_a : f.team_h;
      const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
      const res = VG.computeFixtureXP(pid, oppId, isHome, fdr || 3);
      res.gw = f.event;
      res.opponent = VG.teams[oppId]?.short_name || "?";
      res.venue = isHome ? "H" : "A";
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

  return {
    totalXP: +totalXP.toFixed(2),
    xpComponents: aggComponents,
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
      form: Math.max(form, ppg, 0),
      totalPoints: parseInt(p.total_points || "0"),
      ict: parseFloat(p.ict_index || "0"),
      ownership: parseFloat(p.selected_by_percent || "0"),
      xpPerPrice: 0,
      totalXP: +totalXP.toFixed(2),
      xG: +xG.toFixed(2),
      xA: +xA.toFixed(2),
      xGI: +xGI.toFixed(2),
      trend: +formVsPPG.toFixed(2),
      epNext,
      bps,
      defconPer90: +defConPer90.toFixed(2),
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
    xp.info.xpComponents = xp.xpComponents;
    results.push(xp.info);
  });
  return results.sort((a, b) => b.totalXP - a.totalXP);
};

// ── Per-GW Picks: best XI + formation for a single gameweek ──────────────
VG.computePerGWPicks = (squad, gw, fixtures) => {
  // Compute single-GW xP for each squad member
  const gwXP = squad.map(p => {
    const data = VG.players[p.id];
    if (!data) return { ...p, gwXP: 0, gwOpp: "", gwVenue: "", gwFDR: 3 };
    const teamId = p.teamId;
    const f = fixtures.find(fi => fi.event === gw && (fi.team_h === teamId || fi.team_a === teamId));
    if (!f) return { ...p, gwXP: (p.totalXP || 0) / 12, gwOpp: "N/A", gwVenue: "?", gwFDR: 3 };
    const isHome = f.team_h === teamId;
    const oppId = isHome ? f.team_a : f.team_h;
    const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
    const res = VG.computeFixtureXP(p.id, oppId, isHome, fdr);
    return {
      ...p,
      gwXP: +res.xp.toFixed(2),
      gwOpp: VG.teams[oppId]?.short_name || "?",
      gwVenue: isHome ? "H" : "A",
      gwFDR: fdr
    };
  });

  // Group by position, sort by gwXP desc
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  gwXP.forEach(p => byPos[p.positionId].push(p));
  Object.values(byPos).forEach(arr => arr.sort((a, b) => b.gwXP - a.gwXP));

  // Try all valid formations, pick the one with highest total GW xP
  const formations = [
    [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1]
  ];
  let bestFormation = null, bestGWXP = -1;
  formations.forEach(([defN, midN, fwdN]) => {
    if (byPos[2].length < defN || byPos[3].length < midN || byPos[4].length < fwdN) return;
    let xp = byPos[1][0]?.gwXP || 0;
    for (let i = 0; i < defN; i++) xp += byPos[2][i].gwXP;
    for (let i = 0; i < midN; i++) xp += byPos[3][i].gwXP;
    for (let i = 0; i < fwdN; i++) xp += byPos[4][i].gwXP;
    if (xp > bestGWXP) { bestGWXP = xp; bestFormation = { DEF: defN, MID: midN, FWD: fwdN }; }
  });
  if (!bestFormation) bestFormation = { DEF: 4, MID: 4, FWD: 2 };

  // Build starting XI and bench
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
  while (starting.length < 11) starting.push(bench.shift());

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
      const f = fixtures.filter(fi => fi.event === gw && (fi.team_h === p.teamId || fi.team_a === p.teamId));
      return f.length >= 2;
    }).map(p => p.id)
  };
};

// ── Optimizer: maximize total xP within budget ──────────────────────────
VG.optimizeDraft = (players, budget = 100, fixtures = [], startGW = 1, nGWs = 12) => {
  const target = { 1: 2, 2: 5, 3: 5, 4: 3 };
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
      const candidates = players.filter(function(p) { return p.positionId === pos && !inSquad.has(p.id); })
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
      byValue = [...players].sort((a, b) => (b._sortBy || b.xpPerPrice) - (a._sortBy || a.xpPerPrice));
    } else if (strategy === 'xp') {
      byValue = [...players].sort((a, b) => b.totalXP - a.totalXP);
    } else { // mixed
      byValue = [...players].sort((a, b) => {
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
      const fillers = [...players].sort((a, b) => a.price - b.price);
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
            if (inSquad.has(p.id)) continue;
            if (p.positionId !== sA.positionId) continue;
            if ((clubCounts[p.teamId] || 0) >= 3 && p.teamId !== sA.teamId) continue;
            const gain = p.totalXP - sA.totalXP;
            if (gain > bestAGain) { bestAGain = gain; bestA = { p, gain: gain }; }
          }
          if (!bestA) continue;
          // Find best replacement for sB in same position, fitting remaining budget
          for (const p of players) {
            if (inSquad.has(p.id) || p.id === bestA.p.id) continue;
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

    // Evaluate this squad's total XP
    const totalXP = squad.reduce((s, p) => s + p.totalXP, 0);
    if (totalXP > bestStrategyXP && squad.length === 15) {
      bestStrategyXP = totalXP;
      bestSquad = [...squad];
      bestSpent = spent;
    }
  }

  const squad = bestSquad;
  if (!squad || squad.length < 11) {
    return { mode: "draft", squad: [], starting: [], bench: [], formation: { DEF: 4, MID: 4, FWD: 2 }, totalCost: 0, budgetRemaining: budget, totalXP: 0, benchXP: 0, gotCap: [], gwPicks: [] };
  }
  const spent = bestSpent;

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

// ── Multi-Strategy: Balanced, Premium Heavy, Best Value ────────────────
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

VG.optimizeTransfers = (currentSquad, players, bank, freeTransfers) => {
  const currentIds = new Set(currentSquad.map(p => p.element));
  const candidates = [];

  currentSquad.forEach(sp => {
    const pid = sp.element;
    const cXP = players.find(p => p.id === pid);
    const cPrice = (sp.selling_price || sp.now_cost || 0) / 10;
    if (!cXP) return;
    const pos = cXP.positionId;
    const upgrades = players.filter(p =>
      p.id !== pid && !currentIds.has(p.id) &&
      p.positionId === pos &&
      p.price <= cPrice + bank + 0.1 &&
      p.totalXP > cXP.totalXP + 1.0
    ).sort((a, b) => (b.totalXP - b.price) - (a.totalXP - a.price));

    if (upgrades.length > 0) {
      const best = upgrades[0];
      const gain = best.totalXP - cXP.totalXP;
      const cost = +(best.price - cPrice).toFixed(1);
      candidates.push({
        out: { id: pid, name: sp.web_name || "?", position: VG.POSITIONS[pos], price: cPrice, totalXP: cXP.totalXP },
        in: { id: best.id, name: best.name, position: best.position, price: best.price, totalXP: best.totalXP },
        gain, cost, netGain: gain
      });
    }
  });

  // Sort by net gain (biggest improvement first)
  candidates.sort((a, b) => b.netGain - a.netGain);

  // Phase 1: Only use free transfers (no hits)
  const outPlayers = [];
  const inPlayers = [];
  let spent = 0;
  const usedIds = new Set();

  for (const c of candidates) {
    if (outPlayers.length >= freeTransfers) break;
    if (usedIds.has(c.in.id)) continue;
    if (spent + c.cost > bank + 0.1) continue;
    outPlayers.push(c.out);
    inPlayers.push(c.in);
    spent += c.cost;
    usedIds.add(c.in.id);
    currentIds.delete(c.out.id);
    currentIds.add(c.in.id);
  }

  // Phase 2: Consider hits ONLY if improvement is massive (>8 pts per hit)
  const hitCandidates = [];
  for (const c of candidates) {
    if (usedIds.has(c.in.id)) continue;
    if (c.netGain <= 8) continue; // Not worth a hit
    hitCandidates.push(c);
  }

  let hitTransfers = 0;
  for (const c of hitCandidates) {
    if (spent + c.cost > bank + 0.1) continue;
    outPlayers.push(c.out);
    inPlayers.push(c.in);
    spent += c.cost;
    usedIds.add(c.in.id);
    hitTransfers++;
  }

  const hits = hitTransfers * 4;

  return {
    mode: "transfer", transfersIn: inPlayers, transfersOut: outPlayers,
    hitCost: hits, recommendedTransfers: outPlayers.length, freeTransfersUsed: Math.min(outPlayers.length, freeTransfers),
    hitWarning: hits > 0 ? `${hitTransfers} hit(s) = -${hits} pts. Champion advice: avoid hits unless improvement > 8 pts.` : null
  };
};

// ── Chip Engine: multi-GW lookahead with DGW/BGW detection ──────────────
VG.evaluateChips = (squad, gwPicks, startGW, fixtures) => {
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
    const gwFix = fixtures.filter(f => f.event === gw);

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
      const f = fixtures.find(fi => fi.event === gw && (fi.team_h === p.teamId || fi.team_a === p.teamId));
      if (!f) return false;
      const isH = f.team_h === p.teamId;
      const fdr = isH ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
      return fdr >= 4;
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
        : `No DGW trigger — save for a Double Gameweek`,
      tip: tcBest.tcScore >= TC_THRESHOLD
        ? "Double Gameweek captain — high ceiling play"
        : "TC doubles your captain's points. Only play when your captain has TWO fixtures (DGW) against weak opponents. Classic timing: GW36-37."
    },
    bench_boost: {
      recommend: bbBest.bbScore >= BB_THRESHOLD,
      bestGW: bbBest.gw,
      score: bbBest.bbScore,
      reason: bbBest.bbScore >= BB_THRESHOLD
        ? `GW${bbBest.gw}: Bench xP ${bbBest.benchXP.toFixed(1)}${bbBest.benchDGWCount >= 2 ? ` · ${bbBest.benchDGWCount} DGW players` : ""}`
        : `No DGW bench coverage — save for a Double Gameweek`,
      tip: bbBest.bbScore >= BB_THRESHOLD
        ? "Multiple bench players have double fixtures — ideal BB window"
        : "BB is best in DGW when bench players play twice. Classic sequence: WC → BB → FH → TC. New rule: must use one chip in first half."
    },
    wildcard: {
      recommend: wcBest.wcScore >= WC_THRESHOLD,
      bestGW: wcBest.gw,
      score: wcBest.wcScore,
      reason: wcBest.wcScore >= WC_THRESHOLD
        ? `GW${wcBest.gw}: ${wcBest.injuredCount >= 3 ? wcBest.injuredCount + ' injuries' : wcBest.badFixCount >= 8 ? wcBest.badFixCount + ' tough fixtures' : 'Squad needs restructuring'}`
        : `Squad looks healthy — hold WC for later`,
      tip: wcBest.wcScore >= WC_THRESHOLD
        ? "Significant squad issues detected — WC can fix multiple problems at once"
        : "Save WC until you have 3+ injuries or a run of tough fixtures. Use it to set up for BB. Classic: WC early to fix mistakes, or WC GW32 to prepare for DGW run."
    },
    free_hit: {
      recommend: fhBest.fhScore >= FH_THRESHOLD,
      bestGW: fhBest.gw,
      score: fhBest.fhScore,
      reason: fhBest.fhScore >= FH_THRESHOLD
        ? `GW${fhBest.gw}: ${fhBest.isBGW ? "Blank GW — many teams out" : `DGW with ${fhBest.dgwTeams?.length || 0} double teams`}`
        : `No BGW/DGW trigger — save for a Blank Gameweek`,
      tip: fhBest.fhScore >= FH_THRESHOLD
        ? "Blank Gameweek — use FH to field 11 without hits"
        : "FH lets you pick any 15 players for one week. Best on BGWs. Also powerful in GW38 for differential sprint to win mini-league."
    },
    gwScores
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
  const bestGWText = advice.bestGW ? `Best: GW${advice.bestGW}` : "";
  const scoreBar = advice.score > 0 ? `<div class="chip-score-bar"><div class="chip-score-fill" style="width:${Math.min(advice.score / 1.2, 100)}%;background:${advice.recommend ? color : '#334155'}"></div></div>` : '';
  return `<div class="chip${active}" style="border-color:${advice.recommend ? color : 'rgba(255,255,255,0.06)'}">
    <div class="chip-header"><div class="chip-label" style="color:${color}">${label}</div><div class="chip-action" style="color:${textColor}">${advice.recommend ? "PLAY" : "Hold"}</div></div>
    <div class="chip-reason">${advice.reason}</div>
    ${scoreBar}
    <div class="chip-timing" style="color:#64748b;">${bestGWText}</div>
    ${advice.tip ? `<div class="chip-tip" style="color:#94a3b8;font-size:0.65rem;margin-top:4px;font-style:italic;">💡 ${advice.tip}</div>` : ''}
  </div>`;
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

// ── Strategy Tips: championship wisdom ──────────────────────────────────
VG.TIPS = [
  {
    category: "Core Strategy",
    icon: "🏆",
    tips: [
      { title: "Avoid Points Hits", text: "2025/26 champion Erik Ibsen did not take a single points hit all season. \"Better to play a player with a bad fixture than take a hit — it's mathematically never the right call.\"", source: "Erik Ibsen (2025/26 Champion)" },
      { title: "Master Rolling Transfers", text: "Ibsen made zero transfers in 15 out of 38 gameweeks, rolling his free transfers. This gave him 2 free transfers in 8 GWs and 3 in 3 GWs for \"big moves\" to restructure his squad.", source: "Erik Ibsen" },
      { title: "Balance Template vs Differentials", text: "The \"template\" squad has high-ownership players — safe but limited upside. Top players hunt low-ownership differentials in mid-to-late season to jump up ranks.", source: "General wisdom" },
      { title: "Stay Adaptable", text: "2023/24 champion Jonas Sand Labakk was struggling early and decisively used his Wildcard in GW8. \"You need to think for yourself. You can't let others make all the decisions for you.\"", source: "Jonas Sand Labakk (2023/24 Champion)" }
    ]
  },
  {
    category: "Player Selection",
    icon: "⚽",
    tips: [
      { title: "Invest in Starting Players", text: "Ibsen stresses having 15 regular starters. He strongly advises against picking non-playing \"bench fillers\" just to save money — every player should get minutes.", source: "Erik Ibsen" },
      { title: "Goalkeeper Rotation", text: "Ibsen experimented with two premium keepers (Raya and Pickford) and rotated them based on fixtures. A rotating GK pair can outperform a single premium pick.", source: "Erik Ibsen" },
      { title: "Captaincy is King", text: "Champion Lovro Budisin scored 29.1% of his total points from his captain — nearly 8% more than the previous season's winner. Captain choice is the single biggest lever.", source: "Lovro Budisin (2024/25 Champion)" },
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
      { title: "Triple Captain in DGW", text: "Play during a Double Gameweek on an in-form player with two favorable fixtures. Never waste it on a single fixture — the upside isn't there.", source: "FPL experts" }
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
      { title: "Avoid Points Hits", text: "It's almost always better to roll your transfer. The math doesn't lie — a 4-point hit needs to outperform by 4+ points to break even.", source: "Multiple champions" }
    ]
  }
];

VG.render.tips = () => {
  let html = '';
  VG.TIPS.forEach(section => {
    html += `<div class="tips-section">`;
    html += `<div class="tips-section-header">${section.icon} ${section.category}</div>`;
    section.tips.forEach(tip => {
      html += `<div class="tip-card">`;
      html += `<div class="tip-title">${tip.title}</div>`;
      html += `<div class="tip-text">${tip.text}</div>`;
      html += `<div class="tip-source">— ${tip.source}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  });
  return html;
};
