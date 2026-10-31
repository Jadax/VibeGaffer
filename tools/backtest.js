// Walk-forward backtest of the CURRENT engine against past gameweeks.
//
// For each finished GW it pulls docs/data/* exactly as committed just before
// that GW's deadline (the data bot snapshots every few hours, so git history
// is a record of what the engine would have seen), runs the engine on it in a
// fresh process, and compares projections with the real points.
//
// usage: node tools/backtest.js [fromGW] [toGW] [horizon]
//   e.g. node tools/backtest.js 2 8
// Real results are cached in tools/.cache (gitignored).
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const cache = path.join(__dirname, ".cache");
fs.mkdirSync(cache, { recursive: true });
const DATA_FILES = ["bootstrap-lite.json", "bootstrap.json", "fixtures.json", "understat.json",
  "recent-form.json", "history-priors.json", "setpieces.json", "odds.json"];

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

const getJSON = url => new Promise((resolve, reject) => {
  https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; VibeGaffer-backtest/1.0)" } }, res => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", c => { body += c; });
    res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(url + " -> " + res.statusCode)));
  }).on("error", reject);
});

async function bootstrapNow() {
  const f = path.join(cache, "bootstrap-now.json");
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3) return JSON.parse(fs.readFileSync(f, "utf8"));
  const j = await getJSON("https://fantasy.premierleague.com/api/bootstrap-static/");
  fs.writeFileSync(f, JSON.stringify({ events: j.events }));
  return j;
}

// Actual points per player for a finished GW: { id: { pts, mins } }.
async function actuals(gw) {
  const f = path.join(cache, `live2-gw${gw}.json`);
  if (fs.existsSync(f)) return f;
  const j = await getJSON(`https://fantasy.premierleague.com/api/event/${gw}/live/`);
  const map = {};
  j.elements.forEach(e => {
    const s = e.stats;
    map[e.id] = { pts: s.total_points, mins: s.minutes, starts: s.starts, g: s.goals_scored, a: s.assists,
      cs: s.clean_sheets, gc: s.goals_conceded, saves: s.saves, bonus: s.bonus, dc: s.defensive_contribution, yc: s.yellow_cards };
  });
  fs.writeFileSync(f, JSON.stringify(map));
  return f;
}

// docs/data as committed just before the deadline.
function snapshot(gw, deadline) {
  const dir = path.join(cache, `snap-gw${gw}`);
  const commit = git("rev-list", "-1", `--before=${deadline}`, "HEAD", "--", "docs/data").trim();
  if (!commit) throw new Error("no data snapshot before GW" + gw + " deadline");
  const stamp = path.join(dir, ".commit");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === commit) return { dir, commit };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of DATA_FILES) {
    try { fs.writeFileSync(path.join(dir, name), git("show", `${commit}:docs/data/${name}`)); } catch (e) { /* not present yet at that commit */ }
  }
  fs.writeFileSync(stamp, commit);
  return { dir, commit };
}

// ── metrics ───────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const spearman = (x, y) => pearson(rank(x), rank(y));
const topK = (rows, key, k) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, k);
const teamPoints = (sel, act) => sel.xi.reduce((s, id) => s + ((act[id] && act[id].pts) || 0), 0) + ((act[sel.captain] && act[sel.captain].pts) || 0);

(async () => {
  const [fromGW, toGW, horizon] = [parseInt(process.argv[2] || "2"), parseInt(process.argv[3] || "8"), process.argv[4] || "6"];
  const boot = await bootstrapNow();
  const rows = [], perGW = [];
  for (let gw = fromGW; gw <= toGW; gw++) {
    const ev = boot.events.find(e => e.id === gw);
    if (!ev || !ev.finished) { console.log(`GW${gw}: not finished, skipped`); continue; }
    const snap = snapshot(gw, ev.deadline_time);
    const actPath = await actuals(gw);
    const act = JSON.parse(fs.readFileSync(actPath, "utf8"));
    const res = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "backtest-worker.js"), gw, snap.dir, horizon, actPath],
      { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }));
    const players = res.players.map(p => ({ ...p, gw, act: (act[p.id] && act[p.id].pts) || 0, actMins: (act[p.id] && act[p.id].mins) || 0, a_: act[p.id] || {} }));
    rows.push(...players);
    const rel = players.filter(p => p.own >= 1 || p.minsSoFar >= 90);
    const team = Object.fromEntries(Object.entries(res.selections).map(([k, s]) => [k, teamPoints(s, act)]));
    perGW.push({ gw, commit: snap.commit.slice(0, 7), avg: ev.average_entry_score, n: rel.length,
      rhoModel: spearman(rel.map(p => p.proj), rel.map(p => p.act)),
      rhoEp: spearman(rel.map(p => p.epNext), rel.map(p => p.act)),
      top50Model: mean(topK(rel, "proj", 50).map(p => p.act)),
      top50Ep: mean(topK(rel, "epNext", 50).map(p => p.act)),
      team });
  }

  const f2 = x => (Math.round(x * 100) / 100).toFixed(2);
  console.log("\nGW  snap     n    rho(model) rho(ep_next)  top50 model/ep   team: model / ep_next / oracle / avg mgr");
  perGW.forEach(r => console.log(
    `${String(r.gw).padEnd(3)} ${r.commit}  ${String(r.n).padEnd(4)} ${f2(r.rhoModel).padStart(9)}  ${f2(r.rhoEp).padStart(11)}   ${f2(r.top50Model)} / ${f2(r.top50Ep)}      ${r.team.model} / ${r.team.epNext} / ${r.team.oracle} / ${r.avg}`));
  const tot = k => perGW.reduce((s, r) => s + (r.team[k] || 0), 0);
  console.log(`\nMean rho  model ${f2(mean(perGW.map(r => r.rhoModel)))}  ep_next ${f2(mean(perGW.map(r => r.rhoEp)))}`);
  console.log(`Team totals  model ${tot("model")}  ep_next ${tot("epNext")}  oracle ${tot("oracle")}  avg manager ${perGW.reduce((s, r) => s + r.avg, 0)}`);

  // Calibration: where is the model biased?
  const rel = rows.filter(p => p.own >= 1 || p.minsSoFar >= 90);
  const band = (label, list) => console.log(`${label.padEnd(26)} n=${String(list.length).padEnd(5)} proj ${f2(mean(list.map(p => p.proj)))}  ep ${f2(mean(list.map(p => p.epNext)))}  actual ${f2(mean(list.map(p => p.act)))}  played ${Math.round(100 * mean(list.map(p => p.actMins > 0 ? 1 : 0)))}%`);
  console.log("\nCalibration (relevant players, all GWs):");
  ["", "GK", "DEF", "MID", "FWD"].forEach((n, pos) => pos && band(n, rel.filter(p => p.pos === pos)));
  [[0, 5], [5, 6.5], [6.5, 8.5], [8.5, 20]].forEach(([a, b]) => band(`price £${a}-${b}m`, rel.filter(p => p.price >= a && p.price < b)));
  band("top-100 projected", perGW.flatMap(r => topK(rel.filter(p => p.gw === r.gw), "proj", 100)));
  band("top-100 by ep_next", perGW.flatMap(r => topK(rel.filter(p => p.gw === r.gw), "epNext", 100)));

  // Horizon check: GW g..g+3 projected from the deadline-g snapshot vs the
  // real 4-GW total (only where all four GWs have finished).
  const actByGW = {};
  for (const r of perGW) for (const k of [0, 1, 2, 3]) {
    const g = r.gw + k, ev = boot.events.find(e => e.id === g);
    if (ev && ev.finished && !actByGW[g]) actByGW[g] = JSON.parse(fs.readFileSync(await actuals(g), "utf8"));
  }
  const hz = perGW.filter(r => [1, 2, 3].every(k => actByGW[r.gw + k]));
  if (hz.length) {
    const rh = hz.map(r => {
      const l = rows.filter(p => p.gw === r.gw && (p.own >= 1 || p.minsSoFar >= 90));
      const proj = l.map(p => p.proj + p.projAhead.reduce((s, x) => s + x, 0));
      const act = l.map(p => [0, 1, 2, 3].reduce((s, k) => s + (((actByGW[r.gw + k] || {})[p.id] || {}).pts || 0), 0));
      return { gw: r.gw, rho: spearman(proj, act), bias: mean(proj) / Math.max(mean(act), 1e-9) };
    });
    console.log("\n4-GW horizon (projected from the first deadline):");
    rh.forEach(h => console.log(`  GW${h.gw}-${h.gw + 3}: rho ${f2(h.rho)}  level ${f2(h.bias)}`));
    console.log(`  mean rho ${f2(mean(rh.map(h => h.rho)))}`);
  }

  fs.writeFileSync(path.join(cache, "last-run.json"), JSON.stringify({ perGW, rows }));
  console.log("\nRows saved to tools/.cache/last-run.json");
})().catch(e => { console.error(e); process.exit(1); });
