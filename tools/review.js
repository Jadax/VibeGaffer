// Weekly self-review: for every finished gameweek, rebuild the advice the
// CURRENT engine gives a real squad at that deadline (from the data as it was
// committed before the deadline), score it against what actually happened,
// and set it beside the manager's own score, the top 200 and the average.
// The misses are spelled out (non-playing starters, cards, captain, price
// calls, biased scoring channels) so each week says what to fix next.
//
// usage: node tools/review.js [entryId=2769173] [fromGW=2]
// writes tools/data/review-gw{g}.json and docs/data/review.json (summary the
// app and the FPL Copilot show).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getJSON, bootstrapNow, actuals, snapshot, git, spearman, mean } = require("./backtest.js");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(__dirname, "data");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = x => Math.round(x * 10) / 10;

// Free transfers banked before each GW, rebuilt from the manager's history:
// one a week, up to five; Wildcard / Free Hit weeks keep the bank.
function freeTransfersBefore(history) {
  const ft = {};
  let bank = 1;
  const chipAt = Object.fromEntries((history.chips || []).map(c => [c.event, c.name]));
  for (const e of history.current) {
    ft[e.event] = e.event === 1 ? 0 : bank;
    if (e.event === 1) { bank = 1; continue; }
    const kept = chipAt[e.event] === "wildcard" || chipAt[e.event] === "freehit" ? bank : Math.max(0, bank - e.event_transfers);
    bank = Math.min(5, kept + 1);
  }
  return ft;
}

// Points a lineup actually scores: XI with simple auto-subs (bench order,
// GK for GK), captain doubled, vice if the captain did not play.
function lineupPoints(xi, bench, captain, vice, act, pos) {
  const played = id => ((act[id] || {}).mins || 0) > 0;
  const pts = id => (act[id] || {}).pts || 0;
  const used = new Set();
  let total = 0;
  const subs = [];
  for (const id of xi) {
    if (played(id)) { total += pts(id); continue; }
    const sub = bench.find(b => !used.has(b) && played(b) && ((pos[b] === 1) === (pos[id] === 1)));
    if (sub) { used.add(sub); total += pts(sub); subs.push([id, sub]); }
  }
  const cap = played(captain) ? captain : played(vice) ? vice : null;
  if (cap) total += pts(cap);
  return { total, subs, captainUsed: cap };
}

(async () => {
  const entry = parseInt(process.argv[2] || process.env.FPL_ENTRY || "2769173", 10);
  const fromGW = parseInt(process.argv[3] || "2", 10);
  const boot = await bootstrapNow();
  const players = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "bootstrap.json"), "utf8")).elements;
  const name = Object.fromEntries(players.map(p => [p.id, p.web_name]));
  const pos = Object.fromEntries(players.map(p => [p.id, p.element_type]));
  const history = await getJSON(`https://fantasy.premierleague.com/api/entry/${entry}/history/`);
  const ftBefore = freeTransfersBefore(history);
  const weeks = [];
  // Chips follow the advice's own path: once the engine has played one in a
  // half-season window it is gone for the rest of that window.
  const adviceUsed = new Set();

  for (const ev of boot.events.filter(e => e.finished && e.id >= fromGW)) {
    const gw = ev.id;
    const mine = history.current.find(e => e.event === gw);
    if (!mine) continue;
    const prev = await getJSON(`https://fantasy.premierleague.com/api/entry/${entry}/event/${gw - 1}/picks/`);
    const now = await getJSON(`https://fantasy.premierleague.com/api/entry/${entry}/event/${gw}/picks/`);
    await sleep(200);
    const windowEnd = gw <= 19 ? 19 : 38;
    if (gw === 20) adviceUsed.clear();
    const adviceIn = {
      picks: prev.picks.map(p => ({ element: p.element, position: p.position, selling_price: p.selling_price })),
      bank: ((prev.entry_history || {}).bank || 0) / 10,
      ft: Math.max(1, ftBefore[gw] || 1),
      chips: { windowEnd, chipsAvailable: ["wildcard", "free_hit", "bench_boost", "triple_captain"].filter(k => !adviceUsed.has(k)) }
    };

    const snap = snapshot(gw, ev.deadline_time);
    const actPath = await actuals(gw);
    const act = JSON.parse(fs.readFileSync(actPath, "utf8"));
    const res = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "backtest-worker.js"), gw, snap.dir, "6", actPath], {
      cwd: root, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ADVICE: JSON.stringify(adviceIn) }
    }));
    const a = res.advice;

    // What the advice would have scored, with or without the chip squad.
    const plain = lineupPoints(a.xi, a.bench, a.captain, a.vice, act, pos);
    const chipLine = a.chipSquad ? lineupPoints(a.chipSquad.xi, a.chipSquad.bench, a.chipSquad.captain, a.chipSquad.vice, act, pos) : null;
    const used = chipLine ? a.chipSquad : a;
    const playNow = Object.entries(a.chips).filter(([, v]) => v.recommend && v.bestGW === gw).map(([k]) => k);
    let advicePoints = chipLine ? chipLine.total : plain.total - a.hitCost;
    let teamChip = null;
    if (!chipLine && playNow.includes("triple_captain") && plain.captainUsed) {
      advicePoints += (act[plain.captainUsed] || {}).pts || 0;
      teamChip = "triple_captain";
    } else if (!chipLine && playNow.includes("bench_boost")) {
      const subbedIn = new Set(plain.subs.map(x => x[1]));
      advicePoints += a.bench.filter(id => !subbedIn.has(id)).reduce((t, id) => t + ((act[id] || {}).pts || 0), 0);
      teamChip = "bench_boost";
    }
    const chipPlayed = chipLine ? a.chipSquad.chip : teamChip;
    if (chipPlayed) adviceUsed.add(chipPlayed);

    // Top 200 that week.
    const eliteFile = path.join(dataDir, `elite-gw${gw}.json`);
    const elite = fs.existsSync(eliteFile) ? JSON.parse(fs.readFileSync(eliteFile, "utf8")) : null;
    const eliteCap = elite ? Object.entries(elite.players).sort((x, y) => y[1].cap - x[1].cap)[0] : null;

    // Diagnostics.
    const rows = res.players;
    const byId = Object.fromEntries(rows.map(p => [p.id, p]));
    const noShows = used.xi.filter(id => !((act[id] || {}).mins > 0)).map(id => {
      const p = byId[id] || {};
      return { id, name: name[id], flagged: p.chance != null && p.chance < 100, xMins: Math.round(p.xMins || 0) };
    });
    const cards = used.xi.filter(id => (act[id] || {}).yc || (act[id] || {}).rc).map(id => ({ id, name: name[id], yc: act[id].yc || 0, rc: act[id].rc || 0 }));
    const projRank = Object.fromEntries([...rows].sort((x, y) => y.proj - x.proj).map((p, i) => [p.id, i + 1]));
    const missedHauls = Object.entries(act).filter(([, s]) => s.pts >= 10).sort((x, y) => y[1].pts - x[1].pts).slice(0, 8)
      .map(([id, s]) => ({ id: +id, name: name[id], pts: s.pts, projRank: projRank[id] || null, proj: byId[id] ? r1(byId[id].proj) : null }));
    const rel = rows.filter(p => p.own >= 1 || p.minsSoFar >= 90);
    const channel = {};
    for (const [label, p] of [["GK", 1], ["DEF", 2], ["MID", 3], ["FWD", 4]]) {
      const l = rel.filter(r => r.pos === p);
      channel[label] = { proj: r1(mean(l.map(r => r.proj))), actual: r1(mean(l.map(r => (act[r.id] || {}).pts || 0))) };
    }
    // Price calls from the deadline vs prices a day later.
    let priceHit = null;
    try {
      const t = new Date(new Date(ev.deadline_time).getTime() + 30 * 3600e3).toISOString();
      const c = git("rev-list", "-1", `--before=${t}`, "HEAD", "--", "docs/data/bootstrap.json").trim();
      const later = Object.fromEntries(JSON.parse(git("show", `${c}:docs/data/bootstrap.json`)).elements.map(e => [e.id, e.now_cost]));
      const before = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(snap.dir, fs.existsSync(path.join(snap.dir, "bootstrap.json")) ? "bootstrap.json" : "bootstrap-lite.json"), "utf8")).elements.map(e => [e.id, e.now_cost]));
      const calls = res.prices.filter(x => x.risk === "rising" || x.risk === "falling");
      const right = calls.filter(x => (x.risk === "rising" ? later[x.id] > before[x.id] : later[x.id] < before[x.id])).length;
      priceHit = calls.length ? { calls: calls.length, right } : null;
    } catch (e) { /* no later snapshot yet */ }

    const lessons = [];
    if (noShows.length) lessons.push(`${noShows.length} advised starter${noShows.length > 1 ? "s" : ""} did not play: ${noShows.map(n => n.name + (n.flagged ? " (was flagged)" : "")).join(", ")}.`);
    const capPts = (act[used.captain] || {}).pts || 0;
    if (eliteCap && +eliteCap[0] !== used.captain) {
      const ePts = (act[eliteCap[0]] || {}).pts || 0;
      lessons.push(`Captain ${name[used.captain]} (${capPts}) vs the top 200's ${name[eliteCap[0]]} (${ePts}, ${Math.round(eliteCap[1].cap * 100)}%).`);
    }
    if (cards.length) lessons.push(`Cards in the advised XI: ${cards.map(c => c.name + (c.rc ? " (red)" : "")).join(", ")}.`);
    const blind = missedHauls.filter(h => !h.projRank || h.projRank > 60);
    if (blind.length) lessons.push(`Hauls the model did not see: ${blind.map(h => `${h.name} ${h.pts} (ranked ${h.projRank || "-"})`).join(", ")}.`);
    for (const [k, v] of Object.entries(channel)) if (Math.abs(v.proj - v.actual) >= 0.6) lessons.push(`${k} ${v.proj > v.actual ? "over" : "under"}-projected: ${v.proj} vs ${v.actual} per player.`);
    if (priceHit && priceHit.right / priceHit.calls < 0.5) lessons.push(`Price calls weak: ${priceHit.right} of ${priceHit.calls} right.`);

    const week = {
      gw, entry,
      advice: {
        points: advicePoints, hitCost: chipLine ? 0 : a.hitCost, chip: chipPlayed,
        transfers: a.transfersOut.map((o, i) => [name[o], name[a.transfersIn[i]]]),
        captain: name[used.captain], captainPoints: capPts,
        chipsAdvised: playNow
      },
      manager: { points: mine.points - mine.event_transfers_cost, hitCost: mine.event_transfers_cost, chip: now.active_chip || null, captain: name[(now.picks.find(p => p.is_captain) || {}).element] },
      top200: elite ? { points: elite.strategy.points, captain: name[eliteCap[0]], chips: elite.strategy.chips } : null,
      average: ev.average_entry_score,
      rho: r1(spearman(rel.map(p => p.proj), rel.map(p => (act[p.id] || {}).pts || 0)) * 100) / 100,
      noShows, cards, missedHauls, channel, priceHit, lessons
    };
    fs.writeFileSync(path.join(dataDir, `review-gw${gw}.json`), JSON.stringify(week, null, 1) + "\n");
    weeks.push(week);
    console.log(`GW${gw}: advice ${advicePoints} | you ${week.manager.points} | top200 ${week.top200 ? week.top200.points : "-"} | avg ${week.average}`);
    week.lessons.forEach(l => console.log("   - " + l));
  }

  const total = k => weeks.reduce((s, w) => s + (k(w) || 0), 0);
  const summary = {
    updated: new Date().toISOString().slice(0, 10), entry,
    totals: { advice: total(w => w.advice.points), manager: total(w => w.manager.points), top200: r1(total(w => w.top200 && w.top200.points)), average: total(w => w.average) },
    weeks: weeks.map(w => ({ gw: w.gw, advice: w.advice.points, manager: w.manager.points, top200: w.top200 && w.top200.points, average: w.average, captain: w.advice.captain, chip: w.advice.chip, transfers: w.advice.transfers, lessons: w.lessons }))
  };
  fs.writeFileSync(path.join(root, "docs", "data", "review.json"), JSON.stringify(summary, null, 1) + "\n");
  console.log("\nTotals:", JSON.stringify(summary.totals));
})().catch(e => { console.error(e); process.exit(1); });
