"""
VibeGaffer | data_loader.py
Multi-source data ingestion module for FPL optimization.
Fetches from official FPL API, Vaastav archive, Olbauday Elo, and Martgra momentum.
All fetchers are wrapped with @st.cache_data (TTL=3600s) to prevent re-fetching
during active sessions and minimize API rate-limit hits.

Author: Tushant Sharma | Astraiva
"""

import requests
import pandas as pd
import numpy as np
import streamlit as st
from io import StringIO
from typing import Optional, Dict, Any
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------------------
# API base URLs for all data sources
# ---------------------------------------------------------------------------
FPL_BASE = "https://fantasy.premierleague.com/api"
VAASTAV_BASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
OLBAUDAY_BASE = "https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main"
MARTGRA_BASE = "https://raw.githubusercontent.com/martgra/fpl-timeseries-data/main"

# Cache duration in seconds — keeps API calls fast and avoids rate-limiting
CACHE_TTL = 3600

# Maps FPL element_type integer to human-readable position name
POSITION_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


# ============================================================================
# Shared HTTP Session — User-Agent + Retry Logic
# ============================================================================
#
# FPL occasionally blocks cloud-provider IPs (returning 503). The official
# FPL web app sends a browser User-Agent, so we mimic that. The retry
# adapter handles transient 5xx errors with exponential backoff.
# ---------------------------------------------------------------------------

def _build_session() -> requests.Session:
    """Create a requests Session with browser User-Agent and retry logic."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive"
    })
    retry = Retry(
        total=3,
        backoff_factor=1.0,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET"]
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


# Module-level session — reused across calls
_SESSION = _build_session()


# ============================================================================
# FPL Official API — Bootstrap Static
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def fetch_bootstrap_static() -> Dict[str, Any]:
    """Fetch the FPL bootstrap-static endpoint containing all players, teams,
       gameweek info, and meta-data for the current season."""
    try:
        resp = _SESSION.get(f"{FPL_BASE}/bootstrap-static/", timeout=20)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        st.error(f"Failed to fetch FPL bootstrap data: {e}")
        return {}


# ============================================================================
# Player & Team DataFrames
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def get_players_df() -> pd.DataFrame:
    """Return a pandas DataFrame of all FPL players with position names,
       full names, and prices converted from integer (x10) to millions."""
    data = fetch_bootstrap_static()
    if not data or "elements" not in data:
        return pd.DataFrame()
    df = pd.DataFrame(data["elements"])
    df["position_name"] = df["element_type"].map(POSITION_MAP)
    df["full_name"] = df["first_name"] + " " + df["second_name"]
    # FPL stores prices as integers (e.g. 85 = 8.5m)
    df["now_cost"] = df["now_cost"] / 10.0
    df["selling_price"] = df["selling_price"] / 10.0 if "selling_price" in df.columns else df["now_cost"]
    return df


@st.cache_data(ttl=CACHE_TTL)
def get_teams_df() -> pd.DataFrame:
    """Return a DataFrame of all 20 Premier League teams with strength ratings."""
    data = fetch_bootstrap_static()
    if not data or "teams" not in data:
        return pd.DataFrame()
    df = pd.DataFrame(data["teams"])
    df = df[["id", "name", "short_name", "strength", "strength_overall_home",
             "strength_overall_away", "strength_attack_home", "strength_attack_away",
             "strength_defence_home", "strength_defence_away"]]
    return df


# ============================================================================
# Fixtures
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def get_fixtures_df() -> pd.DataFrame:
    """Fetch all fixtures for the current season with difficulty ratings."""
    try:
        resp = _SESSION.get(f"{FPL_BASE}/fixtures/", timeout=15)
        resp.raise_for_status()
        fixtures = resp.json()
        df = pd.DataFrame(fixtures)
        if df.empty:
            return df
        df = df[["id", "event", "finished", "kickoff_time", "team_h", "team_a",
                  "team_h_difficulty", "team_a_difficulty", "team_h_score",
                  "team_a_score"]]
        df.rename(columns={
            "team_h": "home_team_id",
            "team_a": "away_team_id",
            "team_h_difficulty": "home_fdr",
            "team_a_difficulty": "away_fdr"
        }, inplace=True)
        return df
    except Exception as e:
        st.error(f"Failed to fetch fixtures: {e}")
        return pd.DataFrame()


# ============================================================================
# User Squad Data
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def get_user_team_info(team_id: int) -> Dict[str, Any]:
    """Fetch team meta-data from FPL API: name, rank, bank balance."""
    if not team_id or team_id <= 0:
        return {}
    try:
        resp = _SESSION.get(f"{FPL_BASE}/entry/{team_id}/", timeout=15)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        st.error(f"Failed to fetch team {team_id}: {e}")
        return {}


@st.cache_data(ttl=CACHE_TTL)
def get_user_picks(team_id: int, gameweek: int) -> Dict[str, Any]:
    """Fetch a user's squad picks and captain/vice selections for a given GW."""
    if not team_id or team_id <= 0:
        return {}
    try:
        resp = _SESSION.get(f"{FPL_BASE}/entry/{team_id}/event/{gameweek}/picks/", timeout=15)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        st.error(f"Failed to fetch picks for team {team_id} GW{gameweek}: {e}")
        return {}


# ============================================================================
# Player Detail Queries
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def get_player_history(player_id: int) -> pd.DataFrame:
    """Fetch a player's historical GW-by-GW performance data."""
    try:
        resp = _SESSION.get(f"{FPL_BASE}/element-summary/{player_id}/", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if "history" in data and data["history"]:
            return pd.DataFrame(data["history"])
        return pd.DataFrame()
    except Exception:
        return pd.DataFrame()


@st.cache_data(ttl=CACHE_TTL)
def get_upcoming_fixtures_for_player(player_id: int, n_fixtures: int = 5) -> pd.DataFrame:
    """Fetch a player's upcoming fixtures from the FPL element-summary endpoint."""
    try:
        resp = _SESSION.get(f"{FPL_BASE}/element-summary/{player_id}/", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if "fixtures" in data and data["fixtures"]:
            df = pd.DataFrame(data["fixtures"])
            return df.head(n_fixtures)
        return pd.DataFrame()
    except Exception:
        return pd.DataFrame()


# ============================================================================
# Open-Source GitHub Data Sources
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def fetch_github_csv(url: str) -> pd.DataFrame:
    """Generic fetcher for CSV files hosted on GitHub raw content URLs.
       Returns empty DataFrame on failure with a warning."""
    try:
        resp = _SESSION.get(url, timeout=20)
        resp.raise_for_status()
        return pd.read_csv(StringIO(resp.text))
    except Exception as e:
        st.warning(f"GitHub source unavailable ({url}): {e}")
        return pd.DataFrame()


@st.cache_data(ttl=CACHE_TTL)
def fetch_vaastav_historical(season: str = "2024-25") -> pd.DataFrame:
    """Fetch historical player data from the Vaastav FPL archive.
       Provides baseline minutes and performance metrics per season."""
    url = f"{VAASTAV}/{season}/players_raw.csv"
    return fetch_github_csv(url)


@st.cache_data(ttl=CACHE_TTL)
def fetch_olbauday_elo() -> pd.DataFrame:
    """Fetch team Elo ratings from the Olbauday FPL-Core-Insights repo."""
    url = f"{OLBAUDAY_BASE}/data/team_elo.csv"
    return fetch_github_csv(url)


@st.cache_data(ttl=CACHE_TTL)
def fetch_martgra_momentum() -> pd.DataFrame:
    """Fetch player momentum trends from the Martgra time-series dataset."""
    url = f"{MARTGRA_BASE}/data/player_momentum.csv"
    return fetch_github_csv(url)


# ============================================================================
# Derived Data Structures
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def build_fixture_difficulty_map(fixtures_df: pd.DataFrame, teams_df: pd.DataFrame) -> Dict[int, Dict[int, int]]:
    """Build a nested dict: {gameweek: {team_id: fdr}} for fast FDR lookups."""
    if fixtures_df.empty or teams_df.empty:
        return {}
    fdr_map = {}
    for _, row in fixtures_df.iterrows():
        gw = row.get("event")
        if gw is None:
            continue
        gw = int(gw)
        if gw not in fdr_map:
            fdr_map[gw] = {}
        home_id = int(row["home_team_id"])
        away_id = int(row["away_team_id"])
        home_fdr = int(row.get("home_fdr", 3))
        away_fdr = int(row.get("away_fdr", 3))
        fdr_map[gw][home_id] = home_fdr
        fdr_map[gw][away_id] = away_fdr
    return fdr_map


@st.cache_data(ttl=CACHE_TTL)
def get_current_gameweek() -> int:
    """Determine the current active gameweek from bootstrap event data."""
    data = fetch_bootstrap_static()
    if not data:
        return 1
    events = data.get("events", [])
    for ev in events:
        if ev.get("is_current"):
            return ev["id"]
    return 1


@st.cache_data(ttl=CACHE_TTL)
def get_squad_with_details(team_id: int, gameweek: int) -> pd.DataFrame:
    """Merge a user's squad picks with full player data for a given GW."""
    picks_data = get_user_picks(team_id, gameweek)
    players_df = get_players_df()
    if not picks_data or "picks" not in picks_data or players_df.empty:
        return pd.DataFrame()
    picks = picks_data["picks"]
    picks_df = pd.DataFrame(picks)
    merged = picks_df.merge(players_df, left_on="element", right_on="id", how="left")
    merged = merged.sort_values("position")
    return merged


# ============================================================================
# Live Gameweek Data & Price Changes
# ============================================================================

@st.cache_data(ttl=300)  # 5-min cache for live data
def fetch_live_data(gameweek: int) -> pd.DataFrame:
    """Fetch live GW element data (transfers, captain %, live points)."""
    try:
        resp = _SESSION.get(f"{FPL_BASE}/event/{gameweek}/live/", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if "elements" not in data:
            return pd.DataFrame()
        live = pd.DataFrame(data["elements"])
        return live
    except Exception:
        return pd.DataFrame()


@st.cache_data(ttl=CACHE_TTL)
def get_price_change_risks() -> pd.DataFrame:
    """
    Predict players likely to rise or fall in price based on net transfers.
    Merges bootstrap player data with live GW transfer counts to estimate
    who is approaching a price change threshold.
    FPL uses ~net transfers to trigger nightly price changes.
    """
    players = get_players_df()
    current_gw = get_current_gameweek()
    if players.empty or current_gw < 1:
        return pd.DataFrame()

    live = fetch_live_data(current_gw)
    if live.empty:
        return pd.DataFrame()

    # Merge live transfer data with player info
    merged = players.merge(live, left_on="id", right_on="id", how="inner")

    # Net transfers: (transfers_in - transfers_out) from this GW
    if "transfers_balance" in merged.columns:
        merged["net_transfers"] = merged["transfers_balance"].fillna(0).astype(int)
    elif "transfers_in_event" in merged.columns and "transfers_out_event" in merged.columns:
        merged["net_transfers"] = (
            merged["transfers_in_event"].fillna(0).astype(int) -
            merged["transfers_out_event"].fillna(0).astype(int)
        )
    else:
        merged["net_transfers"] = 0

    # FPL nightly change threshold: ~15,000-30,000 net transfers for a rise
    RISE_THRESHOLD = 15000
    FALL_THRESHOLD = -8000

    merged["risk"] = "stable"
    merged.loc[merged["net_transfers"] >= RISE_THRESHOLD * 0.7, "risk"] = "likely_rise"
    merged.loc[merged["net_transfers"] >= RISE_THRESHOLD, "risk"] = "rising_tonight"
    merged.loc[merged["net_transfers"] <= FALL_THRESHOLD * 0.7, "risk"] = "likely_fall"
    merged.loc[merged["net_transfers"] <= FALL_THRESHOLD, "risk"] = "falling_tonight"

    cols = ["id", "full_name", "position_name", "now_cost", "selected_by_percent",
            "net_transfers", "risk"]
    available = [c for c in cols if c in merged.columns]
    return merged[available].sort_values("net_transfers", ascending=False)


@st.cache_data(ttl=CACHE_TTL)
def get_player_ownership_df() -> pd.DataFrame:
    """Return players with ownership % from bootstrap static data."""
    players = get_players_df()
    if players.empty:
        return pd.DataFrame()
    cols = ["id", "full_name", "position_name", "now_cost",
            "selected_by_percent", "total_points", "form", "team"]
    available = [c for c in cols if c in players.columns]
    return players[available]


# ============================================================================
# Fixture Difficulty Ticker
# ============================================================================

@st.cache_data(ttl=CACHE_TTL)
def build_fixture_ticker(start_gw: int, n_gws: int = 8) -> pd.DataFrame:
    """
    Build a fixture difficulty ticker grid for all 20 teams over the next n_gws.
    Returns a DataFrame with columns: team, GW1_fdr, GW2_fdr, ..., GWn_fdr.
    FDR values are color-coded: 1-2=green, 3=gray, 4-5=red.
    """
    fixtures_df = get_fixtures_df()
    teams_df = get_teams_df()
    if fixtures_df.empty or teams_df.empty:
        return pd.DataFrame()

    ticker = {}
    for _, team in teams_df.iterrows():
        tid = int(team["id"])
        tname = team.get("short_name", team.get("name", f"T{tid}"))
        row = {"Team": tname, "team_id": tid}
        for gw in range(start_gw, start_gw + n_gws):
            fix = fixtures_df[
                ((fixtures_df["home_team_id"] == tid) |
                 (fixtures_df["away_team_id"] == tid)) &
                (fixtures_df["event"] == gw)
            ]
            if fix.empty:
                row[f"GW{gw}"] = 0  # Blank
                continue
            fix = fix.iloc[0]
            is_home = int(fix["home_team_id"]) == tid
            fdr = int(fix["home_fdr"]) if is_home else int(fix["away_fdr"])
            opp_id = int(fix["away_team_id"]) if is_home else int(fix["home_team_id"])
            opp_name = ""
            opp_row = teams_df[teams_df["id"] == opp_id]
            if not opp_row.empty:
                opp_name = opp_row.iloc[0].get("short_name", f"T{opp_id}")
            row[f"GW{gw}"] = fdr
            row[f"GW{gw}_opp"] = opp_name
            row[f"GW{gw}_h"] = "H" if is_home else "A"
        ticker[tname] = row

    return pd.DataFrame.from_dict(ticker, orient="index").reset_index(drop=True)


# ============================================================================
# System Status Monitor
# ============================================================================

def get_data_status() -> Dict[str, str]:
    """Quick connectivity check for all data sources.
       Returns status dict for the Streamlit sidebar status panel."""
    status = {}
    try:
        resp = _SESSION.get(f"{FPL_BASE}/bootstrap-static/", timeout=5)
        status["FPL API"] = "Connected" if resp.status_code == 200 else "Error"
    except Exception:
        status["FPL API"] = "Offline"
    try:
        resp = _SESSION.get(f"{FPL_BASE}/fixtures/", timeout=5)
        status["Fixtures"] = "Connected" if resp.status_code == 200 else "Error"
    except Exception:
        status["Fixtures"] = "Offline"
    status["Cache"] = "Active (TTL=3600s)"
    return status
