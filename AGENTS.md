# AGENTS.md — VibeGaffer

This file provides context for AI models working on the VibeGaffer codebase.

## Quick Status

- **Current version**: v5.0 (tagged `v5.0`, commit `c6cc293`)
- **Architecture**: Pure static HTML/CSS/JS on GitHub Pages (no backend)
- **Live URL**: https://jadax.github.io/VibeGaffer/
- **Data**: Auto-fetched every 15 min via GitHub Actions cron → `docs/data/*.json`

## Critical Files

| File | Lines | Purpose |
|------|-------|---------|
| `docs/app.js` | 1703 | All logic: xP engine, optimizer, chips, transfers, roadmap, tips |
| `docs/index.html` | 678 | All UI: tabs, rendering, Chart.js radar/bar, inline JS |
| `docs/style.css` | 275 | All styles |
| `docs/data/bootstrap.json` | ~1.3MB | Player data (514 active, 20 teams) |
| `docs/data/fixtures.json` | ~118KB | 380 fixtures with FDR |
| `.github/workflows/fetch-data.yml` | 61 | Cron job: fetch FPL data every 15 min |

## Architecture Decisions

### Why Static?

Originally Python Backend (FastAPI) + Streamlit Frontend. Replaced with static app because:
- GitHub Pages is free with zero maintenance
- No CORS issues (same-origin JSON reads)
- No server to keep alive
- FPL API is public, no auth needed for reads

### Why No ILP Solver?

The optimizer is a 5-phase greedy algorithm with local search. A proper ILP solver (PuLP/HiGHS) would give globally optimal solutions but requires WebAssembly. The greedy approach produces good results (~382 xP over 5 GWs) in ~65ms.

### xP Engine Design

The xP engine computes per-fixture expected points using:
- Position-specific team strength (attack vs defence, not overall)
- Opponent defense wiring (was computed but unused in v3.x)
- FPL pre-computed per-90 rates (expected_goals_per_90 etc.)
- BPS for bonus prediction
- Position-specific ICT (influence for GK/DEF, creativity+threat for MID/FWD)
- Enhanced form multiplier with ep_next and value_form signals
- DEFCON calibration to real 2025/26 data
- Captain ceiling bonus (FWD 1.15x, premium MID 1.18x)

## Key Functions in app.js

### Data Layer
- `VG.init()` → loads bootstrap + fixtures, calls buildMaps/computeAllXP
- `VG.buildMaps(bootstrap)` → populates VG.players, VG.teams, VG.currentGW
- `VG.computeAllXP(startGW, nGWs, fixtures)` → returns sorted array of all players with totalXP
- `VG.computeFixtureXP(pid, oppTeamId, isHome, fdr)` → single fixture xP with full breakdown
- `VG.computeMultiGWXP(pid, startGW, nGWs, fixtures)` → multi-GW aggregate

### Optimizer
- `VG.optimizeDraft(players, budget, fixtures, startGW, nGWs)` → 5-phase squad builder
- `VG.optimizeStrategies(players, budget, fixtures, startGW, nGWs)` → 3 strategies
- `VG.optimizeTransfers(squad, players, bank, freeTransfers, fixtures, startGW, nGWs)` → transfer recommendations with break-even

### Analysis
- `VG.computeCaptainRotation(squad, allXP, fixtures, startGW, nGWs)` → top 3 captains per GW
- `VG.computeTransferRoadmap(squad, allXP, fixtures, startGW, nGWs)` → per-GW fixture grid + swap suggestions
- `VG.evaluateChips(squad, gwPicks, startGW, fixtures)` → chip recommendations with gwScores
- `VG.analyzeFixtureSwings(startGW, nGWs, fixtures)` → easy/hard run detection
- `VG.buildFixtureTicker(startGW, nGWs, fixtures)` → per-team fixture grid

### Rendering
- `VG.render.metrics(result)` → metric cards (xP, cost, formation)
- `VG.render.chipCard(label, color, advice)` → individual chip card
- `VG.render.tips(result, allXP, fixtures, gw, nGWs)` → dynamic + static tips

### Constants
- `VG.POSITIONS` → `{ 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" }`
- `VG.POSITIONS_R` → `{ GK: 1, DEF: 2, MID: 3, FWD: 4 }`
- `VG.POS_SHIRT` → `{ 1: "gk", 2: "def", 3: "mid", 4: "fwd" }` (CSS class)
- `VG.POS_TARGET` → `{ 1: 2, 2: 5, 3: 5, 4: 3 }` (target squad composition)
- `VG.STRATEGIES` → balanced/premium/value descriptions

## Known Issues

1. **Greedy optimizer**: Can miss global optima (no ILP solver)
2. **Pre-season data**: Team strengths all 0, form 0.0 — fallback estimates used
3. **No multi-week transfer planning**: Only optimizes for current GW
4. **No expected minutes model**: Uses simple 82% fallback
5. **Python files are dead code**: `app.py`, `backend.py`, `data_loader.py`, `xp_engine.py`, `optimizer.py` are from old architecture

## Testing

Tests are at `C:\Users\Tushant\AppData\Local\Temp\opencode\test_v5.js` (local only, not committed).

Run: `node test_v5.js`

34/35 tests pass (1 expected: backup GKs with 0 starts have low xP).

## Commit Convention

- Version commits: `v{major}.{minor}: {description}`
- Bug fixes: `fix: {description}`
- Tags: `v{major}.{minor}` (e.g., `v5.0`)

## FPL API

Base: `https://fantasy.premierleague.com/api`

Key endpoints:
- `bootstrap-static/` → all players, teams, gameweeks
- `fixtures/` → all fixtures with FDR
- `event/{gw}/live/` → live gameweek data (transfers, points)
- `entry/{team_id}/` → user team info
- `entry/{team_id}/event/{gw}/picks/` → user squad for a GW

Pre-season note: All `strength_*` fields are 0. Form is 0.0. `total_points`, `minutes`, `starts`, `goals_scored`, `assists`, `clean_sheets`, `saves`, `bonus` are real last-season data.
