# AGENTS.md — VibeGaffer

Primary context document for AI models working on this codebase. Read fully before editing. New model picking up the repo: start with **Handover Status**, then **Critical Files**, then the section matching your task.

## Handover Status

- **Current version**: v5.6.1 (pushed as `90dcd56` = v5.6.0 + an uncommitted v5.6.1 hardening pass in progress — see below)
- **v5.6.1 hardening/refactor (uncommitted)**:
  - Fixed a real XSS class-bug: `VG.playerProfileHTML` interpolated the opponent `short_name` raw into HTML (`app.js:2512`) — now `VG.esc()`-wrapped (Golden Rule 2)
  - Removed dead code: `price` var in `computeFixtureXP`, `rows`/`gotCap`-misread in `render.pitch` (only `rows` was dead), `maxScore` in `index.html` chip timeline, unused `fixtures`/`ids`/`plannerByGw` in `chipCalendar`, unused `horizon` param on `VG.preloadTabs` (+ test/call-site updated), redundant `VG.render = VG.render || {};`, orphaned "Fixture Ticker" header, stale "~8 historical copies" comment
  - Added shared helpers to kill duplication: `VG.playerName(p)`, `VG.fdrColor(fdr)` (replaced 5 inline ternaries), `VG.hasFitnessFlag(p)` (shared by `injuryNews` + `teamNewsFeed`), `VG.setPieceBadge(sp)` (Compare + profile)
  - Attribution: **author is Tushant Sharma only** — removed all `Astraiva` references (title, header, footer, README, Metadata) and added `author` to `package.json`
  - Version bumped to v5.6.1; tests now 136/136
- **v5.4.0 shipped**:
  - v5.3 feature set: **Live tab**, **Smart Captaincy** (blank risk + VC insurance EV), **Differential Matrix**
  - v5.4 feature set: **Understat forecast odds** (free w/d/l per fixture → xP engine), **Real xG/xA** (Understat priors blended into xP + new columns), **Injury & Availability Watch** (fitness/news feed in Strategy tab), **Team Strength Ratings** (npxG/npxGA → attack/defence/overall indices, ranks, 1-5 rating in Fixtures tab), **xG regression due/over flags** (Understat xG vs actual goals → green DUE / red OVER badges in Compare + Differentials tabs)
  - Hardening pass: removed dead params (`optimizeTransfers` `fixtures`, `evaluateChips` `startGW`, `render.tips` `nGWs`, `computeTransferPlan` `freeTransfers`), removed dead state (`outCandidates`, `breakEvenGW`, `gwXPold/new`, `usedFreeTransfers`, `netAfterHit`, `activeStrategy`, dead `currentIds` mutation), added shared fixture helpers (`VG.fixtureInfo`, `VG.teamFixtures`, `VG.fixturesForGW`), consolidated the two price functions onto one model (fixed a latent bug: old code read `stats.transfers_in`, which does not exist on the real live API — the real fields are top-level `transfers_in_event`/`transfers_out_event`), fixed a `~?%` captain-share display bug, fixed captain-fallback duplication, hardened `simulateAutoSubs`/`predictBonus` edge cases (DGW bonus accumulation, missing `liveMinutes` guard), deduped `buildFixtureTicker`/`analyzeFixtureSwings` onto `VG.teamFixtureRow`, replaced `VG.TEAM_COLORS` numeric-ID keys with `short_name` keys via `VG.teamColor()` (robust to promotion/relegation)
- **Post-commit review fixes** (v5.4.1, applied after `93fa865`):
  - `render.tips`'s weaknesses bullets skipped `VG.esc()` while the strengths bullets right above them didn't — inconsistent with the codebase's escape-everything-API-derived convention. Team names aren't attacker-controlled today (unlike league/manager names), so this wasn't exploitable, but it's the same class of bug v5.3.0 hardened against. Fixed in `docs/app.js`.
  - The Live tab's "auto-refresh every 5 min" comment described recurring behaviour, but was a single `setTimeout` that fired once and stopped. Made it self-reschedule in `docs/index.html`.
- **Tests**: 136/136 pass (`npm test`), verified after all hardening + v5.6.1 refactor
- **State**: `docs/app.js` ~3325 lines, `docs/index.html` ~1005 lines; both syntax-check clean
- **Uncommitted (v5.5 — competitor-borrowed features, per Borrowing Policy)**:
  - **Effective Ownership** (`VG.computeEffectiveOwnership`) — ownership weighted by modelled captain-share (FFix/FPL Review idea); EO column in Compare + Differentials; sharper TEMPLATE vs DIFFERENTIAL signal than raw ownership
  - **Monte Carlo GW Projection** (`VG.mcGWDistribution`, `VG.greenArrowProb`, `VG.render.gwProjection`) — samples starting XI points (captain doubled) → real points distribution; Squad tab shows `mean ± SD` + 90% band (FPL Review/FFix idea). The old whole-source `Math.random()` determinism test was re-scoped to the greedy-optimizer body only (the optimizer stays deterministic; MC legitimately uses Math.random)
  - **DGW/BGW Season Planner** (`VG.buildSeasonPlanner`, `VG.teamSeasonRow`) — Ben Crellin-style calendar flagging double/blank weeks + chip windows (Fixtures tab); "no doubles yet" note pre-postponement, becomes live after postponements
  - **Set-Piece Takers** (new `docs/data/setpieces.json` + `VG.loadSetPieceData`/`VG.setPieceRole`) — pen/FK/corner xP boost in `computeFixtureXP` + "P/F/C" badges (FFHUB/FFS idea). **Seasonal — update each year**
  - **Transfer Rank-Impact** (`VG.estimateRankImpact`) — transfer xP gain → approximate overall-rank move (FFHub AI idea), in Squad tab transfer panel
  - **Player Profile** (`VG.playerProfileHTML`) — click any Squad player to expand: form trend, Understat xG/90, regression, EO, set-piece role, value, next-5 fixture run + easy/hard quality (FPL Review/FFHub idea)
  - **Live Rank tracker** (`VG.fetchTeamRank`) — real FPL Overall Rank + GW points via Team ID, cached 5 min, renders a "📊 Live Rank" card (LiveFPL/FFHub idea)
  - **Team News feed** (`VG.teamNewsFeed`) — injury/fitness flags + news grouped by club in the Strategy tab
  - **Chip EV Calendar** (`VG.chipCalendar`, `VG.render.chipCalendar`) — DGW/BGW-aware per-GW TC/BB/FH/WC window scores for the squad; populated once postponements create doubles (Ben Crellin idea)
- **Next model TODO**: commit v5.6.1 (see **Commit Convention**), then optionally implement **Remaining Improvements** below.

## Quick Status

- **Architecture**: Pure static HTML/CSS/JS on GitHub Pages (no backend)
- **Live URL**: https://jadax.github.io/VibeGaffer/
- **Data**: Auto-fetched on a deadline-aware GitHub Actions schedule → `docs/data/*.json` (30 min inside 6h of a deadline, 2-hourly within 36h, 6-hourly otherwise). **Understat** free xG/forecast data fetched weekly → `docs/data/understat.json`
- **ILP Solver**: highs-js (HiGHS WASM) loaded from CDN, falls back to greedy. highs-js publishes `window.Module`, **not** `window.Highs` — see Known Issues
- **Odds**: The-Odds-API free tier (500 req/month), fetched once per GW when deadline is within 30h → `docs/data/odds.json`. Requires optional `ODDS_API_KEY` repo secret (currently unset). **Understat forecasts are the free no-key alternative** used by default

## Critical Files

| File | Lines | Purpose |
|------|-------|---------|
| `docs/app.js` | ~2910 | All logic: xP engine, optimizer, chips, transfers, planner, league, tips, live GW |
| `docs/index.html` | ~930 | All UI: 9 tabs, CSP, rendering, Chart.js radar/bar, inline JS |
| `docs/style.css` | 275 | All styles |
| `docs/data/bootstrap.json` | ~1.3MB | Player data (~560 active, 20 teams) |
| `docs/data/fixtures.json` | ~118KB | 380 fixtures with FDR |
| `docs/data/understat.json` | ~120KB | Free Understat xG/xA priors + team stats + per-fixture forecasts |
| `.github/workflows/fetch-data.yml` | ~125 | Deadline-aware FPL data fetch |
| `.github/workflows/fetch-understat.yml` | ~230 | Weekly Understat xG/forecast fetch |
| `.github/workflows/fetch-history-priors.yml` | ~55 | Weekly vaastav historical priors |
| `.github/workflows/fetch-odds.yml` | ~55 | Optional bookmaker odds (needs `ODDS_API_KEY`) |
| `.github/workflows/test.yml` | ~30 | CI: `node --check` + `npm test` |
| `tests/run.js` | ~520 | Regression suite (136 checks) |

## Golden Rules (violations cause bugs)

1. **Never reimplement shared helpers.** `VG.esc`, `VG.isAvailable`, `VG.fixtureFDR`, `VG.fixtureInfo`, `VG.pickBestXI`, `VG.formationLegal`, `VG.countUnavailable`, `VG.hasPlayed`, `VG.topCaptainCandidates` exist to be reused.
2. **Escape everything API-derived before `innerHTML`.** `VG.esc()` is the real XSS defence (league/manager names are controlled by other FPL users). CSP cannot be tightened because of inline `onclick=` handlers.
3. **All optimizer/selection code must filter injuries** via `VG.isAvailable(p)`. Doubtful players stay eligible but are flagged.
4. **When changing a function signature, update every call site** — `docs/index.html` (inline script), `docs/app.js`, `tests/run.js`. Grep `VG.functionName(`.
5. **Do not add a second price/fixture lookup.** `VG.predictPriceChanges` and `VG.fixtureInfo` are the single sources of truth.
6. **Run `node -c docs/app.js` + `npm test` after every change.** Browser smoke (python http.server + tab check) for UI changes.

## Third-Party Public Data Policy (intentional — do NOT remove)

Every third-party data integration in this repo is a **deliberate product decision**, not tech debt. Enriching the engine with free public data is the app's core competitive advantage.

**Allowed, intentionally-permitted sources** (all public, read-only, community-licensed):

- **FPL API** (`fantasy.premierleague.com`) — official public read-only endpoint. Primary source.
- **The-Odds-API** — optional bookmaker odds, gated by the `ODDS_API_KEY` repo secret.
- **Understat** (`https://understat.com/getLeagueData/EPL/{season}`) — free player xG/xA/xGChain/xGBuildup, per-match team xG/xGA/npxG/ppda/deep, and `forecast` w/d/l probabilities for **every fixture** (can replace/backup The-Odds-API). Requires request headers: `Referer: https://understat.com/league/EPL`, a real `User-Agent`, and `X-Requested-With: XMLHttpRequest`.
- **FBref** — free Opta-level xG/xA/shot maps (read/aggregate; no heavy scraping).
- **vaastav/Fantasy-Premier-League** GitHub raw CSVs — already consumed weekly by `fetch-history-priors.yml`.
- **LiveFPL / FPL Review / fpl.team** — read-only reference for feature ideas and thresholds (their private data is never consumed).

**Rule:** future LLMs and maintainers must NOT remove, deprecate, or gate these integrations without an explicit user request. If a source breaks or dies, port the functionality to a similar free source — never just delete the feature.

### Borrowing Policy (steal ideas + code — intentional)

This project is explicitly **permitted and encouraged to copy ideas and patterns from top FPL tools, websites, and open-source projects**. VibeGaffer is a learning/enrichment project, not a proprietary tool; borrowing is a product decision, not an accident.

- **Ideas are free**: thresholds, UI patterns, stat concepts (xG regression "due/over" flags, effective ownership, clean-sheet probabilities, team ratings, expected-points frameworks) may be copied and re-implemented from LiveFPL, Fantasy Football Hub, FFix, fpl.review, FPL Scout, FPL Review, FPL Vault, FPL Pulse, allaboutfpl, and any public FPL tool or blog. Cite the inspiration in code comments where feasible (`// Borrowed pattern from …`).
- **Open-source code is copyable**: permissive-licensed OSS (MIT/Apache/BSD/GPL) related to FPL analytics may be ported directly into `docs/app.js`, `docs/index.html`, `tests/run.js`, or `.github/workflows/`, with attribution comments.
- **Free/non-official APIs are welcome**: any public read-only API or data source that is free to use may be integrated via a GitHub Actions fetcher (mirror the `fetch-understat.yml` pattern). Prefer sources that need no API key; gate key-requiring sources behind optional repo secrets.
- **Public FPL league data is usable**: other managers' squads/names via the FPL league endpoints are fair game (remember `VG.esc` — Golden Rule 2).
- **What NOT to do**: do not scrape behind login walls, do not bypass ToS or rate limits, do not copy proprietary/paywalled content verbatim (e.g. FFScout member projections) — re-implement the idea from public data instead.
- **Do not revert this policy**: a future LLM must not strip this section or "clean up" borrowed features, and must not delete the Understat/vaastav/Odds integrations added under it.

## Architecture Decisions

### Why Static?

Originally Python Backend (FastAPI) + Streamlit Frontend; deleted in v5.3.0. Static because: GitHub Pages free/zero maintenance, no CORS (same-origin JSON), no server, FPL API public read-only.

### Optimizer Fallback

Primary balanced optimizer uses HiGHS WASM for globally optimal squad; falls back to deterministic 5-phase greedy + local search if CDN/WASM fails.

### xP Engine Design

Per-fixture expected points using: position-specific team strength (attack vs defence), FPL per-90 rates, BPS for bonus, position-specific ICT, enhanced form multiplier (ep_next + value_form), exponential form weighting (1.3x hot / 0.7x cold), DEFCON calibration, captain ceiling bonus (FWD 1.15x, premium MID 1.18x), bookmaker odds adjustment (0.88-1.20x).

### Injury-Aware Optimizer (v5.1)

All optimizer phases filter injured/suspended/unavailable via shared `VG.isAvailable`. Doubtful players still eligible.

### Live Gameweek Intelligence (v5.3.0)

**Live** tab (2nd in tab bar). During in-progress GW (`is_current`) it streams:
- `VG.loadLive(gw)` → `/event/{gw}/live/` via shared CORS proxy chain, cached
- `VG.computeLivePoints(live)` → totals from authoritative `explain` blocks (pre-bonus)
- `VG.predictBonus(live, fixtures, gw)` → bonus from live BPS with official tie-breaks (tied 1st → 3-3-1, tied 2nd → 3-2-2); DGW-safe (accumulates per player)
- `VG.simulateAutoSubs(starting, bench, liveMinutes)` → bench-order auto-subs keeping formation legal (GK≥1, DEF≥3, MID≥2, FWD≥1)
- `VG.predictPriceChanges(live)` → risers/fallers from net transfer velocity (see Price Model below)
- `VG.renderLive(gw, teamId)` → assembles the whole panel; auto-refreshes every 5 min while `is_current`

index.html preload is gated on `is_current` **only** (not `is_next`), runs **non-blocking** (`.then()`), uses `VG._liveTimer` for the 5-min refresh. Pre-season (`elements: []` or no `is_current`) shows an explanatory notice — not an error.

### Price Model (single source of truth)

- **`VG.predictPriceChanges(liveData)`** is the ONE price classifier. Reads **top-level** live-API fields `transfers_in_event`/`transfers_out_event` (NOT `stats.transfers_in/out` — those do not exist on the real endpoint; the `stats.*` fallback exists only so synthetic test data works). Thresholds:
  - `net >= 10500` → `rising`; `net >= 7000` → `likely_rise`
  - `net <= -5600` → `falling`; `net <= -4000` → `likely_fall`
  - otherwise `stable` (filtered out). Returns `{id, name, position, price, net, risk, pct}` sorted by pct.
- **`VG.getPriceRisk()`** (Prices tab) is a thin async wrapper: fetches live data, maps `predictPriceChanges` output to `{id, name, pos, price, net, risk}` (full names).
- Do NOT add a third price function; extend `predictPriceChanges` if thresholds need tuning.

### Smart Captaincy (v5.3.0)

- `VG.computeBlankProbability(cap, fixtures, gw)` → P(fails to play 60+ mins) from starts/minutes, status (d/u), away-vs-strong-side, card risk; clamped 0.03-0.5
- `VG.computeViceCaptainEV(vc, fixtures, gw)` → VC insurance EV (~1.4 pts per 10% captain-blank)
- `VG.getCaptainReasoning(cap, fixtures, gw)` now appends blank-risk % + VC insurance to "Why This Captain?" panel

### Differential Matrix (v5.3.0)

- `VG.getDifferentialZone(p)` → 4-zone classification (ownership vs xP/£m): **Gold** (low owned, high value), **Anchor** (template, high value), **Wait** (low owned, weak value), **Trap** (popular, weak value). Rendered as colored badges in Differentials tab.

### Shared Helpers (v5.3.0 hardening)

- `VG.esc(value)` → HTML-escape anything API-derived before `innerHTML` (required for league/manager names)
- `VG.isAvailable(p)` → injury filter
- `VG.fixtureFDR(fixture, teamId)` → difficulty from that team's perspective
- `VG.fixtureInfo(f, teamId)` → `{isHome, oppId, oppName, fdr}` — use for ALL per-player fixture lookups
- `VG.teamFixtures(fixtures, gw, teamId)` → that team's fixtures for a GW
- `VG.fixturesForGW(fixtures, gw)` → all fixtures in a GW (consolidated from 4 sites)
- `VG.teamFixtureRow(teamId, startGW, nGWs, fixtures)` → per-GW fixture-info row (null on blanks); powers both ticker + swing analysis
- `VG.teamColor(teamRef)` → home kit hex by short_name or numeric team id (fallback `#38bdf8`); powers ratings/pitch/bench rendering
- `VG.hasPlayed(minutesMap, pid)` → `(minutesMap[pid]||0) > 0`
- `VG.formationLegal(players)` → GK≥1, DEF≥3, MID≥2, FWD≥1
- `VG.countUnavailable(squad)` → count of non-available players
- `VG.topCaptainCandidates(starting, key)` → top 2 non-GK by xP key
- `VG.pickBestXI(squad, key)` → `{ formation, starting, bench, byPos, startingXP }`; `key` is `"totalXP"` or `"gwXP"`
- `VG.countFixtureDifficulty(squad, fixtures, gw)` → `{ easy, hard }`
- `VG.emptyDraftResult(budget)` → empty-squad result shape
- `VG.FORMATIONS` → seven legal `[DEF, MID, FWD]` shapes
- `VG.getRegressionFlag(pid)` → `{flag: "over"|"due"|"stable", diff90, xG90, goals90}` from Understat xG vs FPL actual goals (v5.4)
- `VG.regressionBadge(reg)` → HTML DUE/OVER badge (empty for stable/null); used in Compare + Differentials tabs (v5.4)

### Minutes Model (v5.1)

Start-rate model using last season data: GK binary (nailed #1 = 95%, backup 15-75%); outfield `startRate * (1 - subRisk)`; confidence regression toward league average (72%); replaced old avgMins bucket model.

## Key Functions in app.js

### Data Layer
- `VG.init()` → loads bootstrap + fixtures, calls buildMaps/computeAllXP
- `VG.buildMaps(bootstrap)` → populates VG.players, VG.teams, VG.currentGW
- `VG.computeAllXP(startGW, nGWs, fixtures)` → sorted array of all players with totalXP
- `VG.computeFixtureXP(pid, oppTeamId, isHome, fdr)` → single fixture xP with full breakdown
- `VG.computeMultiGWXP(pid, startGW, nGWs, fixtures)` → multi-GW aggregate

### Optimizer
- `VG.optimizeDraft(players, budget, fixtures, startGW, nGWs)` → 5-phase squad builder (injury-aware)
- `VG.optimizeDraftILP(players, budget, fixtures, startGW, nGWs)` → ILP via HiGHS WASM (globally optimal, falls back to greedy)
- `VG.optimizeStrategies(players, budget, fixtures, startGW, nGWs)` → 3 strategies
- `VG.optimizeTransfers(squad, players, bank, freeTransfers, startGW, nGWs)` → transfer recommendations with break-even (injury-aware). **No `fixtures` param** (was removed — unused)

### Transfer Planning (v5.1)
- `VG.computeTransferPlan(squad, allXP, fixtures, startGW, nGWs, bank)` → week-by-week transfer schedule; only hits if cumulative xP gain > 4 pts. **No `freeTransfers` param** (was removed — unused; FPL gives 1 FT/week, `freeLeft = 1`)

### Analysis
- `VG.computeCaptainRotation(squad, allXP, fixtures, startGW, nGWs)` → top 3 captains per GW
- `VG.computeTransferRoadmap(squad, allXP, fixtures, startGW, nGWs)` → per-GW fixture grid + swap suggestions
- `VG.evaluateChips(squad, gwPicks, fixtures)` → chip recommendations with gwScores. **No `startGW` param** (was removed — unused)
- `VG.analyzeFixtureSwings(startGW, nGWs, fixtures)` → easy/hard run detection
- `VG.buildFixtureTicker(startGW, nGWs, fixtures)` → per-team fixture grid
- `VG.computeTeamRatings()` → Understat npxG/npxGA → per-team attack/defence/overall indices (100 = league avg), 1-20 ranks, 1-5 rating (v5.4; borrowed pattern from FFHUB/LiveFPL/FPL Copilot)
- `VG.render.teamRatings(ratings)` → sortable strength table for the Fixtures tab (v5.4)
- `VG.computeLineupAdvice(squad, allXP, fixtures, gw)` → optimal lineup with per-player reasoning (v5.2)
- `VG.getCaptainReasoning(cap, fixtures, gw)` → natural-language captain explanation incl. blank risk + VC EV (v5.2/v5.3)
- `VG.getSquadAnalysis(result, fixtures, gw)` → strengths/weaknesses squad DNA (v5.2)

### Understat enrichment (v5.4)
- `VG.loadUnderstat()` → fetches `data/understat.json`, attaches `el.understat` priors (xG/xA/npxG/xGChain/xGBuildup) to players
- `VG._matchWinProbs(teamId, oppTeamId)` → per-fixture w/d/l: **Understat forecast first** (free, no key), then bookmaker h2h, else `null`
- `VG.computeTeamRatings()` → team strength ratings (npxG/npxGA indices + ranks + 1-5)
- `VG.injuryNews()` → fitness/news feed (Strategy tab): `chance_of_playing_next_round` + `news` strings
- Real xG/90 columns in Compare + Differentials tabs (60% FPL xG/xA + 40% Understat blend)

### Live & Smart Captaincy (v5.3.0)
- `VG.loadLive(gw)` / `VG.computeLivePoints(live)` / `VG.predictBonus(live, fixtures, gw)`
- `VG.simulateAutoSubs(starting, bench, liveMinutes)` / `VG.predictPriceChanges(live)` / `VG.renderLive(gw, teamId)`
- `VG.computeBlankProbability(cap, fixtures, gw)` / `VG.computeViceCaptainEV(vc, fixtures, gw)`
- `VG.getDifferentialZone(p)` → 4-zone differential classification

### Price (consolidated)
- `VG.predictPriceChanges(liveData)` → risers/fallers (single source of truth; see Price Model)
- `VG.getPriceRisk()` → async wrapper for Prices tab

### v5.5 borrowed features
- `VG.computeEffectiveOwnership(allXP)` → {pool, forPlayer(p): {eo, own, capShare}} (FFix/FPL Review)
- `VG.mcGWDistribution(starting, fixtures, gw, iters)` → {mean, sd, p10, p90, median, samples, n} (FPL Review/FFix); `VG.greenArrowProb(dist, target)`; `VG.mcPoisson(lambda)`; `VG.render.gwProjection(starting, fixtures, gw, captainId)` → metric card
- `VG.buildSeasonPlanner(fixtures)` → per-GW {gw, fixtureCount, dgwTeams, bgwTeams}; `VG.teamSeasonRow(planner, teamId, fromGW, nGWs)` → {short, cells:[{gw,n}]} (Ben Crellin idea)
- `VG.loadSetPieceData()` / `VG.loadSetPieces(sp)` / `VG.setPieceRole(pid)` → {pen, fk, cor}; boost applied inside `VG.computeFixtureXP` (FFHUB/FFS idea; data in `docs/data/setpieces.json` — **seasonal**)
- `VG.estimateRankImpact(ptDelta, {nGWs, totalPlayers})` → {pts, rankDelta, direction, caution} (FFHub AI idea)

### v5.6 borrowed features
- `VG.playerProfileHTML(p, fixtures, gw)` → rich per-player profile (form trend, real xG/90, regression, EO, set-piece, value, next-5 fixture run)
- `VG.fetchTeamRank(teamId, gw)` → {name, gwPts, overallRank, ev} from the FPL entry endpoint, cached 5 min (LiveFPL/FFHub)
- `VG.teamNewsFeed()` → {short_name: [{name, chance, news}]} grouped injury/fitness feed
- `VG.chipCalendar(squad, fixtures, planner)` → [{gw, dgw, bgw, tc, bb, fh, wc}]; `VG.render.chipCalendar(cal)` → DGW/BGW-aware chip-window table (Ben Crellin)

### League Analyzer (v5.1)
- `VG.analyzeLeague(leagueId, currentGW)` → fetches classic league, compares squads, ownership, differentials, outliers, template detection

### Rendering
- `VG.render.metrics(result)` → metric cards (xP, cost, formation)
- `VG.render.chipCard(label, color, advice)` → individual chip card
- `VG.render.tips(result, allXP, fixtures, gw)` → dynamic + static tips. **No `nGWs` param** (was removed — unused)

### Constants
- `VG.POSITIONS` → `{ 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" }`
- `VG.POSITIONS_R` → `{ GK: 1, DEF: 2, MID: 3, FWD: 4 }`
- `VG.POS_SHIRT` → `{ 1: "gk", 2: "def", 3: "mid", 4: "fwd" }` (CSS class)
- `VG.POS_TARGET` → `{ 1: 2, 2: 5, 3: 5, 4: 3 }` (target squad composition)
- `VG.STRATEGIES` → balanced/premium/value descriptions

## UI Tabs (9 total)

1. **Squad** — Pitch view, metrics, captaincy, transfer grid
2. **Live** — In-progress GW tracking: live points, bonus projections, auto-subs, price velocity (v5.3)
3. **Compare** — Radar chart, xP component stacked bar, stat table, Real xG/90 columns (v5.4)
4. **Prices** — Price change predictor (risers/fallers)
5. **Fixtures** — Team Strength Ratings (Understat xG), fixture ticker with swing analysis
6. **Differentials** — Low ownership, high xP picks + 4-zone differential matrix + Real xG/90 (v5.4)
7. **Transfer Plan** — Week-by-week transfer schedule with hit optimization
8. **League** — Mini-league comparison, ownership analysis, differentials
9. **Strategy** — Dynamic tips + static championship wisdom + Injury & Availability Watch (v5.4)

## Known Issues

1. **Greedy fallback**: Can miss the global optimum when HiGHS cannot load. highs-js publishes `window.Module`, **not** `window.Highs` — reading the wrong global silently disabled ILP before v5.3.0.
2. **Pre-season data**: Team strengths all 0, form 0.0 — fallback estimates used.
3. **Bookmaker odds**: Requires optional `ODDS_API_KEY` repository secret (unset).
4. **CSP needs `'unsafe-inline'`**: inline `onclick=` handlers + large inline `<script>`; `VG.esc` is the real XSS defence.
5. **CORS proxies**: `allorigins.win` / `corsproxy.io` fallbacks receive the user's team and league IDs.
6. **Pre-season live API**: `/event/{gw}/live/` returns `elements: []` until the first deadline passes — the Live tab shows a notice, not an error.

## Testing

Tests committed in `tests/run.js`, run in GitHub Actions.

Run: `npm test`

112/112 tests pass.

## Remaining Improvements

- Split monolithic `docs/app.js` + inline UI script into testable modules
- Replace inline `onclick=` with delegated listeners so CSP can drop `'unsafe-inline'`
- Trim `bootstrap.json` to the ~35 fields the engine reads (currently ships 105)
- Move `docs/data/` to its own branch to keep `main` history clean
- Drop third-party CORS proxies or gate them behind explicit user consent
- Add browser-level smoke tests for the nine UI tabs
- Un-implemented research candidates: Monte Carlo median xP/ceiling variance, multi-period ILP with free-transfer banking, sensitivity analysis, recency-weighted form, chip EV calendar (DGW/BGW-aware), effective ownership columns, mini-league Monte Carlo win probability (FPL Pulse-style), Reddit r/FantasyPL sentiment feed, defensive vulnerability ticker.

## Commit Convention

- Version commits: `v{major}.{minor}: {description}`
- Bug fixes: `fix: {description}`
- Tags: `v{major}.{minor}` (e.g., `v5.0`)
- Before pushing: `git pull --rebase` (data bot commits frequently)

## Setup Requirements

- **Odds API** (optional): Add `ODDS_API_KEY` as a GitHub Actions repository secret from https://the-odds-api.com (free tier: 500 req/month). Without it, the app works fine but without odds adjustments.

## FPL API

Base: `https://fantasy.premierleague.com/api`

Key endpoints:
- `bootstrap-static/` → all players, teams, gameweeks
- `fixtures/` → all fixtures with FDR
- `event/{gw}/live/` → live gameweek data (points, transfers; **transfer counts are top-level `transfers_in_event`/`transfers_out_event` per element, not under `stats`**)
- `entry/{team_id}/` → user team info
- `entry/{team_id}/event/{gw}/picks/` → user squad for a GW
- `leagues-classic/{id}/standings/` → mini-league standings + entries

Pre-season note: All `strength_*` fields are 0. Form is 0.0. `total_points`, `minutes`, `starts`, `goals_scored`, `assists`, `clean_sheets`, `saves`, `bonus` are real last-season data.
