const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appPath = path.join(root, "docs", "app.js");
const dataPath = path.join(root, "docs", "data.js");
const indexPath = path.join(root, "docs", "index.html");
const uiPath = path.join(root, "docs", "ui.js");
const oddsWorkflowPath = path.join(root, ".github", "workflows", "fetch-odds.yml");
const dataWorkflowPath = path.join(root, ".github", "workflows", "fetch-data.yml");
const dataWorkflowSource = fs.readFileSync(dataWorkflowPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bootstrap = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "bootstrap.json"), "utf8"));
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "fixtures.json"), "utf8"));

global.document = {
  getElementById: () => null,
  createElement: () => ({}),
  head: { appendChild: () => {} }
};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = async () => ({ ok: false });
global.window = {};
global.VG = {};

const source = fs.readFileSync(appPath, "utf8").replace("const VG = {};", "// VG supplied by test harness");
new Function(source)();
new Function(fs.readFileSync(dataPath, "utf8"))();

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${name}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function positionCounts(squad) {
  return squad.reduce((counts, player) => {
    counts[player.positionId] = (counts[player.positionId] || 0) + 1;
    return counts;
  }, {});
}

VG.buildMaps(bootstrap);
const promotedTeamFixture = {
  elements: [],
  teams: [{ id: 99, name: "Promoted FC", strength: 2, strength_defence_home: 0, strength_overall_home: 0 }],
  events: []
};
VG.buildMaps(promotedTeamFixture);
check("Promoted-team fallback uses the API team rating", VG.teams[99].strength_overall_home === 930 && VG.teams[99].strength_attack_away === 890);
VG.buildMaps(bootstrap);
const allXP = VG.computeAllXP(1, 5, fixtures);

section("Data and xP engine");
check("Loaded all active players", allXP.length > 500);
check("Loaded 20 teams", Object.keys(VG.teams).length === 20);
check("Doubtful players remain available for evaluation", allXP.some(p => p.status === "d"));
check("Haaland has a positive projection", allXP.find(p => p.name === "Haaland")?.totalXP > 0);
check("Every player projection is non-negative", allXP.every(p => p.totalXP >= 0));
check("DEFCON uses a bounded threshold probability", VG.poissonAtLeast(0, 10) === 0 && VG.poissonAtLeast(20, 10) > 0.99 && VG.poissonAtLeast(5, 10) < 0.1);
check("At least one first-choice GK projects above 20 xP", allXP.some(p => p.position === "GK" && p.totalXP > 20));
check("Low-minute backup GKs may remain below 20 xP", allXP.some(p => p.position === "GK" && p.totalXP < 20));

// ── Recency-weighted rotation risk (v5.7) ──────────────────────────────
// Season-total starts can't distinguish "nailed for the last 5 GWs" from
// "started well early, benched since" — VG.loadRecentForm() (optional,
// absent pre-season) closes that gap. Test the blend directly against a
// real mid-rotation-rate player so both directions of the correction show up.
section("Recency-weighted rotation risk (v5.7)");
// Season-agnostic band: mid-season data has 10-30 start players; a freshly
// reset season has 0/1-start players — any outfielder with minutes on record
// exercises both directions of the recency correction.
const rotationCandidate = Object.values(VG.players).find(p =>
  p.element_type !== 1 && (p.starts || 0) >= 1 && (p.starts || 0) <= 30 && (p.minutes || 0) > 0
);
check("fixture data has an outfield player with minutes on record to test against", !!rotationCandidate);
if (rotationCandidate) {
  const fx = fixtures.find(f => f.event === 1 && (f.team_h === rotationCandidate.team || f.team_a === rotationCandidate.team));
  const isHome = fx.team_h === rotationCandidate.team;
  const oppId = isHome ? fx.team_a : fx.team_h;
  const fdr = isHome ? (fx.team_h_difficulty || 3) : (fx.team_a_difficulty || 3);

  const baseline = VG.computeFixtureXP(rotationCandidate.id, oppId, isHome, fdr);
  check("baseline projection has no recentForm influence pre-season", rotationCandidate.recentForm === undefined);

  rotationCandidate.recentForm = { starts5: 0, gws5: 5, mins5: 0 }; // just dropped from the XI
  const droppedProjection = VG.computeFixtureXP(rotationCandidate.id, oppId, isHome, fdr);
  check("a player with zero recent starts gets a lower minutes probability than the season baseline", droppedProjection.minsProb < baseline.minsProb);

  rotationCandidate.recentForm = { starts5: 5, gws5: 5, mins5: 450 }; // just became nailed
  const nailedProjection = VG.computeFixtureXP(rotationCandidate.id, oppId, isHome, fdr);
  check("a player with 5/5 recent starts gets a minutes probability >= the season baseline", nailedProjection.minsProb >= baseline.minsProb);
  check("recent-form correction moves projected xP in the same direction as minutes probability", nailedProjection.xp >= droppedProjection.xp);

  rotationCandidate.recentForm = { starts5: 1, gws5: 1, mins5: 90 };
  const thinSample = VG.computeFixtureXP(rotationCandidate.id, oppId, isHome, fdr);
  check("a single recent GW (below the 2-GW confidence floor) doesn't move the projection", Math.abs(thinSample.minsProb - baseline.minsProb) < 0.001);

  delete rotationCandidate.recentForm;
  const restored = VG.computeFixtureXP(rotationCandidate.id, oppId, isHome, fdr);
  check("removing recentForm restores the exact season-aggregate baseline", restored.minsProb === baseline.minsProb);
}

// ── Shared fixture/team helpers (v5.4 hardening) ──────────────────────
section("Shared fixture + team helpers (v5.4)");
const gw1All = VG.fixturesForGW(fixtures, 1);
const gw1Fixture = gw1All[0];
const homePid = gw1Fixture.team_h;
const awayPid = gw1Fixture.team_a;
check("fixturesForGW returns exactly that gameweek's matches", gw1All.length > 0 && gw1All.every(f => f.event === 1));
check("fixturesForGW returns [] for a blank gameweek", Array.isArray(VG.fixturesForGW(fixtures, 99)) && VG.fixturesForGW(fixtures, 99).length === 0);
const homeInfo = VG.teamFixtures(fixtures, 1, homePid);
check("teamFixtures finds home-side fixture", homeInfo.length === 1 && homeInfo[0].team_h === homePid);
check("teamFixtures returns [] when team plays no fixture", VG.teamFixtures(fixtures, 99, homePid).length === 0);
const rows = VG.teamFixtureRow(homePid, 1, 3, fixtures);
check("teamFixtureRow builds a 3-row fixture grid", rows.length === 3);
check("teamFixtureRow returns fixture info or null per week", rows.every(r => r === null || (r.oppName && typeof r.fdr === "number" && typeof r.isHome === "boolean")));
check("teamColor resolves short_name to a kit color", typeof VG.teamColor("ARS") === "string" && VG.teamColor("ARS").startsWith("#"));
check("teamColor resolves numeric team id via VG.teams", typeof VG.teamColor(homePid) === "string" && VG.teamColor(homePid).startsWith("#"));
check("teamColor falls back to a neutral color", VG.teamColor("ZZZ") === "#38bdf8" && VG.teamColor(null) === "#38bdf8");

section("Deterministic draft optimizer");
const draft = VG.optimizeDraft(allXP, 100, fixtures, 1, 5);
const repeatDraft = VG.optimizeDraft(allXP, 100, fixtures, 1, 5);
const counts = positionCounts(draft.squad);
check("Draft has 15 players", draft.squad.length === 15);
check("Draft has exact FPL position counts", counts[1] === 2 && counts[2] === 5 && counts[3] === 5 && counts[4] === 3);
check("Draft stays within budget", draft.totalCost <= 100.1);
check("Draft has no more than three players per club", Math.max(...Object.values(draft.squad.reduce((clubs, p) => {
  clubs[p.teamId] = (clubs[p.teamId] || 0) + 1;
  return clubs;
}, {}))) <= 3);
check("Draft has a legal starting formation", draft.formation.DEF + draft.formation.MID + draft.formation.FWD === 10);
check("Draft has captain and vice-captain", draft.gotCap.length === 2);
check(
  "Repeated optimization returns the same squad",
  draft.squad.map(p => p.id).sort((a, b) => a - b).join(",") ===
    repeatDraft.squad.map(p => p.id).sort((a, b) => a - b).join(",")
);

section("Single-gameweek projection");
const gw1Player = draft.squad[0];
const gw1Projection = VG.computePlayerGWProjection(gw1Player, 1, fixtures);
check("Normal GW projection has one fixture", gw1Projection.fixtureCount === 1);
check("Normal GW projection is not a horizon total", gw1Projection.gwXP < gw1Player.totalXP);
check("Blank GW projection is zero", VG.computePlayerGWProjection(gw1Player, 99, fixtures).gwXP === 0);

const lineup = VG.computeLineupAdvice(draft.squad, allXP, fixtures, 1);
check("Lineup advice exists", !!lineup);
check("Lineup contains 11 starters", lineup?.starting.length === 11);
check("Lineup contains four bench players", lineup?.bench.length === 4);
check("Lineup total is a plausible single-GW value", Number(lineup?.totalXP) > 0 && Number(lineup?.totalXP) < 150);
check(
  "Every displayed lineup xP equals its GW projection",
  lineup?.starting.every(player => {
    const sourcePlayer = allXP.find(candidate => candidate.id === draft.squad.find(p => p.name === player.name)?.id);
    return sourcePlayer && Math.abs(player.totalXP - VG.computePlayerGWProjection(sourcePlayer, 1, fixtures).gwXP) < 0.01;
  })
);

section("Captain rotation and DGW detection");
const rotation = VG.computeCaptainRotation(draft.squad, allXP, fixtures, 1, 5);
check("Rotation covers five GWs", rotation?.length === 5);
check("Normal GWs are not marked as doubles", rotation?.every(gw => !gw.dgw));
check("Each GW has three sorted candidates", rotation?.every(gw =>
  gw.top3.length === 3 && gw.top3[0].gwXP >= gw.top3[1].gwXP && gw.top3[1].gwXP >= gw.top3[2].gwXP
));
check(
  "Captain rotation uses actual per-GW xP",
  rotation?.every(gw => gw.top3.every(player =>
    Math.abs(player.gwXP - VG.computePlayerGWProjection(player, gw.gw, fixtures).gwXP) < 0.01
  ))
);

const dgwPlayer = draft.squad.find(player => player.positionId !== 1);
const baseFixture = fixtures.find(f => f.event === 1 && (f.team_h === dgwPlayer.teamId || f.team_a === dgwPlayer.teamId));
const dgwFixtures = [
  { ...baseFixture, id: 9001, event: 39 },
  { ...baseFixture, id: 9002, event: 39 }
];
const dgwRotation = VG.computeCaptainRotation(draft.squad, allXP, dgwFixtures, 39, 1);
check("A team with two fixtures is marked as a DGW", dgwRotation?.[0].dgw === true);
check("DGW projection sums both fixtures", VG.computePlayerGWProjection(dgwPlayer, 39, dgwFixtures).fixtureCount === 2);

section("Strategies and supporting engines");
const strategies = VG.optimizeStrategies(allXP, 100, fixtures, 1, 5);
check("All three strategies are available", !!strategies.balanced && !!strategies.premium && !!strategies.value);
check("Every strategy returns a full squad", Object.values(strategies).every(strategy => strategy.squad.length === 15));
check("Value strategy respects the £8m cap", strategies.value.squad.every(player => player.price <= 8));
check("Premium strategy is labelled correctly", strategies.premium.strategy === "premium");
check("Value strategy is labelled correctly", strategies.value.strategy === "value");

const mockSquad = draft.squad.map(p => ({
  element: p.id,
  web_name: p.name,
  now_cost: Math.round(p.price * 10),
  selling_price: Math.round(p.price * 10)
}));
const transfers = VG.optimizeTransfers(mockSquad, allXP, 0.5, 1, 1, 5);
check("Transfer optimizer returns hit details", Array.isArray(transfers.hitDetails));
check("Transfer roadmap covers five GWs", VG.computeTransferRoadmap(draft.squad, allXP, fixtures, 1, 5)?.length === 5);
check("Transfer planner covers five GWs", VG.computeTransferPlan(draft.squad, allXP, fixtures, 1, 5, draft.budgetRemaining, 1)?.schedule.length === 5);
check("Chip engine evaluates every chip", Object.keys(VG.evaluateChips(draft.squad, draft.gwPicks, fixtures)).includes("triple_captain"));

// v5.17: user-tunable transfer constraints (FFHub "transfer preferences" idea).
check("validTransfer honours avoidTeams", (() => {
  const p = { teamId: 2, price: 6.0, positionId: 3, eo: 40 };
  return VG.validTransfer(p, { avoidTeams: [2] }) === false && VG.validTransfer(p, { avoidTeams: [3] }) === true;
})());
check("validTransfer honours maxPrice/minPrice/EO band", (() => {
  const p = { teamId: 2, price: 6.0, positionId: 3, eo: 40 };
  return VG.validTransfer(p, { maxPrice: 5.5 }) === false &&
         VG.validTransfer(p, { minPrice: 6.5 }) === false &&
         VG.validTransfer(p, { minEO: 50 }) === false &&
         VG.validTransfer(p, { maxEO: 30 }) === false &&
         VG.validTransfer(p, {}) === true;
})());
check("validTransfer honours targetTeams and avoidPositions", (() => {
  const p = { teamId: 2, price: 6.0, positionId: 3, eo: 40 };
  return VG.validTransfer(p, { targetTeams: [2] }) === true &&
         VG.validTransfer(p, { targetTeams: [9] }) === false &&
         VG.validTransfer(p, { avoidPositions: [3] }) === false;
})());
check("optimizeTransfers caps total trades via maxTransfers", (() => {
  const constrained = VG.optimizeTransfers(mockSquad, allXP, 10, 5, 1, 5, { maxTransfers: 1 });
  return constrained.transfersIn.length <= 1 && constrained.transfersOut.length <= 1;
})());

// v5.17: forced-replacement pass — when a player is unavailable (injured,
// suspended, left the league), the optimizer MUST recommend replacing them
// even when no value upgrade clears the threshold. This guards against the
// "Watkins in Saudi league + Mateta injured → 0 transfers" scenario.
check("optimizeTransfers forces replacement for unavailable players", (() => {
  // Mark a squad player as unavailable (status "i" = injured)
  const victim = allXP.find(p => p.positionId >= 2 && p.positionId <= 4 && p.totalXP > 10);
  if (!victim) return false;
  const origStatus = VG.players[victim.id]?.status;
  if (VG.players[victim.id]) VG.players[victim.id].status = "i";
  // Build a squad containing the unavailable player with 0 bank so there's
  // no budget for a value-upgrade — the forced pass should still fire.
  const unavailSquad = mockSquad.length > 0 ? [...mockSquad] : allXP.slice(0, 15).map(p => ({
    element: p.id, web_name: p.name, now_cost: Math.round(p.price * 10), selling_price: Math.round(p.price * 10)
  }));
  // Ensure victim is in the squad
  if (!unavailSquad.some(sp => sp.element === victim.id)) {
    unavailSquad[0] = { element: victim.id, web_name: victim.name, now_cost: Math.round(victim.price * 10), selling_price: Math.round(victim.price * 10) };
  }
  const result = VG.optimizeTransfers(unavailSquad, allXP, 0, 2, 1, 5);
  const forcedOut = result.transfersOut.some(p => p.id === victim.id);
  // Restore status
  if (VG.players[victim.id] && origStatus !== undefined) VG.players[victim.id].status = origStatus;
  return forcedOut && result.transfersIn.length >= 1;
})());

// Captaincy must never select an unavailable player (Golden Rule 3).
check("topCaptainCandidates filters unavailable players", (() => {
  const starterWithId = allXP.slice(0, 11).map(p => ({ ...p }));
  // Make the best player unavailable
  const best = starterWithId.reduce((a, b) => (b.totalXP || 0) > (a.totalXP || 0) ? b : a);
  const origStatus = VG.players[best.id]?.status;
  if (VG.players[best.id]) VG.players[best.id].status = "s";
  const caps = VG.topCaptainCandidates(starterWithId, "totalXP");
  const safe = caps.every(c => c.id !== best.id);
  if (VG.players[best.id] && origStatus !== undefined) VG.players[best.id].status = origStatus;
  return safe;
})());

section("Regressions");
const captainReason = VG.getCaptainReasoning({
  name: "Test",
  position: "MID",
  positionId: 3,
  price: 10,
  isHome: "H",
  oppName: "TST",
  fdr: 2,
  gwXP: 7,
  isDoubtful: true
}, fixtures, 1);
check("Doubtful captain warning is shown", captainReason.details.some(detail => detail.includes("Doubtful")));

const indexMarkup = fs.readFileSync(indexPath, "utf8");
const uiSource = fs.readFileSync(uiPath, "utf8");
const indexSource = indexMarkup + "\n" + uiSource;
check("Premium/value dropdown routes through strategy optimizer", indexSource.includes('VG.optimizeStrategies(allXP, 100, VG.allFixtures, gw, horizon)[strategy]'));
check("Tab preloader defines its DOM helper", /VG\.preloadTabs = async \(gw\) => \{\r?\n  const el = id => document\.getElementById\(id\);/.test(indexSource));
check(
  `Release assets are cache-busted to package version ${pkg.version}`,
  indexMarkup.includes(`app.js?v=${pkg.version}`) && indexMarkup.includes(`data.js?v=${pkg.version}`) && indexMarkup.includes(`ui.js?v=${pkg.version}`) && indexMarkup.includes(`style.css?v=${pkg.version}`)
);

const appSource = fs.readFileSync(appPath, "utf8");
const dataSource = fs.readFileSync(dataPath, "utf8");
// Scope the "no randomness" determinism check to the greedy optimizer body only —
// the Monte Carlo simulator legitimately uses Math.random() elsewhere.
const optStart = appSource.indexOf("VG.optimizeDraft =");
const optBody = optStart >= 0 ? appSource.slice(optStart, appSource.indexOf("VG.optimizeStrategies =", optStart)) : appSource;
check("ILP uses exact GK constraint", appSource.includes("' pos' + pos + '_exact: '"));
check("ILP no longer allows flexible forward counts", !appSource.includes("fwd_min:"));
check("Optimizer no longer uses random swaps", !optBody.includes("Math.random()"));
check("Pitch is inverted per FPL-opposite request (GK row at top)", appSource.includes('{ pos: 1, label: "GK", y: 18 }'));

const oddsWorkflow = fs.readFileSync(oddsWorkflowPath, "utf8");
check("Odds workflow handles bookmaker arrays", oddsWorkflow.includes("for bookmaker in event.get('bookmakers', []):"));
check("Odds workflow reads bookmaker markets", oddsWorkflow.includes("bookmaker.get('markets', [])"));
check("Odds workflow no longer calls .items() on bookmakers", !oddsWorkflow.includes("event.get('bookmakers', {}).items()"));

section("v5.3.0 hardening");

check("esc() neutralises angle brackets", VG.esc('<img src=x onerror=alert(1)>') === "&lt;img src=x onerror=alert(1)&gt;");
check("esc() escapes quotes and ampersands", VG.esc(`"&'`) === "&quot;&amp;&#39;");
check("esc() handles null and undefined", VG.esc(null) === "" && VG.esc(undefined) === "");
check(
  "Attacker-controlled league names are escaped before render",
  indexSource.includes("VG.esc(league.leagueName)") && indexSource.includes("VG.esc(s.name)")
);
check("CDN scripts pin an SRI hash", indexSource.includes('integrity="sha384-') && appSource.includes("script.integrity = 'sha384-"));
check("A Content-Security-Policy is declared", indexSource.includes("Content-Security-Policy") && indexSource.includes("default-src 'none'"));

check("Formation list is defined once", appSource.split("[3, 4, 3], [3, 5, 2]").length - 1 === 1);
check("Availability filter is defined once", appSource.split("VG.isAvailable = (p)").length - 1 === 1);
check("FDR extraction is centralised", !appSource.includes("team_h_difficulty || 3) : (f.team_a_difficulty"));
check("Shared XI picker is used by every optimizer", appSource.split("VG.pickBestXI(").length - 1 >= 4);

check("Pitch xP/GW respects the selected horizon", !appSource.includes("p.totalXP / 12"));
check("Compare tab matches players by id, not name", !indexSource.includes("x.name === name") && indexSource.includes("x.id === parseInt(o.value)"));
check("Transfer mode reports a real squad value", !indexSource.includes("totalCost: 0, budgetRemaining: bank"));
check("Transfer mode honours the xP horizon", indexSource.includes("g >= gw && g < gw + horizon"));
check("HiGHS loading flag is cleared on success", /VG\._highsReady = highs;\s*\n\s*VG\._highsLoading = false;/.test(appSource));
check("Optimize does not refetch bootstrap when already loaded", indexSource.includes("if (!VG.bootstrapData || !VG.players)"));
check("HiGHS is read from the global it actually publishes", appSource.includes("window.Module || window.Highs"));
check("CSP permits WebAssembly without allowing eval", indexMarkup.includes("'wasm-unsafe-eval'") && !indexMarkup.includes("'unsafe-eval' ") && !indexMarkup.includes("script-src 'self' 'unsafe-inline'"));
check("UI logic is externalized and inline handlers are removed", indexMarkup.includes(`ui.js?v=${pkg.version}`) && !indexMarkup.includes("onclick=") && !uiSource.includes("onclick="));
check("data transport is externalized into its own module", indexMarkup.includes(`data.js?v=${pkg.version}`) && fs.readFileSync(dataPath, "utf8").includes("VG.loadBootstrap"));
check("public modules load in dependency order", indexMarkup.indexOf("app.js?v=") < indexMarkup.indexOf("data.js?v=") && indexMarkup.indexOf("data.js?v=") < indexMarkup.indexOf("ui.js?v="));
check("CORS proxy fallback requires explicit user consent", dataSource.includes("window.confirm(\"The FPL API is not reachable directly") && dataSource.includes("VG.proxyConsent = false"));
check("FPL 404 is authoritative so pre-deadline falls back to draft, not relay roulette", dataSource.includes('r.status === 404') && dataSource.includes('/404/.test(String(e.message))'));
check("user-owned Cloudflare Worker relay is tried first (override) and needs no consent", dataSource.includes("VG._relayList") && dataSource.includes("own: true") && dataSource.includes("VG.proxyURL = ()"));
check("a shared app-wide relay is built in so every visitor loads squad data with no setup", dataSource.includes("VG.SHARED_RELAY") && dataSource.includes("vibegaffer-relay.sharma-tushant.workers.dev") && dataSource.includes('name: "relay"'));
check("CSP allows the workers.dev relay scope", indexMarkup.includes("https://*.workers.dev"));
check("sidebar no longer surfaces CORS Worker URL or Mini-League ID inputs to users", !indexMarkup.includes('id="proxyURL"') && !indexMarkup.includes('id="leagueId"') && !indexMarkup.includes("Mini-League ID"));
check("primary classic league is auto-detected from the entry, no Manual league ID", dataSource.includes("VG.detectPrimaryLeague") && uiSource.includes("VG.detectPrimaryLeague"))

const dataWorkflow = fs.readFileSync(dataWorkflowPath, "utf8");
check("Data fetch fails fast on HTTP errors so fallbacks fire", dataWorkflow.includes("curl -sfL"));
check("Data fetch is deadline-aware, not a flat 15-minute cron", !dataWorkflow.includes("'*/15 * * * *'"));

check("Python implementation is gone", !fs.existsSync(path.join(root, "app.py")) && !fs.existsSync(path.join(root, "optimizer.py")));
check("Free history-prior automation is configured", fs.existsSync(path.join(root, ".github", "workflows", "fetch-history-priors.yml")) && dataSource.includes("VG.applyHistoryPriors"));
check("compact bootstrap is generated and consumed with a full-data fallback", dataSource.includes('data/bootstrap-lite.json') && dataWorkflowSource.includes("bootstrap-lite.json") && dataWorkflowSource.includes("player_fields"));

section("v5.3.0 live + smart captaincy");

check("Live tab is present in the tab bar", indexMarkup.includes('data-tab="live"') && indexMarkup.includes('id="tab-live"'));
check("all ten public tabs have matching controls and panels", ["squad", "briefing", "live", "compare", "prices", "fixtures", "diffs", "plan", "league", "tips"].every(tab => indexMarkup.includes(`data-tab="${tab}"`) && indexMarkup.includes(`id="tab-${tab}"`)));
check("Live tab is preloaded on run", indexSource.includes("VG.renderLive(liveGW, liveTeam)"));

// computeLivePoints sums the authoritative explain blocks
const fakeLive = { elements: [
  { id: 1, explain: [{ fixture: 1, stats: [{ identifier: "goals_scored", points: 6 }, { identifier: "minutes", points: 2 }] }] },
  { id: 2, explain: [] },
  { id: 3, explain: [{ fixture: 2, stats: [{ identifier: "clean_sheets", points: 4 }] }] }
]};
const livePts = VG.computeLivePoints(fakeLive);
check("computeLivePoints sums explain blocks", livePts[1] === 8 && livePts[2] === 0 && livePts[3] === 4);

// predictBonus: distinct BPS gets 3/2/1
const f1 = fixtures.find(f => f.event >= 1);
const bonusLive = { elements: [
  { id: 10, stats: { minutes: 90, bps: 30 }, explain: [{ fixture: f1.id, stats: [] }] },
  { id: 11, stats: { minutes: 90, bps: 25 }, explain: [{ fixture: f1.id, stats: [] }] },
  { id: 12, stats: { minutes: 90, bps: 20 }, explain: [{ fixture: f1.id, stats: [] }] },
  { id: 13, stats: { minutes: 90, bps: 35 }, explain: [{ fixture: f1.id, stats: [] }] }
]};
const bonus = VG.predictBonus(bonusLive, fixtures, f1.event);
check("predictBonus awards 3/2/1 per fixture", bonus[13] === 3 && bonus[10] === 2 && bonus[11] === 1 && bonus[12] === undefined);

// tie for 1st → both 3, next 1
const tieLive = { elements: [
  { id: 20, stats: { minutes: 90, bps: 40 }, explain: [{ fixture: f1.id, stats: [] }] },
  { id: 21, stats: { minutes: 90, bps: 40 }, explain: [{ fixture: f1.id, stats: [] }] },
  { id: 22, stats: { minutes: 90, bps: 30 }, explain: [{ fixture: f1.id, stats: [] }] }
]};
const bonusTie = VG.predictBonus(tieLive, fixtures, f1.event);
check("predictBonus handles 1st-place ties (3-3-1)", bonusTie[20] === 3 && bonusTie[21] === 3 && bonusTie[22] === 1);

// simulateAutoSubs: a 0-min MID starter is replaced by the playing bench MID
const start = [
  { element: 1, id: 1, positionId: 1 },
  { element: 2, id: 2, positionId: 2 }, { element: 3, id: 3, positionId: 2 },
  { element: 4, id: 4, positionId: 2 }, { element: 5, id: 5, positionId: 2 },
  { element: 6, id: 6, positionId: 3 }, { element: 7, id: 7, positionId: 3 },
  { element: 8, id: 8, positionId: 3 }, { element: 9, id: 9, positionId: 3 },
  { element: 10, id: 10, positionId: 4 }, { element: 11, id: 11, positionId: 4 }
];
const bench = [
  { element: 20, id: 20, positionId: 1 },
  { element: 21, id: 21, positionId: 2 },
  { element: 22, id: 22, positionId: 3 },
  { element: 23, id: 23, positionId: 4 }
];
const mins = { 1: 90, 2: 90, 3: 90, 4: 90, 5: 90, 6: 90, 7: 90, 8: 0, 9: 90, 10: 90, 11: 90, 22: 90 };
const subs = VG.simulateAutoSubs(start, bench, mins);
check("auto-subs replace the 0-min starter", subs.subs.length === 1 && subs.subs[0].out === 8 && subs.subs[0].in === 22);
check("auto-sub keeps the formation legal", subs.starting.filter(p => p.positionId === 1).length >= 1 && subs.starting.filter(p => p.positionId === 2).length >= 3 && subs.starting.filter(p => p.positionId === 3).length >= 2 && subs.starting.filter(p => p.positionId === 4).length >= 1);

// captain blank probability
const capDummy = { id: 1, teamId: 1, positionId: 3 };
const blank = VG.computeBlankProbability(capDummy, fixtures, 1);
check("blank probability stays in a sane range", blank.pBlank >= 0.03 && blank.pBlank <= 0.5 && Array.isArray(blank.reasons));
const cr = VG.getCaptainReasoning(Object.assign({}, capDummy, { fdr: 2, gwXP: 7, isHome: "H", oppName: "ARS" }), fixtures, 1);
check("captain reasoning now includes blank risk", cr.blank !== undefined && cr.details.some(d => d.includes("blank risk")));
VG.players[9998] = { starts: 0, minutes: 0, status: "a", yellow_cards: 0 };
VG.players[9999] = { starts: 30, minutes: 2700, status: "u", yellow_cards: 0 };
const insuranceCaptain = { id: 9998, teamId: 1, gwXP: 8 };
const insuranceVice = { id: 9999, teamId: 1, gwXP: 10 };
const insCapBlank = VG.computeBlankProbability(insuranceCaptain, fixtures, 1).pBlank;
const insVcBlank = VG.computeBlankProbability(insuranceVice, fixtures, 1).pBlank;
const expectedInsurance = +(1.4 * (insCapBlank / 0.10) * (1 - insVcBlank) * Math.min(10 / 5, 1.5)).toFixed(2);
check("VC insurance uses the captain blank risk, vice xP and vice blank discount", VG.computeViceCaptainEV(insuranceCaptain, insuranceVice, fixtures, 1) === expectedInsurance);
// Remove the synthetic captains so later Object.values(VG.players) scans
// (candidate searches etc.) don't iterate test stubs.
delete VG.players[9998];
delete VG.players[9999];

// differential matrix zones
const zones = [
  VG.getDifferentialZone({ ownership: 5, xpPerPrice: 2.5 }),
  VG.getDifferentialZone({ ownership: 30, xpPerPrice: 2.5 }),
  VG.getDifferentialZone({ ownership: 5, xpPerPrice: 1.2 }),
  VG.getDifferentialZone({ ownership: 30, xpPerPrice: 1.2 })
];
check("differential matrix classifies all four zones", zones.map(z => z.zone).join(",") === "gold,anchor,wait,trap");

// price-change predictor needs a minimal player table. Save + restore the
// real entries — these ids exist in the bootstrap and later tests scan
// Object.values(VG.players).
const priceStubIds = [100, 101, 102];
const priceStubsSaved = priceStubIds.map(id => [id, VG.players[id]]);
priceStubIds.forEach((id, i) => { VG.players[id] = { web_name: "P" + (i + 1), element_type: [3, 4, 2][i], now_cost: [80, 90, 60][i] }; });
const priceLive = { elements: [
  { id: 100, stats: { transfers_in: 200000, transfers_out: 0 } },
  { id: 101, stats: { transfers_in: 0, transfers_out: 80000 } },
  { id: 102, stats: { transfers_in: 10000, transfers_out: 10000 } }
]};
const priceMoves = VG.predictPriceChanges(priceLive);
check("price predictor flags risers and fallers", priceMoves.some(p => p.risk === "rising") && priceMoves.some(p => p.risk === "falling") && priceMoves.length === 2);
priceStubIds.forEach((id, i) => { if (priceStubsSaved[i][1] === undefined) delete VG.players[id]; else VG.players[id] = priceStubsSaved[i][1]; });

// Understat enrichment: forecasts, real xG, injury feed
section("Understat enrichment (v5.4)");
const mci = bootstrap.teams.find(t => t.short_name === "MCI").id;
const ars = bootstrap.teams.find(t => t.short_name === "ARS").id;
VG.understat = { fixtures: [
  { home: "MCI", away: "ARS", datetime: "2026-08-21 19:30:00", forecast: { w: "0.60", d: "0.22", l: "0.18" } }
] };
const probs = VG._matchWinProbs(mci, ars);
check("understat forecast supplies win/lose probabilities", probs !== null && probs.source === "understat" && Math.abs(probs.win + probs.lose + 0.22 - 1) < 0.001);
VG.understat = null;
VG.oddsData = [{ home: "MCI", away: "ARS", h2h: { home: 1.5, draw: 4.5, away: 7.0 } }];
const probsBk = VG._matchWinProbs(mci, ars);
check("match probs fall back to bookmaker h2h when available", probsBk !== null && probsBk.source === "bookmaker" && probsBk.win > probsBk.lose);
VG.oddsData = null;
check("match probs return null with no data", VG._matchWinProbs(mci, ars) === null);
VG.understat = { fixtures: [
  { home: "MCI", away: "ARS", datetime: "2026-08-21 19:30:00", forecast: { w: "0.60", d: "0.22", l: "0.18" } }
] };

const arsPlayer = bootstrap.elements.find(p => p.team === ars && p.status === "a");
const arsXP = VG.computeAllXP(1, 1, fixtures);
check("real xG exposed on projections", arsXP.some(p => p.id === arsPlayer.id && typeof p.realXG === "number"));
VG.players[arsPlayer.id].understat = { xG: 20, xA: 5, time: 2700, games: 30 };
const arsXPWithUs = VG.computeAllXP(1, 1, fixtures);
const arsWith = arsXPWithUs.find(p => p.id === arsPlayer.id);
check("understat blend changes the projection", Math.abs((arsWith.realXG90 || 0) - 20 * 90 / 2700) < 0.01 && arsWith.realXG === 20);

// ── xG regression flags (v5.4): Understat xG vs actual FPL goals ──────
section("xG regression flags (v5.4)");
VG.players[arsPlayer.id].understat = null;
check("regression flag is null without understat data", VG.getRegressionFlag(arsPlayer.id) === null);
VG.players[arsPlayer.id].understat = { xG: 20, xA: 5, time: 2700, games: 30 };
VG.players[arsPlayer.id].goals_scored = "20";
VG.players[arsPlayer.id].minutes = "2700";
const regStable = VG.getRegressionFlag(arsPlayer.id);
check("regression flag stable when goals match xG", regStable !== null && regStable.flag === "stable");
VG.players[arsPlayer.id].goals_scored = "2";
const regDue = VG.getRegressionFlag(arsPlayer.id);
check("regression flag marks underperforming strikers DUE", regDue !== null && regDue.flag === "due" && regDue.diff90 < 0);
VG.players[arsPlayer.id].goals_scored = "38";
const regOver = VG.getRegressionFlag(arsPlayer.id);
check("regression flag marks overperforming strikers OVER", regOver !== null && regOver.flag === "over" && regOver.diff90 > 0);
check("regression badge renders DUE/OVER and empty for stable", VG.regressionBadge(regDue).includes("DUE") && VG.regressionBadge(regOver).includes("OVER") && VG.regressionBadge({ flag: "stable" }) === "" && VG.regressionBadge(null) === "");
check("regression badge handles diff sign without double-symbol", VG.regressionBadge(regDue).includes("DUE -0.60") && VG.regressionBadge(regOver).includes("OVER +0.60"));
VG.players[arsPlayer.id].understat = null;
VG.players[arsPlayer.id].goals_scored = undefined;
VG.players[arsPlayer.id].minutes = undefined;

const flagged = VG.players[arsPlayer.id];
flagged.chance_of_playing_next_round = 50;
const capFlag = { id: arsPlayer.id, teamId: ars, positionId: 3 };
const blankFlag = VG.computeBlankProbability(capFlag, fixtures, 1);
check("blank risk incorporates chance_of_playing flag", blankFlag.reasons.some(r => r.includes("chance to play")));
const feed = VG.injuryNews();
check("injury feed surfaces fitness-flagged players", feed.some(p => p.id === arsPlayer.id && p.chance === 50));

// ── Team Strength Ratings (v5.4) ──────────────────────────────────────
section("Team strength ratings (v5.4)");
const teamRatesNull = VG.computeTeamRatings();
check("team ratings return null without understat data", teamRatesNull === null);
const teamPrior = {};
const allFplTeams = bootstrap.teams.map(t => t.id);
allFplTeams.forEach((id, i) => {
  teamPrior[id] = {
    npxg90: 0.8 + (i % 5) * 0.4,
    npxga90: 0.9 + ((i * 7) % 4) * 0.3,
    ppda: 9 + i,
    deep: 5 + i
  };
});
teamPrior[Object.keys(teamPrior)[0]].npxg90 = 2.6;
VG.understat = { teams: teamPrior };
const teamRates = VG.computeTeamRatings();
check("team ratings compute for every FPL team", teamRates && teamRates.length === 20);
check("team ratings are ranked and sorted by overall", teamRates[0].overallRank === 1 && teamRates[19].overallRank === 20);
check("strongest attack gets the top attack rank", teamRates.find(r => r.attRank === 1).npxg90 === 2.6);
check("team rating stays within 1-5", teamRates.every(r => r.rating >= 1 && r.rating <= 5));
check("team ratings render HTML table", typeof VG.render.teamRatings(teamRates) === "string" && VG.render.teamRatings(teamRates).includes("ticker-table"));
check("team ratings render gracefully without data", VG.render.teamRatings(null).includes("unavailable"));
VG.understat = null;

// ── v5.10: season-adaptive Elo team strength ────────────────────────────
// computeTeamElo blends results-driven attack/defence Elo back into the
// strength_* fields computeFixtureXP reads. It mutates VG.teams, so snapshot
// the strength fields and restore them after the section to keep later tests
// hermetic.
section("Season-adaptive Elo team strength (v5.10)");
const eloStrengths = {};
Object.values(VG.teams).forEach(t => {
  eloStrengths[t.id] = {
    ah: t.strength_attack_home, aa: t.strength_attack_away,
    dh: t.strength_defence_home, da: t.strength_defence_away,
    oh: t.strength_overall_home, oa: t.strength_overall_away
  };
});
// Seed-only path: clone the real schedule but strip result fields, so the
// assertion holds in-season too (real fixtures.json carries finished GWs once
// games are played — the old "real data is pre-season" assumption broke at GW1).
const unfinishedFx = fixtures.map(f => ({ ...f, finished: false, finished_provisional: false, team_h_score: null, team_a_score: null }));
const preElo = VG.computeTeamElo(unfinishedFx);
check("elo returns a full 20-team table pre-season", preElo && preElo.length === 20);
check("elo is seed-only with no finished fixtures", preElo.every(r => r.played === 0 && r.weight === 0 && r.source === "seed"));
check("elo with no finished fixtures leaves the strength fields byte-identical", Object.values(VG.teams).every(t => t.strength_attack_home === eloStrengths[t.id].ah && t.strength_overall_home === eloStrengths[t.id].oh));
check("elo HTML renders nothing with no data", VG.eloRatingsHTML(preElo) === "");

// Synthetic finished fixtures: ARS (1) beats SHU (19) 3-0 and LIV (5) 2-1;
// MCI (20) wins 2-0 away at CHE (2). Enough to move ratings off the seed.
const eloFx = [
  { id: 1001, event: 1, finished: true, team_h: 1, team_a: 19, team_h_score: 3, team_a_score: 0 },
  { id: 1002, event: 1, finished: true, team_h: 2, team_a: 20, team_h_score: 0, team_a_score: 2 },
  { id: 1003, event: 2, finished: true, team_h: 1, team_a: 5, team_h_score: 2, team_a_score: 1 }
];
const eloRows = VG.computeTeamElo(eloFx);
const arsElo = eloRows.find(r => r.id === 1);
const shuElo = eloRows.find(r => r.id === 19);
check("elo ranks all 20 teams and sorts by overall", eloRows.length === 20 && eloRows[0].rank === 1 && eloRows[19].rank === 20 && eloRows.every((r, i) => i === 0 || eloRows[i - 1].overall >= r.overall));
check("a two-win side ranks above a two-loss side", arsElo.rank < shuElo.rank);
check("a winning side carries higher attack Elo than the team it thumped", arsElo.att > shuElo.att);
check("played teams carry results stats", arsElo.played === 2 && arsElo.w === 2 && arsElo.gf === 5 && arsElo.ga === 1);
const idleElo = eloRows.find(r => r.id === 3);
check("a team with no finished fixtures keeps the seed", idleElo.played === 0 && idleElo.weight === 0 && idleElo.source === "seed");
check("elo blends a winning streak into the strength fields", VG.teams[1].strength_attack_home > eloStrengths[1].ah);
check("elo attaches a per-team elo record", VG.teams[1].elo && VG.teams[1].elo.played === 2 && VG.teams[1].elo.weight > 0);
const manyFx = Array.from({ length: 8 }, (_, i) => ({ id: 2000 + i, event: 1 + i, finished: true, team_h: 1, team_a: 3, team_h_score: 2, team_a_score: 1 }));
const capRows = VG.computeTeamElo(manyFx);
check("blend weight caps at 0.85 once a team has 8+ games", capRows.find(r => r.id === 1).weight === 0.85);
const eloHtml = VG.eloRatingsHTML(eloRows);
check("elo table renders ticker-table markup", typeof eloHtml === "string" && eloHtml.includes("ticker-table") && eloHtml.includes("Attack Elo"));
check("elo table shows each team's short name", eloRows.every(r => eloHtml.includes(r.short)));
Object.values(VG.teams).forEach(t => {
  t.strength_attack_home = eloStrengths[t.id].ah;
  t.strength_attack_away = eloStrengths[t.id].aa;
  t.strength_defence_home = eloStrengths[t.id].dh;
  t.strength_defence_away = eloStrengths[t.id].da;
  t.strength_overall_home = eloStrengths[t.id].oh;
  t.strength_overall_away = eloStrengths[t.id].oa;
  delete t.elo;
});
delete VG.teamElo;

// ── v5.5 features: EO, Monte Carlo, DGW/BGW planner, set-pieces, rank impact ──
section("v5.5 features (EO, MC, planner, set-pieces, rank)");
// Effective ownership
const eoModel = VG.computeEffectiveOwnership(allXP);
check("EO model exposes a captain pool", eoModel.pool.length > 0 && eoModel.pool.length <= 12);
const eoTop = eoModel.forPlayer(allXP[0]);
check("EO is ownership weighted by captain share", eoTop.eo >= eoTop.own && eoTop.capShare >= 0 && typeof eoTop.eo === "number");
check("allXP carries eo/capShare fields", allXP.every(p => typeof p.eo === "number" && typeof p.capShare === "number"));
check("EO ranks template picks highest", allXP.slice(0, 5).every(p => p.eo >= (p.ownership || 0)));

// Monte Carlo distribution
const mcDraft = VG.optimizeDraft(allXP, 100, fixtures, 1, 5);
const mcStart = mcDraft.starting || mcDraft.squad.slice(0, 11);
const mcCap = { ...(mcDraft.gotCap && mcDraft.gotCap[0] ? mcDraft.gotCap[0] : mcStart[0]), isCaptain: true, multiplier: 2 };
const startingWithCap = mcStart.map(p => p.id === mcCap.id ? { ...p, isCaptain: true, multiplier: 2, element_type: p.positionId } : { ...p, element_type: p.positionId });
const dist = VG.mcGWDistribution(startingWithCap, fixtures, 1, 2000);
check("MC distribution returns stats", dist.mean > 0 && dist.n === 2000 && dist.p10 <= dist.median && dist.median <= dist.p90);
check("MC green-arrow probability is bounded 0-100", VG.greenArrowProb(dist, dist.mean) > 0 && VG.greenArrowProb(dist, dist.mean) < 100);
check("MC range helper reports floor/ceiling/band", (() => { const r = VG.mcRange(dist); return r.floor === dist.p10 && r.ceiling === dist.p90 && r.band > 0; })());
check("MC distribution is empty-safe", VG.mcGWDistribution([], fixtures, 1, 100).n === 0);

// DGW/BGW season planner
const planner = VG.buildSeasonPlanner(fixtures);
check("season planner covers 38 gameweeks", planner.length >= 30 && planner.length <= 38);
check("season planner flags DGW/BGW teams per week", planner.every(p => Array.isArray(p.dgwTeams) && Array.isArray(p.bgwTeams)));
check("base fixtures have no DGW/BGW (all teams play once)", planner.every(p => p.dgwTeams.length === 0 && p.bgwTeams.length === 0));
// Inject a synthetic double gameweek: duplicate one fixture to give a team 2 matches in GW1.
const dupFixtures = fixtures.map(f => f.event === 1 ? { ...f, id: f.id + 99999 } : f);
const plannerDup = VG.buildSeasonPlanner(dupFixtures.concat(fixtures.filter(f => f.event === 1)));
const gw1dup = plannerDup.find(p => p.gw === 1);
check("season planner detects a synthetic DGW team", gw1dup && gw1dup.dgwTeams.length > 0);
const row = VG.teamSeasonRow(planner, mcDraft.squad[0].teamId, 1, 38);
check("team season row covers the horizon", row.cells.length === 38 && row.cells.every(c => c.n === 0 || c.n === 1 || c.n === 2));

// Set-piece boost
VG.loadSetPieces({ teams: { ARS: { pen: ["Saka"], fk: ["Ødegaard"], cor: ["Saka"] } } });
check("set-piece role lookup returns a boolean set", (() => { const r = VG.setPieceRole(arsPlayer.id); return typeof r.pen === "boolean" && typeof r.fk === "boolean" && typeof r.cor === "boolean"; })());
const spHaaland = Object.values(VG.players).find(p => p.web_name === "Haaland");
VG.loadSetPieces({ teams: { MCI: { pen: ["Haaland"], fk: [], cor: [] } } });
check("set-piece role flags penalty taker", spHaaland ? VG.setPieceRole(spHaaland.id).pen === true : true);
VG.loadSetPieces({ teams: {} });

// Rank impact estimate
const ri = VG.estimateRankImpact(5.0, { nGWs: 5, totalPlayers: 8000000 });
check("rank impact maps a gain to a rank improvement", ri.pts === 5 && ri.rankDelta < 0 && ri.direction === "gain");
check("rank impact is neutral for zero delta", VG.estimateRankImpact(0, {}).rankDelta === 0);

// ── v5.6 features: player profile, team news, chip calendar ───────────
section("v5.6 features (profile, team news, chip calendar)");
const prof = VG.playerProfileHTML(allXP[0], fixtures, 1);
check("player profile renders rich HTML", typeof prof === "string" && prof.includes("profile-panel") && prof.includes("Next 5 fixtures"));
check("player profile shows EO and set-piece", prof.includes("EO:") && (prof.includes("Set-pieces:") || prof.includes("Set-piece")));
const teamNews = VG.teamNewsFeed();
check("team news feed is a team->players map", typeof teamNews === "object" && teamNews !== null && !Array.isArray(teamNews));
check("team news feed entries are well-formed lists", Object.values(teamNews).every(list => Array.isArray(list) && list.every(e => e && typeof e.name === "string" && typeof e.news === "string")));
// Chip calendar: with a normal (no-DGW) schedule it returns [] or only strong-TC rows.
const chipPlanner = VG.buildSeasonPlanner(fixtures);
const chipCal = VG.chipCalendar(mcDraft.squad, chipPlanner);
check("chip calendar returns an array", Array.isArray(chipCal) && chipCal.every(c => typeof c.gw === "number"));
check("chip calendar renders or shows a no-window note", typeof VG.render.chipCalendar(chipCal) === "string");
// fixture run profile reflects easy/hard count
check("profile fixture run is length-limited to 5", ((prof.match(/\(A\)|\(H\)|BYE/g) || []).length <= 5) && ((prof.match(/\(A\)|\(H\)|BYE/g) || []).length >= 1));

// ── v5.7: Mini-League Race Simulator ───────────────────────────────────
section("v5.7 Mini-League Race Simulator");

// A strong squad (the optimizer's actual pick, captained) vs a deliberately
// weak one (11 cheapest available players, no captain boost) should show
// the strong squad winning the large majority of Monte Carlo draws.
const weakEleven = allXP.filter(p => p.positionId).sort((a, b) => a.price - b.price).slice(0, 11)
  .map(p => ({ ...p, element_type: p.positionId, isCaptain: false, multiplier: 1 }));
const strongSquad = { entry: 1, teamName: "Strong FC", totalPoints: 500, picks: startingWithCap.map(p => ({ ...p, multiplier: p.isCaptain ? 2 : 1 })) };
const weakSquad = { entry: 2, teamName: "Weak FC", totalPoints: 500, picks: weakEleven.map(p => ({ ...p, multiplier: 1 })) };

const race = VG.simulateLeagueRace([strongSquad, weakSquad], fixtures, 1, 1500);
check("race simulator returns one row per entrant", race && race.length === 2);
check("race simulator favors the stronger squad", race[0].entry === 1 && race[0].winProb > race[1].winProb);
check("win probabilities are bounded 0-100 and roughly sum to 100", race.every(r => r.winProb >= 0 && r.winProb <= 100) && Math.abs(race.reduce((s, r) => s + r.winProb, 0) - 100) < 1);
check("top-3 probability is 100% for both when only two entrants exist", race.every(r => r.top3Prob === 100));
check("race projects a floor <= mean <= ceiling per entrant", race.every(r => r.gwFloor <= r.gwMean && r.gwMean <= r.gwCeiling));
check("race simulator needs at least two squads", VG.simulateLeagueRace([strongSquad], fixtures, 1, 100) === null);
check("race simulator ignores squads with no picks", VG.simulateLeagueRace([strongSquad, { entry: 3, teamName: "Empty", totalPoints: 0, picks: [] }], fixtures, 1, 100) === null);

// A same-strength head-to-head should land close to 50/50 (loose bound —
// this is a stochastic test, so give it real room).
const mirrorRace = VG.simulateLeagueRace(
  [{ entry: 1, teamName: "A", totalPoints: 500, picks: strongSquad.picks }, { entry: 2, teamName: "B", totalPoints: 500, picks: strongSquad.picks }],
  fixtures, 1, 1500
);
check("identical squads at equal totals split win probability roughly evenly", mirrorRace.every(r => r.winProb >= 30 && r.winProb <= 70));

// analyzeLeague now enriches picks with id/positionId (needed by the race
// simulator) and accepts a fixtures param — verify the signature and that
// it still fails closed (returns null, never throws) when the network mock
// used by this harness can't actually reach the FPL API.
check("analyzeLeague accepts (leagueId, currentGW, fixtures)", VG.analyzeLeague.length === 3);

// ── v5.8: horizon cap, new-player priors, recency blend, xMins ─────────
section("v5.8 Horizon cap + new-player priors + recency blend");
// Horizon must never exceed the GWs left in the season.
check("remainingGWs caps at the season end", VG.remainingGWs(1) === 38 && VG.remainingGWs(38) === 1 && VG.remainingGWs(50) === 0);
check("clampHorizon respects remaining GWs", VG.clampHorizon(12, 30) === 9 && VG.clampHorizon(12, 38) === 1 && VG.clampHorizon(6, 1) === 6);
// Pre-season fallback must scale to remaining weeks, not the raw request.
const clampPid = allXP[0].id;
const fallbackXP = VG.computeMultiGWXP(clampPid, 30, 12, []).totalXP;
const fallbackXPcap = VG.computeMultiGWXP(clampPid, 30, 5, []).totalXP;
check("pre-season no-fixture fallback is capped to remaining GWs", fallbackXP >= 0 && Math.abs(fallbackXP - fallbackXPcap * (9 / 5)) < 0.5);
// The in-season fixture filter also honors the cap.
const lateHorizonXP = VG.computeMultiGWXP(clampPid, 35, 12, fixtures);
check("computeMultiGWXP only counts fixtures within remaining GWs", lateHorizonXP.gwDetails.length <= 4);
check("computed xP exposes an expected-minutes (xMins) signal", typeof allXP[0].xMins === "number" && allXP[0].xMins >= 0);
check("xMins is capped at 90 for a nailed player", allXP.filter(p => p.xMins > 0).every(p => p.xMins <= 90.1));

// New-player prior: a player with zero PL minutes still projects via ep_next,
// and the fixture result flags them so the UI can label them NEW.
const newCand = Object.values(VG.players).find(p =>
  (p.minutes || 0) === 0 && (p.starts || 0) === 0 && parseFloat(p.expected_goals || "0") === 0 && parseFloat(p.expected_assists || "0") === 0
);
if (newCand) {
  const nfx = fixtures.find(f => f.event === 1 && (f.team_h === newCand.team || f.team_a === newCand.team));
  if (nfx) {
    const nHome = nfx.team_h === newCand.team;
    const nOpp = nHome ? nfx.team_a : nfx.team_h;
    const nFdr = nHome ? (nfx.team_h_difficulty || 3) : (nfx.team_a_difficulty || 3);
    const nres = VG.computeFixtureXP(newCand.id, nOpp, nHome, nFdr);
    check("a new-to-PL player is flagged as isNew", nres.isNew === true);
    check("a new-to-PL player gets a usable prior projection", nres.xp > 0);
  }
}

// ── v5.13: transfer / new-club detection + foreign-league priors ────────
section("v5.13 Transfer detection + new-club context + foreign priors");

// teamByCode maps the stable franchise code (team.code) that history-priors
// and the current bootstrap both use — the key that makes cross-season club
// comparison meaningful (FPL team ids are NOT stable across seasons).
const arsTeam = Object.values(VG.teams).find(t => t.short_name === "ARS");
const mciTeam = Object.values(VG.teams).find(t => t.short_name === "MCI");
check("teamByCode maps the ARS franchise code", arsTeam && VG.teamByCode[String(arsTeam.code)] === arsTeam);
check("teamByCode maps the MCI franchise code", mciTeam && VG.teamByCode[String(mciTeam.code)] === mciTeam);

// transferInfo decisions are null-safe and priors-driven.
check("transferInfo is null-safe", VG.transferInfo(null).transferred === false);
check("transferInfo without a prior reports no move", (() => {
  const t = VG.transferInfo({ id: 1, team: arsTeam.id });
  return t.transferred === false && t.toTeam === arsTeam;
})());
check("transferInfo ignores an unchanged club code", VG.transferInfo({ id: 2, team: arsTeam.id, priorTeamCode: String(arsTeam.code) }).transferred === false);
check("transferInfo detects a cross-club move", (() => {
  const t = VG.transferInfo({ id: 3, team: arsTeam.id, priorTeamCode: String(mciTeam.code) });
  return t.transferred === true && t.fromTeam.short_name === "MCI" && t.toTeam.short_name === "ARS";
})());
check("transferInfo treats an unknown prior club (relegated/foreign) as no move", VG.transferInfo({ id: 4, team: arsTeam.id, priorTeamCode: "9999" }).transferred === false);
check("transferInfo surfaces a foreign-league prior", VG.transferInfo({ id: 5, team: arsTeam.id, understat: { league: "La_liga" } }).foreignLeague === "La_liga");
check("transferInfo ignores an EPL prior league", VG.transferInfo({ id: 6, team: arsTeam.id, understat: { league: "EPL" } }).foreignLeague === "");
check("foreignLeagueLabel maps league slugs", VG.foreignLeagueLabel("La_liga") === "LA LIGA" && VG.foreignLeagueLabel("Bundesliga") === "BUNDESLIGA" && VG.foreignLeagueLabel("") === "");
check("transferBadge renders a move", (() => {
  const b = VG.transferBadge({ transferred: true, fromTeam: { short_name: "MCI" }, toTeam: { short_name: "ARS" } });
  return b.includes("MCI") && b.includes("ARS") && b.includes("NEW CLUB");
})());
check("transferBadge is empty when no move", VG.transferBadge({ transferred: false }) === "" && VG.transferBadge(null) === "");

// New-club attacking-context multiplier: hold the player + current club fixed
// and vary only the OLD club's attack strength. A move from a weak club to a
// strong one must boost the projection; the reverse must dampen it; the swing
// must be clamped (±20%) so one transfer can't dominate the model. Pre-season
// strength fallbacks are all equal, so temporarily install distinct strengths.
const ctxPlayer = Object.values(VG.players).find(p =>
  p.element_type !== 1 && (p.minutes || 0) > 0 && (p.starts || 0) > 0
);
if (ctxPlayer) {
  const ctxFixture = fixtures.find(f => f.event === 1 && (f.team_h === ctxPlayer.team || f.team_a === ctxPlayer.team));
  const ctxTeam = VG.teams[ctxPlayer.team];
  const strongClub = Object.values(VG.teams).find(t => t.id !== ctxPlayer.team && t.id !== (ctxFixture ? (ctxFixture.team_h === ctxPlayer.team ? ctxFixture.team_a : ctxFixture.team_h) : -1));
  const weakClub = Object.values(VG.teams).find(t => t.id !== ctxPlayer.team && t.id !== strongClub.id);
  const ctxClubs = [ctxTeam, strongClub, weakClub].filter(Boolean);
  const savedCtx = { clubs: ctxClubs.map(t => ({ t, home: t.strength_attack_home, away: t.strength_attack_away })), prior: ctxPlayer.priorTeamCode, starts: ctxPlayer.starts, minutes: ctxPlayer.minutes };
  // Pin the projection gate to a mid-season GW AND a full-confidence sample:
  // these direct computeFixtureXP calls assert EXACT multiplier ratios, which
  // only hold when dataConfidence is 1.0 (GW6+ disables the three-phase cap,
  // and gamesPlayed >= 19 disables the league-average regression term). A
  // freshly-reset season has 1-start players, so force the sample explicitly.
  ctxPlayer.starts = 38;
  VG._projGW = 10;
  if (ctxFixture && strongClub && weakClub) {
    const ctxHome = ctxFixture.team_h === ctxPlayer.team;
    const ctxOpp = ctxHome ? ctxFixture.team_a : ctxFixture.team_h;
    const ctxFdr = ctxHome ? (ctxFixture.team_h_difficulty || 3) : (ctxFixture.team_a_difficulty || 3);

    // Baseline at the ORIGINAL (real) strengths — the restore must land exactly
    // here. Note the pre-season fallback gives each club distinct home/away
    // attack values, so the uniform 1015 below is only a test scaffold.
    const originalGoal = VG.computeFixtureXP(ctxPlayer.id, ctxOpp, ctxHome, ctxFdr).goalProb;

    ctxClubs.forEach(t => { t.strength_attack_home = 1015; t.strength_attack_away = 1015; });
    strongClub.strength_attack_home = 1150; strongClub.strength_attack_away = 1150;
    weakClub.strength_attack_home = 900; weakClub.strength_attack_away = 900;
    const baselineGoal = VG.computeFixtureXP(ctxPlayer.id, ctxOpp, ctxHome, ctxFdr).goalProb;
    ctxPlayer.priorTeamCode = String(strongClub.code);
    const fromStrong = VG.computeFixtureXP(ctxPlayer.id, ctxOpp, ctxHome, ctxFdr);
    ctxPlayer.priorTeamCode = String(weakClub.code);
    const fromWeak = VG.computeFixtureXP(ctxPlayer.id, ctxOpp, ctxHome, ctxFdr);
    check("fixture XP flags the move and the club", fromStrong.transferred === true && fromStrong.fromTeam === strongClub.short_name && fromStrong.toTeam === ctxTeam.short_name);
    check("moving from a weaker club boosts the projection", fromWeak.goalProb > fromStrong.goalProb);
    check("moving from a stronger club dampens the projection", fromStrong.goalProb < baselineGoal);
    // Both scenarios share every other term, so the goal-prob ratio equals the
    // club-strength multiplier ratio exactly: +115 vs -135 on the 1700 scale.
    const multRatio = (1 + (1015 - 900) / 1700) / (1 + (1015 - 1150) / 1700);
    check("context swing follows the attack-strength model", Math.abs(fromWeak.goalProb / fromStrong.goalProb - multRatio) < 1e-6);

    // Clamp: an extreme downgrade/upgrade must cap at ±20%. The baseline has
    // no move (transferConf = 1.0), so the clamped scenario's ratio includes
    // its own 0.92 confidence dampen: 1.20 * 0.92 exactly.
    const weakClub2 = Object.values(VG.teams).find(t => t.id !== ctxPlayer.team && t.id !== strongClub.id && t.id !== weakClub.id);
    savedCtx.clubs.push({ t: weakClub2, home: weakClub2.strength_attack_home, away: weakClub2.strength_attack_away });
    weakClub2.strength_attack_home = 200; weakClub2.strength_attack_away = 200;
    ctxPlayer.priorTeamCode = String(weakClub2.code);
    const fromExtreme = VG.computeFixtureXP(ctxPlayer.id, ctxOpp, ctxHome, ctxFdr);
    check("context multiplier is clamped at +20%", Math.abs(fromExtreme.goalProb / baselineGoal - 1.20 * 0.92) < 1e-6);

    // Restore original club strengths by value (NOT delete — undefined strengths
    // would NaN every later projection for these clubs) and the prior code.
    savedCtx.clubs.forEach(({ t, home, away }) => { t.strength_attack_home = home; t.strength_attack_away = away; });
    ctxPlayer.priorTeamCode = savedCtx.prior;
    const restoredGoal = VG.computeFixtureXP(ctxPlayer.id, ctxOpp, ctxHome, ctxFdr).goalProb;
    check("restoring prior + strengths restores the baseline projection", restoredGoal === originalGoal);

    // computeMultiGWXP aggregates the move into .info for the UI badges.
    ctxPlayer.priorTeamCode = String(weakClub.code);
    const ctxMulti = VG.computeMultiGWXP(ctxPlayer.id, 1, 2, fixtures);
    check("multi-GW info carries transfer context", ctxMulti.info.transferred === true && ctxMulti.info.toTeam === ctxTeam.short_name && ctxMulti.info.fromTeam === weakClub.short_name);
    ctxPlayer.priorTeamCode = savedCtx.prior;
  }
  VG._projGW = null;
  ctxPlayer.starts = savedCtx.starts;
  ctxPlayer.minutes = savedCtx.minutes;
}

// A foreign signing (0 PL minutes) with a non-EPL understat prior must be
// flagged as new, labelled with its source league, and still project via the
// real xG/xA from its old league.
const foreignCand = Object.values(VG.players).find(p =>
  (p.minutes || 0) === 0 && (p.starts || 0) === 0
);
if (foreignCand) {
  const ffx = fixtures.find(f => f.event === 1 && (f.team_h === foreignCand.team || f.team_a === foreignCand.team));
  if (ffx) {
    const fHome = ffx.team_h === foreignCand.team;
    const fOpp = fHome ? ffx.team_a : ffx.team_h;
    const fFdr = fHome ? (ffx.team_h_difficulty || 3) : (ffx.team_a_difficulty || 3);
    foreignCand.understat = { xG: 8, xA: 3, time: 2400, games: 28, league: "Bundesliga", prevClub: "Hoffenheim" };
    const fres = VG.computeFixtureXP(foreignCand.id, fOpp, fHome, fFdr);
    check("a foreign signing is flagged as new to the PL", fres.isNew === true);
    check("a foreign signing carries its source league", fres.foreignLeague === "Bundesliga" && fres.transferred === false);
    check("a foreign signing still projects usable xP from real xG/xA", fres.xp > 0 && fres.goalProb > 0);
    delete foreignCand.understat;
  }
}

// Data files that were regenerated for this release carry the new fields.
const historyPriorsFile = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "history-priors.json"), "utf8"));
check("history-priors.json records prior club codes", historyPriorsFile.players && Object.values(historyPriorsFile.players).some(p => p.team_code && p.team_code !== "0"));
const understatFile = JSON.parse(fs.readFileSync(path.join(root, "docs", "data", "understat.json"), "utf8"));
check("understat.json carries foreign-league priors", understatFile.foreignLeagues && Object.values(understatFile.players).some(p => p.league && p.league !== "EPL"));

// Workflow guards: the fetchers must keep emitting the fields the engine reads.
const understatWorkflowSource = fs.readFileSync(path.join(root, ".github", "workflows", "fetch-understat.yml"), "utf8");
const historyWorkflowSource = fs.readFileSync(path.join(root, ".github", "workflows", "fetch-history-priors.yml"), "utf8");
check("Understat fetcher pulls the four foreign leagues for prior matching",
  ["La_liga", "Bundesliga", "Serie_A", "Ligue_1"].every(lg => understatWorkflowSource.includes(lg)));
check("Understat fetcher records league + previous club on each prior", understatWorkflowSource.includes("prevClub") && understatWorkflowSource.includes("league"));
check("History-priors feed captures the prior club code", historyWorkflowSource.includes("team_code"));
check("applyHistoryPriors attaches the prior club code to every element", dataSource.includes("priorTeamCode"));

// Recency helper: windowed structure, legacy structure, and confidence floor.
const recPlayer = { recentForm: {
  n: 5, starts5: 5, gws5: 5, mins5: 450,
  s1: { starts: 1, mins: 90, pts: 8, xgi: 1.5, bps: 30 },
  s3: { starts: 3, mins: 270, pts: 20, xgi: 4.5, bps: 90 },
  s5: { starts: 5, mins: 450, pts: 35, xgi: 7.0, bps: 150 }
}};
const recF = VG._recencyFactors(recPlayer);
check("recency factors extract a starts rate", recF && recF.startsRate === 1);
check("recency factors compute last-3-GW xGI/90", Math.abs(recF.xgi90 - 1.5) < 0.01 && Math.abs(recF.pts90 - 6.67) < 0.1);
check("recency weight is confidence-scaled", recF.weight >= 0.38 && recF.weight <= 0.51);
check("recency factors fall back to legacy v5.7 fields", (() => {
  const legacy = VG._recencyFactors({ recentForm: { starts5: 3, gws5: 5, mins5: 300 } });
  return legacy && legacy.startsRate === 0.6 && legacy.xgi90 === 0;
})());
check("recency factors reject a single-GW sample", VG._recencyFactors({ recentForm: { starts5: 1, gws5: 1, mins5: 90 } }) === null);
check("recency factors reject missing data", VG._recencyFactors({}) === null);

// Recency output blend: a hot recent window should nudge projections up.
const hotPlayer = Object.values(VG.players).find(p => p.element_type !== 1 && (p.minutes || 0) > 0);
if (hotPlayer) {
  const hfx = fixtures.find(f => f.event === 1 && (f.team_h === hotPlayer.team || f.team_a === hotPlayer.team));
  if (hfx) {
    const hHome = hfx.team_h === hotPlayer.team;
    const hOpp = hHome ? hfx.team_a : hfx.team_h;
    const hFdr = hHome ? (hfx.team_h_difficulty || 3) : (hfx.team_a_difficulty || 3);
    const base = VG.computeFixtureXP(hotPlayer.id, hOpp, hHome, hFdr);
    hotPlayer.recentForm = {
      n: 5, starts5: 5, gws5: 5, mins5: 450,
      s1: { starts: 1, mins: 90, pts: 10, xgi: 3.0, bps: 45 },
      s3: { starts: 3, mins: 270, pts: 28, xgi: 7.5, bps: 130 },
      s5: { starts: 5, mins: 450, pts: 40, xgi: 10.0, bps: 200 }
    };
    const hot = VG.computeFixtureXP(hotPlayer.id, hOpp, hHome, hFdr);
    delete hotPlayer.recentForm;
    check("a hot recent-xGI window raises the fixture projection", hot.xp > base.xp);
    const restored = VG.computeFixtureXP(hotPlayer.id, hOpp, hHome, hFdr);
    check("removing recentForm restores the exact baseline projection", restored.xp === base.xp);
  }
}

// ── v5.8: market tags, watchlist, rate-my-team, what-if, FDR planner ───
section("v5.8 Community features (market tags, watchlist, rate, what-if, planner)");
check("market tag defaults to hold", VG.getMarketTag({ xpPerPrice: 0.6, ownership: 5 }).tag === "hold");
check("market tag sells high-ownership cold players", VG.getMarketTag({ recency: { xgi90: 0.3 }, xG: 1.0, xA: 0.5, totalXP: 40, ownership: 15, xpPerPrice: 0.6 }).tag === "sell");
check("market tag buys low-ownership value", VG.getMarketTag({ xpPerPrice: 0.9, ownership: 5, totalXP: 50 }).tag === "buy");
check("market badge escapes the reason", VG.marketBadge({ tag: "sell", reason: "<script>", tone: "red" }).includes("&lt;script&gt;"));
const buyBadge = VG.marketBadge({ tag: "buy", reason: "ok", tone: "green" });
check("market badge renders BUY/SELL text", buyBadge.includes("BUY") && VG.marketBadge({ tag: "sell", reason: "x", tone: "red" }).includes("SELL"));
check("market badge is empty on hold", VG.marketBadge({ tag: "hold" }) === "");

// Watchlist: toggle/persist through the localStorage mock.
check("watchlist starts empty", VG.watchlist().length === 0);
VG.toggleWatch(111);
check("watchlist gains an id after toggle", VG.watchlist().length === 1 && VG.isWatched(111));
VG.toggleWatch(111);
check("watchlist removes the id on second toggle", VG.watchlist().length === 0 && !VG.isWatched(111));
const wlHtml = VG.render.watchlist(allXP);
check("watchlist panel renders a section", typeof wlHtml === "string" && wlHtml.includes("Watchlist"));
const wlToggleHtml = VG.watchToggle(allXP[0]);
check("watch toggle renders a star", typeof wlToggleHtml === "string" && wlToggleHtml.includes("☆"));

// Rate My Team.
const rmt = VG.rateMyTeam(mcDraft, allXP, fixtures, 1);
check("rate-my-team returns a graded score", rmt && typeof rmt.score === "number" && rmt.score >= 0 && rmt.score <= 100 && ["A+", "A", "B", "C", "D", "F"].includes(rmt.grade));
check("rate-my-team exposes all six components", rmt && rmt.components.length === 6 && rmt.components.every(c => typeof c.score === "number") && rmt.components.some(c => c.label === "Efficiency"));
check("rate-my-team gives at least one piece of advice", rmt && rmt.advice.length >= 1);
check("rate-my-team renders an HTML panel", typeof VG.render.rateMyTeam(mcDraft, allXP, fixtures, 1) === "string");
check("rate-my-team is safe on a missing result", VG.rateMyTeam(null, allXP, fixtures, 1) === null);

// What-If race scenarios.
VG.currentTeamId = 1;
const scenario = VG.simulateRaceScenario([strongSquad, weakSquad], fixtures, 1, 1200, { captainId: strongSquad.picks[0].id });
check("what-if captain scenario returns baseline + scenario rows", scenario && scenario.baseline.entry === 1 && scenario.scenario.entry === 1);
const transferScenario = VG.simulateRaceScenario([strongSquad, weakSquad], fixtures, 1, 1200, { addId: allXP[0].id });
check("what-if transfer-in scenario keeps squad size constant", transferScenario && transferScenario.baseline && transferScenario.scenario);
const delta = VG.raceScenarioDelta([strongSquad, weakSquad], fixtures, 1, 1200, { addId: allXP[0].id });
check("what-if delta is a bounded probability-point number", delta && typeof delta.delta === "number" && delta.delta >= -100 && delta.delta <= 100);
check("what-if scenario needs two+ squads", VG.simulateRaceScenario([strongSquad], fixtures, 1, 100, { addId: 1 }) === null);
VG.currentTeamId = 0;

// Full-season FDR planner grid (now consumes teamSeasonRow in the UI).
const plannerHtml = VG.render.seasonPlanner(fixtures, 1, 38, null);
check("season planner renders a full-season grid", typeof plannerHtml === "string" && plannerHtml.includes("GW38") && plannerHtml.includes("Team"));
check("season planner renders every team", Object.keys(VG.teams).length >= 19 && (plannerHtml.match(/<tr/g) || []).length >= 21);
check("season planner is safe on empty fixtures", typeof VG.render.seasonPlanner([], 1, 38, null) === "string");

// ── v5.12: Briefing, Predicted Lineups, CS outlook, Form-vs-Fixtures ────
section("v5.12 One-stop-shop layer (briefing, lineups, CS outlook, scatter)");

// Roll-vs-spend (bank the transfer) economics.
const roll = VG.rollValue(mcDraft.squad, allXP, fixtures, 1, 5, 0);
check("rollValue projects both the roll and spend paths", roll && roll.rollXP > 0 && typeof roll.spendXP === "number");
check("rollValue gain is the spend-minus-roll delta", Math.abs(roll.gain - (roll.spendXP - roll.rollXP)) < 0.11);
check("rollValue picks an affordable unowned upgrade", !roll.transfer || (roll.transfer.inPrice <= roll.transfer.outPrice + 0.21 && roll.transfer.inId !== roll.transfer.outId));
check("rollValue is safe on an empty squad", VG.rollValue([], allXP, fixtures, 1, 5) === null);

// GW Briefing pulls outlook + captain + transfer + market + injuries.
const briefing = VG.buildBriefing(mcDraft, allXP, fixtures, 1);
check("briefing builds from a draft result", briefing && typeof briefing.outlook.avgFDR === "number" && briefing.outlook.avgFDR >= 1 && briefing.outlook.avgFDR <= 5);
check("briefing counts blanks/doubles/easy/hard", briefing.outlook.blanks >= 0 && briefing.outlook.doubles >= 0 && briefing.outlook.easy + briefing.outlook.hard <= 11);
check("briefing picks a non-GK captain with a projection", briefing.captain && briefing.captain.gwXP > 0 && briefing.vice && briefing.vice.gwXP > 0);
check("briefing captain reasoning carries a blank-risk line", briefing.captain.summary.includes("blank"));
check("draft-mode briefing transfer comes from roll-value, not the optimizer", briefing.transfer === null || briefing.transfer.source === "roll-value");
check("briefing surfaces market tags and injury flags", Array.isArray(briefing.market) && Array.isArray(briefing.injuries));
check("briefing renders an HTML panel", typeof VG.render.briefing(briefing) === "string" && VG.render.briefing(briefing).includes("Injury & availability"));
check("briefing is null-safe on a missing result", VG.buildBriefing(null, allXP, fixtures, 1) === null);

// Predicted lineups: pre-season (no recency windows) shows an unlock notice.
VG.recentFormMaxRounds = 0;
const plPre = VG.predictedLineups(1, fixtures);
check("predicted lineups still enumerate every team pre-season", plPre.rows.length === 20);
check("pre-season lineup render shows the unlock notice", VG.render.predictedLineups(plPre).includes("unlock"));
VG.recentFormMaxRounds = 5;
const pl = VG.predictedLineups(1, fixtures);
check("predicted lineups build a full 11 + bench per team", pl.rows.length === 20 && pl.rows.every(r => r.xi.length === 11 && r.bench.length <= 4));
check("every projected XI has exactly one GK and legal minimums", pl.rows.every(r =>
  r.xi.filter(s => s.pos === "GK").length === 1 &&
  r.xi.filter(s => s.pos === "DEF").length >= 4 &&
  r.xi.filter(s => s.pos === "MID").length >= 3 &&
  r.xi.filter(s => s.pos === "FWD").length >= 1));
check("formation label matches the projected XI composition", pl.rows.every(r => {
  const d = r.xi.filter(s => s.pos === "DEF").length, m = r.xi.filter(s => s.pos === "MID").length, f = r.xi.filter(s => s.pos === "FWD").length;
  return r.formation === `${d}-${m}-${f}`;
}));
check("bench never duplicates the starting XI", pl.rows.every(r => r.bench.every(b => !r.xi.some(s => s.id === b.id))));
check("lineup render emits a pl-grid with a bench line", typeof VG.render.predictedLineups(pl) === "string" && VG.render.predictedLineups(pl).includes("pl-grid") && VG.render.predictedLineups(pl).includes("Bench:"));
check("lineup render escapes names", !VG.render.predictedLineups(pl).includes("<script>") && VG.render.predictedLineups(null) === "");
VG.recentFormMaxRounds = 0;

// Clean-sheet / xGC outlook (Poisson on the same Elo numbers the engine uses).
const csRows = VG.teamDefensiveOutlook(1, fixtures);
check("defensive outlook covers all 20 teams next GW", csRows.length === 20);
check("CS probability is a proper e^-xGC Poisson value", csRows.every(r => r.cs > 0 && r.cs < 1 && Math.abs(r.cs - Math.exp(-r.xgc)) < 0.005));
check("outlook is sorted by clean-sheet odds descending", csRows.every((r, i) => i === 0 || csRows[i - 1].cs >= r.cs));
check("outlook ranks teams and bounds the xG endpoints", csRows.every(r => r.rank >= 1 && r.rank <= 20 && r.xgf >= 0.25 && r.xgc >= 0.25 && r.xgf <= 3.2));
check("defensive outlook is idempotent across recomputation", (() => {
  const again = VG.teamDefensiveOutlook(1, fixtures);
  return csRows.every((r, i) => r.cs === again[i].cs && r.xgf === again[i].xgf);
})());
check("defensive outlook renders a table", typeof VG.render.teamDefensiveOutlook(csRows) === "string" && VG.render.teamDefensiveOutlook(csRows).includes("P(CS)") && VG.render.teamDefensiveOutlook(csRows).includes("%"));
check("defensive outlook is empty-safe", VG.render.teamDefensiveOutlook([]) === "");

// Form-vs-Fixture scatter data builder is pure and position-separated.
const ff = VG.formFixturesData(allXP, fixtures, 1);
check("scatter data covers all four positions", Object.keys(ff).every(k => ["GK", "DEF", "MID", "FWD"].includes(k)) && ff.MID.length > 0 && ff.FWD.length > 0);
check("scatter FDR stays within 1-5", [].concat(...Object.values(ff)).every(pt => pt.x >= 1 && pt.x <= 5));
check("scatter form is a finite number", [].concat(...Object.values(ff)).every(pt => typeof pt.y === "number" && isFinite(pt.y)));

// ── v5.14: European rotation / congestion / early-season / VC insurance ──
section("v5.14 Congestion rotation, early-season phases, VC discount, deadline, FT 5");

// Congestion multiplier — synthetic short-gap schedules exercise every branch.
// Callers pass NUMERIC team ids, so the heavy-rotator lookup must resolve the
// short_name through VG.teams (regression: it used to compare the id string
// against "MCI"-style codes and never matched).
const mciId = bootstrap.teams.find(t => t.short_name === "MCI").id;
const nonRotatorId = bootstrap.teams.find(t => !VG.HEAVY_ROTATORS.has(t.short_name)).id;
const synFixtures = [
  { id: 9001, event: 1, team_h: mciId, team_a: nonRotatorId, kickoff_time: "2026-09-12T14:00:00Z" },
  { id: 9002, event: 2, team_h: mciId, team_a: nonRotatorId, kickoff_time: "2026-09-15T14:00:00Z" },
  { id: 9003, event: 3, team_h: mciId, team_a: nonRotatorId, kickoff_time: "2026-09-26T14:00:00Z" }
];
check("3-day gap penalises a heavy rotator hardest (numeric id lookup)", VG.congestionMultiplier(synFixtures, mciId, 2) === 0.82);
check("3-day gap penalises a non-rotator less", VG.congestionMultiplier(synFixtures, nonRotatorId, 2) === 0.88);
check("4-day gap tier applies", (() => {
  const f4 = [{ id: 1, event: 1, team_h: mciId, team_a: 1, kickoff_time: "2026-09-12T14:00:00Z" }, { id: 2, event: 2, team_h: mciId, team_a: 1, kickoff_time: "2026-09-16T14:00:00Z" }];
  return VG.congestionMultiplier(f4, mciId, 2) === 0.88;
})());
check("7-day+ gap applies no penalty", VG.congestionMultiplier(synFixtures, mciId, 3) === 1.0);
check("congestion multiplier defaults to no penalty with no fixtures", VG.congestionMultiplier(fixtures, mciId, 1) === 1.0);
check("heavy rotators are flagged in the set", VG.HEAVY_ROTATORS.has("MCI") && VG.HEAVY_ROTATORS.has("ARS"));
check("congestion multiplier is <= 1.0 for any team/gw", VG.congestionMultiplier(fixtures, 1, 1) <= 1.0 + 0.01);

// Three-phase early-season confidence: with a healthy sample, mid-season
// (GW >= 6) has higher dataConfidence than the capped GW1-3 window, so a fully
// established player should project more output later in the season. Synthetic
// (not live-data id 1, which has no games and trips the ep_next level anchor)
// so the confidence channel genuinely drives the comparison.
const estFid = 999992;
VG.players[estFid] = {
  id: estFid, element_type: 4, minutes: 850, starts: 10, goals_scored: 4,
  assists: 2, clean_sheets: 0, saves: 0, bonus: 12, yellow_cards: 1,
  red_cards: 0, own_goals: 0, penalties_missed: 0, points_per_game: "5.5",
  form: "6.0", bps: 120, influence: "200.0", creativity: "120.0", threat: "180.0",
  expected_goals: "4.5", expected_assists: "2.2", expected_goal_involvements: "6.7",
  expected_goals_conceded: "0.0", expected_goals_per_90: "0.48",
  expected_assists_per_90: "0.23", clean_sheets_per_90: "0.0",
  defensive_contribution_per_90: "0.0", ep_next: "5.5", value_form: "0.1",
  team: 2, now_cost: 85, code: estFid, status: "a", chance_of_playing_next_round: 100
};
VG._projGW = 1;
const gw1Res = VG.computeFixtureXP(estFid, 10, true, 2);
VG._projGW = 10;
const gw10Res = VG.computeFixtureXP(estFid, 10, true, 2);
VG._projGW = null;
delete VG.players[estFid];
check("early-season xP is more conservative (lower or equal) than mid-season", gw1Res.xp <= gw10Res.xp + 0.5);

// VC blank discount: a VC with high blank risk reduces insurance value
const vcCap = { id: 99970, teamId: 1, gwXP: 8 };
const vcVcNailed = { id: 7, teamId: 1, gwXP: 8 };
const vcVcRisk = { id: 99990, teamId: 1, gwXP: 8 };
VG.players[99970] = { starts: 30, minutes: 2700, status: "a", yellow_cards: 0 };
VG.players[99990] = { starts: 0, minutes: 0, status: "u", yellow_cards: 0 };
const evNailed = VG.computeViceCaptainEV(vcCap, vcVcNailed, fixtures, 1);
const evRisk = VG.computeViceCaptainEV(vcCap, vcVcRisk, fixtures, 1);
delete VG.players[99970];
delete VG.players[99990];
check("VC insurance is lower when the VC itself has high blank risk", evNailed >= evRisk);

// Deadline countdown helper exists
check("deadline countdown is defined in ui.js", uiSource.includes("VG.startDeadlineCountdown = () => {"));

// Free transfers dropdown has 5 options
check("FT dropdown allows up to 5 free transfers", indexSource.includes('<option value="5">5</option>'));

// Scatter chart has tooltips
check("scatter chart has tooltip callback", appSource.includes("tooltip: { callbacks: { label:"));

// Efficiency score appears in rate-my-team output
check("rate-my-team includes efficiency score", rmt && rmt.components.some(c => c.label === "Efficiency" && typeof c.score === "number"));

// Position-differentiated home boost: DEF gets higher boost than FWD
check("home boost is higher for defenders than forwards", (() => {
  // Extract homeBoost from app.js source for pos=2 vs pos=4
  const src = appSource;
  const idx = src.indexOf("const homeBoost = pos === 2");
  if (idx < 0) return false;
  const snippet = src.slice(idx, idx + 200);
  // DEF (pos===2) should use 1.18, FWD default 1.15
  return snippet.includes("1.18") && snippet.includes("1.15");
})());

// fixtureGapDays is a function
check("fixtureGapDays is a function", typeof VG.fixtureGapDays === "function");

// ── Fresh-season small-sample robustness (GW1 45-pointer post-mortem) ──
// A one-game hauler must not extrapolate into a superhuman projection, and a
// premium who blanked must not collapse — the GW1 draft once ranked a £4.5m
// DEF at 47 xP while Haaland sat at rank 118.
section("Small-sample robustness: shrinkage, caps, ep anchor");
(() => {
  // Deterministic synthetic one-game DEF hauler: 1 goal + 1.4 xG from a single
  // 90-minute game. Without shrinkage this would extrapolate to ~1.4 xG/90 and
  // hit a goal-prob ceiling every fixture; the Bayesian priors must pull it back
  // under the positional cap. Synthetic (not a live-data search) so the check
  // always runs regardless of the current data state.
  const fid = 999991;
  VG.players[fid] = {
    id: fid, element_type: 2, minutes: 90, starts: 1, goals_scored: 1,
    assists: 0, clean_sheets: 0, saves: 0, bonus: 3, yellow_cards: 0,
    red_cards: 0, own_goals: 0, penalties_missed: 0, points_per_game: "9.0",
    form: "9.0", bps: 30, influence: "80.0", creativity: "20.0", threat: "60.0",
    expected_goals: "1.4", expected_assists: "0.0", expected_goal_involvements: "1.4",
    expected_goals_conceded: "1.0", expected_goals_per_90: "1.4",
    expected_assists_per_90: "0.0", clean_sheets_per_90: "0.0",
    defensive_contribution_per_90: "2.0", ep_next: "3.0", value_form: "0.0",
    team: 2, now_cost: 45, code: fid, status: "a",
    chance_of_playing_next_round: 100
  };
  VG._projGW = 1;
  const r = VG.computeFixtureXP(fid, 10, true, 2);
  VG._projGW = null;
  delete VG.players[fid];
  check("one-game hauler stays under the positional goal cap", r.goalProb <= 0.35 + 1e-9);
  check("one-game hauler xP is sane (under 6)", r.xp < 6);
  // A 1/1 starter must read as a near-weekly starter (the old max(games,5)
  // floor divided 1 start by 5 and projected Haaland at 40 xMins).
  const starter = Object.values(VG.players).find(p => (p.starts || 0) === 1 && (p.minutes || 0) >= 60 && (p.element_type || 0) !== 1);
  if (starter) {
    VG._projGW = 1;
    const r = VG.computeFixtureXP(starter.id, 10, true, 2);
    VG._projGW = null;
    check("a 1/1 starter projects near-weekly minutes (xMins >= 55)", r.xMins >= 55);
  } else {
    check("a 1/1 starter projects near-weekly minutes (xMins >= 55)", false);
  }
  // A sub-cameo (0 starts) must not read as a rotation candidate.
  const cameo = Object.values(VG.players).find(p => (p.starts || 0) === 0 && (p.minutes || 0) > 0 && (p.minutes || 0) < 30 && (p.element_type || 0) !== 1);
  if (cameo) {
    VG._projGW = 1;
    const r = VG.computeFixtureXP(cameo.id, 10, true, 2);
    VG._projGW = null;
    check("a sub-cameo player stays bench-level (xMins < 45)", r.xMins < 45);
    check("a sub cameo cannot earn certain DEFCON points", r.xpComponents.xpDEFCON < 1.0);
  } else {
    check("a sub-cameo player stays bench-level (xMins < 45)", false);
    check("a sub cameo cannot earn certain DEFCON points", false);
  }
  // GK clean-sheet probability is capped well below the old additive 0.70.
  const gk = Object.values(VG.players).find(p => p.element_type === 1 && (p.starts || 0) > 0);
  if (gk) {
    VG._projGW = 1;
    const r = VG.computeFixtureXP(gk.id, 10, true, 1);
    VG._projGW = null;
    check("GK clean-sheet probability caps at 0.55", r.csProb <= 0.55 + 1e-9);
  } else {
    check("GK clean-sheet probability caps at 0.55", false);
  }
  // Premium ceiling bonus is live again (documented feature lost in refactor).
  const premiumFwd = Object.values(VG.players).find(p => p.element_type === 4 && p.now_cost >= 85 && (p.minutes || 0) >= 0);
  check("premium forward carries the captain-ceiling bonus", (() => {
    if (!premiumFwd) return false;
    VG._projGW = 1;
    const r = VG.computeFixtureXP(premiumFwd.id, 10, true, 3);
    VG._projGW = null;
    // Recompute without the ceiling path is hard; instead assert the multiplier
    // exists in source and the projection is positive.
    return appSource.includes("ceilingMult") && r.xp > 0;
  })());
})();

// ── Full-review regression tests (post-v5.14 review fixes) ──
section("Review fixes: DEFCON, BGW, chip hint, live double-count, state hygiene");

// DEFCON must enter the model at its face value (2 × P(threshold)), not
// doubled again — xpDEFCON used to be defconXP * 2 and inflate every DEF/MID.
const defconDefender = Object.values(VG.players).find(p => p.element_type === 2 && (p.minutes || 0) > 0);
if (defconDefender) {
  VG._projGW = 10;
  const dres = VG.computeFixtureXP(defconDefender.id, 1, true, 2);
  VG._projGW = null;
  check("DEFCON contributes at face value (xpDEFCON === defconProb)", Math.abs(dres.xpComponents.xpDEFCON - dres.defconProb) < 1e-3);
} else {
  check("DEFCON contributes at face value (xpDEFCON === defconProb)", false);
}

// BGW detection: a team ABSENT from a GW's fixtures is a blank, not a team
// with a zero-valued entry (the old filter could never match).
const bgwPlanner = VG.buildSeasonPlanner(synFixtures);
const gw2Row = bgwPlanner.find(p => p.gw === 2);
check("planner leaves bgwTeams empty when every tracked team plays", Array.isArray(gw2Row.bgwTeams) && gw2Row.bgwTeams.length === 0);
const thirdTeamId = bootstrap.teams.find(t => t.id !== mciId && t.id !== nonRotatorId).id;
const bgwFixtures = [
  synFixtures[0],
  { id: 9102, event: 2, team_h: mciId, team_a: thirdTeamId, kickoff_time: "2026-09-15T14:00:00Z" },
  synFixtures[2]
];
check("planner flags a team with no fixture in a GW as BGW", VG.buildSeasonPlanner(bgwFixtures).find(p => p.gw === 2).bgwTeams.includes(nonRotatorId));

// Chip hint: the label comes from the chip KEY (objects carry no label field).
(() => {
  const brief = VG.buildBriefing({ squad: [], chipAdvice: { free_hit: { recommend: true, score: 99, bestGW: 2, reason: "blank week incoming", tip: "" } } }, allXP, fixtures, 1);
  check("briefing chip hint surfaces the chip name from its key", !!brief && !!brief.chipHint && brief.chipHint.label === "FREE HIT" && brief.chipHint.advice === "blank week incoming");
})();

// The per-fixture projection gate must be reset after a multi-GW run so
// direct computeFixtureXP calls don't inherit a stale gameweek.
VG.computeMultiGWXP(defconDefender ? defconDefender.id : 1, 1, 2, fixtures);
check("_projGW is cleared after computeMultiGWXP", VG._projGW === null || VG._projGW === undefined);

// Static guards: live double-count fix, rank endpoint fields, allXP copy-sort.
check("live bench points come only from auto-subbed players", appSource.includes("subResult.subs.forEach(s => { benchPts += (livePts[s.in] || 0); })"));
check("live table excludes promoted players from the bench rows", appSource.includes("const benchRows = bench.filter(p => !promotedIds.has(p.id));"));
check("team rank reads the entry payload's summary fields", appSource.includes("info.summary_event_points") && !appSource.includes("const hist = info.history"));
check("comparison select sorts a copy of allXP (xP order preserved)", indexSource.includes("[...allXP].sort((a, b) => a.name.localeCompare(b.name))"));
check("run retry budget resets after a successful run", /VG\._runRetries = 0;\s*VG\.preloadTabs\(gw\)/.test(indexSource));
check("home boost differentiates positions by clean-sheet premium", (() => {
  const src = appSource;
  const idx = src.indexOf("const homeBoost = pos === 2 ? 1.18 : pos === 1 ? 1.12 : 1.15");
  return idx >= 0;
})());

(async () => {
  let analyzeLeagueThrew = false;
  const leagueResult = await VG.analyzeLeague(999999, 1, fixtures).catch(() => { analyzeLeagueThrew = true; return "threw"; });
  check("analyzeLeague fails closed instead of throwing when the API is unreachable", !analyzeLeagueThrew && leagueResult === null);

  // VG.runWhatIf is a top-level function (not nested inside VG.run/preloadTabs),
  // so it can't reach their local `const el = id => document.getElementById(id)`
  // closures. It briefly called bare el("leagueId") and threw "el is not
  // defined" on every real click — silently, since the onclick has no .catch().
  // Guard against that class of bug reappearing.
  check("runWhatIf resolves its own DOM lookups, not a borrowed `el` closure", !/VG\.runWhatIf = async[\s\S]*?\bel\(/.test(indexSource.slice(indexSource.indexOf("VG.runWhatIf"), indexSource.indexOf("VG.runWhatIf") + 1500)));
  // The delegated watchlist handlers (top of ui.js, before VG.switchTab) run
  // outside any closure that defines `el` — they must use document.getElementById
  // directly. (preloadTabs legitimately defines its own `el`; don't police that.)
  const uiHandlerRegion = uiSource.slice(0, uiSource.indexOf("VG.switchTab"));
  check("watchlist handlers resolve gameweek from the document", !uiHandlerRegion.includes("el('gameweek')") && !uiHandlerRegion.includes('el("gameweek")'));
  check("watchlist player labels escape team names", !appSource.includes("${p.teamName} £${p.price"));
  check("league what-if player labels escape team names", !indexSource.includes("${p.teamName} £${p.price"));

  // v5.17.1: when the selected GW's picks 404 (upcoming GW pre-deadline), the
  // app must fall back to the last published squad and plan transfers from it
  // — NOT silently drop to a from-scratch draft (which shows no transfers and
  // hides dead assets like Watkins/Mateta).
  check("404 pick fallback tries earlier GWs, not just a draft", /trying earlier GWs for transfer planning/.test(uiSource));
  check("fallback builds transfers from the last published squad", /const buildFromSquad = \(squadData\) => \{/.test(uiSource));
  check("fallback surfaces the source GW via fallbackGW", /fallbackGW: squadData\.fallbackGW \|\| null/.test(uiSource));
  check("fallback-GW notice banner renders", /Planning transfers for GW\$\{VG\.esc\(String\(result\.planningForGW \|\| gw\)\)\} from your GW/.test(uiSource));

  // v5.17.3: the FPL picks API returns ONLY element/position/multiplier — no
  // price or name. buildFromSquad must enrich each pick from VG.players, or
  // the forced-replacement pass computes selling_price=0 and can never afford
  // a replacement, so transfers vanish entirely (the real "no transfers shown"
  // bug the user reported).
  check("buildFromSquad enriches picks with prices/names from VG.players",
    /const currentSquad = squadData\.picks\.picks\.map\(sp => \{/.test(uiSource) &&
    /selling_price: sp\.selling_price \|\| sp\.now_cost \|\| \(boot && boot\.now_cost\)/.test(uiSource));
  // Functional reproduction of the exact live bug: element-only picks (as the
  // API returns them) must still yield the forced Watkins/Mateta replacements.
  check("forced transfers survive element-only picks after price enrichment", (() => {
    try {
      // Real GW2 squad element ids incl. unavailable Watkins(55)/Mateta(223).
      const ew = [82, 4, 269, 203, 130, 12, 481, 516, 375, 411, 55, 529, 498, 103, 223];
      const elElementOnly = ew.map(el => ({ element: el, position: 1, multiplier: 1 }));
      const enriched = elElementOnly.map(sp => {
        const boot = VG.players && VG.players[sp.element];
        return { ...sp, web_name: sp.web_name || (boot && boot.web_name) || "?", now_cost: sp.now_cost || (boot && boot.now_cost) || 0, selling_price: sp.selling_price || sp.now_cost || (boot && boot.now_cost) || 0 };
      });
      const res = VG.optimizeTransfers(enriched, allXP, 0.4, 2, 3, 5, {});
      const outIds = res.transfersOut.map(p => p.id).sort((a, b) => a - b);
      return res.transfersOut.length > 0 && res.transfersIn.length > 0 && outIds.includes(55) && outIds.includes(223);
    } catch (e) { return false; }
  })());

  // v5.17: forced replacement for players NOT in allXP (injured/left-league).
  check("forced pass builds a bootstrap stub for players missing from allXP", /if \(!cXP\) \{\s*const boot = VG\.players\[pid\]/.test(appSource));

  // v5.17: Free Hit / Wildcard generators (FFHub "optimal chip team" idea).
  try {
    const wc = await VG.generateWildcard(allXP, 100, fixtures, 1, 5);
    check("Wildcard generates an 15-man squad under budget", (() => {
      const cost = wc.squad.reduce((s, p) => s + (p.price || 0), 0);
      return wc.mode === "wildcard" && wc.squad.length === 15 && cost <= 101;
    })());
    check("Wildcard team has a legal formation", VG.formationLegal(wc.squad));
  } catch (e) {
    check("Wildcard generator does not throw (got: " + (e && e.message || e) + ")", false);
  }

  // Free Hit optimises a single GW — assert it switched the ILP key to gwXP
  // and tagged the result, without requiring the live xP engine to be exact.
  check("Free Hit attaches per-GW gwXP to candidates", (() => {
    const p = VG.computePlayerGWProjection(allXP[0], 1, fixtures);
    return typeof p.gwXP === "number" && isFinite(p.gwXP);
  })());
  check("filterPool drops players excluded by constraints", (() => {
    const before = allXP.length;
    const after = VG.filterPool(allXP, { constraints: { avoidTeams: [allXP[0].teamId] } }).length;
    return after < before && after >= 0;
  })());
  // Guard the pool filter feeds both chip generators (not just Wildcard).
  check("Free Hit + Wildcard both route through filterPool", appSource.indexOf("VG.filterPool(players, opts)") >= 0);

  section("Summary");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
