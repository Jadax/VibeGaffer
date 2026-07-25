const VG = {};

VG.FPL = "https://fantasy.premierleague.com/api";
VG.POSITIONS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
VG.POSITIONS_R = { GK: 1, DEF: 2, MID: 3, FWD: 4 };
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

  // Minutes probability — start-rate model using last season data
  const seasonGames = 38;
  const gamesPlayed = starts || Math.max(1, Math.ceil(mins / 80));
  const avgMins = gamesPlayed > 0 ? mins / gamesPlayed : 0;

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

  // Confidence adjustment: low sample = regress toward league average
  const dataConfidence = Math.min(1.0, gamesPlayed / Math.max(seasonGames * 0.5, 10));
  const confidenceMult = 0.5 + 0.5 * dataConfidence;
  const leagueAvgMinsProb = 0.72; // ~72% of starters play 60+ mins
  minsProb = minsProb * confidenceMult + leagueAvgMinsProb * (1 - confidenceMult);

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

  // ── Enhanced form: exponential weighting to amplify hot/cold streaks ──
  const formVsPPG = ppg > 0 ? form / ppg : 1.0;
  const epNextSignal = epNext > 0 && ppg > 0 ? Math.min(epNext / ppg, 1.5) : 1.0;
  const valueFormBoost = valueForm > 0 ? Math.min(1.0 + valueForm * 0.02, 1.15) : 1.0;
  // Exponential form: hot streaks (form/ppg > 1) amplified, cold streaks penalized more
  const expForm = formVsPPG > 1.0 ? Math.pow(formVsPPG, 1.3) : Math.pow(formVsPPG, 0.7);
  // 60% exponential form trend + 25% FPL ep_next + 15% value form
  const rawTrend = 0.6 * expForm + 0.25 * epNextSignal + 0.15 * valueFormBoost;
  const trendMult = Math.min(Math.max(0.80 + 0.20 * rawTrend, 0.70), 1.30);

  // ── Fixture difficulty multipliers ──
  const fdrMult = { 1: 1.35, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.65 };
  const attMult = fdrMult[fdr] || 1.0;
  const defMult = fdrMult[6 - (fdr || 3)] || 1.0;

  // ── Bookmaker odds adjustment (if available) ──
  let oddsAttMult = 1.0;
  let oddsDefMult = 1.0;
  let oddsCSMult = 1.0;
  if (VG.oddsData && VG.oddsData.length > 0 && oppTeamId) {
    const oppTeam = VG.teams[oppTeamId];
    const thisTeam = VG.teams[p.team];
    if (oppTeam && thisTeam) {
      const matchOdds = VG.oddsData.find(o =>
        (o.home === thisTeam.short_name && o.away === oppTeam.short_name) ||
        (o.away === thisTeam.short_name && o.home === oppTeam.short_name)
      );
      if (matchOdds && matchOdds.h2h) {
        const h = matchOdds.h2h.home || 3.0;
        const d = matchOdds.h2h.draw || 3.0;
        const a = matchOdds.h2h.away || 3.0;
        // Implied probabilities (remove overround)
        const rawH = 1 / h, rawD = 1 / d, rawA = 1 / a;
        const total = rawH + rawD + rawA;
        const pH = rawH / total, pD = rawD / total, pA = rawA / total;
        // Determine which side this team is on
        const isThisHome = matchOdds.home === thisTeam.short_name;
        const thisWinProb = isThisHome ? pH : pA;
        const thisLoseProb = isThisHome ? pA : pH;
        // Attack boost: favorite gets up to 1.15x, underdog gets 0.88x
        oddsAttMult = 0.88 + 0.27 * thisWinProb;
        // Defense penalty: underdog concedes more
        oddsDefMult = 0.88 + 0.27 * thisLoseProb;
        // Clean sheet: lower if high-scoring game expected (implied from odds)
        // Use odds-implied goal expectation: if both teams > 40% win prob, expect goals
        const bothDangerous = (pH > 0.40 && pA > 0.30) || (pA > 0.40 && pH > 0.30);
        oddsCSMult = bothDangerous ? 0.85 : (thisWinProb > 0.55 ? 1.10 : 1.0);
        // Clamp all
        oddsAttMult = Math.max(0.80, Math.min(1.20, oddsAttMult));
        oddsDefMult = Math.max(0.80, Math.min(1.20, oddsDefMult));
        oddsCSMult = Math.max(0.75, Math.min(1.15, oddsCSMult));
      }
    }
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
    baseCS * confidenceMult * xGCImpact * oppDefFactor * oddsCSMult
    + csRatePer90 * confidenceMult * defMult * oppDefFactor * oddsCSMult,
    0), 0.70);

  // ── Goal / assist probability ──
  const homeBoost = 1.15;
  const projGoals = Math.min(projGoalsPer90 * (isHome ? homeBoost : 1.0) * oddsAttMult, 0.85);
  const projAssists = Math.min(projAssistsPer90 * (isHome ? homeBoost : 1.0) * oddsAttMult, 0.85);

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
  // Calibrated to real 2025/26 data: top CBs ~1.4 DEFCON pts/game, avg CB ~0.8
  let defconXP = 0;
  if (pos === 2) {
    if (defConPer90 > 0) {
      const dcPerFixture = defConPer90 * (mins / 90);
      defconXP = Math.min(dcPerFixture / 6, 2.5) * minsProb * confidenceMult * defMult * defStrMult;
    } else {
      // Fallback: base 0.65 thresholds/game * team defence quality (divisor 1200)
      const defconBase = 0.65;
      const teamDefStr = team ? ((team.strength_defence_home + team.strength_defence_away) / 2 / 1200) : 0.75;
      defconXP = defconBase * teamDefStr * minsProb * confidenceMult * defMult;
    }
  } else if (pos === 3) {
    if (defConPer90 > 0) {
      const dcPerFixture = defConPer90 * (mins / 90);
      defconXP = Math.min(dcPerFixture / 8, 1.5) * minsProb * confidenceMult * defMult;
    } else {
      // DEF MIDs get partial DEFCON (~0.4 thresholds/game)
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
    xpComponents: {
      xpAppearance: +(xpAppearance * captainBonus).toFixed(4),
      xpCS: +(xpCS * captainBonus).toFixed(4),
      xpGoals: +(xpGoals * captainBonus).toFixed(4),
      xpAssists: +(xpAssists * captainBonus).toFixed(4),
      xpBonus: +(xpBonus * captainBonus).toFixed(4),
      xpSaves: +(xpSaves * captainBonus).toFixed(4),
      xpDEFCON: +(xpDEFCON * captainBonus).toFixed(4),
      xpNegative: +(xpNegative * captainBonus).toFixed(4)
    }
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

    // Injury filter: exclude injured/suspended/unavailable players
    const isAvailable = (p) => {
      const data = VG.players[p.id];
      return !data || data.status === 'a' || data.status === 'd'; // available or doubtful only
    };

    // Phase 1a: Seed with must-have premiums (highest xP per position)
    // This ensures expensive captains like Haaland/Saka aren't priced out by budget reserve
    // For MIDs, seed top 2 (e.g. Saka + Bruno) since they're captain-viable
    const seeds = [];
    [1, 2, 3, 4].forEach(function(pos) {
      const candidates = players.filter(function(p) { return p.positionId === pos && !inSquad.has(p.id) && isAvailable(p); })
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
      byValue = players.filter(isAvailable).sort((a, b) => (b._sortBy || b.xpPerPrice) - (a._sortBy || a.xpPerPrice));
    } else if (strategy === 'xp') {
      byValue = players.filter(isAvailable).sort((a, b) => b.totalXP - a.totalXP);
    } else { // mixed
      byValue = players.filter(isAvailable).sort((a, b) => {
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
      const fillers = players.filter(isAvailable).sort((a, b) => a.price - b.price);
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
          if (inSquad.has(p.id) || !isAvailable(p)) continue;
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
            if (inSquad.has(p.id) || !isAvailable(p)) continue;
            if (p.positionId !== sA.positionId) continue;
            if ((clubCounts[p.teamId] || 0) >= 3 && p.teamId !== sA.teamId) continue;
            const gain = p.totalXP - sA.totalXP;
            if (gain > bestAGain) { bestAGain = gain; bestA = { p, gain: gain }; }
          }
          if (!bestA) continue;
          // Find best replacement for sB in same position, fitting remaining budget
          for (const p of players) {
            if (inSquad.has(p.id) || p.id === bestA.p.id || !isAvailable(p)) continue;
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

    // Phase 5: Local search — random single-player swaps to escape greedy local optima
    // Try N random swaps, keep improvements, occasionally accept worse solutions (simulated annealing)
    let currentXP = squad.reduce((s, p) => s + p.totalXP, 0);
    const bestLocalXP = currentXP;
    for (let iter = 0; iter < 50; iter++) {
      const idx = Math.floor(Math.random() * squad.length);
      const cur = squad[idx];
      const candidates = players.filter(p =>
        p.id !== cur.id && !inSquad.has(p.id) && isAvailable(p) &&
        p.positionId === cur.positionId &&
        (clubCounts[p.teamId] || 0) < 3 && p.teamId !== cur.teamId
      );
      if (candidates.length === 0) continue;
      const cand = candidates[Math.floor(Math.random() * candidates.length)];
      const costDiff = +(cand.price - cur.price).toFixed(1);
      if (costDiff > remaining()) continue;
      const gain = cand.totalXP - cur.totalXP;
      // Accept if improvement, or with low probability if worse (annealing)
      const temp = 0.3 * (1 - iter / 50);
      if (gain > 0 || (gain > -3 && Math.random() < temp)) {
        clubCounts[cur.teamId] = (clubCounts[cur.teamId] || 1) - 1;
        clubCounts[cand.teamId] = (clubCounts[cand.teamId] || 0) + 1;
        inSquad.delete(cur.id);
        inSquad.add(cand.id);
        squad[idx] = { ...cand };
        spent = +(spent + costDiff).toFixed(1);
        currentXP += gain;
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

// ── ILP Solver: globally optimal squad via HiGHS WebAssembly ──────────
// Uses highs-js (HiGHS C++ solver compiled to WASM) from CDN.
// Falls back to greedy optimizer if WASM fails to load.
VG._highsReady = null;
VG._highsLoading = false;

VG._loadHighs = async () => {
  if (VG._highsReady) return VG._highsReady;
  if (VG._highsLoading) return null;
  VG._highsLoading = true;
  try {
    // Load highs-js from CDN — no build step needed
    if (!window.Highs) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/highs.js';
      document.head.appendChild(script);
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = reject;
        setTimeout(reject, 8000);
      });
    }
    const highs = await window.Highs({
      locateFile: (file) => 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/' + file
    });
    VG._highsReady = highs;
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

  const target = { 1: 2, 2: 5, 3: 5, 4: 3 };
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

  // Constraint 2: position counts (GK=2, DEF 3-5, MID 3-5, FWD 1-3)
  [1, 2, 3, 4].forEach(pos => {
    const posVars = [];
    for (let i = 0; i < n; i++) {
      if (players[i].positionId === pos) posVars.push('x' + i);
    }
    if (posVars.length === 0) return;
    const posExpr = posVars.join(' + ');
    if (pos === 1) {
      lp += ' gk_exact: ' + posExpr + ' = 2\n';
    } else if (pos === 4) {
      lp += ' fwd_min: ' + posExpr + ' >= 1\n';
      lp += ' fwd_max: ' + posExpr + ' <= 3\n';
    } else {
      lp += ' pos' + pos + '_min: ' + posExpr + ' >= 3\n';
      lp += ' pos' + pos + '_max: ' + posExpr + ' <= 5\n';
    }
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
    const byPos = { 1: [], 2: [], 3: [], 4: [] };
    selected.forEach(p => byPos[p.positionId].push(p));
    Object.values(byPos).forEach(arr => arr.sort((a, b) => b.totalXP - a.totalXP));

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
    while (starting.length < 11 && bench.length > 0) starting.push(bench.shift());
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

VG.optimizeTransfers = (currentSquad, players, bank, freeTransfers, fixtures, startGW, nGWs) => {
  fixtures = fixtures || [];
  startGW = startGW || 1;
  nGWs = nGWs || 5;

  const isAvailable = (p) => {
    const data = VG.players[p.id];
    return !data || data.status === 'a' || data.status === 'd';
  };

  const currentIds = new Set(currentSquad.map(p => p.element));
  const candidates = [];

  currentSquad.forEach(sp => {
    const pid = sp.element;
    const cXP = players.find(p => p.id === pid);
    const cPrice = (sp.selling_price || sp.now_cost || 0) / 10;
    if (!cXP) return;
    const pos = cXP.positionId;
    const upgrades = players.filter(p =>
      p.id !== pid && !currentIds.has(p.id) && isAvailable(p) &&
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
        const breakEvenGW = breakEvenGWs !== null ? Math.min(startGW + breakEvenGWs - 1, startGW + nGWs - 1) : null;
        const breaksEven = breakEvenGWs !== null && breakEvenGWs <= nGWs;

        candidates.push({
          out: { id: pid, name: sp.web_name || "?", position: VG.POSITIONS[pos], price: cPrice, totalXP: cXP.totalXP },
          in: { id: best.id, name: best.name, position: best.position, price: best.price, totalXP: best.totalXP },
          gain, cost, netGain: gain,
          breakEvenGWs, breakEvenGW, breaksEven, gwAvgGain
        });
      }
  });

  candidates.sort((a, b) => b.netGain - a.netGain);

  // Phase 1: Only use free transfers (no hits)
  const outPlayers = [];
  const inPlayers = [];
  const outCandidates = [];
  let spent = 0;
  const usedIds = new Set();

  for (const c of candidates) {
    if (outPlayers.length >= freeTransfers) break;
    if (usedIds.has(c.in.id)) continue;
    if (spent + c.cost > bank + 0.1) continue;
    outPlayers.push(c.out);
    inPlayers.push(c.in);
    outCandidates.push(c);
    spent += c.cost;
    usedIds.add(c.in.id);
    currentIds.delete(c.out.id);
    currentIds.add(c.in.id);
  }

  // Phase 2: Consider hits with break-even analysis
  // A hit is worth it if the cumulative per-GW gain recovers 4 pts within the horizon
  const hitCandidates = [];
  for (const c of candidates) {
    if (usedIds.has(c.in.id)) continue;
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
    outCandidates.push(c);
    spent += c.cost;
    usedIds.add(c.in.id);
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

// ── Fixture Swing Analysis: detect easy/hard runs ─────────────────────
VG.analyzeFixtureSwings = (startGW, nGWs, fixtures) => {
  const swings = [];
  Object.values(VG.teams).forEach(t => {
    const fdrs = [];
    const fixtures_list = [];
    for (let gw = startGW; gw < startGW + nGWs; gw++) {
      const f = fixtures.find(fi => fi.event === gw && (fi.team_h === t.id || fi.team_a === t.id));
      if (f) {
        const isHome = f.team_h === t.id;
        const oppId = isHome ? f.team_a : f.team_h;
        const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
        fdrs.push(fdr);
        fixtures_list.push({ gw, fdr, opp: VG.teams[oppId]?.short_name || "", isHome });
      } else {
        fdrs.push(0);
        fixtures_list.push({ gw, fdr: 0, opp: "BLANK", isHome: false });
      }
    }
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
    const gwFix = fixtures.filter(f => f.event === gw);
    const candidates = squadXP.map(p => {
      const f = gwFix.find(fi => fi.team_h === p.teamId || fi.team_a === p.teamId);
      const isHome = f ? f.team_h === p.teamId : false;
      const oppId = f ? (isHome ? f.team_a : f.team_h) : null;
      const fdr = f ? (isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3)) : 0;
      const oppName = oppId ? (VG.teams[oppId]?.short_name || "?") : "BLANK";
      const gwXP = p.gwXP || (p.totalXP / Math.max(nGWs, 1));
      return { ...p, fdr, oppName, isHome, gwXP };
    }).sort((a, b) => b.gwXP - a.gwXP);

    rotation.push({
      gw,
      top3: candidates.slice(0, 3),
      dgw: gwFix.length >= 2
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
  const bank = 0; // Simplified — assume neutral budget

  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    const gwFix = fixtures.filter(f => f.event === gw);
    const gwData = { gw, players: [], problems: [], recommendations: [] };

    // Analyze each squad player's fixture
    squad.forEach(sp => {
      const pid = sp.element || sp.id;
      const xp = squadXP.find(p => p.id === pid);
      if (!xp) return;
      const f = gwFix.find(fi => fi.team_h === xp.teamId || fi.team_a === xp.teamId);
      const isHome = f ? f.team_h === xp.teamId : false;
      const oppId = f ? (isHome ? f.team_a : f.team_h) : null;
      const fdr = f ? (isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3)) : 0;
      const oppName = oppId ? (VG.teams[oppId]?.short_name || "?") : "BLANK";
      const gwXP = xp.gwXP || (xp.totalXP / Math.max(nGWs, 1));

      const info = { name: xp.name, position: xp.position, teamId: xp.teamId, fdr, oppName, isHome, gwXP, id: pid, price: xp.price, totalXP: xp.totalXP };
      gwData.players.push(info);

      if (fdr >= 4 || fdr === 0) {
        gwData.problems.push(info);
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
        const bestF = gwFix.find(f => f.team_h === best.teamId || f.team_a === best.teamId);
        const bestIsHome = bestF ? bestF.team_h === best.teamId : false;
        const bestFDR = bestF ? (bestIsHome ? (bestF.team_h_difficulty || 3) : (bestF.team_a_difficulty || 3)) : 3;
        const bestOppId = bestF ? (bestIsHome ? bestF.team_a : bestF.team_h) : null;
        const bestOpp = bestOppId ? (VG.teams[bestOppId]?.short_name || "?") : "?";

        gwData.recommendations.push({
          out: prob.name, outFDR: prob.fdr, outOpp: prob.oppName,
          in: best.name, inFDR: bestFDR, inOpp: bestOpp, inPrice: best.price, inXP: best.totalXP,
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
VG.computeTransferPlan = (squad, allXP, fixtures, startGW, nGWs, bank, freeTransfers) => {
  if (!squad || squad.length < 11 || !allXP || allXP.length === 0 || !fixtures || fixtures.length === 0) return null;

  bank = bank || 0;
  freeTransfers = Math.max(freeTransfers || 1, 1);

  const isAvailable = (p) => {
    const data = VG.players[p.id];
    return !data || data.status === 'a' || data.status === 'd';
  };

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
  let usedFreeTransfers = 0;
  const usedIds = new Set();

  for (let gw = startGW; gw < startGW + nGWs; gw++) {
    const gwFix = fixtures.filter(f => f.event === gw);
    const gwTransfer = { gw, transfers: [], hitCost: 0, freeUsed: 0, squadXP: 0, cumGain: 0 };

    // Compute each squad player's GW xP (using per-GW detail, not average)
    const squadGWXP = [];
    currentSquadIds.forEach(pid => {
      const xp = perGWXP[gw][pid] || 0;
      const info = allXPMap[pid];
      if (!info) return;
      const f = gwFix.find(fi => fi.team_h === info.teamId || fi.team_a === info.teamId);
      const isHome = f ? f.team_h === info.teamId : false;
      const fdr = f ? (isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3)) : 3;
      const oppId = f ? (isHome ? f.team_a : f.team_h) : null;
      const oppName = oppId ? (VG.teams[oppId]?.short_name || "?") : "BLANK";
      squadGWXP.push({ id: pid, xp, price: currentSquadPrices[pid] || info.price, positionId: info.positionId, position: info.position, name: info.name, teamId: info.teamId, totalXP: info.totalXP, fdr, oppName, isHome });
    });

    // Only evaluate starters (top 11 by xP) for replacement — bench upgrades rarely matter
    squadGWXP.sort((a, b) => b.xp - a.xp);
    const starters = squadGWXP.slice(0, 11);
    const weakStarters = starters.slice(-4); // Bottom 4 starters are replacement candidates

    gwTransfer.squadXP = +starters.slice(0, 11).reduce((s, p) => s + p.xp, 0).toFixed(2);

    // Find transfers for weak starters
    const transferOpts = [];
    for (const weak of weakStarters) {
      if (weak.xp < 1.0) continue; // Skip very low-xP placeholders

      const candidates = allXP.filter(p =>
        !currentSquadIds.has(p.id) && !usedIds.has(p.id) &&
        p.positionId === weak.positionId && isAvailable(p) &&
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
        cumGain -= cost > 0 ? 0 : 0; // Cost doesn't subtract xP, just constrains budget

        if (cumGain > 1.0) { // Minimum 1 xP gain to consider
          transferOpts.push({
            out: weak, in: cand, cost, cumGain,
            gwXPold: +weak.xp.toFixed(2),
            gwXPnew: perGWXP[gw][cand.id] || +(cand.totalXP / Math.max(nGWs, 1)).toFixed(2)
          });
        }
      }
    }

    // Sort by cumulative xP gain (best first)
    transferOpts.sort((a, b) => b.cumGain - a.cumGain);

    // Apply transfers: free first, then hits
    let freeLeft = gw === startGW ? freeTransfers : Math.max(1, freeTransfers - usedFreeTransfers);
    // After a hit, carry over one free transfer
    freeLeft = Math.min(freeLeft, 1);

    let gwHitCost = 0;
    for (const opt of transferOpts) {
      if (gwTransfer.transfers.length >= 5) break; // Max 5 transfers per GW
      if (opt.cost > remainingBank + 0.1) continue;
      if (usedIds.has(opt.in.id)) continue;
      if (currentSquadIds.has(opt.in.id)) continue;

      if (gwTransfer.transfers.length < freeLeft) {
        // Free transfer
        gwTransfer.transfers.push({ ...opt, isHit: false });
        gwTransfer.freeUsed++;
        usedFreeTransfers++;
      } else if (opt.cumGain > 4.0) {
        // Hit is worth it: cumulative gain exceeds 4 pts
        gwHitCost += 4;
        totalHits += 4;
        totalGainFromHits += opt.cumGain;
        gwTransfer.transfers.push({ ...opt, isHit: true });
      } else {
        continue; // Skip — not worth a hit
      }

      // Apply the transfer
      currentSquadIds.delete(opt.out.id);
      currentSquadIds.add(opt.in.id);
      currentSquadPrices[opt.in.id] = opt.in.price;
      remainingBank = +(remainingBank - opt.cost).toFixed(1);
      usedIds.add(opt.in.id);
    }

    gwTransfer.hitCost = gwHitCost;
    gwTransfer.cumGain = +(gwTransfer.transfers.reduce((s, t) => s + t.cumGain, 0) - gwHitCost).toFixed(2);
    schedule.push(gwTransfer);
  }

  // Summary
  const totalSquadXP = schedule.reduce((s, g) => s + g.squadXP, 0);
  const totalTransfers = schedule.reduce((s, g) => s + g.transfers.length, 0);
  const netGain = +(totalGainFromHits - totalHits).toFixed(2);

  return {
    schedule,
    summary: {
      totalSquadXP: +totalSquadXP.toFixed(2),
      totalTransfers,
      totalHits,
      netGainFromHits: netGain,
      freeTransfersUsed: usedFreeTransfers,
      avgSquadXP: +(totalSquadXP / nGWs).toFixed(2)
    }
  };
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

// ── Mini-League Analyzer ────────────────────────────────────────────────
VG.analyzeLeague = async (leagueId, currentGW) => {
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

    for (const entry of topEntries) {
      try {
        const gw = Math.min(currentGW || VG.currentGW || 1, VG.currentGW || 1);
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

    return {
      leagueName,
      totalSquads,
      fetchedSquads: squads.length,
      ownership: ownership.slice(0, 30),
      templateIds: [...templateIds],
      differentials,
      outliers,
      uniquePicks,
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

VG.render.tips = (result, allXP, fixtures, gw, nGWs) => {
  let html = '';

  // ── Dynamic: Your Squad Analysis ──
  if (result && allXP) {
    const tips = [];
    const squad = result.squad || [];
    const gwPicks = result.gwPicks || [];
    const chipAdvice = result.chipAdvice || {};

    // Captain analysis
    if (result.gotCap?.length >= 1) {
      const c = result.gotCap[0];
      const capXP = c.gwXP || c.totalXP || 0;
      const capShare = result.gwTotalXP > 0 ? ((capXP / result.gwTotalXP) * 100).toFixed(0) : '?';
      tips.push({
        title: `Captain: ${c.name} (${capXP.toFixed(1)} xP)`,
        text: `Your captain contributes ~${capShare}% of GW${gw} expected points. ${capXP >= 6 ? 'Strong pick — this is a premium captaincy.' : capXP >= 4 ? 'Decent pick — consider alternatives if fixtures worsen.' : 'Weak pick — look for a better option in your squad or via transfer.'}`,
        source: 'VibeGaffer Analysis'
      });
    }

    // Injury/doubtful count
    const injuredCount = squad.filter(p => {
      const data = VG.players[p.element || p.id];
      return data && data.status !== 'a';
    }).length;
    if (injuredCount >= 3) {
      tips.push({
        title: `${injuredCount} Injured/Doubtful Players`,
        text: `Your squad has ${injuredCount} players with injury concerns. This is a wildcard trigger — consider using WC to replace them before they lose value.`,
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
    const gwFix = fixtures.filter(f => f.event === gw);
    let hardFixtures = 0;
    squad.forEach(sp => {
      const xp = allXP.find(p => p.id === (sp.element || sp.id));
      if (!xp) return;
      const f = gwFix.find(fi => fi.team_h === xp.teamId || fi.team_a === xp.teamId);
      if (!f) return;
      const isHome = f.team_h === xp.teamId;
      const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
      if (fdr >= 4) hardFixtures++;
    });
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
        text: `You're missing popular high-xP picks: ${missing.slice(0, 3).map(p => p.name).join(', ')}. These are highly owned — if they score well, you'll lose rank. Consider whether your differentials can compensate.`,
        source: 'VibeGaffer Analysis'
      });
    }

    if (tips.length > 0) {
      html += `<div class="tips-section">`;
      html += `<div class="tips-section-header">📊 Your Squad Analysis</div>`;
      tips.forEach(tip => {
        html += `<div class="tip-card" style="border-left:3px solid #00ff87;">`;
        html += `<div class="tip-title">${tip.title}</div>`;
        html += `<div class="tip-text">${tip.text}</div>`;
        html += `<div class="tip-source">— ${tip.source}</div>`;
        html += `</div>`;
      });
      html += `</div>`;
    }
  }

  // ── Static championship tips ──
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
