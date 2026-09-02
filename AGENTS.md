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

## Golden Rules (violations cause real bugs)

1. **Never reimplement shared helpers.** Use: `VG.esc`, `VG.isAvailable`, `VG.fixtureFDR`, `VG.fixtureInfo`, `VG.teamFixtures`, `VG.fixturesForGW`, `VG.teamFixtureRow`, `VG.pickBestXI`, `VG.formationLegal`, `VG.countUnavailable`, `VG.hasPlayed`, `VG.topCaptainCandidates`, `VG.playerName`, `VG.fdrColor`, `VG.teamColor`, `VG.hasFitnessFlag`, `VG.setPieceBadge`, `VG._mcLambdas`, `VG._mcDrawTotal`, `VG._percentile`, `VG.transferInfo`, `VG.transferBadge`, `VG.foreignLeagueLabel`, `VG.congestionMultiplier`, `VG.predictPriceChanges`.
2. **Escape everything API-derived before `innerHTML`.** `VG.esc()` is the XSS defence (league/manager names are controlled by other FPL users). Script CSP is strict; UI actions are delegated `data-action` attributes.
3. **All optimizer/selection code must filter injuries** via `VG.isAvailable(p)`. Doubtful players stay eligible but are flagged.
4. **When changing a function signature, update every call site** — grep `VG.functionName(` across `app.js`, `ui.js`, `data.js`, `tests/run.js`.
5. **Single sources of truth**: prices → `VG.predictPriceChanges`; per-player fixture lookup → `VG.fixtureInfo`. Never add a second one.
6. **`allXP` is xP-sorted and shared.** Never sort it in place (Differentials quartile math + watchlist pool depend on the order) — sort a copy: `[...allXP].sort(...)`.
7. **Run `node -c docs/app.js` (and ui.js/data.js) + `npm test` after every change.** Browser smoke (`python -m http.server` + tab check) for UI changes.
8. **When editing ui.js, re-read the surrounding function before saving** — a past edit dropped the `const sel = ...` line of `renderComparison` and broke it. Verify brace balance with `node -c`.

## Engine Model (what the numbers mean)

- **xP engine** (`computeFixtureXP`): per-fixture — position-specific team strength vs opponent, FPL per-90 rates blended with Understat priors (60/40), BPS bonus, ICT, form multiplier (ep_next + value_form, exponential 1.3x hot / 0.7x cold), DEFCON at face value (`2 × P(reach threshold)` — do NOT multiply twice), captain ceiling bonus (FWD ≥£8.5m 1.15x, premium MID ≥£8.5m 1.18x), odds/forecast adjustment (0.88–1.20x), set-piece boosts, home boost by position (DEF 1.18 / MID-FWD 1.15 / GK 1.12), transfer context (`newClubMult` clamp 0.80–1.20 × `transferConf` 0.92).
- **Small-sample robustness (v5.16 — the GW1 45-pointer fix)**: every season-aggregate rate is Bayesian-shrunk toward a positional prior — per-90 xG/xA (K=12 nineties; DEF 0.08/0.07, MID 0.15/0.18, FWD 0.40/0.15), per-game CS/bonus/saves/cards (K=10 games), DEFCON per-90 (K=4; DEF 9.0, MID 6.0). Start-rate shrinks toward a role prior (started 0.72 / featured-benched 0.30 / unknown 0.12, K=15; GK 0.80 K=10). Positional goal/assist caps (DEF 0.35, MID 0.60/0.65, FWD 0.75/0.55) replace the old global 0.85. CS is a weighted average of structural base and observed rate (cap 0.55), NOT additive. Without these, a one-game hauler projected 47 xP while Haaland ranked 118th.
- **Rate vs minutes confidence**: `rateConf = 0.80 + 0.20·dataConfidence` scales OUTPUT rates; the stronger `confidenceMult = 0.5 + 0.5·dataConfidence` regression applies to MINUTES only. Stacking both used to flatten premiums into the pack.
- **Early-season ep_next anchor**: GW1–3 blends `0.50·ep_next + 0.50·model`, GW4–5 `0.35/0.65` (established players only; new signings keep their own 50/50 path). FPL's ep_next is compressed early (everyone 1.5–4.0) but encodes role — it stops one-game noise from ranking a hauler over a premium.
- **Three-phase early season** (`VG._projGW`): `computeMultiGWXP` sets `VG._projGW` per fixture and CLEARS it after the loop. GW1–3: `dataConfidence` ≤ 0.30, blend 40/45/15; GW4–5: ≤ 0.55, 50/35/15; GW6+: uncapped, 60/25/15. Direct `computeFixtureXP` calls with `_projGW` unset run as GW1 — pin `VG._projGW` in tests that assert exact ratios (low confidence activates an additive league-average term in projGoals/projAssists).
- **Congestion** (`VG.congestionMultiplier`): days since previous PL fixture (`VG.fixtureGapDays`); <4d → 0.82 heavy-rotator / 0.88 else; <5d → 0.88/0.93; else 1.0. `VG.HEAVY_ROTATORS` holds **short_name codes** (MCI/ARS/LIV/CHE/AVL/TOT/BHA/NEW) — the function resolves numeric team ids through `VG.teams`.
- **Minutes model**: start-rate from last season (GK binary 95%/15–75%; outfield `startRate × (1 − subRisk)`), regressed toward 72% league average by confidence; recent-form last-5 starts rate blended in when `recentForm.gws5 >= 2` (starts ÷ games on record, capped at 5).
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

- **Current version**: v5.17.3 (Fix: the FPL picks API returns only element/position/multiplier — NO `now_cost`/`selling_price`/`web_name`. The transfer optimizer reads `sp.selling_price`/`sp.now_cost` to compute affordability, so with raw picks `cPrice` collapsed to 0 and the forced-replacement filter `p.price <= 0 + bank + 0.1` could never find a real replacement — forced transfers silently vanished (the user's "no transfers shown" bug, masked by a diag that pre-enriched picks). `buildFromSquad` now enriches each pick with `web_name`/`now_cost`/`selling_price` from `VG.players[element]` before calling `optimizeTransfers`. Regression: "forced transfers survive element-only picks after price enrichment". v5.17.2 added the 404-picks fallback to the last published squad via `buildFromSquad` + `fallbackGW`/`planningForGW` fields + a blue notice banner. v5.17.1 fixed forced transfers for players absent from allXP by building a bootstrap stub — `computeAllXP` excludes status !== "a"/"d", so injured/left-league players were invisible to the optimizer; Phase 0 now forces their replacement with an "OUT → IN" warning.)
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
- **Next model TODO**: keep workflows green; re-check `docs/data/*.json` after GW1 finishes (recency windows activate at 2+ GWs); update this Handover on the next release.
