/**
 * VibeGaffer — FPL Intelligence Engine
 * Static web app, no backend required. Browser fetches FPL API directly.
 * Hosted on GitHub Pages. Author: Tushant Sharma | Astraiva
 */
const VG = {};

// ── FPL API ────────────────────────────────────────────────────────────────
VG.FPL = "https://fantasy.premierleague.com/api";
VG.POSITIONS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
VG.POS_BASE_XP = { 1: 2.5, 2: 3.5, 3: 4.5, 4: 4.0 };
VG.FDR_MULT = { 1: 1.30, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.70 };
VG.CS_PROB = { 1: { 1: 0.55, 2: 0.45, 3: 0.35, 4: 0.25, 5: 0.15 }, 2: { 1: 0.45, 2: 0.35, 3: 0.28, 4: 0.20, 5: 0.12 }, 3: { 1: 0.35, 2: 0.28, 3: 0.22, 4: 0.15, 5: 0.10 }, 4: { 1: 0.30, 2: 0.22, 3: 0.18, 4: 0.12, 5: 0.08 } };
VG.GOAL_PROB = { 1: 0.01, 2: 0.05, 3: 0.12, 4: 0.20 };
VG.ASSIST_PROB = { 1: 0.01, 2: 0.06, 3: 0.15, 4: 0.14 };
VG.GOAL_PTS = { 1: 6, 2: 6, 3: 5, 4: 4 };
VG.ASSIST_PTS = 3;
VG.CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
VG.CACHE_TTL = 1800000; // 30 min

// ── Cache (localStorage) ───────────────────────────────────────────────────
VG.cache = {
  get(k) {
    try { const v = JSON.parse(localStorage.getItem("vg_" + k)); if (v && Date.now() - v.t < VG.CACHE_TTL) return v.d; } catch {}
    return null;
  },
  set(k, d) { localStorage.setItem("vg_" + k, JSON.stringify({ d, t: Date.now() })); }
};

// ── Fetcher (browser direct + CORS proxy fallback) ─────────────────────────
VG.PROXIES = [
  { fn: (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url), name: "allorigins" },
  { fn: (url) => "https://corsproxy.io/?" + encodeURIComponent(url), name: "corsproxy" },
  { fn: (url) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), name: "codetabs" },
];

VG.fetch = async (url, label) => {
  const c = VG.cache.get(url);
  if (c) return c;
  document.getElementById("status").innerHTML = '<span style="color:#ffc107;">●</span> Fetching ' + (label || "data") + '...';
  let lastErr = null;
  for (const proxy of VG.PROXIES) {
    try {
      const proxyUrl = proxy.fn(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(proxyUrl, { signal: ctrl.signal, cache: "no-cache" });
      clearTimeout(timer);
      if (!r.ok) { lastErr = new Error(proxy.name + " returned " + r.status); continue; }
      const txt = await r.text();
      const j = JSON.parse(txt);
      VG.cache.set(url, j);
      return j;
    } catch(e) { lastErr = e; }
  }
  throw new Error(label + " failed: " + (lastErr?.message || "all proxies timed out"));
};

// ── Data Loading ──────────────────────────────────────────────────────────
VG.loadBootstrap = () => VG.fetch(VG.FPL + "/bootstrap-static/", "bootstrap");
VG.loadFixtures = () => VG.fetch(VG.FPL + "/fixtures/", "fixtures");

VG.loadSquad = async (tid, gw) => {
  const [info, picks] = await Promise.all([
    VG.fetch(VG.FPL + "/entry/" + tid + "/", "team"),
    VG.fetch(VG.FPL + "/entry/" + tid + "/event/" + gw + "/picks/", "picks")
  ]);
  return { info, picks };
};

// ── Build lookup tables ───────────────────────────────────────────────────
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

// ── xP Engine ─────────────────────────────────────────────────────────────
VG.computeFixtureXP = (pid, oppTeamId, isHome, fdr, eloDiff) => {
  const p = VG.players[pid];
  if (!p) return { xp: 0.1 };
  const pos = p.element_type;
  const baseXP = VG.POS_BASE_XP[pos] || 3.5;
  const form = parseFloat(p.form || "0");
  const ppg = parseFloat(p.points_per_game || "0");
  const fplForm = Math.max(form, ppg, 0.5);
  const mins = parseInt(p.minutes || "0");
  const starts = parseInt(p.starts || "0");
  const minsAvg = mins > 0 ? mins / Math.max(starts, 19) : (starts > 0 ? 75 : 0);
  const minsProb = minsAvg >= 80 ? 0.95 : minsAvg >= 60 ? 0.80 : minsAvg >= 45 ? 0.60 : minsAvg >= 30 ? 0.40 : minsAvg >= 15 ? 0.20 : 0.50;

  const fdrMult = VG.FDR_MULT[fdr] || 1.0;
  const homeMult = isHome ? 1.10 : 1.0;
  const eloFactor = 1.0 + Math.max(-0.15, Math.min(0.15, eloDiff * 0.1));

  const rawXP = 0.20 * baseXP + 0.35 * fplForm + 0.30 * (baseXP * fdrMult) + 0.15 * (baseXP * eloFactor);
  const adjXP = rawXP * homeMult;

  let csProb = (pos === 1 || pos === 2) ? (VG.CS_PROB[pos]?.[fdr] || 0.2) : 0;
  if (isHome && (pos === 1 || pos === 2)) csProb = Math.min(csProb * 1.15, 0.65);
  const goalProb = (VG.GOAL_PROB[pos] || 0.1) * fdrMult;
  const assistProb = (VG.ASSIST_PROB[pos] || 0.08) * fdrMult;

  const xp = minsProb * 2 + csProb * (VG.CS_PTS[pos] || 0) + goalProb * (VG.GOAL_PTS[pos] || 4) + assistProb * VG.ASSIST_PTS + 0.5 * minsProb - 0.15;
  return { xp: Math.max(xp, 0.1), minsProb, csProb, goalProb, assistProb, fdr, adjXP };
};

VG.computeMultiGWXP = (pid, startGW, nGWs, fixtures, eloMap) => {
  const p = VG.players[pid];
  if (!p) return { totalXP: 0, gwDetails: [], info: {} };
  const teamId = p.team;
  const teamElo = eloMap[teamId] || 1500;

  const upcoming = fixtures.filter(f =>
    (f.team_h === teamId || f.team_a === teamId) && f.event >= startGW && f.event < startGW + nGWs
  );

  let totalXP = 0;
  const gwDetails = [];
  upcoming.forEach(f => {
    const isHome = f.team_h === teamId;
    const oppId = isHome ? f.team_a : f.team_h;
    const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
    const oppElo = eloMap[oppId] || 1500;
    const eloDiff = (teamElo - oppElo) / 400;
    const res = VG.computeFixtureXP(pid, oppId, isHome, fdr || 3, eloDiff);
    res.gw = f.event;
    res.opponent = VG.teams[oppId]?.short_name || "";
    res.venue = isHome ? "H" : "A";
    gwDetails.push(res);
    totalXP += res.xp;
  });

  const form = parseFloat(p.form || "0");
  totalXP += form * 0.1;
  const ppg = parseFloat(p.points_per_game || "0");
  return {
    totalXP: +totalXP.toFixed(2),
    gwDetails,
    info: { id: p.id, name: p.first_name + " " + p.second_name, position: VG.POSITIONS[p.element_type], teamId, price: p.now_cost / 10, form: Math.max(form, ppg, 0), xpPerPrice: 0 }
  };
};

VG.computeAllXP = (startGW, nGWs, fixtures, eloMap) => {
  const results = [];
  Object.values(VG.players).forEach(p => {
    if (p.status !== "a" || p.now_cost <= 0) return;
    const xp = VG.computeMultiGWXP(p.id, startGW, nGWs, fixtures, eloMap);
    if (xp.totalXP > 0) {
      xp.info.xpPerPrice = +(xp.totalXP / Math.max(xp.info.price, 4.0)).toFixed(2);
      xp.info.positionId = p.element_type;
      xp.info.ownership = parseFloat(p.selected_by_percent || "0");
      results.push(xp.info);
    }
  });
  results.forEach(r => { r.xpPerPrice = +(r.xpPerPrice).toFixed(2); });
  return results.sort((a, b) => b.xpPerPrice - a.xpPerPrice);
};

// ── Greedy Squad Optimizer ────────────────────────────────────────────────
VG.optimizeDraft = (players, budget = 100) => {
  const posCounts = { 1: 2, 2: 5, 3: 5, 4: 0 }; // GK, DEF, MID
  for (let pid in VG.players) {
    const p = VG.players[pid];
    if (p.element_type === 4) posCounts[4] = (posCounts[4] || 0) + 1;
  }
  // Fixed: FWD count = 3
  const target = { 1: 2, 2: 5, 3: 5, 4: 3 };

  const squad = [];
  let spent = 0;
  const clubCounts = {};

  // Sort by xP descending (best players first)
  const sorted = [...players].sort((a, b) => b.xpPerPrice - a.xpPerPrice);

  // Phase 1: greedy selection respecting constraints
  for (const p of sorted) {
    if (squad.length >= 15) break;
    const pos = p.positionId || parseInt(VG.players[p.id]?.element_type);
    const posCount = squad.filter(s => (s.positionId || parseInt(VG.players[s.id]?.element_type)) === pos).length;
    if (posCount >= (target[pos] || 0)) continue;
    const club = p.teamId || VG.players[p.id]?.team;
    if ((clubCounts[club] || 0) >= 3) continue;
    if (spent + p.price > budget) continue;
    squad.push(p);
    spent += p.price;
    clubCounts[club] = (clubCounts[club] || 0) + 1;
  }

  // Phase 2: fill any remaining slots
  for (const p of sorted) {
    if (squad.length >= 15) break;
    if (squad.includes(p)) continue;
    const pos = p.positionId || parseInt(VG.players[p.id]?.element_type);
    const posCount = squad.filter(s => (s.positionId || parseInt(VG.players[s.id]?.element_type)) === pos).length;
    if (posCount >= (target[pos] || 0)) continue;
    const club = p.teamId || VG.players[p.id]?.team;
    if ((clubCounts[club] || 0) >= 3) continue;
    if (spent + p.price > budget + 0.5) continue;
    squad.push(p);
    spent += p.price;
    clubCounts[club] = (clubCounts[club] || 0) + 1;
  }

  // Select starting XI
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  squad.forEach(p => { const pos = p.positionId || parseInt(VG.players[p.id]?.element_type); byPos[pos].push(p); });
  Object.values(byPos).forEach(arr => arr.sort((a, b) => (b.xpPerPrice || b.totalXP || 0) - (a.xpPerPrice || a.totalXP || 0)));

  const starting = [byPos[1][0]];
  const bench = [byPos[1][1]];
  [2, 3, 4].forEach(pos => {
    const arr = byPos[pos];
    const minStart = pos === 2 ? 3 : pos === 3 ? 3 : 1;
    const maxStart = pos === 2 ? 5 : pos === 3 ? 5 : 3;
    const nStart = Math.min(maxStart, Math.max(minStart, arr.length - 1));
    arr.forEach((p, i) => { if (i < nStart && starting.length < 11) starting.push(p); else bench.push(p); });
  });
  while (starting.length < 11 && bench.length) starting.push(bench.shift());
  bench.sort((a, b) => (b.xpPerPrice || b.totalXP || 0) - (a.xpPerPrice || a.totalXP || 0));

  const defCount = starting.filter(p => (p.positionId || parseInt(VG.players[p.id]?.element_type)) === 2).length;
  const midCount = starting.filter(p => (p.positionId || parseInt(VG.players[p.id]?.element_type)) === 3).length;
  const fwdCount = starting.filter(p => (p.positionId || parseInt(VG.players[p.id]?.element_type)) === 4).length;

  return {
    mode: "draft", squad, starting: starting.slice(0, 11), bench: bench.slice(0, 4),
    formation: { DEF: defCount, MID: midCount, FWD: fwdCount },
    totalCost: +spent.toFixed(1), budgetRemaining: +(budget - spent).toFixed(1),
    gotCap: starting.slice(0, 2), totalXP: +starting.reduce((s, p) => s + (p.xpPerPrice || 0), 0).toFixed(1)
  };
};

VG.optimizeTransfers = (currentSquad, players, bank, freeTransfers) => {
  // Simple transfer optimizer: find best upgrade per position
  const currentIds = new Set(currentSquad.map(p => p.element));
  const outPlayers = [];
  const inPlayers = [];

  // Check if any squad players have low xP and can be replaced
  currentSquad.forEach(sp => {
    const pid = sp.element;
    const cXP = players.find(p => p.id === pid);
    const cPrice = sp.selling_price || sp.now_cost / 10;
    if (!cXP) return;
    const pos = parseInt(cXP.positionId || VG.players[pid]?.element_type);
    // Find candidates: same position, higher xP, affordable
    const candidates = players.filter(p =>
      p.id !== pid && !currentIds.has(p.id) &&
      (p.positionId || parseInt(VG.players[p.id]?.element_type)) === pos &&
      p.price <= cPrice + bank &&
      (p.xpPerPrice || 0) > (cXP.xpPerPrice || 0) + 0.5
    ).sort((a, b) => (b.xpPerPrice || 0) - (a.xpPerPrice || 0));

    if (candidates.length > 0) {
      const best = candidates[0];
      if ((best.xpPerPrice || 0) > (cXP.xpPerPrice || 0) + 1.0) {
        outPlayers.push({ id: pid, name: sp.web_name || VG.players[pid]?.second_name, position: VG.POSITIONS[pos], price: cPrice });
        inPlayers.push({ id: best.id, name: best.name, position: best.position, price: best.price, xpPerPrice: best.xpPerPrice });
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

// ── Chip Advice ───────────────────────────────────────────────────────────
VG.evaluateChips = (starting, bench, gw, fixtures) => {
  const capXP = Math.max(...starting.map(p => p.xpPerPrice || 0), 0);
  const benchXP = bench.reduce((s, p) => s + (p.xpPerPrice || 0), 0);
  const gwFix = fixtures.filter(f => f.event === gw);
  const teamCounts = {};
  gwFix.forEach(f => { teamCounts[f.team_h] = (teamCounts[f.team_h] || 0) + 1; teamCounts[f.team_a] = (teamCounts[f.team_a] || 0) + 1; });
  const isDGW = Object.values(teamCounts).some(c => c >= 2);
  const isBGW = gwFix.length === 0;
  return {
    triple_captain: { recommend: capXP >= 11.5 || isDGW, reason: "Cap xP " + capXP.toFixed(1) + (isDGW ? " + DGW" : "") },
    bench_boost: { recommend: benchXP >= 14.5, reason: "Bench xP " + benchXP.toFixed(1) },
    free_hit: { recommend: isBGW, reason: isBGW ? "Blank GW" : "No trigger" },
    wildcard: { recommend: false, reason: "Hold" }
  };
};

// ── Fixture Ticker Builder ────────────────────────────────────────────────
VG.buildFixtureTicker = (startGW, nGWs, fixtures) => {
  const ticker = {};
  Object.values(VG.teams).forEach(t => {
    const row = { name: t.short_name || t.name, fdr: [] };
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

// ── Price Change Risk ─────────────────────────────────────────────────────
VG.getPriceRisk = async () => {
  const data = VG.bootstrapData;
  if (!data) return [];
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
};

// ── Render Engine ─────────────────────────────────────────────────────────
VG.render = {};

VG.render.loader = (text) => `<div class="vg-loader"><div class="vg-loader-spinner"></div><div class="vg-loader-text">${text}</div></div>`;

VG.render.pitch = (starting, formation) => {
  const DEF_Y = 72, MID_Y = 48, FWD_Y = 24, GK_Y = 92;
  const xPos = n => n === 1 ? [50] : Array.from({ length: n }, (_, i) => 8 + 84 * i / (n - 1));
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  starting.forEach(p => { const pos = p.positionId || parseInt(VG.players[p.id]?.element_type); byPos[pos].push(p); });

  const groups = [
    { arr: byPos[1], y: GK_Y, cls: "gk" },
    { arr: byPos[2], y: DEF_Y, cls: "def" },
    { arr: byPos[3], y: MID_Y, cls: "mid" },
    { arr: byPos[4], y: FWD_Y, cls: "fwd" }
  ];

  const defCount = byPos[2].length;
  const midCount = byPos[3].length;
  const fwdCount = byPos[4].length;

  let html = '<div class="vg-pitch-wrap"><div class="vg-pitch">';
  html += '<div class="vg-line hl"></div><div class="vg-line vc"><div class="vg-circle"></div><div class="vg-dot"></div></div>';
  html += '<div class="vg-box top-pen"></div><div class="vg-box bot-pen"></div>';
  html += '<div class="vg-box top-six"></div><div class="vg-box bot-six"></div>';
  html += '<div class="vg-arc top-arc"></div><div class="vg-arc bot-arc"></div>';

  groups.forEach(g => {
    const n = g.arr.length;
    if (n === 0) return;
    const xs = xPos(n);
    g.arr.forEach((p, i) => {
      if (i >= xs.length) return;
      const name = p.name || VG.players[p.id]?.second_name || "?";
      const shortName = name.length > 11 ? name.split(" ").pop() : name;
      const xp = (p.xpPerPrice || 0).toFixed(1);
      html += `<div class="vg-player ${g.cls}" style="left:${xs[i].toFixed(1)}%;top:${g.y}%;"><div class="vp-name">${shortName}</div><div class="vp-xp">xP ${xp}</div></div>`;
    });
  });
  html += '</div></div>';
  return html;
};

VG.render.bench = (bench) => {
  if (!bench.length) return "";
  let html = '<div class="vg-bench"><div class="section-title">🪑 Bench</div><div class="bench-row">';
  bench.forEach((p, i) => {
    const name = p.name || VG.players[p.id]?.second_name || "?";
    const pos = p.position || VG.POSITIONS[parseInt(VG.players[p.id]?.element_type)] || "?";
    const price = (p.price || VG.players[p.id]?.now_cost / 10 || 0).toFixed(1);
    const xp = (p.xpPerPrice || 0).toFixed(1);
    const cls = pos === "GK" ? "gk" : pos === "DEF" ? "def" : pos === "MID" ? "mid" : "fwd";
    html += `<div class="bench-card ${cls}"><div class="bench-num">B${i + 1}</div><div class="bench-name">${name}</div><div class="bench-info">${pos} · £${price}m · xP ${xp}</div></div>`;
  });
  html += '</div></div>';
  return html;
};

VG.render.ticker = (ticker, startGW, nGWs) => {
  const fdrColors = { 1: "#2d7a2d", 2: "#5baa3a", 3: "#555", 4: "#c0392b", 5: "#8b0000", 0: "#1a1a2e" };
  let html = '<div class="ticker-wrap"><table class="ticker-table"><tr><th>Team</th>';
  for (let gw = startGW; gw < startGW + nGWs; gw++) html += `<th>GW${gw}</th>`;
  html += '</tr>';
  Object.entries(ticker).forEach(([tid, row]) => {
    html += `<tr><td class="team-name">${row.name}</td>`;
    row.fdr.forEach(cell => {
      const color = fdrColors[cell.fdr] || "#333";
      html += `<td><div class="fdr-cell" style="background:${color}">${cell.fdr > 0 ? cell.opp + " " + (cell.isHome ? "H" : "A") : "—"}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</table></div>';
  return html;
};

VG.render.radarChart = (canvasId, players, labels, datasets) => {
  new Chart(document.getElementById(canvasId), {
    type: 'radar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { r: { grid: { color: 'rgba(255,255,255,0.08)' }, pointLabels: { color: '#aaa', font: { size: 10 } }, ticks: { display: false } } },
      plugins: { legend: { labels: { color: '#ddd', font: { size: 11 } } } }
    }
  });
};

VG.render.metricCard = (label, value, color) =>
  `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value" style="color:${color}">${value}</div></div>`;

VG.render.chipCard = (label, color, advice) => {
  const cls = advice.recommend ? "chip-card active pulse-glow" : "chip-card";
  const borderColor = advice.recommend ? color : "rgba(255,255,255,0.08)";
  const text = advice.recommend ? "PLAY NOW!" : "Hold";
  const textColor = advice.recommend ? "#00ff87" : "#666";
  return `<div class="${cls}" style="border-color:${borderColor}"><div class="chip-label" style="color:${color}">${label}</div><div class="chip-action" style="color:${textColor}">${text}</div><div class="chip-reason">${advice.reason}</div></div>`;
};
