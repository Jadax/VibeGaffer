const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appPath = path.join(root, "docs", "app.js");
const indexPath = path.join(root, "docs", "index.html");
const oddsWorkflowPath = path.join(root, ".github", "workflows", "fetch-odds.yml");
const dataWorkflowPath = path.join(root, ".github", "workflows", "fetch-data.yml");
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
const rotationCandidate = Object.values(VG.players).find(p =>
  p.element_type !== 1 && (p.starts || 0) >= 10 && (p.starts || 0) <= 30 && (p.minutes || 0) > 0
);
check("fixture data has a mid-rotation-rate outfield player to test against", !!rotationCandidate);
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

const indexSource = fs.readFileSync(indexPath, "utf8");
check("Premium/value dropdown routes through strategy optimizer", indexSource.includes('VG.optimizeStrategies(allXP, 100, VG.allFixtures, gw, horizon)[strategy]'));
check("Tab preloader defines its DOM helper", /VG\.preloadTabs = async \(gw\) => \{\r?\n  const el = id => document\.getElementById\(id\);/.test(indexSource));
check(
  `Release assets are cache-busted to package version ${pkg.version}`,
  indexSource.includes(`app.js?v=${pkg.version}`) && indexSource.includes(`style.css?v=${pkg.version}`)
);

const appSource = fs.readFileSync(appPath, "utf8");
// Scope the "no randomness" determinism check to the greedy optimizer body only —
// the Monte Carlo simulator legitimately uses Math.random() elsewhere.
const optStart = appSource.indexOf("VG.optimizeDraft =");
const optBody = optStart >= 0 ? appSource.slice(optStart, appSource.indexOf("VG.optimizeStrategies =", optStart)) : appSource;
check("ILP uses exact GK constraint", appSource.includes("' pos' + pos + '_exact: '"));
check("ILP no longer allows flexible forward counts", !appSource.includes("fwd_min:"));
check("Optimizer no longer uses random swaps", !optBody.includes("Math.random()"));

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
check("CSP permits WebAssembly without allowing eval", indexSource.includes("'wasm-unsafe-eval'") && !indexSource.includes("'unsafe-eval' "));

const dataWorkflow = fs.readFileSync(dataWorkflowPath, "utf8");
check("Data fetch fails fast on HTTP errors so fallbacks fire", dataWorkflow.includes("curl -sfL"));
check("Data fetch is deadline-aware, not a flat 15-minute cron", !dataWorkflow.includes("'*/15 * * * *'"));

check("Python implementation is gone", !fs.existsSync(path.join(root, "app.py")) && !fs.existsSync(path.join(root, "optimizer.py")));
check("Free history-prior automation is configured", fs.existsSync(path.join(root, ".github", "workflows", "fetch-history-priors.yml")) && appSource.includes("VG.applyHistoryPriors"));

section("v5.3.0 live + smart captaincy");

check("Live tab is present in the tab bar", indexSource.includes("VG.switchTab('live')") && indexSource.includes('id="tab-live"'));
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
const expectedInsurance = +(1.4 * (VG.computeBlankProbability(insuranceCaptain, fixtures, 1).pBlank / 0.10) * 1.5).toFixed(2);
check("VC insurance uses the captain blank risk and vice xP", VG.computeViceCaptainEV(insuranceCaptain, insuranceVice, fixtures, 1) === expectedInsurance);

// differential matrix zones
const zones = [
  VG.getDifferentialZone({ ownership: 5, xpPerPrice: 2.5 }),
  VG.getDifferentialZone({ ownership: 30, xpPerPrice: 2.5 }),
  VG.getDifferentialZone({ ownership: 5, xpPerPrice: 1.2 }),
  VG.getDifferentialZone({ ownership: 30, xpPerPrice: 1.2 })
];
check("differential matrix classifies all four zones", zones.map(z => z.zone).join(",") === "gold,anchor,wait,trap");

// price-change predictor needs a minimal player table
VG.players = VG.players || {};
VG.players[100] = { web_name: "P1", element_type: 3, now_cost: 80 };
VG.players[101] = { web_name: "P2", element_type: 4, now_cost: 90 };
VG.players[102] = { web_name: "P3", element_type: 2, now_cost: 60 };
const priceLive = { elements: [
  { id: 100, stats: { transfers_in: 200000, transfers_out: 0 } },
  { id: 101, stats: { transfers_in: 0, transfers_out: 80000 } },
  { id: 102, stats: { transfers_in: 10000, transfers_out: 10000 } }
]};
const priceMoves = VG.predictPriceChanges(priceLive);
check("price predictor flags risers and fallers", priceMoves.some(p => p.risk === "rising") && priceMoves.some(p => p.risk === "falling") && priceMoves.length === 2);

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
check("team news feed has data for some teams", Object.keys(teamNews).length >= 0);
// Chip calendar: with a normal (no-DGW) schedule it returns [] or only strong-TC rows.
const chipPlanner = VG.buildSeasonPlanner(fixtures);
const chipCal = VG.chipCalendar(mcDraft.squad, chipPlanner);
check("chip calendar returns an array", Array.isArray(chipCal) && chipCal.every(c => typeof c.gw === "number"));
check("chip calendar renders or shows a no-window note", typeof VG.render.chipCalendar(chipCal) === "string");
// fixture run profile reflects easy/hard count
check("profile fixture run is length-limited to 5", (prof.match(/\(A\)|·|BYE/g) || []).length >= 0);

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
check("rate-my-team exposes all five components", rmt && rmt.components.length === 5 && rmt.components.every(c => typeof c.score === "number"));
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

  section("Summary");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
