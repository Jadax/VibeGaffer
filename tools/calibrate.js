// Per-channel calibration from the last backtest run: does each scoring
// component (minutes, goals, assists, CS, saves, bonus, DEFCON, conceded)
// match what actually happened? Run tools/backtest.js first.
//
// usage: node tools/calibrate.js
const path = require("path");
const { rows } = require(path.join(__dirname, ".cache", "last-run.json"));

const rel = rows.filter(p => p.own >= 1 || p.minsSoFar >= 90);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const f = x => x.toFixed(3);
const line = (label, exp, act) => console.log(`${label.padEnd(34)} expected ${f(exp).padStart(6)}  actual ${f(act).padStart(6)}  ratio ${(exp / Math.max(act, 1e-9)).toFixed(2)}`);

const byPos = { GK: 1, DEF: 2, MID: 3, FWD: 4 };
for (const [name, pos] of Object.entries(byPos)) {
  const l = rel.filter(p => p.pos === pos);
  console.log(`\n── ${name} (n=${l.length})`);
  line("P(start)  vs starts", mean(l.map(p => p.comp.minsProb)), mean(l.map(p => p.a_.starts || 0)));
  line("goals", mean(l.map(p => p.comp.goalProb)), mean(l.map(p => p.a_.g || 0)));
  line("assists", mean(l.map(p => p.comp.assistProb)), mean(l.map(p => p.a_.a || 0)));
  if (pos <= 3) line("CS pts", mean(l.map(p => p.comp.xpCS || 0)), mean(l.map(p => (p.a_.cs || 0) * ({ 1: 4, 2: 4, 3: 1 })[pos])));
  if (pos === 1) line("save pts", mean(l.map(p => p.comp.xpSaves || 0)), mean(l.map(p => Math.floor((p.a_.saves || 0) / 3))));
  line("bonus pts", mean(l.map(p => p.comp.xpBonus || 0)), mean(l.map(p => p.a_.bonus || 0)));
  if (pos === 2 || pos === 3) line("DEFCON pts", mean(l.map(p => p.comp.xpDEFCON || 0)), mean(l.map(p => ((p.a_.dc || 0) >= (pos === 2 ? 10 : 12)) ? 2 : 0)));
  if (pos <= 2) line("conceded deduction (pts, -)", mean(l.map(p => p.comp.conceded || 0)), mean(l.map(p => (p.a_.mins || 0) >= 60 ? Math.floor((p.a_.gc || 0) / 2) : 0)));
  line("appearance pts", mean(l.map(p => p.comp.xpAppearance || 0)), mean(l.map(p => (p.a_.mins || 0) >= 60 ? 2 : (p.a_.mins || 0) > 0 ? 1 : 0)));
  line("TOTAL", mean(l.map(p => p.proj)), mean(l.map(p => p.act)));
}

// Start-probability calibration: is P(start) honest across its range?
console.log("\n── P(start) buckets (all positions)");
[[0, .2], [.2, .4], [.4, .6], [.6, .8], [.8, 1.01]].forEach(([a, b]) => {
  const l = rel.filter(p => p.fixtures === 1 && p.comp.minsProb >= a && p.comp.minsProb < b);
  console.log(`[${a.toFixed(1)}, ${b.toFixed(1)})  n=${String(l.length).padEnd(5)} predicted ${f(mean(l.map(p => p.comp.minsProb)))}  actual start rate ${f(mean(l.map(p => p.a_.starts || 0)))}`);
});
