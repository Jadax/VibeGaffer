// Runs the engine on one historical data snapshot and prints per-player
// projections for a gameweek as JSON. Invoked by tools/backtest.js, one fresh
// process per GW so no engine state leaks between gameweeks.
//
// usage: node tools/backtest-worker.js <gw> <snapshotDir> [horizon]
const fs = require("fs");
const path = require("path");

const [gwArg, snapDir, horizonArg] = process.argv.slice(2);
const gw = parseInt(gwArg, 10);
const horizon = parseInt(horizonArg || "6", 10);
const root = path.resolve(__dirname, "..");

global.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window = {};
global.VG = {};
// Same-origin JSON reads resolve against the snapshot; everything else fails
// closed, exactly like an offline browser (no live API calls in a backtest).
global.fetch = async (url) => {
  const m = String(url).match(/^data\/(.+?)(\?|$)/);
  const file = m && path.join(snapDir, m[1]);
  if (!file || !fs.existsSync(file)) return { ok: false, status: 404, json: async () => null };
  const body = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
};
const quiet = console.warn; console.warn = () => {};

new Function(fs.readFileSync(path.join(root, "docs", "app.js"), "utf8").replace("const VG = {};", ""))();
new Function(fs.readFileSync(path.join(root, "docs", "data.js"), "utf8"))();

// Experiment hook: VG_MODEL='{"startK":4}' overrides engine constants.
if (process.env.VG_MODEL) Object.assign(VG.MODEL, JSON.parse(process.env.VG_MODEL));

(async () => {
  // Mirror VG.init's load order, awaiting the optional loaders the UI awaits in VG.run.
  VG.bootstrapData = await VG.loadBootstrap();
  VG.applyHistoryPriors(VG.bootstrapData, await VG.loadHistoryPriors());
  VG.buildMaps(VG.bootstrapData);
  VG.allFixtures = await VG.loadFixtures();
  await VG.loadOdds();
  await VG.loadUnderstat();
  await VG.loadSetPieceData();
  await VG.loadRecentForm();

  const allXP = VG.computeAllXP(gw, horizon, VG.allFixtures);
  const out = allXP.map(p => {
    const raw = VG.players[p.id];
    const proj = VG.computePlayerGWProjection(p, gw, VG.allFixtures);
    // Per-component sums for this GW (same pinning as computePlayerGWProjection)
    // so each scoring channel can be calibrated against the actual stat.
    const comp = { minsProb: 0, goalProb: 0, assistProb: 0, csProb: 0 };
    const prev = VG._projGW; VG._projGW = gw;
    VG.teamFixtures(VG.allFixtures, gw, p.teamId).forEach(f => {
      const info = VG.fixtureInfo(f, p.teamId);
      const r = VG.computeFixtureXP(p.id, info.oppId, info.isHome, info.fdr);
      comp.minsProb += r.minsProb; comp.conceded = (comp.conceded || 0) + (r.concededXP || 0); comp.goalProb += r.goalProb; comp.assistProb += r.assistProb; comp.csProb += r.csProb;
      Object.entries(r.xpComponents).forEach(([k, v]) => { comp[k] = (comp[k] || 0) + v; });
    });
    VG._projGW = prev;
    return {
      id: p.id, name: p.name, pos: p.positionId, team: p.teamId, price: p.price,
      own: parseFloat(raw.selected_by_percent || "0"),
      epNext: parseFloat(raw.ep_next || "0"),
      form: parseFloat(raw.form || "0"),
      ppg: parseFloat(raw.points_per_game || "0"),
      minsSoFar: parseInt(raw.minutes || "0", 10),
      startsSoFar: parseInt(raw.starts || "0", 10),
      chance: raw.chance_of_playing_next_round,
      status: raw.status,
      fixtures: proj.fixtureCount,
      proj: proj.gwXP,
      // Projections for the next 3 GWs too (transfer-horizon validation).
      projAhead: [1, 2, 3].map(k => VG.computePlayerGWProjection(p, gw + k, VG.allFixtures).gwXP),
      projHorizon: p.totalXP,
      xMins: p.xMins || 0,
      comp
    };
  });
  // Team-level KPI: a "free hit" each GW — best 15 under £100m by a given
  // score, best legal XI by the same score, captain = top non-GK. Scored later
  // against real points. Uses the engine's own optimizer/XI/captain helpers so
  // the only thing that varies between sources is the projection itself.
  const actualPath = process.argv[5];
  const actual = actualPath && fs.existsSync(actualPath) ? JSON.parse(fs.readFileSync(actualPath, "utf8")) : null;
  const sources = {
    model: p => p.proj,
    epNext: p => p.epNext,
    ...(actual ? { oracle: p => (actual[p.id] && actual[p.id].pts) || 0 } : {})
  };
  const byId = Object.fromEntries(allXP.map(p => [p.id, p]));
  const selections = {};
  for (const [name, fn] of Object.entries(sources)) {
    const pool = out.map(o => {
      const score = fn(o);
      return { ...byId[o.id], totalXP: score, score, xpPerPrice: score / Math.max(o.price, 4) };
    });
    const draft = VG.optimizeDraft(pool, 100, VG.allFixtures, gw, 1);
    const squad = draft.squad.map(p => ({ ...p, score: pool.find(q => q.id === p.id).score }));
    const xi = VG.pickBestXI(squad, "score");
    const cap = VG.topCaptainCandidates(xi.starting, "score")[0];
    selections[name] = { squad: squad.map(p => p.id), xi: xi.starting.map(p => p.id), captain: cap && cap.id, cost: draft.totalCost };
  }

  process.stdout.write(JSON.stringify({ gw, currentGW: VG.currentGW, n: out.length, players: out, selections }));
})().catch(e => { quiet("worker failed:", e && e.stack || e); process.exit(1); });
