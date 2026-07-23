"""
VibeGaffer | backend.py
Private FastAPI backend serving optimization endpoints.
Wraps data_loader, xp_engine, and optimizer modules behind REST endpoints
with CORS enabled for the Streamlit frontend.

Run: uvicorn backend:app --host 0.0.0.0 --port 8000 --reload

Author: Tushant Sharma | Astraiva
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uvicorn
import pandas as pd

from data_loader import (
    get_players_df, get_teams_df, get_fixtures_df,
    get_user_team_info, get_user_picks, get_squad_with_details,
    get_current_gameweek, get_data_status, fetch_bootstrap_static
)
from xp_engine import compute_all_players_xp, compute_multi_gw_xp
from optimizer import (
    solve_draft_squad, select_starting_xi, find_optimal_formation,
    solve_transfers, evaluate_chips, get_captain_choices
)

# ---------------------------------------------------------------------------
# FastAPI Application Initialization
# ---------------------------------------------------------------------------

app = FastAPI(
    title="VibeGaffer API",
    description="FPL Optimization Backend by Astraiva",
    version="1.0.0"
)

# Allow Streamlit frontend (or any client) to call these endpoints
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Pydantic Request Models
# ---------------------------------------------------------------------------

class DraftRequest(BaseModel):
    """Mode A: Build a draft squad from scratch."""
    gameweek: int = 1
    n_gws_horizon: int = 3
    budget: float = 100.0


class TransferRequest(BaseModel):
    """Mode B: Optimize transfers for an existing FPL team."""
    team_id: int
    gameweek: int
    free_transfers: int = 1
    bank_override: Optional[float] = None
    n_gws_horizon: int = 3


class PlayerXpRequest(BaseModel):
    """Request xP for a specific player over a GW window."""
    player_id: int
    start_gw: int
    n_gws: int = 3


# ---------------------------------------------------------------------------
# Utility Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    """Root endpoint returning app metadata."""
    return {"app": "VibeGaffer", "author": "Tushant Sharma", "company": "Astraiva"}


@app.get("/health")
def health():
    """Health check endpoint for monitoring."""
    return {"status": "healthy"}


@app.get("/status")
def status():
    """Return connectivity status for all data sources."""
    return get_data_status()


@app.get("/current-gw")
def current_gw():
    """Return the current active gameweek number."""
    return {"current_gameweek": get_current_gameweek()}


# ---------------------------------------------------------------------------
# Data Endpoints
# ---------------------------------------------------------------------------

@app.get("/players")
def get_all_players():
    """Return all FPL players with stats."""
    df = get_players_df()
    if df.empty:
        raise HTTPException(status_code=503, detail="Player data unavailable")
    return {"count": len(df), "players": df.to_dict(orient="records")}


@app.get("/teams")
def get_all_teams():
    """Return all 20 Premier League teams with strength data."""
    df = get_teams_df()
    if df.empty:
        raise HTTPException(status_code=503, detail="Team data unavailable")
    return {"count": len(df), "teams": df.to_dict(orient="records")}


@app.get("/fixtures")
def get_fixtures():
    """Return all season fixtures with FDR ratings."""
    df = get_fixtures_df()
    if df.empty:
        raise HTTPException(status_code=503, detail="Fixture data unavailable")
    return {"count": len(df), "fixtures": df.to_dict(orient="records")}


# ---------------------------------------------------------------------------
# Squad & Player xP Endpoints
# ---------------------------------------------------------------------------

@app.get("/squad/{team_id}/{gameweek}")
def get_squad(team_id: int, gameweek: int):
    """Fetch a user's squad and team info for a specific gameweek."""
    team_info = get_user_team_info(team_id)
    if not team_info:
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    squad = get_squad_with_details(team_id, gameweek)
    if squad.empty:
        raise HTTPException(status_code=404, detail="Squad data unavailable")

    bank = team_info.get("last_deadline_bank", 0) / 10.0
    return {
        "team_info": {
            "id": team_info.get("id"),
            "name": team_info.get("player_first_name", "") + " " + team_info.get("player_last_name", ""),
            "team_name": team_info.get("name", ""),
            "bank": round(bank, 1),
            "overall_points": team_info.get("summary_overall_points", 0),
            "overall_rank": team_info.get("summary_overall_rank", 0)
        },
        "squad": squad.to_dict(orient="records")
    }


@app.get("/player-xp/{player_id}")
def get_player_xp(
    player_id: int,
    start_gw: int = Query(default=1),
    n_gws: int = Query(default=3)
):
    """Return xP projection for a single player over multiple gameweeks."""
    result = compute_multi_gw_xp(player_id, start_gw, n_gws)
    if result["total_xp"] == 0:
        raise HTTPException(status_code=404, detail="Player xP data unavailable")
    return result


# ---------------------------------------------------------------------------
# Optimization Endpoints
# ---------------------------------------------------------------------------

@app.post("/optimize/draft")
def optimize_draft(req: DraftRequest):
    """
    Mode A: GW1 Draft Builder.
    Solves unconstrained 15-player squad under budget using PuLP ILP.
    Returns Starting XI, Bench, formation, captaincy, and chip advice.
    """
    xp_df = compute_all_players_xp(req.gameweek, req.n_gws_horizon)
    if xp_df.empty:
        raise HTTPException(status_code=503, detail="Cannot compute xP data")

    result = solve_draft_squad(xp_df, req.budget)
    if result["status"] != "optimal":
        raise HTTPException(status_code=500, detail=f"Optimization failed: {result.get('message', 'Unknown')}")

    starting, bench = select_starting_xi(result["squad"])
    formation = find_optimal_formation(starting)
    captain_choices = get_captain_choices(starting)
    fixtures_df = get_fixtures_df()
    chip_advice = evaluate_chips(result["squad"], starting, bench, req.gameweek, fixtures_df)

    return {
        "mode": "draft",
        "gameweek": req.gameweek,
        "horizon_gws": req.n_gws_horizon,
        "total_cost": result["total_cost"],
        "budget_remaining": result["budget_remaining"],
        "total_xp": result["total_xp"],
        "formation": formation,
        "starting_xi": starting,
        "bench": bench,
        "captain_choices": captain_choices,
        "chip_advice": chip_advice
    }


@app.post("/optimize/transfers")
def optimize_transfers(req: TransferRequest):
    """
    Mode B: Weekly Squad & Transfer Advisor.
    Fetches current squad, computes optimal 0/1/2-transfer plans,
    returns recommended transfers with hit-cost analysis.
    """
    team_info = get_user_team_info(req.team_id)
    if not team_info:
        raise HTTPException(status_code=404, detail=f"Team {req.team_id} not found")

    current_squad = get_squad_with_details(req.team_id, req.gameweek)
    if current_squad.empty:
        raise HTTPException(status_code=404, detail="Current squad data unavailable")

    bank = req.bank_override if req.bank_override is not None else team_info.get("last_deadline_bank", 0) / 10.0

    xp_df = compute_all_players_xp(req.gameweek, req.n_gws_horizon)
    if xp_df.empty:
        raise HTTPException(status_code=503, detail="Cannot compute xP data")

    result = solve_transfers(current_squad, xp_df, bank, req.free_transfers, req.n_gws_horizon)
    if result["status"] != "optimal":
        raise HTTPException(status_code=500, detail="Transfer optimization failed")

    best = result["best_plan"]

    # Build the full projected squad (retained + transfers IN)
    full_squad_data = []
    out_ids = [p["id"] for p in best.get("transfers_out", [])]

    # Add retained players with xP data
    for _, row in current_squad.iterrows():
        pid = int(row.get("element", 0))
        if pid not in out_ids:
            xp_match = xp_df[xp_df["id"] == pid]
            player_data = row.to_dict()
            if not xp_match.empty:
                player_data["total_xp"] = float(xp_match.iloc[0]["total_xp"])
                player_data["name"] = xp_match.iloc[0].get("name", player_data.get("web_name", ""))
            full_squad_data.append(player_data)

    # Add transfers IN
    for p_in in best.get("transfers_in", []):
        full_squad_data.append(p_in)

    starting, bench = select_starting_xi(full_squad_data)
    formation = find_optimal_formation(starting)
    captain_choices = get_captain_choices(starting)
    fixtures_df = get_fixtures_df()
    chip_advice = evaluate_chips(full_squad_data, starting, bench, req.gameweek, fixtures_df)
    all_plans = result.get("all_plans", {})

    return {
        "mode": "transfer",
        "gameweek": req.gameweek,
        "team_id": req.team_id,
        "horizon_gws": req.n_gws_horizon,
        "recommended_transfers": result["recommended_transfers"],
        "transfers_in": best.get("transfers_in", []),
        "transfers_out": best.get("transfers_out", []),
        "hit_cost": best.get("hit_cost", 0),
        "net_xp_gain": best.get("net_xp_gain", 0),
        "net_after_hit": best.get("net_after_hit", 0),
        "bank": round(bank, 1),
        "formation": formation,
        "starting_xi": starting,
        "bench": bench,
        "captain_choices": captain_choices,
        "chip_advice": chip_advice,
        "all_plans_summary": {
            str(k): {
                "net_xp_gain": v.get("net_xp_gain", 0),
                "hit_cost": v.get("hit_cost", 0),
                "net_after_hit": v.get("net_after_hit", 0)
            } for k, v in all_plans.items()
        }
    }


# ---------------------------------------------------------------------------
# Run server directly
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
