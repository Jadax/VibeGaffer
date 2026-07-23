"""
VibeGaffer | xp_engine.py
Expected Points (xP) projection engine. Blends form, Elo ratings,
fixture difficulty (FDR), home/away advantage, and player momentum
to compute per-gameweek and multi-gameweek xP for every FPL player.

Author: Tushant Sharma | Astraiva
"""

import pandas as pd
import numpy as np
import streamlit as st
from typing import Dict, List, Optional, Tuple
from data_loader import (
    get_players_df, get_teams_df, get_fixtures_df,
    get_player_history, get_upcoming_fixtures_for_player,
    build_fixture_difficulty_map, get_current_gameweek,
    fetch_olbauday_elo, fetch_martgra_momentum, CACHE_TTL
)

# ---------------------------------------------------------------------------
# Baseline Constants — position-specific xP baselines and modifiers
# ---------------------------------------------------------------------------

# Base xP per position before modifiers (GK/DEF/MID/FWD)
POSITION_BASE_XP = {1: 2.5, 2: 3.5, 3: 4.5, 4: 4.0}

# Fixture Difficulty Rating multipliers: 1=easiest → 5=hardest
FDR_MULTIPLIER = {1: 1.30, 2: 1.15, 3: 1.00, 4: 0.85, 5: 0.70}

# Home advantage bonus factor
HOME_BONUS = 1.10

# Clean sheet probability matrix: [position][FDR] → probability
CS_PROB_BY_FDR = {
    1: {1: 0.55, 2: 0.45, 3: 0.35, 4: 0.25, 5: 0.15},
    2: {1: 0.45, 2: 0.35, 3: 0.28, 4: 0.20, 5: 0.12},
    3: {1: 0.35, 2: 0.28, 3: 0.22, 4: 0.15, 5: 0.10},
    4: {1: 0.30, 2: 0.22, 3: 0.18, 4: 0.12, 5: 0.08}
}

# Per-position goal/assist probabilities (base, before FDR scaling)
GOAL_PROB_BY_POSITION = {1: 0.01, 2: 0.05, 3: 0.12, 4: 0.20}
ASSIST_PROB_BY_POSITION = {1: 0.01, 2: 0.06, 3: 0.15, 4: 0.14}

# FPL point values for each scoring action
GOAL_POINTS = {1: 6.0, 2: 6.0, 3: 5.0, 4: 4.0}
ASSIST_POINTS = 3.0
CS_POINTS = {1: 4.0, 2: 4.0, 3: 1.0, 4: 0.0}
BONUS_EXPECTATION = 0.5
YELLOW_CARD_PENALTY = -0.15
APPEARANCE_POINTS = 2.0


# ============================================================================
# Player Form & Momentum Calculations
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def compute_player_form(player_id: int, n_games: int = 5) -> Dict[str, float]:
    """
    Calculate a player's recent form over the last n_games.
    Falls back to FPL bootstrap fields (form, points_per_game, minutes, total_points)
    when GW-by-GW history is empty OR all zeros (pre-season carryover from last season).
    Returns points per game, average minutes, number of starts, and total points.
    """
    history = get_player_history(player_id)
    if not history.empty:
        recent = history.tail(n_games)
        total_pts = recent["total_points"].sum() if "total_points" in recent.columns else 0
        total_mins = recent["minutes"].sum() if "minutes" in recent.columns else 0
        n = len(recent)
        starts = int((recent["minutes"].ge(60)).sum()) if "minutes" in recent.columns else 0
        # If the recent history has meaningful data (season has started), use it.
        # The FPL API includes last season's history which is all zeros pre-season —
        # detect that and fall through to bootstrap fallback.
        if total_pts > 0 or total_mins > 0:
            return {
                "form_ppg": float(total_pts / max(n, 1)),
                "minutes_avg": float(total_mins / max(n, 1)),
                "starts": starts,
                "total_points": int(total_pts)
            }
        # else: fall through to bootstrap fallback below

    # Fallback: use FPL bootstrap fields for pre-season / no-history players
    players_df = get_players_df()
    if not players_df.empty:
        match = players_df[players_df["id"] == player_id]
        if not match.empty:
            row = match.iloc[0]
            try:
                form_ppg = float(row.get("form", 0) or 0)
            except (ValueError, TypeError):
                form_ppg = 0.0
            try:
                ppg = float(row.get("points_per_game", 0) or 0)
            except (ValueError, TypeError):
                ppg = 0.0
            # Use the higher of 'form' (recent) and 'points_per_game' (season avg)
            form_ppg = max(form_ppg, ppg)
            try:
                total_mins = int(row.get("minutes", 0) or 0)
            except (ValueError, TypeError):
                total_mins = 0
            minutes_avg = float(total_mins) / 38.0  # Approx across season
            try:
                total_points = int(row.get("total_points", 0) or 0)
            except (ValueError, TypeError):
                total_points = 0
            starts = int(row.get("starts", 0) or 0)
            return {
                "form_ppg": form_ppg,
                "minutes_avg": minutes_avg,
                "starts": starts,
                "total_points": total_points
            }

    return {"form_ppg": 0.0, "minutes_avg": 0.0, "starts": 0, "total_points": 0}


@st.cache_data(ttl=CACHE_TTL)
def compute_momentum_score(player_id: int) -> float:
    """
    Compute a weighted momentum score from last 3 GWs.
    First attempts to use the Martgra momentum dataset;
    falls back to a weighted sum of recent FPL points (weights: 0.5, 0.3, 0.2).
    For pre-season, falls back to FPL's 'form' field from bootstrap.
    """
    momentum_df = fetch_martgra_momentum()
    if not momentum_df.empty and "player_id" in momentum_df.columns:
        row = momentum_df[momentum_df["player_id"] == player_id]
        if not row.empty and "momentum" in row.columns:
            return float(row.iloc[0]["momentum"])

    # Fallback: weighted sum of last 3 gameweek points
    history = get_player_history(player_id)
    if not history.empty and len(history) >= 3:
        last3 = history.tail(3)["total_points"].values if "total_points" in history.columns else [0, 0, 0]
        # Skip if all zeros (pre-season carryover from last season)
        if any(v > 0 for v in last3):
            weights = [0.5, 0.3, 0.2]
            return float(sum(v * w for v, w in zip(last3, weights)))

    # Pre-season fallback: use FPL bootstrap 'form' as momentum proxy
    players_df = get_players_df()
    if not players_df.empty:
        match = players_df[players_df["id"] == player_id]
        if not match.empty:
            try:
                return float(match.iloc[0].get("form", 0) or 0)
            except (ValueError, TypeError):
                pass

    return 0.0


# ============================================================================
# Team Strength (Elo Ratings)
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def get_team_elo_ratings() -> Dict[int, float]:
    """
    Load team Elo ratings from the Olbauday dataset.
    Falls back to estimating from FPL 'strength' rating if external data missing.
    """
    elo_df = fetch_olbauday_elo()
    if not elo_df.empty and "team_id" in elo_df.columns and "elo" in elo_df.columns:
        return dict(zip(elo_df["team_id"].astype(int), elo_df["elo"].astype(float)))

    # Fallback: approximate Elo from FPL's strength ratings.
    # FPL doesn't expose a single 'strength' field — we average the home/away
    # overall, attack, and defence ratings into a composite score.
    teams_df = get_teams_df()
    if teams_df.empty:
        return {}
    avg_elo = 1500.0
    result = {}
    for _, row in teams_df.iterrows():
        try:
            tid = int(row["id"])
        except (KeyError, ValueError, TypeError):
            continue
        # Composite strength: average of all available strength fields
        strength_fields = [
            row.get("strength_overall_home", 3),
            row.get("strength_overall_away", 3),
            row.get("strength_attack_home", 3),
            row.get("strength_attack_away", 3),
            row.get("strength_defence_home", 3),
            row.get("strength_defence_away", 3),
        ]
        try:
            composite = sum(float(v) for v in strength_fields) / len(strength_fields)
        except (ValueError, TypeError):
            composite = 3.0
        result[tid] = avg_elo + (composite - 3) * 50
    return result


# ============================================================================
# Probability Utilities
# ============================================================================

def compute_minutes_probability(minutes_avg: float) -> float:
    """
    Estimate the probability a player starts and plays significant minutes
    based on their recent average minutes per game.
    """
    if minutes_avg >= 80:
        return 0.95
    elif minutes_avg >= 60:
        return 0.80
    elif minutes_avg >= 45:
        return 0.60
    elif minutes_avg >= 30:
        return 0.40
    elif minutes_avg >= 15:
        return 0.20
    else:
        return 0.05


# ============================================================================
# Core xP Calculation — Single Fixture
# ============================================================================

def compute_fixture_xp(
    player_row: pd.Series,
    opponent_team_id: int,
    is_home: bool,
    fdr: int,
    team_elo: Dict[int, float],
    player_team_id: int
) -> Dict[str, float]:
    """
    Compute expected points for a single fixture.

    Formula blends four weighted components:
        - base_weight (0.20): position baseline xP
        - form_weight (0.35): recent form ppg
        - fixture_weight (0.30): base xP * FDR multiplier
        - elo_weight (0.15): base xP * Elo differential factor

    Then adds: appearance points (2 pts * minute_prob), clean sheet, goals,
    assists, bonus expectation, and yellow card penalty.
    """
    pos = int(player_row.get("element_type", 3))
    base_xp = POSITION_BASE_XP.get(pos, 3.5)
    form = player_row.get("form_ppg", 0.0)
    mins_prob = player_row.get("minutes_prob", 0.5)
    fdr_mult = FDR_MULTIPLIER.get(fdr, 1.0)
    home_mult = HOME_BONUS if is_home else 1.0

    # Elo differential factor — bounded within ±15%
    player_elo = team_elo.get(player_team_id, 1500.0)
    opp_elo = team_elo.get(opponent_team_id, 1500.0)
    elo_diff = (player_elo - opp_elo) / 400.0
    elo_factor = 1.0 + np.clip(elo_diff * 0.1, -0.15, 0.15)

    # Blend weights for the raw xP projection
    form_weight = 0.35
    fixture_weight = 0.30
    elo_weight = 0.15
    base_weight = 0.20

    raw_xp = (
        base_weight * base_xp +
        form_weight * max(form, 0.5) +
        fixture_weight * (base_xp * fdr_mult) +
        elo_weight * (base_xp * elo_factor)
    )
    raw_xp *= home_mult

    # --- Scoring components ---

    # Clean sheet probability (GK & DEF only), boosted at home
    cs_prob = 0.0
    if pos in (1, 2):
        cs_prob = CS_PROB_BY_FDR.get(pos, {}).get(fdr, 0.2)
        if is_home:
            cs_prob = min(cs_prob * 1.15, 0.65)

    # Goal & assist probabilities scaled by fixture difficulty
    goal_prob = GOAL_PROB_BY_POSITION.get(pos, 0.1) * fdr_mult
    assist_prob = ASSIST_PROB_BY_POSITION.get(pos, 0.08) * fdr_mult

    # Convert probabilities to expected points
    goal_xp = goal_prob * GOAL_POINTS.get(pos, 4.0)
    assist_xp = assist_prob * ASSIST_POINTS
    cs_xp = cs_prob * CS_POINTS.get(pos, 0.0)
    bonus_xp = BONUS_EXPECTATION * mins_prob
    card_xp = YELLOW_CARD_PENALTY
    appearance_xp = mins_prob * 2.0

    total_xp = appearance_xp + cs_xp + goal_xp + assist_xp + bonus_xp + card_xp
    total_xp = max(total_xp, 0.1)  # Floor at 0.1 to avoid zero-values in ILP

    return {
        "xp": round(total_xp, 2),
        "cs_prob": round(cs_prob, 3),
        "goal_prob": round(goal_prob, 3),
        "assist_prob": round(assist_prob, 3),
        "minutes_prob": round(mins_prob, 3),
        "fdr": fdr
    }


# ============================================================================
# Multi-Gameweek xP Projection
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def compute_multi_gw_xp(
    player_id: int,
    start_gw: int,
    n_gws: int = 3
) -> Dict[str, any]:
    """
    Compute the total xP for a single player over the next n_gws.
    Looks up upcoming fixtures, computes per-fixture xP, and adds momentum boost.
    Returns player info, per-GW breakdown, and total xP.
    """
    players_df = get_players_df()
    teams_df = get_teams_df()
    fixtures_df = get_fixtures_df()

    if players_df.empty or teams_df.empty:
        return {"total_xp": 0.0, "gw_details": [], "player_info": {}}

    player_row = players_df[players_df["id"] == player_id]
    if player_row.empty:
        return {"total_xp": 0.0, "gw_details": [], "player_info": {}}

    player_row = player_row.iloc[0]
    player_team_id = int(player_row["team"])

    # Gather form and momentum data
    form_data = compute_player_form(player_id)
    momentum = compute_momentum_score(player_id)

    # Build augmented player row with form/minutes data
    player_row = player_row.copy()
    player_row["form_ppg"] = form_data["form_ppg"]
    player_row["minutes_prob"] = compute_minutes_probability(form_data["minutes_avg"])

    team_elo = get_team_elo_ratings()
    fdr_map = build_fixture_difficulty_map(fixtures_df, teams_df)

    # Filter upcoming fixtures for this player's team in the target GW range
    upcoming = fixtures_df[
        ((fixtures_df["home_team_id"] == player_team_id) |
         (fixtures_df["away_team_id"] == player_team_id)) &
        (fixtures_df["event"] >= start_gw) &
        (fixtures_df["event"] < start_gw + n_gws) &
        (~fixtures_df["finished"].astype(bool))
    ].sort_values("event")

    gw_details = []
    total_xp = 0.0

    for _, fix in upcoming.iterrows():
        gw = int(fix["event"])
        is_home = int(fix["home_team_id"]) == player_team_id
        opp_id = int(fix["away_team_id"]) if is_home else int(fix["home_team_id"])
        # FDR can be None for fixtures before the season starts — default to 3 (neutral)
        raw_fdr = fix["home_fdr"] if is_home else fix["away_fdr"]
        fdr = int(raw_fdr) if raw_fdr is not None and not pd.isna(raw_fdr) else 3

        result = compute_fixture_xp(player_row, opp_id, is_home, fdr, team_elo, player_team_id)

        # Look up opponent short name
        opp_name = ""
        opp_row = teams_df[teams_df["id"] == opp_id]
        if not opp_row.empty:
            opp_name = opp_row.iloc[0].get("short_name", f"Team {opp_id}")

        result["gw"] = gw
        result["opponent"] = opp_name
        result["venue"] = "H" if is_home else "A"
        gw_details.append(result)
        total_xp += result["xp"]

    # Apply small momentum modifier (10% of momentum score)
    total_xp += momentum * 0.1

    player_info = {
        "id": int(player_row["id"]),
        "name": str(player_row["full_name"]),
        "position": str(player_row["position_name"]),
        "team_id": player_team_id,
        "price": float(player_row["now_cost"]),
        "form_ppg": form_data["form_ppg"],
        "minutes_prob": compute_minutes_probability(form_data["minutes_avg"]),
        "momentum": momentum,
        "total_points_season": int(player_row.get("total_points", 0))
    }

    return {
        "total_xp": round(total_xp, 2),
        "gw_details": gw_details,
        "player_info": player_info
    }


# ============================================================================
# Full League xP Computation
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def compute_all_players_xp(
    start_gw: int,
    n_gws: int = 3
) -> pd.DataFrame:
    """
    Compute xP for all available (status='a') players over n_gws.
    Returns a DataFrame with player info, total_xp, and xp_per_price ratio.
    This is the most expensive operation — cached for 1 hour.
    """
    players_df = get_players_df()
    if players_df.empty:
        return pd.DataFrame()

    # Only consider available players with a positive price
    active = players_df[
        (players_df["status"] == "a") &
        (players_df["now_cost"] > 0)
    ].copy()

    records = []
    for _, player in active.iterrows():
        pid = int(player["id"])
        xp_data = compute_multi_gw_xp(pid, start_gw, n_gws)
        if xp_data["total_xp"] > 0:
            rec = {
                "id": pid,
                "name": xp_data["player_info"]["name"],
                "position": xp_data["player_info"]["position"],
                "position_id": int(player["element_type"]),
                "team_id": xp_data["player_info"]["team_id"],
                "price": xp_data["player_info"]["price"],
                "total_xp": xp_data["total_xp"],
                "form_ppg": xp_data["player_info"]["form_ppg"],
                "minutes_prob": xp_data["player_info"]["minutes_prob"],
                "momentum": xp_data["player_info"]["momentum"],
                "gw_details": xp_data["gw_details"]
            }
            records.append(rec)

    df = pd.DataFrame(records)
    if not df.empty:
        # Value-for-money ratio — higher is better, floor price at 4.0m
        df["xp_per_price"] = df["total_xp"] / df["price"].clip(lower=4.0)
    return df


# ============================================================================
# Differential Picks Finder
# ============================================================================

def get_differential_picks(
    start_gw: int,
    n_gws: int = 3,
    max_ownership: float = 5.0,
    min_xp: float = 10.0
) -> pd.DataFrame:
    """
    Find high-xP, low-ownership differential players.
    Filters players with:
      - Ownership <= max_ownership% (default 5%)
      - Total xP >= min_xp over the horizon
      - Available (not injured/loaned)
    Returns sorted by xP descending.
    """
    xp_df = compute_all_players_xp(start_gw, n_gws)
    if xp_df.empty:
        return pd.DataFrame()

    from data_loader import get_player_ownership_df
    ownership = get_player_ownership_df()
    if ownership.empty:
        return pd.DataFrame()

    merged = xp_df.merge(
        ownership[["id", "selected_by_percent", "form"]],
        on="id", how="inner"
    )

    # Filter for differentials
    diffs = merged[
        (merged["selected_by_percent"].astype(float) <= max_ownership) &
        (merged["total_xp"] >= min_xp)
    ].copy()

    diffs["ownership"] = diffs["selected_by_percent"].astype(float)
    diffs["vfm_rank"] = diffs["xp_per_price"].rank(ascending=False)

    cols = ["id", "name", "position", "team_id", "price", "total_xp",
            "xp_per_price", "ownership", "minutes_prob", "form_ppg"]
    available = [c for c in cols if c in diffs.columns]
    return diffs[available].sort_values("total_xp", ascending=False).head(20)


# ============================================================================
# Formatting Utilities
# ============================================================================

def get_next_fixture_text(gw_details: List[Dict], max_show: int = 3) -> str:
    """
    Format upcoming fixtures as a compact string.
    E.g., 'ARS(H) | MCI(A) | LIV(H)'
    """
    if not gw_details:
        return "N/A"
    parts = []
    for gd in gw_details[:max_show]:
        parts.append(f"{gd.get('opponent', '?')}({gd.get('venue', '?')})")
    return " | ".join(parts)
