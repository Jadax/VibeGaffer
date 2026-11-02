// Picks of the top managers in the FPL overall league, summarised per GW:
// how many own, start and captain each player. Public endpoints only, one
// request at a time with a pause, so FPL is never hammered.
//
// usage: node tools/fetch-elite.js <fromGW> <toGW> [managers=200]
// Writes tools/data/elite-gw{g}.json for every GW in range whose deadline has
// passed (picks are fixed after it, so existing files are kept), and
// docs/data/elite.json = the latest one, which the app reads.
const fs = require("fs");
const path = require("path");
const https = require("https");

const root = path.resolve(__dirname, "..");
const dir = path.join(__dirname, "data");
fs.mkdirSync(dir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const getJSON = (url, tries = 4) => new Promise((resolve, reject) => {
  https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; VibeGaffer/6.1)" } }, res => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", c => { body += c; });
    res.on("end", async () => {
      if (res.statusCode === 200) return resolve(JSON.parse(body));
      if (tries > 1 && (res.statusCode === 429 || res.statusCode >= 500)) {
        await sleep(3000);
        return getJSON(url, tries - 1).then(resolve, reject);
      }
      reject(new Error(url + " -> " + res.statusCode));
    });
  }).on("error", reject);
});

async function topEntries(n) {
  const ids = [];
  for (let page = 1; ids.length < n; page++) {
    const j = await getJSON(`https://fantasy.premierleague.com/api/leagues-classic/314/standings/?page_standings=${page}`);
    ids.push(...j.standings.results.map(r => r.entry));
    if (!j.standings.has_next) break;
    await sleep(250);
  }
  return ids.slice(0, n);
}

// Per GW: player shares (own / start / captain) plus how the top managers
// played the week: chips, transfers, hits, points, bench points, bank, value.
async function summarise(gw, ids) {
  const players = {};
  const chips = {};
  const t = { pts: 0, transfers: 0, hits: 0, bench: 0, bank: 0, value: 0, hitTakers: 0 };
  let n = 0;
  // Four requests in flight, each worker pausing between calls.
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      let p;
      try { p = await getJSON(`https://fantasy.premierleague.com/api/entry/${id}/event/${gw}/picks/`); } catch (e) { continue; }
      n++;
      for (const pk of p.picks) {
        const s = players[pk.element] || (players[pk.element] = { own: 0, start: 0, cap: 0 });
        s.own++;
        if (pk.multiplier > 0) s.start++;
        if (pk.is_captain) s.cap++;
      }
      if (p.active_chip) chips[p.active_chip] = (chips[p.active_chip] || 0) + 1;
      const h = p.entry_history || {};
      t.pts += h.points || 0;
      t.transfers += h.event_transfers || 0;
      t.hits += h.event_transfers_cost || 0;
      if (h.event_transfers_cost) t.hitTakers++;
      t.bench += h.points_on_bench || 0;
      t.bank += (h.bank || 0) / 10;
      t.value += (h.value || 0) / 10;
      await sleep(200);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (!n) return { gw, n };
  // Shares, so the signal does not depend on how many managers were read.
  for (const s of Object.values(players)) { s.own = +(s.own / n).toFixed(3); s.start = +(s.start / n).toFixed(3); s.cap = +(s.cap / n).toFixed(3); }
  const avg = x => +(x / n).toFixed(2);
  const strategy = {
    points: avg(t.pts), transfers: avg(t.transfers), hitCost: avg(t.hits), hitTakers: avg(t.hitTakers),
    benchPoints: avg(t.bench), bank: avg(t.bank), value: avg(t.value),
    chips: Object.fromEntries(Object.entries(chips).map(([k, v]) => [k, +(v / n).toFixed(3)]))
  };
  return { gw, n, strategy, players };
}

(async () => {
  const [from, to, nArg] = process.argv.slice(2);
  const boot = await getJSON("https://fantasy.premierleague.com/api/bootstrap-static/");
  const started = boot.events.filter(e => new Date(e.deadline_time).getTime() < Date.now()).map(e => e.id);
  const gws = started.filter(g => g >= parseInt(from, 10) && g <= parseInt(to, 10));
  const todo = gws.filter(g => !fs.existsSync(path.join(dir, `elite-gw${g}.json`)));
  if (todo.length) {
    const ids = await topEntries(parseInt(nArg || "200", 10));
    for (const gw of todo) {
      const res = await summarise(gw, ids);
      if (!res.n) continue;
      fs.writeFileSync(path.join(dir, `elite-gw${gw}.json`), JSON.stringify(res));
      console.log(`GW${gw}: ${res.n} managers, ${Object.keys(res.players).length} players`);
    }
  }
  const latest = gws.filter(g => fs.existsSync(path.join(dir, `elite-gw${g}.json`))).pop();
  if (latest) fs.copyFileSync(path.join(dir, `elite-gw${latest}.json`), path.join(root, "docs", "data", "elite.json"));
})().catch(e => { console.error(e); process.exit(1); });
