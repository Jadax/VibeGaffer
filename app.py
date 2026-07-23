"""
VibeGaffer | app.py (Streamlit Frontend)
Single-page dashboard with branded header, sidebar configuration,
executive recommendation banner, Plotly pitch visualizer, bench view,
and system status indicators.

Run: streamlit run app.py --server.port 8501

Author: Tushant Sharma | Astraiva
"""

import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from typing import Dict, List, Any

from data_loader import (
    get_players_df, get_teams_df, get_fixtures_df,
    get_user_team_info, get_squad_with_details,
    get_current_gameweek, get_data_status
)
from xp_engine import compute_all_players_xp, get_next_fixture_text
from optimizer import (
    solve_draft_squad, select_starting_xi, find_optimal_formation,
    solve_transfers, evaluate_chips, get_captain_choices
)

# ---------------------------------------------------------------------------
# Page Configuration
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="VibeGaffer | Astraiva",
    page_icon="⚽",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ---------------------------------------------------------------------------
# Color Palette
# ---------------------------------------------------------------------------

PITCH_GREEN = "#2E7D32"
PITCH_LIGHT = "#388E3C"
PITCH_LINES = "#4CAF50"
CARD_BG = "#1B5E20"
CARD_TEXT = "#FFFFFF"
GK_COLOR = "#FFC107"   # Amber
DEF_COLOR = "#2196F3"  # Blue
MID_COLOR = "#4CAF50"  # Green
FWD_COLOR = "#F44336"  # Red

POS_COLORS = {"GK": GK_COLOR, "DEF": DEF_COLOR, "MID": MID_COLOR, "FWD": FWD_COLOR}

# ---------------------------------------------------------------------------
# Formation Position Coords (normalized 0–1 for Plotly layout)
# ---------------------------------------------------------------------------

FORMATION_POSITIONS = {
    "GK": [(0.5, 0.08)],
    "DEF_3": [(0.17, 0.28), (0.5, 0.28), (0.83, 0.28)],
    "DEF_4": [(0.1, 0.28), (0.37, 0.28), (0.63, 0.28), (0.9, 0.28)],
    "DEF_5": [(0.05, 0.28), (0.27, 0.28), (0.5, 0.28), (0.73, 0.28), (0.95, 0.28)],
    "MID_3": [(0.17, 0.52), (0.5, 0.52), (0.83, 0.52)],
    "MID_4": [(0.1, 0.52), (0.37, 0.52), (0.63, 0.52), (0.9, 0.52)],
    "MID_5": [(0.05, 0.52), (0.27, 0.52), (0.5, 0.52), (0.73, 0.52), (0.95, 0.52)],
    "FWD_1": [(0.5, 0.78)],
    "FWD_2": [(0.3, 0.78), (0.7, 0.78)],
    "FWD_3": [(0.17, 0.78), (0.5, 0.78), (0.83, 0.78)]
}


# ============================================================================
# Branding — Header & Footer
# ============================================================================

def render_header():
    """Render the branded VibeGaffer header with Astraiva meta."""
    st.markdown("""
    <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                padding: 20px 30px; border-radius: 12px; margin-bottom: 20px;
                border: 1px solid #e94560;">
        <h1 style="color: #e94560; margin: 0; font-size: 2.5rem; font-weight: 800;">
            ⚽ VibeGaffer
        </h1>
        <p style="color: #a8a8b3; margin: 5px 0 0 0; font-size: 0.95rem;">
            Powered by <span style="color: #e94560; font-weight: 600;">Astraiva</span>
            &nbsp;|&nbsp; Author: <span style="color: #ffffff;">Tushant Sharma</span>
        </p>
    </div>
    """, unsafe_allow_html=True)


def render_footer():
    """Render the footer with copyright and metadata."""
    st.markdown("---")
    st.markdown("""
    <div style="text-align: center; padding: 15px; color: #666; font-size: 0.8rem;">
        <strong style="color: #e94560;">VibeGaffer</strong> v1.0 &nbsp;|&nbsp;
        &copy; 2025 <strong>Astraiva</strong> &nbsp;|&nbsp;
        Built by <strong>Tushant Sharma</strong>
        <br>
        <span style="font-size: 0.7rem; color: #999;">
            FPL optimization engine &bull; Data from official FPL API &amp; open-source community
        </span>
    </div>
    """, unsafe_allow_html=True)


# ============================================================================
# Sidebar — User Configuration
# ============================================================================

def render_sidebar() -> Dict[str, Any]:
    """Render the sidebar with Team ID input, GW selector, and data status.
       Returns a config dict consumed by run_optimization()."""
    st.sidebar.markdown("## 🎯 Configuration")

    # FPL Team ID
    team_id_input = st.sidebar.text_input("FPL Team ID", value="", placeholder="Enter your Team ID")
    try:
        team_id = int(team_id_input) if team_id_input.strip() else 0
    except ValueError:
        team_id = 0

    # Gameweek selector
    current_gw = get_current_gameweek()
    gameweek = st.sidebar.selectbox("Gameweek", range(1, 39), index=current_gw - 1)

    # Transfer settings
    free_transfers = st.sidebar.selectbox("Free Transfers", [1, 2], index=0)
    bank_override = st.sidebar.number_input(
        "Bank Override (£m)", min_value=0.0, max_value=100.0, value=0.0, step=0.1
    )

    # xP horizon
    horizon = st.sidebar.slider("xP Horizon (GWs)", 3, 5, 3)

    # Data status indicators
    st.sidebar.markdown("---")
    st.sidebar.markdown("### 📡 Data Status")
    status = get_data_status()
    for source, state in status.items():
        icon = "🟢" if state in ("Connected", "Active (TTL=3600s)") else "🔴"
        st.sidebar.markdown(f"{icon} **{source}**: {state}")

    # Action button
    st.sidebar.markdown("---")
    fetch_clicked = st.sidebar.button("🚀 Fetch & Optimize", use_container_width=True)

    return {
        "team_id": team_id,
        "gameweek": gameweek,
        "free_transfers": free_transfers,
        "bank_override": bank_override if bank_override > 0 else None,
        "horizon": horizon,
        "fetch_clicked": fetch_clicked
    }


# ============================================================================
# Executive Recommendation Banner
# ============================================================================

def render_recommendation_banner(result: Dict[str, Any]):
    """Render the top-level recommendation cards: mode, transfers, hit cost, xP gain,
       transfer IN/OUT lists, captain picks, and chip advice."""
    mode = result.get("mode", "draft")
    st.markdown("### 📋 Executive Recommendation")

    # Summary metrics row
    cols = st.columns(4)
    with cols[0]:
        st.metric("Mode", "Draft Squad" if mode == "draft" else "Transfer Advisor")
    with cols[1]:
        transfers_in = result.get("transfers_in", [])
        n_transfers = len(transfers_in)
        st.metric("Transfers", n_transfers)
    with cols[2]:
        hit = result.get("hit_cost", 0)
        st.metric("Hit Cost", f"-{hit} pts" if hit > 0 else "None")
    with cols[3]:
        net = result.get("net_after_hit", result.get("total_xp", 0))
        st.metric("Net xP Gain", f"+{net:.1f}" if net > 0 else f"{net:.1f}")

    # Transfers IN cards
    if result.get("transfers_in"):
        st.markdown("#### 🔄 Transfers IN")
        t_cols = st.columns(min(len(result["transfers_in"]), 4))
        for i, p in enumerate(result["transfers_in"]):
            with t_cols[i % len(t_cols)]:
                st.markdown(f"""
                <div style="background: #1a472a; padding: 10px; border-radius: 8px;
                            border-left: 4px solid #4CAF50; margin-bottom: 5px;">
                    <strong style="color: #4CAF50;">{p.get('name', 'Unknown')}</strong><br>
                    <span style="color: #aaa; font-size: 0.8rem;">
                        {p.get('position', '')} &bull; £{p.get('price', 0):.1f}m &bull;
                        xP: {p.get('total_xp', 0):.1f}
                    </span>
                </div>
                """, unsafe_allow_html=True)

    # Transfers OUT cards
    if result.get("transfers_out"):
        st.markdown("#### 📤 Transfers OUT")
        t_cols = st.columns(min(len(result["transfers_out"]), 4))
        for i, p in enumerate(result["transfers_out"]):
            with t_cols[i % len(t_cols)]:
                st.markdown(f"""
                <div style="background: #4a1a1a; padding: 10px; border-radius: 8px;
                            border-left: 4px solid #F44336; margin-bottom: 5px;">
                    <strong style="color: #F44336;">{p.get('name', 'Unknown')}</strong><br>
                    <span style="color: #aaa; font-size: 0.8rem;">
                        {p.get('position', '')} &bull; £{p.get('price', 0):.1f}m
                    </span>
                </div>
                """, unsafe_allow_html=True)

    # Captain / Vice-Captain
    captain = result.get("captain_choices", {}).get("captain")
    vice = result.get("captain_choices", {}).get("vice_captain")
    if captain or vice:
        st.markdown("#### 🏅 Captaincy")
        c_cols = st.columns(2)
        with c_cols[0]:
            if captain:
                st.markdown(f"""
                <div style="background: linear-gradient(135deg, #1a472a, #2E7D32);
                            padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 0.7rem; color: #FFC107;">CAPTAIN (C)</div>
                    <div style="font-size: 1.1rem; font-weight: bold; color: white;">
                        {captain.get('name', 'N/A')}
                    </div>
                    <div style="font-size: 0.8rem; color: #aaa;">
                        {captain.get('position', '')} &bull; xP: {captain.get('xp', 0):.1f}
                    </div>
                </div>
                """, unsafe_allow_html=True)
        with c_cols[1]:
            if vice:
                st.markdown(f"""
                <div style="background: linear-gradient(135deg, #1a3a4a, #1565C0);
                            padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 0.7rem; color: #64B5F6;">VICE-CAPTAIN (V)</div>
                    <div style="font-size: 1.1rem; font-weight: bold; color: white;">
                        {vice.get('name', 'N/A')}
                    </div>
                    <div style="font-size: 0.8rem; color: #aaa;">
                        {vice.get('position', '')} &bull; xP: {vice.get('xp', 0):.1f}
                    </div>
                </div>
                """, unsafe_allow_html=True)

    # Chip Advice
    chip_advice = result.get("chip_advice", {})
    if chip_advice:
        st.markdown("#### 💎 Chip Advice")
        chip_cols = st.columns(4)
        chip_names = {
            "triple_captain": ("TC", "#FFC107"),
            "bench_boost": ("BB", "#2196F3"),
            "wildcard": ("WC", "#4CAF50"),
            "free_hit": ("FH", "#F44336")
        }
        for i, (key, (label, color)) in enumerate(chip_names.items()):
            with chip_cols[i]:
                advice = chip_advice.get(key, {})
                recommend = advice.get("recommend", False)
                status_text = "PLAY NOW!" if recommend else "Hold"
                status_color = "#4CAF50" if recommend else "#999"
                st.markdown(f"""
                <div style="background: #1a1a2e; padding: 10px; border-radius: 8px;
                            text-align: center; border: 2px solid {color if recommend else '#333'};">
                    <div style="font-size: 1.2rem; font-weight: bold; color: {color};">{label}</div>
                    <div style="font-size: 0.85rem; color: {status_color}; font-weight: bold;">
                        {status_text}
                    </div>
                    <div style="font-size: 0.7rem; color: #888; margin-top: 4px;">
                        {advice.get('reason', '')}
                    </div>
                </div>
                """, unsafe_allow_html=True)


# ============================================================================
# Pitch Visualizer
# ============================================================================

def draw_pitch():
    """
    Draw a green football pitch using Plotly shapes.
    Includes center line, center circle, penalty areas, and goal areas.
    Returns a Plotly Figure.
    """
    fig = go.Figure()

    # Pitch outline
    fig.add_shape(type="rect", x0=0, x1=100, y0=0, y1=100,
                  line=dict(color=PITCH_LINES, width=2),
                  fillcolor=PITCH_GREEN)

    # Center line & circle
    fig.add_shape(type="line", x0=0, x1=100, y0=50, y1=50,
                  line=dict(color=PITCH_LINES, width=1))
    fig.add_shape(type="circle", x0=44, x1=56, y0=44, y1=56,
                  line=dict(color=PITCH_LINES, width=1))

    # Penalty areas
    fig.add_shape(type="rect", x0=18, x1=82, y0=0, y1=16,
                  line=dict(color=PITCH_LINES, width=1))
    fig.add_shape(type="rect", x0=18, x1=82, y0=84, y1=100,
                  line=dict(color=PITCH_LINES, width=1))

    # Goal areas
    fig.add_shape(type="rect", x0=36, x1=64, y0=0, y1=6,
                  line=dict(color=PITCH_LINES, width=1))
    fig.add_shape(type="rect", x0=36, x1=64, y0=94, y1=100,
                  line=dict(color=PITCH_LINES, width=1))

    # Lock axes
    fig.update_xaxes(visible=False, range=[-2, 102])
    fig.update_yaxes(visible=False, range=[-2, 102])

    fig.update_layout(
        plot_bgcolor="rgba(0,0,0,0)",
        paper_bgcolor="rgba(0,0,0,0)",
        margin=dict(l=0, r=0, t=10, b=10),
        height=550,
        showlegend=False
    )
    return fig


def render_pitch(starting_xi: List[Dict], formation: Dict[str, int]):
    """
    Place player cards on the pitch in their correct formation positions.
    Cards show name, position, club, and xP.
    Uses color-coded annotations by position (GK=Amber, DEF=Blue, MID=Green, FWD=Red).
    """
    fig = draw_pitch()

    # Separate players by position
    gk_players = [p for p in starting_xi if p.get("position_id") == 1 or p.get("position") == "GK"]
    def_players = [p for p in starting_xi if p.get("position_id") == 2 or p.get("position") == "DEF"]
    mid_players = [p for p in starting_xi if p.get("position_id") == 3 or p.get("position") == "MID"]
    fwd_players = [p for p in starting_xi if p.get("position_id") == 4 or p.get("position") == "FWD"]

    # Get formation counts
    def n_def():
        return formation.get("DEF", len(def_players))
    def n_mid():
        return formation.get("MID", len(mid_players))
    def n_fwd():
        return formation.get("FWD", len(fwd_players))

    position_groups = [
        (gk_players[:1], "GK"),
        (def_players[:n_def()], f"DEF_{n_def()}"),
        (mid_players[:n_mid()], f"MID_{n_mid()}"),
        (fwd_players[:n_fwd()], f"FWD_{n_fwd()}")
    ]

    for players, pos_key in position_groups:
        coords = FORMATION_POSITIONS.get(pos_key, [])
        for i, player in enumerate(players):
            if i >= len(coords):
                break
            cx, cy = coords[i]
            x_px = cx * 100
            y_py = cy * 100

            # Use surname if full name is too long
            name = player.get("name", "Unknown")
            if len(name) > 14:
                parts = name.split()
                name = parts[-1] if parts else name[:14]

            pos = player.get("position", "")
            xp = player.get("total_xp", 0)
            color = POS_COLORS.get(pos, "#666")

            # Add player annotation on pitch
            fig.add_annotation(
                x=x_px, y=y_py,
                text=f"<b>{name}</b><br>{pos} | xP:{xp:.1f}",
                showarrow=False,
                font=dict(color=CARD_TEXT, size=9),
                bgcolor=color,
                borderpad=4,
                borderwidth=1,
                bordercolor="white",
                opacity=0.92
            )

    st.plotly_chart(fig, use_container_width=True)


# ============================================================================
# Bench View
# ============================================================================

def render_bench(bench: List[Dict]):
    """Render the 4 bench players in priority order with color-coded cards."""
    if not bench:
        return

    st.markdown("### 🪑 Bench (Priority Order)")
    bench_cols = st.columns(min(len(bench), 4))

    for i, player in enumerate(bench):
        with bench_cols[i % len(bench_cols)]:
            name = player.get("name", "Unknown")
            pos = player.get("position", "")
            xp = player.get("total_xp", 0)
            price = player.get("price", player.get("now_cost", 0))
            color = POS_COLORS.get(pos, "#666")

            st.markdown(f"""
            <div style="background: {color}; padding: 12px; border-radius: 8px;
                        text-align: center; color: white; margin-bottom: 8px;">
                <div style="font-size: 0.7rem; opacity: 0.8;">BENCH {i+1}</div>
                <div style="font-weight: bold; font-size: 1rem;">{name}</div>
                <div style="font-size: 0.8rem; opacity: 0.9;">
                    {pos} &bull; £{price:.1f}m &bull; xP: {xp:.1f}
                </div>
            </div>
            """, unsafe_allow_html=True)


# ============================================================================
# Core Optimization Runner
# ============================================================================

def run_optimization(config: Dict[str, Any]):
    """
    Run the full optimization pipeline based on sidebar config.
    Dispatches to Mode A (draft) or Mode B (transfers) depending on context.
    Stores result in st.session_state so page re-renders don't re-trigger the solver.
    """
    team_id = config["team_id"]
    gameweek = config["gameweek"]
    free_transfers = config["free_transfers"]
    bank_override = config["bank_override"]
    horizon = config["horizon"]

    # Step 1: Compute xP for all players (most expensive step, cached with TTL)
    with st.spinner("Computing xP projections across all players..."):
        xp_df = compute_all_players_xp(gameweek, horizon)

    if xp_df.empty:
        st.error("Failed to compute xP data. Check your internet connection and try again.")
        return

    # Step 2: Determine mode and run optimization
    if team_id <= 0 or gameweek == 1:
        # === Mode A: GW1 Draft Builder ===
        with st.spinner("Solving draft optimization (PuLP ILP)..."):
            result = solve_draft_squad(xp_df, 100.0)

        if result["status"] != "optimal":
            st.error(f"Optimization failed: {result.get('message', 'Unknown error')}")
            return

        starting, bench = select_starting_xi(result["squad"])
        formation = find_optimal_formation(starting)
        captain_choices = get_captain_choices(starting)
        fixtures_df = get_fixtures_df()
        chip_advice = evaluate_chips(result["squad"], starting, bench, gameweek, fixtures_df)

        full_result = {
            "mode": "draft",
            "gameweek": gameweek,
            "total_cost": result["total_cost"],
            "budget_remaining": result["budget_remaining"],
            "total_xp": result["total_xp"],
            "formation": formation,
            "starting_xi": starting,
            "bench": bench,
            "captain_choices": captain_choices,
            "chip_advice": chip_advice,
            "transfers_in": [],
            "transfers_out": [],
            "hit_cost": 0,
            "net_after_hit": result["total_xp"]
        }

    else:
        # === Mode B: Transfer Advisor ===
        team_info = get_user_team_info(team_id)
        if not team_info:
            st.error(f"Team ID {team_id} not found. Check your FPL Team ID.")
            return

        current_squad = get_squad_with_details(team_id, gameweek)
        if current_squad.empty:
            st.error("Could not fetch current squad. Try a different gameweek.")
            return

        bank = bank_override if bank_override else team_info.get("last_deadline_bank", 0) / 10.0

        with st.spinner("Solving transfer optimization (PuLP ILP)..."):
            result = solve_transfers(current_squad, xp_df, bank, free_transfers, horizon)

        if result["status"] != "optimal":
            st.error("Transfer optimization failed.")
            return

        best = result["best_plan"]
        out_ids = [p["id"] for p in best.get("transfers_out", [])]

        # Build projected squad after transfers
        full_squad_data = []
        for _, row in current_squad.iterrows():
            pid = int(row.get("element", 0))
            if pid not in out_ids:  # Retain this player
                player_data = row.to_dict()
                xp_match = xp_df[xp_df["id"] == pid]
                if not xp_match.empty:
                    player_data["total_xp"] = float(xp_match.iloc[0]["total_xp"])
                    player_data["name"] = xp_match.iloc[0].get("name",
                                                              player_data.get("web_name", ""))
                    player_data["position"] = xp_match.iloc[0].get("position",
                                                                   player_data.get("position_name", ""))
                full_squad_data.append(player_data)

        for p_in in best.get("transfers_in", []):
            full_squad_data.append(p_in)

        starting, bench = select_starting_xi(full_squad_data)
        formation = find_optimal_formation(starting)
        captain_choices = get_captain_choices(starting)
        fixtures_df = get_fixtures_df()
        chip_advice = evaluate_chips(full_squad_data, starting, bench, gameweek, fixtures_df)

        full_result = {
            "mode": "transfer",
            "gameweek": gameweek,
            "team_id": team_id,
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
            "chip_advice": chip_advice
        }

    # Store result in session state to survive re-renders
    st.session_state["result"] = full_result


# ============================================================================
# Main App Entry Point
# ============================================================================

def main():
    """Main Streamlit app orchestrator."""
    render_header()
    config = render_sidebar()

    # Run optimization when user clicks the button
    if config["fetch_clicked"]:
        run_optimization(config)

    # Render the current result (persists across re-renders via session state)
    result = st.session_state.get("result")

    if result:
        # Executive banner: transfers, captain, chips
        render_recommendation_banner(result)
        st.markdown("---")

        # Pitch visualizer with formation
        starting = result.get("starting_xi", [])
        formation = result.get("formation", {"DEF": 4, "MID": 4, "FWD": 2})
        if starting:
            st.markdown(f"""
            <div style="text-align: center; margin-bottom: 10px;">
                <h3 style="color: #4CAF50;">
                    ⚽ Starting XI &nbsp;
                    <span style="color: #aaa; font-size: 0.9rem;">
                        ({formation.get('DEF', 0)}-{formation.get('MID', 0)}-{formation.get('FWD', 0)})
                    </span>
                </h3>
            </div>
            """, unsafe_allow_html=True)
            render_pitch(starting, formation)

        # Bench
        bench = result.get("bench", [])
        if bench:
            render_bench(bench)

        # Summary info
        if result.get("mode") == "draft":
            st.info(f"""
            **Draft Summary**: Total Cost £{result.get('total_cost', 0):.1f}m | \
            Budget Remaining £{result.get('budget_remaining', 0):.1f}m | \
            Total Squad xP: {result.get('total_xp', 0):.1f}
            """)
        else:
            # Transfer plan comparison (0/1/2)
            plans = result.get("all_plans_summary", {})
            if plans:
                st.markdown("#### 📊 Transfer Plan Comparison")
                plan_cols = st.columns(len(plans))
                for i, (k, v) in enumerate(sorted(plans.items())):
                    with plan_cols[i]:
                        label = f"{k} transfer{'s' if k != '1' else ''}"
                        net = v.get("net_after_hit", 0)
                        hit = v.get("hit_cost", 0)
                        st.markdown(f"""
                        <div style="background: #1a1a2e; padding: 10px; border-radius: 8px;
                                    text-align: center;
                                    border: 2px solid {'#4CAF50' if net >= 0 else '#F44336'};">
                            <div style="color: #aaa; font-size: 0.8rem;">{label}</div>
                            <div style="color: {'#4CAF50' if net >= 0 else '#F44336'};
                                        font-size: 1.2rem; font-weight: bold;">
                                {net:+.1f} pts
                            </div>
                            <div style="color: #888; font-size: 0.7rem;">
                                Hit: -{hit} pts
                            </div>
                        </div>
                        """, unsafe_allow_html=True)

    else:
        # Welcome screen when no result yet
        st.markdown("""
        <div style="text-align: center; padding: 60px 20px; color: #888;">
            <div style="font-size: 4rem;">⚽</div>
            <h2 style="color: #e94560;">Welcome to VibeGaffer</h2>
            <p>Enter your <strong>FPL Team ID</strong> in the sidebar and select a <strong>Gameweek</strong>,
            then click <strong>"Fetch & Optimize"</strong> to get your personalized recommendations.</p>
            <p style="font-size: 0.85rem; color: #666;">
                Leave Team ID blank for <strong>GW1 Draft Mode</strong> — builds a full squad from scratch.
            </p>
        </div>
        """, unsafe_allow_html=True)

    render_footer()


if __name__ == "__main__":
    main()
