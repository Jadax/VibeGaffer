# AGENTS.md — VibeGaffer

Primary context document for AI models working on this codebase. Read fully before editing. New model picking up the repo: start with **Handover Status**, then **Critical Files**, then the section matching your task.

## Handover Status

- **Current version**: v5.11.0 (architectural hardening and modular transport/UI layer on top of v5.10.0)
- **v5.9.0 shipped** (user request: custom subdomain, delist the repo from the live product, modernize the UI, remove AI-writing-tells from all visitor-facing copy):
  1. **Custom domain**: `docs/CNAME` now contains `vibegaffer.astraiva.app`. This only takes effect once the user adds a DNS CNAME record (`vibegaffer` → `jadax.github.io`) at their DNS provider and sets the custom domain in the GitHub repo's Settings → Pages (which also lets "Enforce HTTPS" be turned on once DNS propagates) — neither of those is something a model can do from the repo. Until then the site keeps serving fine at `jadax.github.io/VibeGaffer/`.
  2. **Delisting, not privacy**: the user was told plainly that a static client-side app can't hide its own JS from visitors (View Source/DevTools always works, independent of GitHub repo visibility) — chose "just delist," i.e. no GitHub/repo links anywhere in the live product or the docs' Live URL line, repo itself stays public. Do not add repo links back into `docs/index.html` or the README header without being asked.
  3. **Astraiva branding restored** in the header (`.header-sub`) and footer, reversing the v5.6.1 removal — now that this ships under an astraiva.app subdomain, hiding the affiliation didn't make sense. If a future request removes it again, that supersedes this note.
  4. **Design pass** (scope: "polish the current theme," not a rebrand — no new color system): pill-style tab nav with per-tab emoji icons and an active-state gradient fill (`docs/style.css` `.tabs`/`.tab`), custom themed scrollbar, `fadeUp` transitions on tab switches and the results/welcome mount (respects `prefers-reduced-motion`), consistent hover-lift (`translateY(-2px)`) added across `.metric`/`.chip`/`.strategy-card`/`.gw-card`/`.price-card`/`.tip-card` (previously inconsistent, some cards had zero hover feedback), rewrote the welcome screen with a punchier headline and a 3-step "how it works" strip (`.welcome-steps`) instead of two paragraphs of prose.
  5. **Copy pass**: every em dash in visitor-facing strings in `docs/app.js` and `docs/index.html` (tips, chip reasoning, captain reasoning, badges, market tags, watchlist, table cells, headings) rewritten with natural punctuation (colon/comma/period, chosen per sentence, not a blanket find-replace). Em dashes remaining in the two files are exclusively inside `//` comments (invisible to visitors) — grep `—` and check every hit is preceded by `//` if verifying this later. README's changelog table and deep technical sections were deliberately left alone (internal dev docs, not visitor-facing, disproportionate effort for the ask's intent).
  - Verified live in-browser at release point: full run unaffected (ILP solver, all tabs, ~192k chars of rendered HTML across squad+fixtures), tab switching works with delegated data actions, no new console errors. 193/193 tests passed at that release point.
- **Previous**: v5.8.1 (`ed6ea7c` → v5.8.1 was a post-review fix pass — see below)
- **v5.8.1 fixes** (found by a full duplication/correctness review, both verified live in-browser):
  1. **What-If scenario buttons were completely broken.** `VG.runWhatIf` (new in v5.8.0) is a top-level function, but called bare `el("leagueId")` — `el` only exists as a local closure inside `VG.init`/`VG.run`/`preloadTabs`. Every click threw `ReferenceError: el is not defined`, silently (the `onclick` has no `.catch()`), leaving the panel stuck on "Simulating…" forever. Fixed to `document.getElementById("leagueId")`. Regression test added (static-analysis check on `indexSource`, since `tests/run.js` doesn't execute the inline `<script>`).
  2. **Git-push race in 3 of 4 secondary data workflows.** `fetch-understat.yml`, `fetch-history-priors.yml`, `fetch-odds.yml`, `fetch-recent-form.yml` all did a bare `git commit && git push` — no retry when the push is rejected. Only `fetch-data.yml` had the retry loop (added in v5.3.0 hardening, for a different reason — concurrent runs of *itself* overwriting the same file). This is what caused the real `Fetch Free Understat xG/Forecast Data` CI failure on `ed6ea7c`: four fetchers committed within the same ~20s window and the loser's push just failed outright. Fixed all three with a 3-attempt `push → pull --rebase → retry` loop. Simpler than `fetch-data.yml`'s version since each of these touches a distinct file, so a plain rebase always resolves cleanly (no "replay generated file over remote tip" needed).
  - Reviewed the rest of v5.8.0 for duplication/redundancy and found none: `simulateRaceScenario` correctly reuses `VG._mcLambdas`/`VG._mcDrawTotal` rather than a third Monte Carlo loop; `_recencyFactors` is a single shared helper consumed from both `computeFixtureXP` and `computeMultiGWXP`; no reintroduced formation arrays, FDR ternaries, or `isAvailable`/`esc` copies. `render.seasonPlanner`'s own fixture index (rather than reusing `teamFixtureRow` in a loop) is a deliberate perf choice for a 20×38 grid, not accidental duplication — documented here so it isn't "fixed" into an O(n²) regression later.
  - Tests: 192 → 193
- **v5.8.0 shipped** — "massive-model-lite" recency/rotation upgrade + a batch of community features, chosen from an explicit research pass against FPL Review's paid **Massive Data Model** (ML ensemble, xMins, hourly odds/team-news) and **OpenFPL** (arXiv 2508.09992, MIT — a public-data rival that beats season aggregates using recency-weighted 1/3/5-match windows). Decided to ship a *lite* version (recency-weighted features, no Python/ML runtime) + all five approved community features. Notes below:
  1. **Horizon cap** — `#horizon` select was hardcoded `6/8/12` (12 default, `index.html:47`), and `computeMultiGWXP`'s pre-season/no-fixtures fallback did `totalXP = nGWs * base * 0.6`, over-projecting near season end. New `VG.SEASON_GW_COUNT` (38), `VG.remainingGWs(gw)` and `VG.clampHorizon(nGWs, startGW)`; `computeMultiGWXP` clamps its horizon (app.js) and `VG.init` builds the horizon options from the GWs actually left (defaulting to `min(12, remaining)`); `VG.run` also clamps defensively.
  2. **New-player handling** — `computeFixtureXP` now returns `isNew` (no PL minutes/starts/xG/xA) and `priorSignal` ("ep_next" | "understat"); the ep_next blend went 0.6/0.4 → 0.5/0.5 for stronger FPL-prior weight. New players surface a `NEW TO PL · FPL PRIOR / UNDERSTAT PRIOR` badge in Compare + Differentials + Player Profile.
  3. **Recency-weighted projection (OpenFPL-style)** — `fetch-recent-form.yml` now emits full 1/3/5-round windows per player: `{n, s1, s3, s5}` each `{starts, mins, pts, xgi, bps}` (plus back-compat `starts5/gws5/mins5`). New `VG._recencyFactors(p)` reduces these to `{weight, rounds, startsRate, mins, xgi90, pts90}` with confidence scaling (0.38 at 2 GWs → 0.50 at 5+); `computeFixtureXP` blends the recent starts rate into `startRate` and nudges the per-90 goals/assists toward the last-3-GW xGI rate (clamped 0.70–1.40). Fully optional/additive — absent pre-season it's byte-identical to old behavior.
  4. **xMins surfaced** — `computeFixtureXP` returns `xMins` (minsProb × 90, FPL Review idea); `computeMultiGWXP.info` carries mean `xMins`, `isNew`, `priorSignal`, and `recency`; shown in Compare, Differentials, Player Profile, Rate My Team.
  5. **Buy/Hold/Sell tags** — `VG.getMarketTag(p)` (recency + xG regression + ownership + xP/£m) + `VG.marketBadge()`; rendered in Compare, Differentials, Player Profile.
  6. **Watchlist** — `VG.watchlist()/toggleWatch()/isWatched()/watchToggle()`, localStorage-backed (`vg_watchlist`); `VG.render.watchlist()` panel in the Strategy tab with a quick-add dropdown + remove buttons; ☆ toggle in Compare + Differentials tables.
  7. **What-If race scenarios** — `VG.simulateRaceScenario(squads, fixtures, gw, iters, {addId[, dropId] | captainId})` + `VG.raceScenarioDelta()` in the League tab. Rivals' scores are drawn ONCE and reused for baseline + scenario (only your squad's draw changes), so the win-prob delta is attributable to the change, not noise. `VG.analyzeLeague` now returns `rawSquads` (the full picks) for this. `VG.runWhatIf(mode, gw)` drives the UI.
  8. **Rate My Team** — `VG.rateMyTeam(result, allXP, fixtures, gw)` → transparent component scores (xP strength 25% / rotation risk 20% / formation 20% / budget 20% / captaincy 15%) + letter grade + advice; rendered as a card on the Squad tab.
  9. **Full-season FDR planner** — `VG.render.seasonPlanner(fixtures, fromGW, nGWs, teamId)` in the Fixtures tab: every team × every GW, colour-coded FDR cells with DGW/BGW markers. Consumes `VG.teamSeasonRow`/`VG.buildSeasonPlanner`, which previously had no live caller.
  - Tests: 153 → 192 (39 new: horizon clamping + capped pre-season fallback + late-season fixture filter, isNew flag + prior, `_recencyFactors` windowed/legacy/thin/null, recency output blend both-directions + fallback-exactness, market-tag classify + XSS-escape, watchlist toggle/persist/render, rate-my-team scores/components/advice/safety, what-if captain + transfer + delta + needs-2-squads, full-season planner HTML)
  - Verified live in-browser (local http server): Squad tab (Rate My Team card A/89), Strategy tab (Watchlist panel + quick-add), Fixtures tab (full-season planner grid), Compare + Differentials (xMins/Rec/Market/☆ columns), League tab What-If end-to-end with mocked league data (baseline 99.4 → scenario 99.4, delta 0 for identical squads). Only console messages are the 3 expected pre-season data 404s. **Also caught + fixed a real bug my earlier edit introduced**: `VG.renderComparison` lost its `const sel = document.getElementById("compareSelect")` line during the What-If UI edit — restored (would have thrown `sel is not defined`).
  - **Data source note**: recent-form 1/3/5 windows are inert until GW1+ results exist (pre-season now) — the blend self-activates once players have 2+ recorded GWs. Verified against synthetic `recentForm` objects in tests; the fetcher emits the new shape daily.
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
- **Tests**: 216/216 pass (`npm test`)
- **State**: `docs/app.js` analytical core, `docs/data.js` transport, `docs/ui.js` UI actions, `docs/index.html` markup; all JavaScript modules syntax-check clean
- **v5.5/v5.6 shipped** (competitor-borrowed features, per Borrowing Policy): Effective Ownership (`VG.computeEffectiveOwnership`), Monte Carlo GW Projection (`VG.mcGWDistribution`), DGW/BGW Season Planner (`VG.buildSeasonPlanner`), Set-Piece Takers (`docs/data/setpieces.json`, seasonal — update each year), Transfer Rank-Impact (`VG.estimateRankImpact`), Player Profile (`VG.playerProfileHTML`), Live Rank tracker (`VG.fetchTeamRank`), Team News feed (`VG.teamNewsFeed`), Chip EV Calendar (`VG.chipCalendar`)
- **Next model TODO**: keep the release-hardening checks and public-data workflows green; update this handover when the next version ships.

## Quick Status

- **Architecture**: Pure static HTML/CSS/JS on GitHub Pages (no backend)
- **Live URL**: https://vibegaffer.astraiva.app/ (custom domain, CNAME'd to jadax.github.io — repo is not linked from the live product; keep it that way)
- **Data**: Auto-fetched on a deadline-aware GitHub Actions schedule → `docs/data/*.json` (30 min inside 6h of a deadline, 2-hourly within 36h, 6-hourly otherwise). The workflow now emits a compact `docs/data/bootstrap-lite.json` for the public app and retains `bootstrap.json` as a fallback/debug snapshot. **Understat** free xG/forecast data fetched weekly → `docs/data/understat.json`. **Recent-form** (1/3/5-round starts/mins/points/xGI/BPS, rotation-risk + recency) fetched daily → `docs/data/recent-form.json` (v5.8.0 shape `{n, s1, s3, s5}` + back-compat; inert until players have 2+ recorded GWs this season)
- **ILP Solver**: highs-js (HiGHS WASM) loaded from CDN, falls back to greedy. highs-js publishes `window.Module`, **not** `window.Highs` — see Known Issues
- **Odds**: The-Odds-API free tier (500 req/month), fetched once per GW when deadline is within 30h → `docs/data/odds.json`. Requires optional `ODDS_API_KEY` repo secret (currently unset). **Understat forecasts are the free no-key alternative** used by default

## Critical Files

| File | Lines | Purpose |
|------|-------|---------|
| `docs/app.js` | ~4400 | All logic: xP engine, optimizer, chips, transfers, planner, league, tips, live GW |
| `docs/index.html` | ~160 | Markup, CSP, tab shells, and static controls |
| `docs/data.js` | ~180 | FPL transport, cache, local-data fallbacks, and enrichment loaders |
| `docs/ui.js` | ~980 | UI orchestration, tab preloading, rendering calls, delegated actions |
| `docs/style.css` | 275 | All styles |
| `docs/data/bootstrap.json` | ~1.3MB | Player data (~560 active, 20 teams) |
| `docs/data/bootstrap-lite.json` | generated | Compact public player/team/event payload; preferred by the app with full snapshot fallback |
| `docs/data/fixtures.json` | ~118KB | 380 fixtures with FDR |
| `docs/data/understat.json` | ~120KB | Free Understat xG/xA priors + team stats + per-fixture forecasts |
| `docs/data/recent-form.json` | small | Per-player 1/3/5-round starts/mins/points/xGI/BPS windows (rotation risk + recency), v5.8.0 |
| `.github/workflows/fetch-data.yml` | ~125 | Deadline-aware FPL data fetch |
| `.github/workflows/fetch-understat.yml` | ~230 | Weekly Understat xG/forecast fetch |
| `.github/workflows/fetch-history-priors.yml` | ~55 | Weekly vaastav historical priors |
| `.github/workflows/fetch-recent-form.yml` | ~90 | Daily last-5-GW rotation-risk fetch (v5.7.0) |
| `.github/workflows/fetch-odds.yml` | ~55 | Optional bookmaker odds (needs `ODDS_API_KEY`) |
| `.github/workflows/test.yml` | ~30 | CI: `node --check` + `npm test` |
| `tests/run.js` | ~590 | Regression suite (153 checks) |

## Golden Rules (violations cause bugs)

1. **Never reimplement shared helpers.** `VG.esc`, `VG.isAvailable`, `VG.fixtureFDR`, `VG.fixtureInfo`, `VG.pickBestXI`, `VG.formationLegal`, `VG.countUnavailable`, `VG.hasPlayed`, `VG.topCaptainCandidates`, `VG._mcLambdas`, `VG._mcDrawTotal` exist to be reused.
2. **Escape everything API-derived before `innerHTML`.** `VG.esc()` is the real XSS defence (league/manager names are controlled by other FPL users). Script CSP is strict; UI actions use delegated data attributes.
3. **All optimizer/selection code must filter injuries** via `VG.isAvailable(p)`. Doubtful players stay eligible but are flagged.
4. **When changing a function signature, update every call site** — `docs/ui.js`, `docs/data.js`, `docs/app.js`, `tests/run.js`. Grep `VG.functionName(`.
5. **Do not add a second price/fixture lookup.** `VG.predictPriceChanges` and `VG.fixtureInfo` are the single sources of truth.
6. **Run `node -c docs/app.js` + `npm test` after every change.** Browser smoke (python http.server + tab check) for UI changes.

## Third-Party Public Data Policy (intentional — do NOT remove)

Every third-party data integration in this repo is a **deliberate product decision**, not tech debt. Enriching the engine with free public data is the app's core competitive advantage.

**Allowed, intentionally-permitted sources** (all public, read-only, community-licensed):

- **FPL API** (`fantasy.premierleague.com`) — official public read-only endpoint. Primary source. Includes `element-summary/{id}/` (per-player GW-by-GW history — used by `fetch-recent-form.yml`, v5.7.0, same trust tier as bootstrap-static).
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

### Minutes Model (v5.1, recency blend v5.7.0)

Start-rate model using last season data: GK binary (nailed #1 = 95%, backup 15-75%); outfield `startRate * (1 - subRisk)`; confidence regression toward league average (72%); replaced old avgMins bucket model. **v5.7.0**: when `p.recentForm` is present (`VG.loadRecentForm()`, optional, daily-fetched, `gws5 >= 2`), a last-5-GW starts rate is blended into `startRate` with confidence-scaled weight (0.45 at 2/5 GWs of data, 0.6 at 5/5) — closes the gap where a player rotated out in the last few GWs looked identical to one still nailed, as long as season aggregates matched.

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

### League Analyzer (v5.1) + Race Simulator (v5.7.0)
- `VG.analyzeLeague(leagueId, currentGW, fixtures)` → fetches classic league, compares squads, ownership, differentials, outliers, template detection. **3rd param added in v5.7.0** — fixtures, needed by the race sim; call site is `docs/index.html`. Return object now also carries `raceSimulation`.
- `VG.simulateLeagueRace(squads, fixtures, gw, iterations)` → Monte Carlo win probability among fetched league squads for the current GW; `null` if fewer than 2 squads have picks. Returns `[{entry, name, priorTotal, gwMean, gwFloor, gwCeiling, winProb, top3Prob}]` sorted by winProb (FPL Pulse idea)
- `VG.currentTeamId` (set in `VG.run()`) → how the race sim and Live Rank tracker both spot "you" among fetched entrants

### v5.7.0 borrowed features
- `VG.simulateLeagueRace(squads, fixtures, gw, iterations)` — see League Analyzer above (FPL Pulse idea)
- `VG._mcLambdas(starting, fixtures, gw)` / `VG._mcDrawTotal(lambdas)` — Poisson-lambda + single-draw helpers factored out of `VG.mcGWDistribution` (v5.5) so the race simulator reuses the exact same scoring model instead of a second implementation
- `VG.loadRecentForm()` → fetches `data/recent-form.json`, attaches `el.recentForm = {starts5, gws5, mins5}`; blended into `VG.computeFixtureXP`'s minutes-probability model — see Minutes Model above

### v5.8.0 features (massive-model-lite + community)
- `VG.SEASON_GW_COUNT` / `VG.remainingGWs(gw)` / `VG.clampHorizon(nGWs, startGW)` — horizon cap (see Handover note 1)
- `VG._recencyFactors(p)` → `{weight, rounds, startsRate, mins, xgi90, pts90}` from the 1/3/5-round recent-form windows; feeds the `startRate` + per-90 xGI blend in `computeFixtureXP` (OpenFPL/FPL Review pattern)
- `VG.getMarketTag(p)` / `VG.marketBadge()` — Buy/Hold/Sell classifier (FFix/FPL Review idea)
- `VG.watchlist()` / `VG.toggleWatch(pid)` / `VG.isWatched(pid)` / `VG.watchToggle(p)` — localStorage-backed watchlist (`vg_watchlist`); `VG.render.watchlist(allXP)` panel (Strategy tab)
- `VG.simulateRaceScenario(squads, fixtures, gw, iters, scenario)` / `VG.raceScenarioDelta()` — What-If race scenarios (shared rival draws, so deltas are change-attributable); `VG.analyzeLeague` now also returns `rawSquads`
- `VG.rateMyTeam(result, allXP, fixtures, gw)` / `VG.render.rateMyTeam(...)` — transparent component-scored team rating (Squad tab)
- `VG.render.seasonPlanner(fixtures, fromGW, nGWs, teamId)` — full-season FDR grid, consumes the previously-dead `VG.teamSeasonRow`/`VG.buildSeasonPlanner` (Fixtures tab)

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
8. **League** — Mini-league comparison, ownership analysis, differentials, 🏁 Race to the Top Monte Carlo win probability (v5.7.0)
9. **Strategy** — Dynamic tips + static championship wisdom + Injury & Availability Watch (v5.4)

## Known Issues

1. **Greedy fallback**: Can miss the global optimum when HiGHS cannot load. highs-js publishes `window.Module`, **not** `window.Highs` — reading the wrong global silently disabled ILP before v5.3.0.
2. **Pre-season data**: Team strengths all 0, form 0.0 — fallback estimates used.
3. **Bookmaker odds**: Requires optional `ODDS_API_KEY` repository secret (unset).
4. **CSP is strict for scripts**: application logic is externalized in `app.js` + `ui.js`, all UI actions are delegated, and `script-src` no longer permits `'unsafe-inline'`; inline styles remain.
5. **CORS proxies require consent**: `allorigins.win` / `corsproxy.io` fallbacks are gated by a one-session confirmation before requests carrying team or league IDs are relayed.
6. **Pre-season live API**: `/event/{gw}/live/` returns `elements: []` until the first deadline passes — the Live tab shows a notice, not an error.

## Testing

Tests committed in `tests/run.js`, run in GitHub Actions.

Run: `npm test`

216/216 tests pass.

## Remaining Improvements

- Split the remaining analytical `docs/app.js` into testable modules; transport and UI are now `docs/data.js` and `docs/ui.js`
- ~~Replace inline `onclick=` with delegated listeners so CSP can drop `'unsafe-inline'`~~ completed in `docs/ui.js`; remaining module split is app.js-only.
- ~~Trim `bootstrap.json` to the ~35 fields the engine reads (currently ships 105)~~ compact `bootstrap-lite.json` is generated and preferred by the app
- Move `docs/data/` to its own branch to keep `main` history clean
- Drop third-party CORS proxies or gate them behind explicit user consent
- ~~Add browser-level smoke tests for the nine UI tabs~~ release smoke + nine-tab contract checks are in place
- **Done in v5.7.0** (was on this list): mini-league Monte Carlo win probability (`VG.simulateLeagueRace`), recency-weighted rotation risk (`fetch-recent-form.yml` + the `startRate` blend). Chip EV calendar and effective ownership were already done in v5.5/v5.6.
- Un-implemented research candidates: Monte Carlo median xP/ceiling variance in squad *selection* (not just display — an optimizer that trades some mean xP for a higher floor/ceiling), multi-period ILP with free-transfer banking, sensitivity analysis (how much of a squad's edge depends on shaky xP inputs), fixture-congestion/European-minutes rotation risk (needs a non-FPL fixture source — no clean free one identified yet), defensive vulnerability ticker (set-piece/counter-attack concession patterns — needs shot-location data beyond what Understat's league-level endpoint exposes). Reddit r/FantasyPL sentiment feed considered and **rejected**: no statistically validated signal, meaningfully more scraping-ToS risk than the read-only APIs in the allowed list, adds noise rather than correctness.

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
- `element-summary/{player_id}/` → per-player GW-by-GW `history` (this season) + `history_past` (prior seasons' aggregates). `history` is `[]` until that player has featured this season — used by `fetch-recent-form.yml` (v5.7.0)

Pre-season note: All `strength_*` fields are 0. Form is 0.0. `total_points`, `minutes`, `starts`, `goals_scored`, `assists`, `clean_sheets`, `saves`, `bonus` are real last-season data. `element-summary`'s `history` is empty for every player until GW1 kicks off — confirmed live against the real endpoint while building v5.7.0.
