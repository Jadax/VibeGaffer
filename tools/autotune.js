// Self-tuning: re-fits the engine's VG.MODEL constants against every finished
// gameweek and publishes them to docs/data/model-params.json, which the app
// and the FPL Copilot load at start-up. Runs weekly in GitHub Actions.
//
// Search: coordinate descent over a small grid per parameter, starting from
// the currently published values. Score per run = mean Spearman rho of
// projected vs actual points + a small team-points term.
// Guard against overfitting: tune on all finished GWs but the last two, then
// keep the new values only if they also score at least as well on those two.
//
// usage: node tools/autotune.js [--dry]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "docs", "data", "model-params.json");
const lastRun = path.join(__dirname, ".cache", "last-run.json");

// Each grid brackets the hand-tuned v6 value.
const GRID = {
  startK: [2, 3, 5],
  teamK: [2, 4, 8],
  xgWeight: [0.5, 0.65, 0.8],
  marketWeight: [0.3, 0.5, 0.7],
  cameoPrior: [0.15, 0.25, 0.35],
  bonusK: [3, 6, 12],
  dcK: [2, 4, 8],
  gaDispersion: [6, 11, 20],
  eliteWeight: [0, 0.15, 0.3],
  benchWeight: [0.05, 0.1, 0.2]
};

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

function run(params, from, to) {
  execFileSync(process.execPath, [path.join(__dirname, "backtest.js"), String(from), String(to)], {
    cwd: root, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, VG_MODEL: JSON.stringify(params) }
  });
  const { perGW } = JSON.parse(fs.readFileSync(lastRun, "utf8"));
  return perGW;
}

const score = perGW => mean(perGW.map(r => r.rhoModel)) +
  0.1 * (perGW.reduce((s, r) => s + r.team.model, 0) / Math.max(1, perGW.reduce((s, r) => s + r.avg, 0)) - 1);

(async () => {
  const dry = process.argv.includes("--dry");
  const published = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  const base = { ...((published && published.params) || {}) };

  // Finished GWs: backtest skips unfinished ones, so one probe run finds them.
  const all = run(base, 1, 38).map(r => r.gw);
  if (all.length < 4) { console.log("Not enough finished GWs to tune (" + all.length + ")"); return; }
  const fitTo = all[all.length - 3], valFrom = all[all.length - 2], last = all[all.length - 1];
  const fitScore = p => score(run(p, all[0], fitTo));
  const valScore = p => score(run(p, valFrom, last));

  let best = { ...base }, bestScore = fitScore(best);
  const baseFit = bestScore;
  console.log(`fit GW${all[0]}-${fitTo}, validate GW${valFrom}-${last}; baseline fit ${bestScore.toFixed(4)}`);
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const [k, values] of Object.entries(GRID)) {
      for (const v of values) {
        if (best[k] === v) continue;
        const s = fitScore({ ...best, [k]: v });
        if (s > bestScore + 0.002) { best = { ...best, [k]: v }; bestScore = s; moved = true; console.log(`  ${k}=${v}  fit ${s.toFixed(4)}`); }
      }
    }
    if (!moved) break;
  }

  const baseVal = valScore(base), newVal = valScore(best);
  const accept = bestScore > baseFit + 0.005 && newVal >= baseVal;
  console.log(`fit ${baseFit.toFixed(4)} -> ${bestScore.toFixed(4)}; validation ${baseVal.toFixed(4)} -> ${newVal.toFixed(4)}: ${accept ? "ACCEPT" : "keep current"}`);
  const params = accept ? best : base;
  const fullRun = run(params, all[0], last);
  const record = {
    updated: new Date().toISOString().slice(0, 10),
    gws: [all[0], last],
    meanRho: +mean(fullRun.map(r => r.rhoModel)).toFixed(3),
    meanRhoEpNext: +mean(fullRun.map(r => r.rhoEp)).toFixed(3),
    teamPoints: fullRun.reduce((s, r) => s + r.team.model, 0),
    avgManagerPoints: fullRun.reduce((s, r) => s + r.avg, 0),
    params
  };
  console.log(JSON.stringify(record));
  if (!dry) fs.writeFileSync(out, JSON.stringify(record, null, 1) + "\n");
})().catch(e => { console.error(e); process.exit(1); });
