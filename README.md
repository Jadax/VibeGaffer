# VibeGaffer v5.8.1

**FPL Optimization Engine** | Author: Tushant Sharma

Live: https://jadax.github.io/VibeGaffer/

---

## What It Does

VibeGaffer generates production-ready Fantasy Premier League squad recommendations. It ingests data from the official FPL API, projects expected points (xP) using a mathematical model, and optimizes 15-player squads under budget and team constraints.

### Modes

| Mode | Trigger | What It Does |
|------|---------|-------------|
| **Draft Builder** | GW1 or no Team ID | Builds a full 15-player squad from scratch under £100m |
| **Transfer Advisor** | Valid FPL Team ID + GW2+ | Recommends transfers with break-even analysis over 5-GW horizon |

---

## Architecture

This is a **pure static web app** deployed on GitHub Pages. Zero backend, zero CORS, zero server costs.

```
┌──────────────────────────────────────────────────────┐
│                    GitHub Pages                        │
│  docs/index.html  +  docs/app.js  +  docs/style.css   │
│  Pure HTML/CSS/JS — no build step, no framework       │
└──────────────────┬───────────────────────────────────┘
                   │ reads local JSON
┌──────────────────┴───────────────────────────────────┐
│                  docs/data/*.json                      │
│  bootstrap.json (~560 players) + fixtures.json (380)  │
│  understat.json (xG/xA + forecasts) + odds.json       │
│  Auto-updated on a deadline-aware GitHub Actions       │
│  schedule + weekly Understat/priors fetch              │
└──────────────────┬───────────────────────────────────┘
                   │ fetched from
┌──────────────────┴───────────────────────────────────┐
│    Free public sources (no key required)              │
│  FPL API · Understat · vaastav · optional Odds API   │
└──────────────────────────────────────────────────────┘
```

### Data Pipeline

1. **GitHub Actions** (`fetch-data.yml`) runs on a deadline-aware schedule: every 30 min inside the 6h before a deadline, 2-hourly within 36h, 6-hourly otherwise
2. Fetches `bootstrap-static/` (player data) and `fixtures/` from FPL API
3. Falls back to CORS proxies if direct fetch fails
4. Commits JSON to `docs/data/` on `main` branch
5. Static app reads local same-origin JSON — zero CORS issues
6. **Weekly** `fetch-understat.yml` pulls free Understat player xG/xA priors, team npxG/pressing stats, and per-fixture w/d/l forecasts; `fetch-history-priors.yml` reduces the public vaastav FPL dataset to the fields needed for players whose official current-season history is missing. Official FPL data always takes precedence.

### Why Static?

The original architecture was Python Backend (FastAPI) + Streamlit Frontend. It was removed in v5.3.0. The static app replaced it because:
- GitHub Pages is free with zero maintenance
- No CORS issues (same-origin JSON reads)
- No server to keep alive
- Instant load times
- The FPL API is public and doesn't require auth for read access

---

## Features (v5.8.1)

### Squad Optimization (ILP + Deterministic Greedy Fallback, Injury-Aware)

| Phase | What It Does |
|-------|-------------|
| 1a | Premium seeding — locks top-3 xP/price players per position |
| 1b | Global value-sorted fill — fills remaining slots by xP/price |
| 2 | Cheapest filler — fills bench with minimum-cost starters |
| 3 | Upgrade pass — iteratively swaps worst player for best affordable upgrade |
| 4 | Cross-position rebalancing — paired swaps across positions |
| 5 | Deterministic local search — repeatedly applies the best affordable improving swap |

All phases filter out injured/suspended/unavailable players (`status !== 'a' && status !== 'd'`).

### ILP Solver (v5.1)

Globally optimal squad via HiGHS WebAssembly solver:
- Loads `highs-js` from CDN (no build step, ~4MB WASM)
- Generates CPLEX .lp format: binary variables for each player, maximize xP
- Constraints: 15 players, position counts, budget ≤ £100m, max 3 per team
- Falls back to greedy optimizer if WASM fails to load
- Produces provably optimal solution (vs greedy's local optimum)

### Multi-Strategy Optimizer

Three strategies run simultaneously, best wins:

| Strategy | Approach |
|----------|----------|
| **Balanced** | Maximize total xP within budget |
| **Premium Heavy** | Stack elite players (1.3x totalXP weight), accept weaker bench |
| **Best Value** | Cap at £8m, maximize xP/£m |

### xP Engine (v4.0)

Position-specific, opponent-aware, multi-signal expected points projection:

- **Position-specific team strength**: Attackers face attack difficulty, defenders face defense difficulty
- **Opponent defense wiring**: CS probability and goal probability adjusted by opponent's actual defensive record
- **FPL pre-computed rates**: Uses `expected_goals_per_90`, `expected_assists_per_90` from API
- **BPS for bonus**: Raw Bonus Points System score as primary bonus predictor
- **Position-specific ICT**: GK/DEF use influence; MID uses influence+creativity; FWD uses threat+creativity
- **Enhanced form**: Blends form/ppg trend (60%) + FPL ep_next (25%) + value_form (15%)
- **Exponential form weighting**: Hot streaks amplified (1.3x power), cold streaks dampened (0.7x power)
- **DEFCON calibration**: Defensive contributions calibrated to real 2025/26 data (CBs ~1.4 pts/game)
- **Captain ceiling bonus**: FWD 1.15x, premium MID 1.18x, budget MID 1.08x
- **Home advantage**: 1.15x multiplier
- **Bookmaker odds adjustment** (v5.1): Implied win probabilities from 1X2 odds boost favorite attack (0.88-1.20x), penalize underdog defense, adjust clean sheet probability based on expected scoring

### Captain Rotation Planner

Table showing top 3 captain candidates for each GW in the horizon with:
- xP values, opponent name, venue (H/A), FDR color-coded (green=easy, red=hard)
- DGW markers on double gameweeks

### Transfer Optimizer

- **Break-even analysis**: Shows how many GWs until a hit pays for itself (ceil(4/gwAvgGain))
- **Hit threshold**: Only recommends hits if break-even is within horizon AND avg gain >= 1.5 pts/GW
- **Per-transfer details**: Shows break-even GWs and average gain per transfer

### Transfer Roadmap

Per-GW fixture grid for the full squad:
- Color-coded FDR cells (green=FDR<=2, red=FDR>=4)
- Automated swap suggestions for hard-fixture players (FDR>=4)
- Shows replacement name, fixture, price, and xP gain

### Multi-Week Transfer Planner (v5.1)

Week-by-week transfer schedule optimized across the full GW horizon:
- Identifies weakest starters per GW (bottom 4 by xP)
- Finds replacements that improve cumulative xP across remaining GWs
- Only recommends hits if cumulative gain exceeds 4 pts (hit cost)
- Summary: total squad xP, transfers made, hits taken, net gain

### Mini-League Analyzer (v5.1)

Compare your squad vs rivals in a classic league:
- Fetches top 10 teams from FPL API league endpoint
- Ownership analysis: template players (≥30%), differentials (<20%), outliers
- Your differentials: low-owned picks unique to your squad
- Missing popular picks: players you don't have but league leaders do
- Standings table with GW points, total points, captain choices

### Race to the Top (v5.7.0)

Monte Carlo win-probability simulator for your mini-league, built on data the League Analyzer already fetches:
- Samples this GW's score (Poisson per player, captain doubled) for every fetched squad, 1,500 draws
- Adds each draw to that manager's season total-to-date and ranks across iterations
- Reports P(finish 1st this GW) and P(top 3), plus a floor–ceiling projection per squad
- Flags your row and names your closest rival by win probability
- Enter your FPL Team ID to see your own numbers; without it, shows the race among the fetched top 10 anyway

### Recency-Weighted Rotation Risk (v5.7.0)

Season-total starts can't tell "nailed for the last 5 GWs" apart from "started well in September, benched since" — both carry the same season aggregate. A weekly-refreshed last-5-gameweek starts/minutes signal (from FPL's own per-player history endpoint) now blends into the minutes-probability model, weighted more heavily than the season total. Fully optional and additive — absent (e.g. pre-season, before GW1), the engine behaves exactly as before.

### Recency-Weighted Projections + xMins (v5.8.0)

The "massive-model-lite" upgrade (a lite, no-ML version of FPL Review's Massive Data Model / OpenFPL arXiv 2508.09992): recency beats season aggregates. When per-round history is on hand, the engine:
- **1/3/5-round windows** — the daily recent-form fetcher now emits per-player windows over the last 1, 3 and 5 GWs (starts, minutes, points, xGI, BPS) plus a confidence-scaled blend weight
- **Recency-weighted projection** — the per-90 goals/assists prior is nudged toward the player's last-3-GW xGI rate (clamped 0.70–1.40), and the recent starts rate feeds the minutes probability — so a player in red-hot form is no longer averaged back to their season mean
- **xMins** — expected minutes per fixture (mins-prob × 90), surfaced in Compare, Differentials, Player Profile and Rate My Team
- **New-to-PL handling** — players with no Premier League history get a visible `NEW TO PL · FPL PRIOR/UNDERSTAT PRIOR` badge and a stronger FPL ep_next prior

### Horizon cap (v5.8.0)

The xP horizon no longer hardcodes 12 GWs. Options are built from the GWs actually left in the season (defaulting to min(12, remaining)), and the engine clamps internally, so near the season's end you never project into weeks that don't exist or over-inflate the pre-season fallback.

### Watchlist, Buy/Hold/Sell, Rate My Team, What-If, Full-Season Planner (v5.8.0)

- **Watchlist** — a localStorage-backed list of players you're monitoring, with live xP/value/recency/market signals, quick-add dropdown, and ☆ toggles in the Compare/Differentials tables
- **Buy/Hold/Sell tags** — a classifier (recency + xG regression + ownership + value) labels what to do with a player in Compare, Differentials and the Player Profile
- **Rate My Team** — a transparent, component-scored team rating (xP strength / rotation risk / formation / budget / captaincy) with a letter grade and actionable advice on the Squad tab
- **What-If race scenarios** — in the League tab, test a transfer or captaincy change against your real rivals; rivals' scores are drawn once and reused, so the win-probability delta is attributable to the change alone
- **Full-season fixture planner** — every team × every GW, colour-coded FDR cells with DGW/BGW markers, in the Fixtures tab

### Chip Strategy

| Chip | Evaluation Logic |
|------|-----------------|
| **Triple Captain** | DGW captain xP * 2.5 multiplier; penalized 0.15x on single GW |
| **Bench Boost** | Only on DGW when 2+ bench players also have doubles |
| **Wildcard** | Triggered by 4+ injuries or 8+ tough fixtures |
| **Free Hit** | BGW detection with blanking team count |

Chip Opportunity Timeline: visual bar chart per GW showing TC/BB/WC/FH scores.

### Player Comparison

- **Radar chart**: xP component breakdown (Appearance, CS, Goals, Assists, Bonus, DEFCON, Saves)
- **Stacked bar chart**: Side-by-side xP composition comparison
- **Table**: Per-component xP values

### Differentials

- Filters for non-GK players with ownership <= 10% and xP >= 25th percentile
- Ownership-weighted scoring: xP * trend * (1 - ownership/50)
- **Differential Matrix (v5.3)**: 4-zone classification per pick — Gold (low owned, high xP/£m), Anchor (template, high value), Wait (low owned, weak value), Trap (popular, weak value)

### Live Gameweek Intelligence (v5.3)

Streams the in-progress gameweek from the FPL `/event/{gw}/live/` endpoint:
- **Live points** from authoritative `explain` blocks (pre-bonus)
- **Bonus projections** from live BPS with official tie-break rules (tied 1st → 3-3-1, tied 2nd → 3-2-2)
- **Auto-sub simulation** — bench-order substitutions that keep the formation legal (GK≥1, DEF≥3, MID≥2, FWD≥1)
- **Price-change velocity** — risers/fallers from net transfer activity (single classifier, classic ~10.5k rise threshold)
- **Your team panel** (when a Team ID is set) — live points × multiplier, captain bonus, sub-risk flags
- Auto-refreshes every 5 minutes while the GW is in progress

### Smart Captaincy (v5.3)

The "Why This Captain?" panel now includes:
- **Blank probability** — P(fails to play 60+ mins) from starts/minutes history, status (doubtful/unavailable), the FPL `chance_of_playing_next_round` fitness flag, away-vs-strong-side signal, and card risk
- **Vice-captain insurance EV** — ~1.4 points of expected value per 10% captain-blank probability

### Dynamic Strategy Tab

Personalized tips generated from actual squad data:
- Captain contribution analysis
- Injury/doubtful count with WC trigger advice
- Hard fixture count with strategic recommendation
- Budget analysis
- Chip opportunity callouts
- Missing template player warning
- **Injury & Availability Watch (v5.4)**: fitness/news feed of `chance_of_playing_next_round` flags + injury strings across the player pool

### Understat xG Enrichment (v5.4)

Free Understat data powers a second, independent xG signal and the no-key odds layer:
- **Understat forecast odds** — per-fixture w/d/l probabilities feed the xP engine (replaces The-Odds-API when the key is unset)
- **Real xG / xA** — Understat priors blended 60% FPL + 40% Understat into xP, exposed as new columns in Compare and Differentials tabs
- **Team Strength Ratings** — Understat npxG/npxGA → attack/defence/overall indices (100 = league average), 1-20 ranks, 1-5 rating in the Fixtures tab
- **xG Regression Flags** — Understat xG vs actual FPL goals → green **DUE** badges (underperforming their xG, goals should come) and red **OVER** badges (running hot, likely to regress) in Compare + Differentials tabs
- **Effective Ownership (v5.5)** — ownership weighted by modelled captain-share (FFix/FPL Review idea); a sharper TEMPLATE vs DIFFERENTIAL signal than raw ownership, shown in Compare + Differentials
- **Monte Carlo GW Projection (v5.5)** — samples the starting XI's points (captain doubled) for a real points distribution; Squad tab shows mean ± SD and a 90% band (FPL Review/FFix idea)
- **DGW/BGW Season Planner (v5.5)** — Ben Crellin-style calendar that flags double/blank gameweeks and chip windows automatically when postponements create them (Fixtures tab)
- **Set-Piece Takers (v5.5)** — bundled `setpieces.json` boosts xP for penalty/FK/corner takers (FFHUB/FFS idea); "P/F/C" badges in Compare + Differentials
- **Transfer Rank-Impact (v5.5)** — maps a transfer's xP gain to an approximate overall-rank move (FFHub AI idea)
- **Player Profile (v5.6)** — click any Squad player to expand a rich profile: form trend, Understat xG/90, xG regression, Effective Ownership, set-piece role, value, next-5-fixture run with easy/hard quality
- **Live Rank tracker (v5.6)** — enter your FPL Team ID and see your actual Overall Rank + GW points, auto-refreshing (LiveFPL/FFHub idea)
- **Team News feed (v5.6)** — injury/fitness flags and news strings grouped by club in the Strategy tab, complementing the availability watch
- **Chip EV Calendar (v5.6)** — DGW/BGW-aware per-GW chip window scores (TC/BB/FH/WC) for your squad, populated automatically once postponements create doubles/blanks (Ben Crellin idea)

### Other Features

- **Price Change Predictor**: Net transfer activity for risers/fallers (reads the real live-API `transfers_in_event`/`transfers_out_event` fields)
- **Fixture Swing Analysis**: Easy/hard run detection across 20 teams
- **Team Strength Ratings**: Understat xG power table (attack/defence/overall + PPDA) above the fixture ticker (v5.4)
- **Championship Tips**: Static tips from FPL champions (Ibsen, Budisin, Labakk)
- **Full Squad xP Breakdown**: Click-to-expand bar chart per player

---

## Data Sources (intentional — do not remove)

VibeGaffer is deliberately enriched with free public data. These integrations are product decisions, not tech debt — do not remove them:

- **FPL API** (`fantasy.premierleague.com`) — official public read-only endpoint. Primary source.
- **The-Odds-API** — optional bookmaker odds, gated by the `ODDS_API_KEY` repo secret.
- **Understat** (`https://understat.com/getLeagueData/EPL/{season}`) — free player xG/xA/xGChain/xGBuildup, per-match team xG/xGA/npxG/ppda/deep, and `forecast` w/d/l probabilities for every fixture (can replace/backup The-Odds-API). Requires headers: `Referer: https://understat.com/league/EPL`, `User-Agent`, `X-Requested-With: XMLHttpRequest`.
- **FBref** — free Opta-level xG/xA/shot maps (read/aggregate only, no heavy scraping).
- **vaastav/Fantasy-Premier-League** GitHub raw CSVs — historical per-game data consumed weekly by `fetch-history-priors.yml`.
- **LiveFPL / FPL Review / fpl.team** — read-only reference for feature ideas and thresholds (their private data is never consumed).

All sources are public, read-only, and community-licensed. If a source breaks, port the functionality to a similar free source rather than deleting the feature.

### Borrowing Policy (steal ideas + code — intentional)

VibeGaffer explicitly **borrows ideas and patterns from top FPL tools and open-source projects** — this is a learning/enrichment project. This policy is intentional and must be preserved:

- **Ideas are free**: stat concepts, thresholds, and UI patterns (xG regression "due/over" flags, effective ownership, team strength ratings, clean-sheet probabilities, expected-points frameworks) may be copied and re-implemented from LiveFPL, Fantasy Football Hub, FFix, fpl.review, FPL Scout, FPL Review, FPL Vault, FPL Pulse, allaboutfpl, and any public FPL tool or blog — cite inspiration in code comments where feasible.
- **Open-source code is copyable**: permissive-licensed OSS (MIT/Apache/BSD/GPL) FPL analytics may be ported directly in, with attribution.
- **Free/non-official APIs are welcome**: any public read-only, free data source may be integrated via a GitHub Actions fetcher (mirror `fetch-understat.yml`); prefer no-key sources, gate key-requiring ones behind optional repo secrets.
- **Public FPL league data is usable**: other managers' squads/names via FPL league endpoints are fair game (always escaped via `VG.esc`).
- **Do NOT**: scrape behind login walls, bypass ToS/rate limits, or copy proprietary/paywalled content verbatim (e.g. FFScout member projections) — re-implement the idea from public data instead.
- **Do not revert**: a future maintainer must not strip this section, "clean up" borrowed features, or delete the Understat/vaastav/Odds integrations added under it.

## Setup

- **Odds API** (optional): Add `ODDS_API_KEY` as a GitHub Actions repository secret from https://the-odds-api.com (free tier: 500 req/month). The odds workflow checks every 6h but only fetches when the next GW deadline is within 30h (~38 calls/season). Without it, the app works fine but without odds adjustments. The Understat `forecast` data can be used as a free no-key alternative for odds-style adjustments.

---

## File Structure

```
VibeGaffer/
├── README.md                           # This file
├── package.json                        # Version + npm scripts (check, test)
├── .github/workflows/
│   ├── fetch-data.yml                  # Deadline-aware FPL data fetch
│   ├── fetch-understat.yml             # Weekly Understat xG/forecast fetch
│   ├── fetch-history-priors.yml        # Weekly vaastav historical priors
│   ├── fetch-recent-form.yml           # Daily last-5-GW rotation-risk fetch
│   ├── fetch-odds.yml                  # Bookmaker odds (optional, needs secret)
│   └── test.yml                        # CI: node --check + npm test
├── docs/                               # GitHub Pages root (deployed)
│   ├── index.html                      # All UI: 9 tabs, CSP, inline JS (~930 lines)
│   ├── app.js                          # Core engine (~2910 lines)
│   ├── style.css                       # All styles (275 lines)
│   ├── .nojekyll                       # Prevents Jekyll processing
│   └── data/
│       ├── bootstrap.json              # Player data (~560 active players)
│       ├── fixtures.json               # 380 fixtures with FDR
│       ├── understat.json              # Free Understat xG/xA + forecasts
│       ├── setpieces.json              # Set-piece takers (pen/FK/corner; seasonal)
│       └── odds.json                   # Bookmaker odds (optional)
├── tests/run.js                        # Regression suite (136 checks)
└── .gitignore
```

---

## How the xP Engine Works

### Per-Fixture Calculation

For each player + fixture combination:

1. **Mins probability**: Start-rate model using last season data (GK: nailed/backup binary, outfield: startRate * (1 - subRisk)), confidence regression toward league average
2. **Clean sheet probability**: `baseCS[pos] * defMult * defStrMult * csPer90 * oppDefFactor`
3. **Goal probability**: `baseGoals[pos] * attackMult * attStrMult * goalsPer90 * oppDefFactor`
4. **Assist probability**: `baseAssists[pos] * attackMult * creativity * assistsPer90 * oppDefFactor`
5. **Bonus probability**: `BPSweight * bonusPer90 * minsProb`
6. **DEFCON**: `defConPer90 * mins/90 * defMult * teamStr`
7. **Captain ceiling bonus**: FWD 1.15x, premium MID 1.18x, budget MID 1.08x

### Multi-GW Aggregation

`totalXP = sum(fixtureXP for each GW in horizon)`

### Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| APPEARANCE_PTS | 2 | Points per appearance |
| CS_PTS | {GK:4, DEF:4, MID:1, FWD:0} | Clean sheet bonus |
| GOAL_PTS | {GK:10, DEF:6, MID:5, FWD:4} | Goal bonus |
| ASSIST_PTS | 3 | Assist bonus |

---

## How to Run Locally

### Static App (Current)

Just open `docs/index.html` in a browser. The data files are already in `docs/data/`.

To update data manually:
```bash
curl -o docs/data/bootstrap.json "https://fantasy.premierleague.com/api/bootstrap-static/"
curl -o docs/data/fixtures.json "https://fantasy.premierleague.com/api/fixtures/"
```

### Test the Engine

```bash
npm test
```

---

## Testing

Tests are committed in `tests/run.js` and run automatically in GitHub Actions. Run locally with:

```bash
npm test
```

**136/136 tests pass.**

Test coverage:
- Optimizer: squad size, formation validity, captain, budget
- Multi-strategy: all 3 strategies produce valid squads
- Transfer optimizer: break-even analysis, hit details
- Captain rotation: 5 GWs, top-3 sorted by xP
- Transfer planner: 5-GW schedule, summary, edge cases
- League analyzer: null/bad input handling
- Chips: all 4 chips, gwScores
- v5.4: Understat blend, xG regression flags/badges, team strength ratings, shared fixture/team helpers
- v5.5: effective ownership, Monte Carlo GW distribution, DGW/BGW planner, set-piece boost, rank-impact estimate
- v5.6: player profiles, live rank tracker, team news feed, chip EV calendar
- Dynamic tips: analysis, captain, static sections
- xpComponents: all 8 fields, sum matches totalXP
- Reverse maps: GK/DEF/MID/FWD mapping
- Edge cases: empty squads, missing fixtures
- xP engine accuracy: Haaland xP, GK xP
- Transfer roadmap: per-GW fixture grid, recommendations
- Live GW: explain-block points, bonus ties, auto-subs, price velocity (v5.3)
- Captaincy: blank probability, VC EV, reasoning with blank risk (v5.3)
- Differential matrix: all four zones (v5.3)
- Understat: forecast w/d/l, bookmaker fallback, real xG blend, injury feed, team strength ratings (v5.4)

---

## Historical Results Snapshot (v5.0 preseason data)

| Strategy | xP (5 GW) | Formation | Captain |
|----------|-----------|-----------|---------|
| Balanced | ~382 | 5-4-1 | Saka (37.2) |
| Premium | ~375 | 5-4-1 | Saka (37.2) |
| Value | ~380 | 5-4-1 | O'Reilly (38.1) |

**Note**: These numbers reflect preseason data (form=0.0, team strengths all 0). Once the season starts with real match data, xP projections will be significantly more accurate.

---

## Version History

| Version | Commit | Key Changes |
|---------|--------|------------|
| v5.8.1 | — | Post-review fixes on v5.8.0: the League tab's What-If scenario buttons (Make Captain / Transfer In) threw `ReferenceError: el is not defined` on every click and failed silently (no `.catch()` on the async onclick) — `VG.runWhatIf` is a top-level function and can't reach `VG.run`/`preloadTabs`' local `el` closures; fixed to call `document.getElementById` directly. Also fixed a git-push race in three of four secondary data workflows (`fetch-understat.yml`, `fetch-history-priors.yml`, `fetch-odds.yml`, `fetch-recent-form.yml`) that had no retry-on-reject logic, unlike `fetch-data.yml` — caused a real CI failure when two fetchers committed in the same window; all four now retry with `git pull --rebase` |
| v5.8.0 | — | "Massive-model-lite" recency/rotation upgrade + community features: horizon cap (options built from remaining GWs, engine clamps), new-to-PL priors + visible NEW badge, OpenFPL-style 1/3/5-round recency-weighted projections (fetcher now emits s1/s3/s5 windows), xMins surfaced everywhere, Buy/Hold/Sell market tags, localStorage Watchlist (Strategy tab + ☆ toggles), What-If race scenarios (shared rival draws → change-attributable deltas) in League tab, Rate My Team card (Squad tab), full-season FDR planner grid (Fixtures tab) |
| v5.7.0 | — | Mini-League Race Simulator: Monte Carlo win probability (P(1st)/P(top 3)) among fetched league squads for the current GW, built entirely on data VG.analyzeLeague already had (no new API calls); Recency-Weighted Rotation Risk: new fetch-recent-form.yml pulls last-5-GW starts/minutes per player from FPL's own per-player history endpoint, blended into the minutes-probability model (season aggregates alone can't distinguish a player nailed for the last 5 GWs from one benched since September) |
| v5.6.1 | — | Hardening + refactor: fixed a player-profile XSS (unescaped opponent name), removed dead code/params/vars, consolidated shared helpers (`playerName`/`fdrColor`/`hasFitnessFlag`/`setPieceBadge`), removed redundant render init + stray comments, author attribution = Tushant Sharma only |
| v5.6.0 | — | Player Profile (form/xG/EO/set-piece/fixture-run per player), Live Rank tracker (real FPL OR via Team ID), Team News feed grouped by club (Strategy tab), DGW/BGW-aware Chip EV Calendar |
| v5.5.0 | — | Effective Ownership (captain-share-weighted; Compare + Differentials EO column), Monte Carlo GW projection (mean +- SD + 90% band in Squad tab), DGW/BGW Season Planner (Ben Crellin-style, Fixtures tab), Set-Piece Takers xP boost (pen/FK/corner + P/F/C badges; seasonal setpieces.json), transfer rank-impact estimate |
| v5.4.1 | — | Post-review fixes on v5.4.0: escaped the Squad DNA "weaknesses" bullets (inconsistent with the escaped "strengths" bullets next to them), made the Live tab's 5-minute refresh actually recur instead of firing once |
| v5.4.0 | — | Understat forecast odds (free per-fixture w/d/l → xP engine), Real xG/xA columns (60/40 FPL+Understat blend), Injury & Availability Watch (Strategy tab), Team Strength Ratings (npxG/npxGA attack/defence/overall indices + ranks + 1-5 in Fixtures tab), xG regression DUE/OVER badges (Compare + Differentials), weekly Understat + vaastav fetchers, explicit borrowing policy for free FPL ideas/APIs, shared fixture helpers (`fixturesForGW`/`teamFixtureRow`/`teamColor`), TEAM_COLORS keyed by short_name |
| v5.3.0 | — | Live GW tab (live points, bonus projection, auto-sub simulation, price-change velocity), captain blank-risk + VC insurance EV, 4-zone differential matrix, escaped all API-derived HTML (mini-league XSS), SRI + CSP, fixed the HiGHS global so the ILP solver actually runs, horizon-aware pitch xP, compare-by-id, deadline-aware data cron, removed the unused Python/Docker stack, deduped the four XI-selection copies, removed dead params/state, consolidated the two price predictors onto one model (real live-API fields), added shared fixture helpers |
| v5.2.1 | `00bf512` | Correct single-GW lineup/captain projections, DGW detection, strategy routing, exact ILP constraints, deterministic fallback, odds fix, CI tests |
| v5.2 | `498566a` | Lineup intelligence, captain explanations, squad DNA analysis |
| v5.1 | — | Injury-aware optimizer, ILP solver, bookmaker odds, transfer planner, league analyzer |
| v5.0 | `c6cc293` | Bug fixes, pos-badge CSS, edge case guards |
| v4.3 | `39c86c0` | Captain rotation planner, chip timeline, dynamic strategy tab |
| v4.2 | `78d9588` | xpComponents in Compare tab, transfer roadmap |
| v4.1 | `f47ad3a` | Phase 5 local search, transfer break-even |
| v4.0 | `f0983b6` | Core xP engine overhaul (8 improvements) |

---

## Known Limitations

1. **ILP solver WASM**: HiGHS WASM is loaded from CDN on first optimization. Falls back to greedy if the CDN is unavailable or the browser blocks WebAssembly.
2. **Pre-season data**: All team strengths are 0, form is 0.0 — fallback estimates used.
3. **Bookmaker odds**: Requires `ODDS_API_KEY` secret in GitHub Actions (The-Odds-API free tier, 500 req/month). Without key, app works fine without odds.
6. **League race simulator treats squads as independent**: no correlation modelling for rivals who share the same player (a standard first-order approximation for this kind of tool).
7. **Recent-form data lags real minutes by up to a day** and stays empty until each player has at least 2 recorded gameweeks this season (so it's inert through pre-season and GW1).
4. **CSP is weakened by inline handlers**: `script-src` still needs `'unsafe-inline'` because the UI uses inline `onclick=` and a large inline `<script>`. Escaping (`VG.esc`) is the primary XSS defence; the CSP is defence-in-depth.
5. **CORS proxies see user identifiers**: when the FPL API is unreachable directly, requests carrying your team/league ID fall back through `allorigins.win` / `corsproxy.io`.

---

## Remaining Improvements

- Split the monolithic `docs/app.js` and inline UI script into testable modules.
- Replace inline `onclick=` handlers with delegated listeners so the CSP can drop `'unsafe-inline'`.
- Trim `bootstrap.json` to the ~35 fields the engine reads (currently ships 105).
- Move `docs/data/` to its own branch to keep `main` history clean.
- Drop the third-party CORS proxies, or gate them behind explicit user consent.
- Add browser-level smoke tests for the nine UI tabs.
- Research candidates (free-data feasible, borrowed-pattern friendly): effective ownership columns in the transfer planner, mini-league Monte Carlo win-probability (FPL Pulse-style, ~100k sims), Reddit r/FantasyPL sentiment feed, defensive vulnerability fixture ticker.

---

## Metadata

- **Application**: VibeGaffer v5.8.1
- **Author**: Tushant Sharma
- **License**: Proprietary
- **Live URL**: https://jadax.github.io/VibeGaffer/
- **GitHub**: https://github.com/Jadax/VibeGaffer
- **Last Updated**: August 2026
