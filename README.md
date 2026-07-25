# VibeGaffer v5.1

**FPL Optimization Engine** | Powered by [Astraiva](https://astraiva.com) | Author: Tushant Sharma

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
│  bootstrap.json (514 players) + fixtures.json (380)   │
│  Auto-updated every 15 min by GitHub Actions           │
└──────────────────┬───────────────────────────────────┘
                   │ fetched from
┌──────────────────┴───────────────────────────────────┐
│           FPL Official API (fantasy.premierleague.com) │
│  bootstrap-static/ + fixtures/ + user squad endpoints  │
└──────────────────────────────────────────────────────┘
```

### Data Pipeline

1. **GitHub Actions** (`fetch-data.yml`) runs every 15 minutes via cron
2. Fetches `bootstrap-static/` (player data) and `fixtures/` from FPL API
3. Falls back to CORS proxies if direct fetch fails
4. Commits JSON to `docs/data/` on `main` branch
5. Static app reads local same-origin JSON — zero CORS issues

### Why Static?

The original architecture was Python Backend (FastAPI) + Streamlit Frontend. It was replaced with a pure static app because:
- GitHub Pages is free with zero maintenance
- No CORS issues (same-origin JSON reads)
- No server to keep alive
- Instant load times
- The FPL API is public and doesn't require auth for read access

---

## Features (v5.1)

### Squad Optimization (5-Phase Greedy + Local Search, Injury-Aware)

| Phase | What It Does |
|-------|-------------|
| 1a | Premium seeding — locks top-3 xP/price players per position |
| 1b | Global value-sorted fill — fills remaining slots by xP/price |
| 2 | Cheapest filler — fills bench with minimum-cost starters |
| 3 | Upgrade pass — iteratively swaps worst player for best affordable upgrade |
| 4 | Cross-position rebalancing — paired swaps across positions |
| 5 | Local search — 50 random swaps with simulated annealing to escape local optima |

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

### Dynamic Strategy Tab

Personalized tips generated from actual squad data:
- Captain contribution analysis
- Injury/doubtful count with WC trigger advice
- Hard fixture count with strategic recommendation
- Budget analysis
- Chip opportunity callouts
- Missing template player warning

### Other Features

- **Price Change Predictor**: Net transfer activity for risers/fallers
- **Fixture Swing Analysis**: Easy/hard run detection across 20 teams
- **Championship Tips**: Static tips from FPL champions (Ibsen, Budisin, Labakk)
- **Full Squad xP Breakdown**: Click-to-expand bar chart per player

---

## Setup

- **Odds API** (optional): Add `ODDS_API_KEY` as a GitHub Actions repository secret from https://the-odds-api.com (free tier: 500 req/month). The odds workflow checks every 6h but only fetches when the next GW deadline is within 30h (~38 calls/season). Without it, the app works fine but without odds adjustments.

---

## File Structure

```
VibeGaffer/
├── README.md                           # This file
├── .github/workflows/fetch-data.yml    # Cron job: fetch FPL data every 15 min
├── docs/                               # GitHub Pages root (deployed)
│   ├── index.html                      # Main HTML (737 lines)
│   ├── app.js                          # Core engine (1875 lines)
│   ├── style.css                       # All styles (275 lines)
│   ├── .nojekyll                       # Prevents Jekyll processing
│   └── data/
│       ├── bootstrap.json              # Player data (514 active players)
│       └── fixtures.json               # 380 fixtures with FDR
├── app.py                              # Original Python Streamlit (not used)
├── backend.py                          # Original FastAPI backend (not used)
├── data_loader.py                      # Original data loader (not used)
├── xp_engine.py                        # Original xP engine (not used)
├── optimizer.py                        # Original optimizer (not used)
├── Dockerfile                          # Original Docker config (not used)
├── docker-compose.yml                  # Original Docker config (not used)
├── requirements.txt                    # Original Python deps (not used)
└── .gitignore
```

**Note**: The Python files (`app.py`, `backend.py`, etc.) are from the original architecture and are kept in the repo but not used in deployment. The live app is the static `docs/` directory.

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
node test_v5.js  # Requires bootstrap.json and fixtures.json in docs/data/
```

---

## Testing

Tests are in `C:\Users\Tushant\AppData\Local\Temp\opencode\test_v5.js` (local only). Run with:

```bash
node test_v5.js
```

**41/42 tests pass** (1 expected: backup GKs with 0 starts have low xP).

Test coverage:
- Optimizer: squad size, formation validity, captain, budget
- Multi-strategy: all 3 strategies produce valid squads
- Transfer optimizer: break-even analysis, hit details
- Captain rotation: 5 GWs, top-3 sorted by xP
- Transfer planner: 5-GW schedule, summary, edge cases
- League analyzer: null/bad input handling
- Chips: all 4 chips, gwScores
- Dynamic tips: analysis, captain, static sections
- xpComponents: all 8 fields, sum matches totalXP
- Reverse maps: GK/DEF/MID/FWD mapping
- Edge cases: empty squads, missing fixtures
- xP engine accuracy: Haaland xP, GK xP
- Transfer roadmap: per-GW fixture grid, recommendations
- Chips: all 4 chips evaluated, gwScores populated
- Dynamic tips: personalized analysis generated
- xpComponents: all 8 fields, sum matches totalXP
- Edge cases: empty squad, empty fixtures

---

## Current Results (v5.0, preseason data)

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
| v5.1 | — | Injury-aware optimizer, multi-week transfer planner, league analyzer |
| v5.1 | — | Injury-aware optimizer, ILP solver (HiGHS WASM), bookmaker odds, transfer planner, league analyzer |
| v5.0 | `c6cc293` | Bug fixes, pos-badge CSS, edge case guards |
| v4.3 | `39c86c0` | Captain rotation planner, chip timeline, dynamic strategy tab |
| v4.2 | `78d9588` | xpComponents in Compare tab, transfer roadmap |
| v4.1 | `f47ad3a` | Phase 5 local search, transfer break-even |
| v4.0 | `f0983b6` | Core xP engine overhaul (8 improvements) |

---

## Known Limitations

1. **ILP solver WASM**: HiGHS WASM is ~4MB, loaded from CDN on first optimization. Falls back to greedy if CDN unavailable.
2. **Pre-season data**: All team strengths are 0, form is 0.0 — fallback estimates used.
3. **Bookmaker odds**: Requires `ODDS_API_KEY` secret in GitHub Actions (The-Odds-API free tier, 500 req/month). Without key, app works fine without odds.
4. **Python files are dead code**: `app.py`, `backend.py`, `data_loader.py`, `xp_engine.py`, `optimizer.py` from old architecture.

---

## TODO (Remaining Improvements)

- [x] ~~Injury/suspension data integration~~ (v5.1: all optimizer phases filter injured players)
- [x] ~~Multi-week transfer planning with hit optimization~~ (v5.1: computeTransferPlan)
- [x] ~~League analyzer~~ (v5.1: analyzeLeague with ownership analysis)
- [x] ~~Team-specific minutes/rotation model~~ (v5.1: start-rate model with sub risk + confidence regression)
- [x] ~~Exponential form weighting~~ (v5.1: hot streaks 1.3x power, cold 0.7x power)
- [x] ~~ILP solver (PuLP/HiGHS via WebAssembly)~~ (v5.1: highs-js from CDN, falls back to greedy)
- [x] ~~Bookmaker odds integration~~ (v5.1: The-Odds-API via GitHub Actions → odds.json, adjusts xP engine)

---

## Metadata

- **Application**: VibeGaffer v5.1
- **Company**: Astraiva
- **Author**: Tushant Sharma
- **License**: Proprietary
- **Live URL**: https://jadax.github.io/VibeGaffer/
- **GitHub**: https://github.com/Jadax/VibeGaffer
- **Last Updated**: July 2026
