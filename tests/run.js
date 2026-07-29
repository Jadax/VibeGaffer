const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appPath = path.join(root, "docs", "app.js");
const indexPath = path.join(root, "docs", "index.html");
const oddsWorkflowPath = path.join(root, ".github", "workflows", "fetch-odds.yml");
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
const allXP = VG.computeAllXP(1, 5, fixtures);

section("Data and xP engine");
check("Loaded all active players", allXP.length > 500);
check("Loaded 20 teams", Object.keys(VG.teams).length === 20);
check("Doubtful players remain available for evaluation", allXP.some(p => p.status === "d"));
check("Haaland has a positive projection", allXP.find(p => p.name === "Haaland")?.totalXP > 0);
check("Every player projection is non-negative", allXP.every(p => p.totalXP >= 0));
check("At least one first-choice GK projects above 20 xP", allXP.some(p => p.position === "GK" && p.totalXP > 20));
check("Low-minute backup GKs may remain below 20 xP", allXP.some(p => p.position === "GK" && p.totalXP < 20));

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
const transfers = VG.optimizeTransfers(mockSquad, allXP, 0.5, 1, fixtures, 1, 5);
check("Transfer optimizer returns hit details", Array.isArray(transfers.hitDetails));
check("Transfer roadmap covers five GWs", VG.computeTransferRoadmap(draft.squad, allXP, fixtures, 1, 5)?.length === 5);
check("Transfer planner covers five GWs", VG.computeTransferPlan(draft.squad, allXP, fixtures, 1, 5, draft.budgetRemaining, 1)?.schedule.length === 5);
check("Chip engine evaluates every chip", Object.keys(VG.evaluateChips(draft.squad, draft.gwPicks, 1, fixtures)).includes("triple_captain"));

section("v5.2.1 regressions");
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

const indexSource = fs.readFileSync(indexPath, "utf8");
check("Premium/value dropdown routes through strategy optimizer", indexSource.includes('VG.optimizeStrategies(allXP, 100, VG.allFixtures, gw, horizon)[strategy]'));
check("Tab preloader defines its DOM helper", /VG\.preloadTabs = async \(gw, horizon\) => \{\r?\n  const el = id => document\.getElementById\(id\);/.test(indexSource));
check("Release assets are cache-busted", indexSource.includes("app.js?v=5.2.1") && indexSource.includes("style.css?v=5.2.1"));

const appSource = fs.readFileSync(appPath, "utf8");
check("ILP uses exact GK constraint", appSource.includes("' pos' + pos + '_exact: '"));
check("ILP no longer allows flexible forward counts", !appSource.includes("fwd_min:"));
check("Optimizer no longer uses random swaps", !appSource.includes("Math.random()"));

const oddsWorkflow = fs.readFileSync(oddsWorkflowPath, "utf8");
check("Odds workflow handles bookmaker arrays", oddsWorkflow.includes("for bookmaker in event.get('bookmakers', []):"));
check("Odds workflow reads bookmaker markets", oddsWorkflow.includes("bookmaker.get('markets', [])"));
check("Odds workflow no longer calls .items() on bookmakers", !oddsWorkflow.includes("event.get('bookmakers', {}).items()"));

section("Summary");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
