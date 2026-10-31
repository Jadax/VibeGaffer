# AGENTS.md — VibeGaffer

Primary context for AI models working on this repo. Ordered stable-first: everything above **Handover** rarely changes (cache-friendly); only the Handover tail changes per release. Start at **Golden Rules**, then the section matching your task.

## Overview

- **What**: FPL (Fantasy Premier League) intelligence engine — squad optimization, xP projections, transfers, captaincy, live tracking, league analysis.
- **Architecture**: Pure static HTML/CSS/JS on GitHub Pages (no backend; a Python backend existed pre-v5.3 and was deleted). Live URL: https://vibegaffer.astraiva.app/ (CNAME → jadax.github.io). The repo is deliberately NOT linked from the live product — do not add repo links to `docs/index.html` or the README header.
- **Data**: GitHub Actions fetchers write `docs/data/*.json` on a deadline-aware schedule; the client reads same-origin JSON only.
- **Optimizer**: HiGHS WASM ILP (loaded from CDN) with deterministic 5-phase greedy + local-search fallback. highs-js publishes `window.Module`, **not** `window.Highs`.
- **Author**: Tushant Sharma. Branding: Astraiva (header/footer).

## Critical Files

| File | Purpose |
|------|---------|
| `docs/app.js` (~4640) | All analytical logic: xP engine, optimizer, chips, transfers, planner, league, live GW, renderers |
| `docs/ui.js` (~1080) | UI orchestration: `VG.init`/`VG.run`/`preloadTabs`, delegated click actions, deadline countdown |
| `docs/data.js` (~190) | FPL transport (`VG.fetch` with proxy chain + consent gate), cache, loaders |
| `docs/index.html` (~167) | Markup, CSP, 10 tab shells, sidebar controls; cache-busters must match package version |
| `docs/style.css` (~330) | All styles |
| `docs/data/bootstrap-lite.json` | Compact player/team/event payload; preferred, `bootstrap.json` is fallback |
| `docs/data/fixtures.json` | 380 fixtures with FDR |
| `docs/data/understat.json` | xG/xA priors, team stats, per-fixture forecasts, foreign-league priors |
| `docs/data/recent-form.json` | Per-player 1/3/5-round windows (inert until 2+ GWs recorded) |
| `docs/data/history-priors.json` | Previous-season stats + `team_code` (the transfer-detection key) |
| `docs/data/setpieces.json` | Seasonal — update takers each year |
| `.github/workflows/` | `fetch-data` (deadline-aware), `fetch-understat`, `fetch-history-priors`, `fetch-recent-form`, `fetch-odds` (needs `ODDS_API_KEY`), `test` (node --check + npm test) |
| `tests/run.js` (~1030) | Regression suite (`npm test`) |
| `tools/backtest.js`, `tools/backtest-worker.js`, `tools/calibrate.js`, `tools/sweep.sh` | Walk-forward backtest against real GW results (see Engine Model) |

## Golden Rules (violations cause real bugs)

1. **Never reimplement shared helpers.** Use: `VG.esc`, `VG.isAvailable`, `VG.fixtureFDR`, `VG.fixtureInfo`, `VG.teamFixtures`, `VG.fixturesForGW`, `VG.teamFixtureRow`, `VG.pickBestXI`, `VG.formationLegal`, `VG.countUnavailable`, `VG.hasPlayed`, `VG.topCaptainCandidates`, `VG.playerName`, `VG.fdrColor`, `VG.teamColor`, `VG.hasFitnessFlag`, `VG.setPieceBadge`, `VG._mcLambdas`, `VG._mcDrawTotal`, `VG._percentile`, `VG.transferInfo`, `VG.transferBadge`, `VG.foreignLeagueLabel`, `VG.congestionMultiplier`, `VG.predictPriceChanges`, `VG.teamRates`, `VG.fixtureLambdas`, `VG.minutesModel`, `VG._negBinPmf`, `VG._poissonFloorDiv`, `VG.playerXPEntry`.
2. **Escape everything API-derived before `innerHTML`.** `VG.esc()` is the XSS defence (league/manager names are controlled by other FPL users). Script CSP is strict; UI actions are delegated `data-action` attributes.
3. **All optimizer/selection code must filter injuries** via `VG.isAvailable(p)`. Doubtful players stay eligible but are flagged.
4. **When changing a function signature, update every call site** — grep `VG.functionName(` across `app.js`, `ui.js`, `data.js`, `tests/run.js`.
5. **Single sources of truth**: prices → `VG.predictPriceChanges`; per-player fixture lookup → `VG.fixtureInfo`. Never add a second one.
6. **`allXP` is xP-sorted and shared.** Never sort it in place (Differentials quartile math + watchlist pool depend on the order) — sort a copy: `[...allXP].sort(...)`.
7. **Run `node -c docs/app.js` (and ui.js/data.js) + `npm test` after every change.** Browser smoke (`python -m http.server` + tab check) for UI changes.
8. **When editing ui.js, re-read the surrounding function before saving** — a past edit dropped the `const sel = ...` line of `renderComparison` and broke it. Verify brace balance with `node -c`.

## Engine Model (what the numbers mean)

- **xP engine v6 = match model** (`computeFixtureXP`, rebuilt in v6.0 from a walk-forward backtest). Pipeline per fixture: `VG.teamRates()` (attack/defence indices from this season's results 65% + Understat npxG 35% + `penPerMatch`, shrunk with `teamK`; league `mu` and measured home/away factors; cached on `VG._teamRatesCache`) → `VG.fixtureLambdas(teamId, oppId, isHome)` → `{gf, ga}` recalibrated toward market 1X2 (`marketWeight` 0.5, Understat entries with `isResult` are post-match and ignored) → `VG.minutesModel(p)` → `{pStart, mps, pSub, p60, pPlay, xMins, avail}` → channels. There is NO hardcoded home boost, form multiplier, ICT term or new-club multiplier any more; do not reintroduce them without a backtest showing they help.
- **Channels**: goals/assists = shrunk per-90 × xMins/90 × team attack factor; CS and goals-conceded deduction from a negative binomial (`gaDispersion` r=11) on goals against × P(60) (NB beats Poisson for CS); saves = `VG._poissonFloorDiv(mean, 3)` × pStart; DEFCON = Poisson tail at the threshold (DEF 10, MID/FWD 12) with a dispersion mixture × pStart, returned as **expected points** in `defconProb` (count once); bonus/cards from shrunk per-90 rates. `minsProb` in the result is `pStart`; result also carries `pStart, p60, pPlay, concededXP`.
- **`VG.MODEL`**: every tuning constant (start priors and K, team K, xG weight, market weight, bonus/saves/DEFCON priors, dispersions, feature flags `congestion`/`epAnchor`/`ceiling`). Tune by running `tools/sweep.sh` with overrides, never by guessing. Backtest baseline (GW1-8): Spearman 0.50 (ep_next 0.42), free-hit team 465 (avg manager 461), 4-GW horizon rho 0.58. Blending ep_next in lowers rho monotonically; tested and rejected.
- **Minutes model**: P(start) = (starts + prior·`startK`)/(teamGames + `startK`), prior from role (`rolePrior`: started/featured/none/gk/gkNone/returning); last season's 38-match totals (`p._priorSeason`, set by `applyHistoryPriors`) count only as a prior; recency (last 5 GWs) blends in; then × availability (`chance_of_playing_next_round`) × congestion. `teamGames` comes from finished fixtures, falling back to `VG.gwData`. **Tests must set `VG.allFixtures`** or mid-season reads as pre-season (everyone ~23% starter).
- **Early-season ep_next anchor**: GW1–3 `0.50·ep_next + 0.50·model`, GW4–5 `0.35/0.65` (established players; new signings keep their own 50/50 path). Backtest-justified (GW2-5 rho 0.551 vs 0.547).
- **`VG._projGW`**: `computeMultiGWXP`, `computePlayerGWProjection` and `predictedLineups` pin it per fixture and restore it. It drives the ep anchor and congestion; direct `computeFixtureXP` calls with it unset run as GW1.
- **Captain ceiling**: FWD ≥£8.5m 1.18x, MID ≥£8.5m 1.15x (calibration shows premiums under-projected without it).
- **Congestion** (`VG.congestionMultiplier`): days since previous PL fixture (`VG.fixtureGapDays`); <4d → 0.82 heavy-rotator / 0.88 else; <5d → 0.88/0.93; else 1.0. Acts on P(start). `VG.HEAVY_ROTATORS` holds **short_name codes** — the function resolves numeric team ids through `VG.teams`.
- **Transfers** (`optimizeTransfers`): Phase 0 forces unavailable players out using free transfers; Phase 1 value upgrades with remaining frees; Phase 2 hits up to `hitCap` (`maxTransfers` setting, else FT+2), each gated on breaking even within the horizon. Unavailable players missing from allXP enter the candidate list at 0 xP so dead slots win hit slots over fit players. ui.js passes the chosen `horizon` (was hardcoded 5).
- **Backtest tooling** (`tools/`, cache gitignored): `node tools/backtest.js <from> <to>` replays the CURRENT engine on the `docs/data` commit just before each deadline (`backtest-worker.js` runs one GW in a fresh process; honours `VG_MODEL` env overrides) and scores rho, top-50, team KPI, calibration, 4-GW horizon; `node tools/calibrate.js` breaks error down by channel and P(start) bucket. Run it after any engine change.
- **Season planner** (`VG.buildSeasonPlanner`): DGW = team with ≥2 fixtures; **BGW = team ABSENT from that GW's fixture map** (not a zero-valued entry). Team universe is derived from the fixtures themselves.
- **MC simulations** share one model: `VG._mcLambdas` → `VG._mcDrawTotal` → `VG._percentile`. Race scenarios reuse rival draws so deltas are change-attributable.
- **Live GW**: points from authoritative `explain` blocks; bonus from live BPS with official tie-breaks (tied 1st → 3-3-1, tied 2nd → 3-2-2), DGW-safe; auto-subs keep formation legal. **Only auto-subbed bench players score** (`subResult.subs`) — never re-add points for bench players from the original bench array (double-count bug, fixed once).
- **Price model**: `net >= 10500` rising, `>= 7000` likely_rise, `<= -5600` falling, `<= -4000` likely_fall. Reads top-level `transfers_in_event`/`transfers_out_event` (the `stats.*` fallback is for synthetic tests only).
- **VC insurance**: `1.4 × (capBlank/0.10) × (1 − vcBlank) × min(vcXP/5, 1.5)` — the `(1 − vcBlank)` discount means risky VCs insure less.
- **Rate My Team**: 6 components — xP 25% / rotation 20% / formation 15% / budget 20% / captaincy 15% / efficiency 5% (1 − CV of starter xP).
- **Chip scores**: TC_THRESHOLD 80; the non-DGW TC exception (capGWXP ≥ 8.5 & FDR ≤ 2) sets 85/82 so it can actually recommend. `evaluateChips` returns an **object keyed by chip name** (`{recommend, bestGW, score, reason, tip}`) — the chip's identity is the KEY; never read `best.label`/`best.chip`.
- **Entry endpoint** (`/entry/{id}/`): has NO `history` array (that's `/entry/{id}/history/`). Use `summary_event_points` / `summary_overall_rank`.

## Shared Helper Reference

| Helper | Returns |
|--------|---------|
| `VG.esc(v)` | HTML-escaped string |
| `VG.isAvailable(p)` | false for injured/suspended/unavailable |
| `VG.fixtureInfo(f, teamId)` | `{isHome, oppId, oppName, fdr}` (fdr 3 when no fixture) |
| `VG.teamFixtures(fixtures, gw, teamId)` / `VG.fixturesForGW(fixtures, gw)` | fixture arrays |
| `VG.teamFixtureRow(teamId, startGW, nGWs, fixtures)` | per-GW `{fdr, opp, isHome}` row (null on blanks) |
| `VG.pickBestXI(squad, key)` | `{formation, starting, bench, byPos, startingXP}`; key `"totalXP"` or `"gwXP"` |
| `VG.topCaptainCandidates(starting, key)` | top 2 non-GK by xP key |
| `VG.playerName(p)` | `web_name || second_name || first_name` |
| `VG.fdrColor(fdr)` | green ≤2 / gray 3 / red ≥4 — use everywhere FDR is coloured |
| `VG.transferInfo(p)` | `{transferred, fromTeam, toTeam, fromCode, toCode, foreignLeague}` via `priorTeamCode` vs current `code` (stable franchise code, NOT the FPL team id) |
| `VG.transferBadge(t)` | `NEW CLUB · OLD → NEW` chip (escaped) |
| `VG.computeEffectiveOwnership(allXP)` | `{pool, forPlayer(p)}` (FFix/FPL Review) |
| `VG.estimateRankImpact(ptDelta, opts)` | approx overall-rank move (FFHub idea) |
| `VG.clampHorizon(nGWs, startGW)` / `VG.remainingGWs(gw)` | never project past season end |

## UI Tabs (10)

1. **Squad** — pitch, metrics, captaincy, Rate My Team, transfer grid
2. **Briefing** — one pre-deadline screen: outlook, captain+VC, roll-vs-spend, chip hint, market/price-risk, injuries, bench concern
3. **Live** — in-progress GW: live points, bonus, auto-subs, price velocity (5-min refresh, timer cleared on every run)
4. **Compare** — radar, xP stacked bar, scatter (form vs FDR, tooltips), stat table
5. **Prices** — risers/fallers
6. **Fixtures** — team ratings, ticker, swing analysis, predicted lineups, CS/xGC outlook, season planner
7. **Differentials** — low-ownership picks + 4-zone matrix (Gold/Anchor/Wait/Trap)
8. **Transfer Plan** — week-by-week schedule (hits only if cumulative gain > 4)
9. **League** — mini-league compare, ownership, race Monte Carlo, What-If scenarios
10. **Strategy** — tips, injury watch, team news feed, watchlist

**GW1 + team ID**: `VG.run` tries `loadSquad` first; a 404 (picks don't exist pre-deadline) falls back to draft mode. Other errors rethrow to the retry logic (3 attempts, budget reset on success).

## Third-Party Public Data Policy (intentional — do NOT remove)

Every third-party integration is a **deliberate product decision**, not tech debt. Allowed sources (all public, read-only):

- **FPL API** (`fantasy.premierleague.com`) — primary. Includes `element-summary/{id}/` (per-player GW history; feeds `fetch-recent-form.yml`).
- **The-Odds-API** — optional bookmaker odds, gated by the `ODDS_API_KEY` repo secret.
- **Understat** (`understat.com/getLeagueData/{league}/{season}`) — free xG/xA/xGChain/xGBuildup, per-match team data, and `forecast` w/d/l for every fixture (free no-key odds replacement). EPL + La Liga/Bundesliga/Serie A/Ligue 1 (foreign priors). Headers required: `Referer: https://understat.com/league/{league}`, real `User-Agent`, `X-Requested-With: XMLHttpRequest`.
- **FBref** — free Opta-level xG data (read/aggregate only).
- **vaastav/Fantasy-Premier-League** GitHub raw CSVs — weekly history priors (captures `team_code`).
- **LiveFPL / FPL Review / fpl.team** — read-only reference for ideas/thresholds; private data never consumed.

**Rule:** do NOT remove, deprecate, or gate these integrations without an explicit user request. If a source breaks, port the functionality to a similar free source — never just delete the feature.

### Borrowing Policy (steal ideas + code — intentional)

This project is **permitted and encouraged** to copy ideas and patterns from top FPL tools and open-source projects.

- **Ideas are free**: thresholds, UI patterns, stat concepts may be re-implemented from LiveFPL, FFHub, FFix, fpl.review, FPL Scout, FPL Review, FPL Vault, FPL Pulse, allaboutfpl, etc. Cite inspiration in comments (`// Borrowed pattern from …`).
- **Permissive-licensed OSS** (MIT/Apache/BSD/GPL) may be ported in with attribution.
- **Free public APIs** are welcome via a GitHub Actions fetcher (mirror `fetch-understat.yml`). Prefer no-key sources; gate key sources behind optional repo secrets.
- **Public FPL league data is usable** (remember `VG.esc` — Golden Rule 2).
- **NOT allowed**: scraping behind login walls, bypassing ToS/rate limits, copying paywalled content verbatim (e.g. FFScout member projections) — re-implement the idea from public data instead.
- **Do not revert this policy** or "clean up" borrowed features.

## Known Issues / Gotchas

1. **Greedy fallback** can miss the global optimum when HiGHS fails to load.
2. **Pre-season data**: team strengths equalized (fallback ~1015), form 0.0 — fallback estimates used. Tests that install synthetic strengths must restore them **by value** (undefined → NaN → every later projection NaN).
3. **CORS**: the FPL API sends no `Access-Control-Allow-Origin`, so entry/picks must go through a relay. The app uses a **shared app-wide Cloudflare Worker** (`VG.SHARED_RELAY`, `https://vibegaffer-relay.sharma-tushant.workers.dev`) automatically with no consent; the author's private worker (`vg_proxyURL`)/free relays are fallbacks. Free public relays (`allorigins.win`/`corsproxy.io`/etc.) still require one-session `confirm()` consent before team/league-ID requests.
4. **Pre-season live API**: `/event/{gw}/live/` returns `elements: []` until the first deadline — the Live tab shows a notice, not an error.
5. **`bootstrap-lite.json` / `odds.json` 404s pre-season are expected** console noise.
6. **FPL team ids change across seasons**; the stable cross-season key is the franchise `code` (`team_code`).
7. **Version sync**: package.json + all four `docs/index.html` cache-busters (`app.js?v=`, `data.js?v=`, `ui.js?v=`, `style.css?v=`) + the header badge must match. CI checks the cache-busters.

## FPL API

Base: `https://fantasy.premierleague.com/api`

- `bootstrap-static/` → players, teams, gameweeks
- `fixtures/` → all fixtures with FDR
- `event/{gw}/live/` → live points (`explain` blocks; transfer counts are top-level `transfers_in_event`/`transfers_out_event`)
- `entry/{team_id}/` → team info (`summary_event_points`, `summary_overall_rank`; no `history` array here)
- `entry/{team_id}/event/{gw}/picks/` → squad (404 pre-deadline)
- `leagues-classic/{id}/standings/` → mini-league entries
- `element-summary/{player_id}/` → per-player GW history (`[]` until the player features)

## Testing & Release

- Run: `npm test` (see Handover for current count). CI: `node --check` on all JS + `npm test`.
- Release checklist: bump `package.json` → bump all four cache-busters + badge in `docs/index.html` → update Handover below → `node -c` all JS → `npm test` → commit `v{major}.{minor}: {description}` → tag `v{major}.{minor}.0` → `git pull --rebase origin main` (the data bot commits frequently) → push.

## Setup Requirements

- **Odds API** (optional): `ODDS_API_KEY` repo secret from https://the-odds-api.com (free tier 500 req/month). Without it the app runs on Understat forecasts.

---

## Handover Status

<!-- Volatile section — update every release; everything above should stay stable. -->

- **Current version**: v6.0.0 (Engine rebuilt as a match model. Trigger: the user's GW9 advisor squad scored 26 (rank 5.5M) and the user sat below the average manager every week GW1-8 (362 vs 461). Built `tools/` walk-forward backtest first: old engine rho 0.26 vs FPL ep_next 0.44, free-hit team 394. Channel calibration showed minutes were the main error (rotation players and prior-season ghosts read as starters; O'Riley/Wilson projected 5.2/4.5 xP, played 0/6 mins). v6: team goals model + market recalibration + explicit minutes model + per-channel scoring (see Engine Model). Result GW1-8: rho 0.50 (ep 0.42), free-hit team 465 (avg 461), horizon rho 0.58. Remaining soft spot: £6.5-8.5m under-projected (proj 3.01 vs actual 3.43). Transfer fixes found replaying GW9 for the user's squad: hit phase was dead code (shared the free cap), dead players missing from allXP could not take hit slots, optimizer ignored the chosen horizon, WC trigger ignored players unlikely to play (`deadCount`, xMins < 30). UI: forced moves no longer show a bogus "pts/GW avg", rank-impact text uses the real horizon and nets off hits. Tests: 363 passed, 0 failed.) · v5.17.9 (Full review pass, two real bugs found by running transfer mode against a live mid-season squad (entry 1, GW9). 1) **Injured players leaked xP**: `computeFixtureXP` applied the fitness flag (`availability` from `chance_of_playing_next_round`) only through `minsProb`, which reaches appearance/DEFCON/cards; goals, assists, CS, bonus and saves ignored it, so Szoboszlai (hamstring, 0%, unknown return) projected 2.25 xP for GW9. Those five components now multiply by `availability`; fully fit players (availability 1, 466 of 496 in the pool) are unchanged, so v5.16 calibration holds. GW9 now 0.1 (floor). 2) **Transfer-mode squad rendered as 14**: with 2 injured players and 1 FT, Phase 0 forces out the first, and the retained second was dropped by `allXP.filter(...)` in `buildFromSquad` (allXP excludes injured). New shared `VG.playerXPEntry(pid, startGW, nGWs, fixtures)` (also used by `computeAllXP`, no duplication) rebuilds those entries so the squad is always 15 and injury-aware features (Rate My Team, WC trigger) stop undercounting. `optimizeTransfers` now returns `stillUnavailable` and the warning says so plainly. Also swapped an inline availability check for `VG.isAvailable` (Golden Rule 1). Sweep found no duplicate VG defs, no in-place allXP sorts, no FDR-ternary leaks, no bare `el(` in top-level ui.js functions, all CI workflows green. Tests: 348 passed, 0 failed (8 new).) · v5.17.8 (Fix: the Transfer Planner sold the same starter twice inside one GW — the option list is ranked across ALL weak slots, and after an option applied, nothing re-checked that `opt.out` was still in the squad, so a weak GK could be "sold" 5 times in one GW with 4 phantom hits and 5 premium GKs in-fitted (the observed live plan `Roefs→Trafford/Tzolakis/Martinez/Verbruggen/Pickford`). The opts loop now skips any option whose out-player has already left the squad this GW. Regression: "no starter is sold twice inside one planned GW". Tests: 340 passed, 0 failed.) · v5.17.7 (Fix: the Transfer Planner charged hits for every non-first transfer — `freeLeft` was hardcoded to 1/GW and ignored FPL's roll rule, so banked FTs were wasted and hits were over-recommended. `computeTransferPlan` now takes `freeNow` (the same Free-transfers limit the optimizer honours) to seed a rolling bank: unspent FTs carry forward (+1 per GW, capped 5), and only transfers beyond the bank get the >4 cumGain hit gate. The plan tab reads the FT limit input and the per-GW label shows the real hit cost (`-8 hits`), not a hardcoded `-4 hit`. Tests: 3 banked-FT regression checks (seed 2 relaxes hits/never raises them, no hit while free slots remain unused, seed 5 caps frees at 5/GW). Tests: 339 passed, 0 failed.) · v5.17.6 (Fix: the engine over-projected in-form players — Groß (£5.9m MID) showed ~10-11 xP/GW and was recommended captain + Triple Captain every single week, above Haaland. Root cause: `VG.computePlayerGWProjection` never pinned `VG._projGW`, so every per-GW projection feeding captaincy / chips / per-GW picks / lineups / briefing silently ran as **GW1** — `dataConfidence` crushed to 0.30 AND the 50/50 `ep_next` level anchor applied (Groß's FPL `ep_next` is 15.5) — while the horizon table (`computeMultiGWXP`, which DOES pin the gate) showed ~5.7. The two paths now pin identically and agree exactly (Groß GW6 10.3→5.0, GW7 11.1→6.8, GW8 10.1→4.6). Result: TC correctly declines ("No DGW trigger") and Groß leads only GW5, with Haaland/Saka leading GW6-10. `computePlayerGWProjection` and `predictedLineups` now save/pin/restore `VG._projGW`. Also fixed a real NaN: negative `form` values (Cash -0.5, Reinildo -1.0) hit `Math.pow(negative, 0.7)` = NaN — clamped to `Math.max(form, 0)`. Tests: relaxed the stale `>500 active` threshold (487 mid-season) and made the forced-transfers check data-robust (the squad now carries 3 injuries vs a 2-FT cap); these 4 were already red on `origin/main` from the refreshed bot data. Tests: 336 passed, 0 failed.) · v5.17.5 (Fix: chip cards could claim a "Double Gameweek" that didn't exist. The TC tip was hardcoded to "Double Gameweek captain, high ceiling play" and the FH tip to "Blank Gameweek", both shown whenever the chip was recommended - even when the trigger was the non-DGW single-fixture exception. Tips and the reason string now reflect the real fixture count: reason marks `(DGW!)` vs `(single fixture)`, and the "Double Gameweek" wording only appears when a genuine double exists. Tests: 336 passed, 0 failed.) · v5.17.4 (Fix: the Chip Opportunity Timeline highlighted no GW — every week showed the same captain line, so a chip recommendation like Triple Captain looked like it applied everywhere (including non-target GWs). The timeline now collects the `bestGW` of every currently-recommended chip and highlights ONLY that week with a green glow + `PLAY` tag, visually anchoring the recommendation to its specific GW — e.g. TC "Best: GW6" (Saka vs LEE, FDR 2), not GW3-Chelsea. Tests: two data-dependent checks were made deterministic with synthetic players (a one-game DEF hauler id 999991 and an established FWD id 999992) instead of live-data searches that could find no fixture — 332 passed, 0 failed.) · v5.17.3 (Fix: the FPL picks API returns only element/position/multiplier — NO `now_cost`/`selling_price`/`web_name`. The transfer optimizer reads `sp.selling_price`/`sp.now_cost` to compute affordability, so with raw picks `cPrice` collapsed to 0 and the forced-replacement filter `p.price <= 0 + bank + 0.1` could never find a real replacement — forced transfers silently vanished (the user's "no transfers shown" bug, masked by a diag that pre-enriched picks). `buildFromSquad` now enriches each pick with `web_name`/`now_cost`/`selling_price` from `VG.players[element]` before calling `optimizeTransfers`. Regression: "forced transfers survive element-only picks after price enrichment". v5.17.2 added the 404-picks fallback to the last published squad via `buildFromSquad` + `fallbackGW`/`planningForGW` fields + a blue notice banner. v5.17.1 fixed forced transfers for players absent from allXP by building a bootstrap stub — `computeAllXP` excludes status !== "a"/"d", so injured/left-league players were invisible to the optimizer; Phase 0 now forces their replacement with an "OUT → IN" warning.)
- **v5.16.0 shipped** — the "GW1 45-pointer" post-mortem. The user's draft scored 45 vs 131 (rank 5.8M). Root cause: the 2026-27 season reset left every player with 0–1 games, and the engine had NO small-sample protection — a one-game hauler (De Cuyper: 1 goal, 1 assist, 1 CS in 77 mins) extrapolated to 1.72 xG/90, hit the 0.85 goal-prob cap every fixture and projected 47 xP (#1) while Haaland (0.74 xG, 0 goals) ranked 118th at 3.2 xP. The draft then captained Dasilva (rank 237). Fixes:
  1. **Bayesian shrinkage everywhere** (see Engine Model above) — per-90, per-game, DEFCON, start-rate all regress toward positional priors by sample size.
  2. **Positional goal/assist caps** replace the global 0.85.
  3. **CS weighted-average** (not additive) + 0.55 cap — GKs were earning 2.8 xP/fixture from clean sheets alone.
  4. **rateConf vs confidenceMult split** — output rates get a gentle 0.80–1.00 confidence curve; minutes keep the strong 0.50–1.00 regression.
  5. **Early-season ep_next level anchor** — GW1–3 50/50, GW4–5 35/65 (established players).
  6. **Captain-ceiling bonus reinstated** (FWD ≥£8.5m 1.15x, MID ≥£8.5m 1.18x) — documented but lost in a refactor.
  7. **Sub-cameo priors** — featured-but-never-started = bench option (0.30 prior), unknown = 0.12; a scoring sub cameo can't read as a 45%-starter, and a 1-minute DEFCON cameo can't earn "certain" 2-pointers.
  - **Validated**: GW1 backtest vs real results — correlation 0.413, projected top-10 all legitimately ownable (Haaland/Raya/Bruno/Saka/Palmer/Gabriel), top-50 projected ∩ top-50 actual = 17 (GW1 haulers are inherently unpredictable). Draft now: Haaland (C), Palmer, Bruno, Gabriel, Raya + value enablers — and its value picks included GW1 haulers De Cuyper (17) and Kayode (13).
  - **Encoding gotcha that bit us**: `Get-Content` + `Set-Content -Encoding UTF8` in PowerShell 5.1 double-encodes every non-ASCII char (read defaults to ANSI). Never rewrite app.js via PS pipes — use the Edit tool, or read with `-Encoding UTF8`.
  - Tests: 300 → 307 (small-sample regression tests: hauler cap, 1/1 starter minutes, sub-cameo bench-level, DEFCON cameo, GK CS cap, ceiling bonus).
- **Previous versions**: v5.15.0 full-codebase correctness review (DEFCON double-count, congestion id-lookup, BGW detection, chip hint, live double-count, allXP mutation, rank endpoint; AGENTS.md restructured stable-first for prompt caching) · v5.14.0 pre-GW1 robustness (congestion, three-phase confidence, deadline countdown, VC discount, efficiency score, position home boost) · v5.13.0 transfer + foreign-signing awareness · v5.12.0 Briefing tab, lineups, CS outlook, scatter · v5.11.0 transport/UI module split · v5.10.0 Elo layer · v5.9.0 domain/design/copy pass · v5.8.0 recency windows, watchlist, What-If, Rate My Team · v5.7.0 race simulator · v5.6.0 profiles, rank, news, chip calendar · v5.5.0 EO, MC distribution, planner, set pieces · v5.4.0 Understat enrichment · v5.3.0 live GW + smart captaincy.
- **Next model TODO**: rerun `node tools/backtest.js 1 <lastGW>` each week to track the model; look at the £6.5-8.5m under-projection; then the planned FPL userscript (Tampermonkey, like the user's Planetarium Manager "PM Copilot") that runs inside the user's logged-in FPL session.
