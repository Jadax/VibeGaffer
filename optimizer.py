"""
VibeGaffer | optimizer.py
Integer Linear Programming (ILP) solver using PuLP for FPL squad optimization.
Handles both Mode A (GW1 Draft Builder) and Mode B (Transfer Advisor with hit-cost analysis).
Includes chip decision matrix for Triple Captain, Bench Boost, Free Hit, and Wildcard.

Author: Tushant Sharma | Astraiva
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Any
from pulp import (
    LpProblem, LpMaximize, LpVariable, lpSum, LpStatus, value
)

# ============================================================================
# Global Constraints & Thresholds
# ============================================================================

# FPL squad composition rules
POSITION_CONSTRAINTS = {
    "total": 15,
    "GK": {"squad": 2, "min_start": 1, "max_start": 1},
    "DEF": {"squad": 5, "min_start": 3, "max_start": 5},
    "MID": {"squad": 5, "min_start": 3, "max_start": 5},
    "FWD": {"squad": 3, "min_start": 1, "max_start": 3}
}

MAX_PER_CLUB = 3       # Max 3 players from any one Premier League club
BUDGET_LIMIT = 100.0   # Standard FPL budget in £m
HIT_COST = 4.0         # Points deducted per transfer beyond free transfers
HIT_THRESHOLD = 4.0    # Minimum net xP gain required to recommend a hit

# Chip trigger thresholds (from Section 3 of the VibeGaffer spec)
TC_XP_THRESHOLD = 11.5       # Triple Captain: single-GW captain xP >= this
BB_BENCH_XP_THRESHOLD = 14.5 # Bench Boost: combined bench xP >= this
WC_MIN_CHANGES = 5           # Wildcard: minimum players to change
WC_XP_GAIN_THRESHOLD = 20.0  # Wildcard: net xP gain over 4 GWs required


# ============================================================================
# Mode A: GW1 Draft Squad (unconstrained, from-scratch optimization)
# ============================================================================

def solve_draft_squad(
    xp_df: pd.DataFrame,
    budget: float = BUDGET_LIMIT
) -> Dict[str, Any]:
    """
    Solve the ILP to build a 15-player squad from scratch.

    Objective: Maximize sum(xP) over selected players.
    Constraints:
        - Exactly 15 players (2 GK, 5 DEF, 5 MID, 3 FWD)
        - Total cost <= budget (£100m)
        - Max 3 players per club
    """
    if xp_df.empty:
        return {"status": "error", "message": "No player data available", "squad": []}

    # Initialize PuLP problem
    prob = LpProblem("FPL_Draft_Squad", LpMaximize)

    # Binary decision variable for each player (1 = selected, 0 = not)
    player_vars = {}
    for _, row in xp_df.iterrows():
        pid = int(row["id"])
        player_vars[pid] = LpVariable(f"player_{pid}", cat="Binary")

    # Objective: maximize total expected points
    prob += lpSum(
        player_vars[int(row["id"])] * float(row["total_xp"])
        for _, row in xp_df.iterrows()
    ), "Total_xP"

    # Budget constraint
    prob += lpSum(
        player_vars[int(row["id"])] * float(row["price"])
        for _, row in xp_df.iterrows()
    ) <= budget, "Budget"

    # Squad size: exactly 15 players
    prob += lpSum(player_vars.values()) == 15, "Total_Players"

    # Per-position squad composition
    for pos_name in ["GK", "DEF", "MID", "FWD"]:
        pos_id = {"GK": 1, "DEF": 2, "MID": 3, "FWD": 4}[pos_name]
        pos_players = xp_df[xp_df["position_id"] == pos_id]
        required = POSITION_CONSTRAINTS[pos_name]["squad"]
        prob += lpSum(
            player_vars[int(row["id"])] for _, row in pos_players.iterrows()
        ) == required, f"Position_{pos_name}"

    # Max 3 players per Premier League club
    for team_id in xp_df["team_id"].unique():
        team_players = xp_df[xp_df["team_id"] == team_id]
        prob += lpSum(
            player_vars[int(row["id"])] for _, row in team_players.iterrows()
        ) <= MAX_PER_CLUB, f"Club_{int(team_id)}"

    prob.solve()
    status = LpStatus[prob.status]

    if status != "Optimal":
        return {"status": status, "message": f"Solver status: {status}", "squad": []}

    # Extract selected players
    selected = []
    for _, row in xp_df.iterrows():
        pid = int(row["id"])
        if value(player_vars[pid]) and value(player_vars[pid]) > 0.5:
            selected.append(row.to_dict())

    # Sort by position (GK→DEF→MID→FWD) then by xP descending
    selected.sort(key=lambda x: (-x["position_id"], -x["total_xp"]))

    total_cost = sum(p["price"] for p in selected)
    total_xp = sum(p["total_xp"] for p in selected)

    return {
        "status": "optimal",
        "squad": selected,
        "total_cost": round(total_cost, 1),
        "total_xp": round(total_xp, 2),
        "budget_remaining": round(budget - total_cost, 1)
    }


# ============================================================================
# Starting XI Selection & Formation
# ============================================================================

def select_starting_xi(squad: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
    """
    Split a 15-player squad into Starting XI (11) and Bench (4).
    Always starts 1 GK. Distribution of DEF/MID/FWD follows min_start rules,
    placing the highest-xP players in the starting lineup.
    Bench is sorted by xP descending (priority order).
    """
    if len(squad) < 15:
        return squad, []

    # Group players by position
    by_pos = {1: [], 2: [], 3: [], 4: []}
    for p in squad:
        pos_id = int(p.get("position_id", 3))
        by_pos[pos_id].append(p)

    # Sort each position group by xP descending
    for pos_id in by_pos:
        by_pos[pos_id].sort(key=lambda x: -x.get("total_xp", 0))

    starting = []
    bench = []

    # GK: exactly 1 starts, 1 on bench
    starting.append(by_pos[1][0])
    bench.append(by_pos[1][1])

    # DEF / MID / FWD: at least min_start in XI, at most max_start, rest to bench
    for pos_id in [2, 3, 4]:
        pos_name = {2: "DEF", 3: "MID", 4: "FWD"}[pos_id]
        min_start = POSITION_CONSTRAINTS[pos_name]["min_start"]
        max_start = POSITION_CONSTRAINTS[pos_name]["max_start"]
        players = by_pos[pos_id]
        # Start the high-xP players, leave lowest for bench
        n_start = min(max_start, max(min_start, len(players) - 1))
        for i, p in enumerate(players):
            if i < n_start and len(starting) < 11:
                starting.append(p)
            else:
                bench.append(p)

    # Fill any remaining starting spots from bench (top xP first)
    while len(starting) < 11 and bench:
        starting.append(bench.pop(0))

    bench.sort(key=lambda x: -x.get("total_xp", 0))
    return starting[:11], bench[:4]


def find_optimal_formation(starting: List[Dict]) -> Dict[str, int]:
    """
    Determine the optimal formation (e.g. 3-4-3, 4-4-2) by testing
    all valid combos and choosing the one that maximizes starting XI xP.
    """
    defs = [p for p in starting if p.get("position_id") == 2]
    mids = [p for p in starting if p.get("position_id") == 3]
    fwds = [p for p in starting if p.get("position_id") == 4]

    best_formation = {"DEF": 3, "MID": 5, "FWD": 3}
    best_xp = -1

    # All valid FPL formations (DEF-MID-FWD, GK always 1)
    formations = [
        (3, 4, 3), (3, 5, 2), (4, 3, 3), (4, 4, 2), (4, 5, 1),
        (5, 3, 2), (5, 4, 1)
    ]

    for d, m, f in formations:
        if d <= len(defs) and m <= len(mids) and f <= len(fwds):
            xp = (
                sum(p.get("total_xp", 0) for p in defs[:d]) +
                sum(p.get("total_xp", 0) for p in mids[:m]) +
                sum(p.get("total_xp", 0) for p in fwds[:f])
            )
            if xp > best_xp:
                best_xp = xp
                best_formation = {"DEF": d, "MID": m, "FWD": f}

    return best_formation


# ============================================================================
# Mode B: Transfer Optimization (GW2+)
# ============================================================================

def solve_transfers(
    current_squad: pd.DataFrame,
    xp_df: pd.DataFrame,
    bank: float,
    free_transfers: int = 1,
    n_gws: int = 3
) -> Dict[str, Any]:
    """
    Evaluate 0, 1, and 2-transfer plans. Returns the best plan.
    Only recommends a -4 pt hit if net xP gain > HIT_THRESHOLD (4.0) over n_gws.
    """
    if current_squad.empty or xp_df.empty:
        return {"status": "error", "message": "Insufficient data", "transfers": []}

    # Current squad player IDs
    current_ids = set(current_squad["element"].astype(int).tolist()) if "element" in current_squad.columns else set()

    # Calculate current squad xP
    current_xp_total = 0.0
    for pid in current_ids:
        match = xp_df[xp_df["id"] == pid]
        if not match.empty:
            current_xp_total += float(match.iloc[0]["total_xp"])

    results = {}

    # Try all transfer counts: 0, 1, 2
    for n_transfers in range(3):
        hit_cost = max(0, (n_transfers - free_transfers)) * HIT_COST

        if n_transfers == 0:
            # No transfers — baseline
            results[0] = {
                "transfers_in": [],
                "transfers_out": [],
                "net_xp_gain": 0.0,
                "hit_cost": 0,
                "net_after_hit": current_xp_total,
                "new_squad_xp": current_xp_total
            }
            continue

        result = _solve_n_transfers(current_squad, xp_df, bank, n_transfers)
        if result["status"] == "optimal":
            new_xp = result["total_xp"]
            net_gain = new_xp - current_xp_total
            results[n_transfers] = {
                "transfers_in": result["transfers_in"],
                "transfers_out": result["transfers_out"],
                "net_xp_gain": round(net_gain, 2),
                "hit_cost": hit_cost,
                "net_after_hit": round(net_gain - hit_cost, 2),
                "new_squad_xp": round(new_xp, 2)
            }
        else:
            results[n_transfers] = {
                "transfers_in": [],
                "transfers_out": [],
                "net_xp_gain": 0.0,
                "hit_cost": hit_cost,
                "net_after_hit": -hit_cost,
                "new_squad_xp": current_xp_total
            }

    # Select best plan (highest net xP after hit cost)
    best_plan = 0
    best_net = results[0]["net_after_hit"]
    for n, r in results.items():
        if r["net_after_hit"] > best_net:
            best_net = r["net_after_hit"]
            best_plan = n

    # Enforce hit threshold: don't recommend a hit unless net gain > 4.0 pts
    if best_plan > 0 and results[best_plan]["net_xp_gain"] < HIT_THRESHOLD:
        best_plan = 0

    return {
        "status": "optimal",
        "recommended_transfers": best_plan,
        "all_plans": results,
        "best_plan": results[best_plan],
        "current_squad_xp": round(current_xp_total, 2)
    }


def _solve_n_transfers(
    current_squad: pd.DataFrame,
    xp_df: pd.DataFrame,
    bank: float,
    n_transfers: int
) -> Dict[str, Any]:
    """
    ILP solver to find the optimal exact-n transfers.
    Maximizes new squad xP while preserving position counts and budget.
    """
    current_ids = set(current_squad["element"].astype(int).tolist()) if "element" in current_squad.columns else set()

    # Extract current selling prices
    current_prices = {}
    if "selling_price" in current_squad.columns:
        for _, row in current_squad.iterrows():
            current_prices[int(row["element"])] = float(row["selling_price"])
    elif "now_cost" in current_squad.columns:
        for _, row in current_squad.iterrows():
            current_prices[int(row["element"])] = float(row["now_cost"])

    # Candidate pool: players NOT already in squad
    candidates = xp_df[~xp_df["id"].isin(current_ids)].copy()
    if candidates.empty:
        return {"status": "infeasible", "total_xp": 0, "transfers_in": [], "transfers_out": []}

    # Current players' xP for objective calculation
    current_in_xp = {}
    for pid in current_ids:
        match = xp_df[xp_df["id"] == pid]
        if not match.empty:
            current_in_xp[pid] = float(match.iloc[0]["total_xp"])

    prob = LpProblem(f"FPL_{n_transfers}_Transfers", LpMaximize)

    # Decision variables
    out_vars = {pid: LpVariable(f"out_{pid}", cat="Binary") for pid in current_ids}
    in_vars = {}
    for _, row in candidates.iterrows():
        pid = int(row["id"])
        in_vars[pid] = LpVariable(f"in_{pid}", cat="Binary")

    # Objective: maximize new squad xP
    prob += lpSum(
        in_vars.get(int(row["id"]), 0) * float(row["total_xp"])
        for _, row in candidates.iterrows()
    ) + lpSum(
        (1 - out_vars[pid]) * current_in_xp.get(pid, 0) for pid in current_ids
    ) - lpSum(
        out_vars[pid] * current_in_xp.get(pid, 0) for pid in current_ids
    ), "New_Squad_xP"

    # Exactly n transfers out, n transfers in
    prob += lpSum(out_vars.values()) == n_transfers, "N_Out"
    prob += lpSum(in_vars.values()) == n_transfers, "N_In"

    # Budget constraint: cost of players IN <= money from players OUT + bank
    sell_value = lpSum(
        out_vars[pid] * current_prices.get(pid, 0) for pid in current_ids
    )
    buy_cost = lpSum(
        in_vars.get(int(row["id"]), 0) * float(row["price"])
        for _, row in candidates.iterrows()
    )
    prob += buy_cost <= sell_value + bank, "Budget"

    # Club limit (max 3 per club) on the resulting squad
    for team_id in xp_df["team_id"].unique():
        team_players_current = [
            pid for pid in current_ids
            if _get_player_team(pid, current_squad) == team_id
        ]
        team_players_new = candidates[candidates["team_id"] == team_id]

        prob += lpSum(
            (1 - out_vars[pid]) for pid in team_players_current
        ) + lpSum(
            in_vars.get(int(row["id"]), 0) for _, row in team_players_new.iterrows()
        ) <= MAX_PER_CLUB, f"Club_{int(team_id)}"

    # Position composition must be maintained exactly
    for pos_name in ["GK", "DEF", "MID", "FWD"]:
        pos_id = {"GK": 1, "DEF": 2, "MID": 3, "FWD": 4}[pos_name]
        required = POSITION_CONSTRAINTS[pos_name]["squad"]
        current_pos = [
            pid for pid in current_ids
            if _get_player_pos(pid, current_squad) == pos_id
        ]
        new_pos = candidates[candidates["position_id"] == pos_id]
        prob += lpSum(
            (1 - out_vars[pid]) for pid in current_pos
        ) + lpSum(
            in_vars.get(int(row["id"]), 0) for _, row in new_pos.iterrows()
        ) == required, f"Position_{pos_name}"

    prob.solve()
    status = LpStatus[prob.status]

    if status != "Optimal":
        return {"status": status, "total_xp": 0, "transfers_in": [], "transfers_out": []}

    # Extract results
    transfers_out = [pid for pid in current_ids
                     if value(out_vars[pid]) and value(out_vars[pid]) > 0.5]
    transfers_in = [int(row["id"]) for _, row in candidates.iterrows()
                    if value(in_vars.get(int(row["id"]), 0)) and
                    value(in_vars.get(int(row["id"]), 0)) > 0.5]

    # Compute total xP of resulting squad
    new_squad_ids = (current_ids - set(transfers_out)) | set(transfers_in)
    total_xp = sum(current_in_xp.get(pid, 0) for pid in new_squad_ids
                   if pid in current_in_xp)
    for pid in transfers_in:
        match = xp_df[xp_df["id"] == pid]
        if not match.empty:
            total_xp += float(match.iloc[0]["total_xp"])

    # Build detail records
    transfers_in_details = []
    for pid in transfers_in:
        match = xp_df[xp_df["id"] == pid]
        if not match.empty:
            row = match.iloc[0]
            transfers_in_details.append({
                "id": int(row["id"]),
                "name": row.get("name", f"Player {pid}"),
                "position": row.get("position", ""),
                "price": float(row.get("price", 0)),
                "total_xp": float(row.get("total_xp", 0))
            })

    transfers_out_details = []
    for pid in transfers_out:
        match = current_squad[current_squad["element"] == pid] if "element" in current_squad.columns else pd.DataFrame()
        if not match.empty:
            row = match.iloc[0]
            transfers_out_details.append({
                "id": pid,
                "name": row.get("web_name", row.get("second_name", f"Player {pid}")),
                "position": row.get("position_name", ""),
                "price": float(current_prices.get(pid, 0))
            })

    return {
        "status": "optimal",
        "total_xp": round(total_xp, 2),
        "transfers_in": transfers_in_details,
        "transfers_out": transfers_out_details
    }


# ============================================================================
# Helpers for player attribute lookups from squad DataFrame
# ============================================================================

def _get_player_team(player_id: int, squad_df: pd.DataFrame) -> int:
    """Get team ID for a player in the squad DataFrame."""
    if "team" in squad_df.columns:
        match = squad_df[squad_df["element"] == player_id]
        if not match.empty:
            return int(match.iloc[0]["team"])
    return 0


def _get_player_pos(player_id: int, squad_df: pd.DataFrame) -> int:
    """Get position ID for a player in the squad DataFrame."""
    if "element_type" in squad_df.columns:
        match = squad_df[squad_df["element"] == player_id]
        if not match.empty:
            return int(match.iloc[0]["element_type"])
    if "position_id" in squad_df.columns:
        match = squad_df[squad_df["element"] == player_id]
        if not match.empty:
            return int(match.iloc[0]["position_id"])
    return 3  # Default to MID


# ============================================================================
# Chip Decision Matrix
# ============================================================================

def evaluate_chips(
    squad_xp: List[Dict],
    starting_xp: List[Dict],
    bench_xp: List[Dict],
    current_gw: int,
    fixtures_df: pd.DataFrame
) -> Dict[str, Dict[str, Any]]:
    """
    Chip decision matrix implementing the trigger thresholds from Section 3:
    - Triple Captain: top captain xP >= 11.5 OR DGW detected
    - Bench Boost: 4 bench players combined xP >= 14.5
    - Free Hit: Blank Gameweek detected
    - Wildcard: placeholder (evaluate based on squad turnover analysis)
    """
    chip_advice = {}

    # ----- Triple Captain -----
    if starting_xp:
        top_captain_xp = max(p.get("total_xp", 0) for p in starting_xp)
        is_dgw = _check_double_gameweek(current_gw, fixtures_df)
        tc_trigger = top_captain_xp >= TC_XP_THRESHOLD or is_dgw
        chip_advice["triple_captain"] = {
            "recommend": tc_trigger,
            "reason": f"Top captain xP={top_captain_xp:.1f}" +
                      (" + DGW detected" if is_dgw else ""),
            "top_captain_xp": round(top_captain_xp, 2),
            "dgw_detected": is_dgw
        }
    else:
        chip_advice["triple_captain"] = {"recommend": False, "reason": "No squad data"}

    # ----- Bench Boost -----
    bench_total_xp = sum(p.get("total_xp", 0) for p in bench_xp)
    bb_trigger = bench_total_xp >= BB_BENCH_XP_THRESHOLD
    chip_advice["bench_boost"] = {
        "recommend": bb_trigger,
        "reason": f"Bench combined xP={bench_total_xp:.1f}",
        "bench_xp": round(bench_total_xp, 2)
    }

    # ----- Free Hit -----
    is_bgw = _check_blank_gameweek(current_gw, fixtures_df)
    chip_advice["free_hit"] = {
        "recommend": is_bgw,
        "reason": "Blank Gameweek detected" if is_bgw else "No blank GW trigger",
        "bgw_detected": is_bgw
    }

    # ----- Wildcard (placeholder) -----
    chip_advice["wildcard"] = {
        "recommend": False,
        "reason": "Evaluate based on squad turnover analysis"
    }

    return chip_advice


def _check_double_gameweek(gw: int, fixtures_df: pd.DataFrame) -> bool:
    """Detect if any team plays twice in the given GW (DGW)."""
    if fixtures_df.empty or "event" not in fixtures_df.columns:
        return False
    gw_fixtures = fixtures_df[fixtures_df["event"] == gw]
    if gw_fixtures.empty:
        return False
    team_counts = {}
    for _, fix in gw_fixtures.iterrows():
        h = int(fix["home_team_id"])
        a = int(fix["away_team_id"])
        team_counts[h] = team_counts.get(h, 0) + 1
        team_counts[a] = team_counts.get(a, 0) + 1
    return any(c >= 2 for c in team_counts.values())


def _check_blank_gameweek(gw: int, fixtures_df: pd.DataFrame) -> bool:
    """Detect if a GW has no fixtures (BGW)."""
    if fixtures_df.empty or "event" not in fixtures_df.columns:
        return False
    gw_fixtures = fixtures_df[fixtures_df["event"] == gw]
    return gw_fixtures.empty


# ============================================================================
# Captaincy Selection
# ============================================================================

def get_captain_choices(starting_xi: List[Dict]) -> Dict[str, Any]:
    """Select captain and vice-captain as the two highest-xP players in the XI."""
    if not starting_xi:
        return {"captain": None, "vice_captain": None}

    sorted_players = sorted(starting_xi, key=lambda x: -x.get("total_xp", 0))
    captain = sorted_players[0] if len(sorted_players) >= 1 else None
    vice = sorted_players[1] if len(sorted_players) >= 2 else None

    return {
        "captain": {
            "name": captain.get("name", "N/A") if captain else "N/A",
            "xp": round(captain.get("total_xp", 0), 2) if captain else 0,
            "position": captain.get("position", "") if captain else ""
        } if captain else None,
        "vice_captain": {
            "name": vice.get("name", "N/A") if vice else "N/A",
            "xp": round(vice.get("total_xp", 0), 2) if vice else 0,
            "position": vice.get("position", "") if vice else ""
        } if vice else None
    }
