"""
VibeGaffer | app.py (Streamlit Frontend)
Premium dark-themed fantasy football dashboard.
Features: pitch visualizer, player comparison radar, price change predictor,
fixture ticker, differential picks finder, chip advisor, transfer optimizer.

Run: streamlit run app.py --server.port 8501

Author: Tushant Sharma | Astraiva
"""

import streamlit as st
import pandas as pd
import numpy as np
import plotly.graph_objects as go
from typing import Dict, List, Any

from data_loader import (
    get_players_df, get_teams_df, get_fixtures_df,
    get_user_team_info, get_squad_with_details,
    get_current_gameweek, get_data_status,
    get_price_change_risks, build_fixture_ticker, fetch_live_data
)
from xp_engine import (
    compute_all_players_xp, get_next_fixture_text, get_differential_picks,
    compute_player_form, compute_multi_gw_xp
)
from optimizer import (
    solve_draft_squad, select_starting_xi, find_optimal_formation,
    solve_transfers, evaluate_chips, get_captain_choices
)

# ---------------------------------------------------------------------------
# Page Configuration
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="VibeGaffer — FPL Intelligence",
    page_icon="⚽",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ---------------------------------------------------------------------------
# Global CSS Injection — The entire UI skin
# ---------------------------------------------------------------------------

def inject_css():
    st.markdown("""
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');

    /* ---- Root overrides ---- */
    html, body, [class*="st-"] {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    /* Full page dark bg */
    .stApp { background: radial-gradient(ellipse at top, #0f0f23 0%, #08080f 70%); }

    /* ---- Hide ALL Streamlit chrome (top bar, GitHub link, Share, Manage app, etc.) ---- */
    #MainMenu { visibility: hidden !important; }
    header [data-testid="stToolbar"] { display: none !important; }
    [data-testid="stToolbar"] { display: none !important; }
    [data-testid="stDecoration"] { display: none !important; }
    [data-testid="stStatusWidget"] { display: none !important; }
    .viewerBadge_link__qRIco,
    .viewerBadge_container__r5tak,
    [class*="viewerBadge"] { display: none !important; }
    footer { visibility: hidden !important; }
    [data-testid="stFooter"] { display: none !important; }
    /* Hide "Manage app" button and all streamlit.io links */
    [data-testid="stAppDeployButton"] { display: none !important; }
    [data-testid="baseButton-headerNoPadding"] { display: none !important; }
    .stAppDeployButton { display: none !important; }
    a[href*="streamlit.io"] { display: none !important; }
    [class*="manageApp"],
    [class*="ManageApp"],
    [class*="deployButton"],
    [class*="DeployButton"],
    button[title*="Manage"],
    button[aria-label*="Manage"],
    [data-testid*="manage"],
    [data-testid*="deploy"] { display: none !important; }
    /* Hide error page elements */
    .stException { display: none !important; }
    [data-testid="stException"] { display: none !important; }
    /* Nuclear option: hide entire header bar on error pages */
    header { display: none !important; height: 0 !important; min-height: 0 !important; }
    /* Ultra-aggressive: hide ANY button or link with "Manage" or "Deploy" text */
    button:has(span:contains("Manage")),
    a:has(span:contains("Manage")),
    [class*="appDeploy"],
    [class*="AppDeploy"],
    [data-testid="stAppDeployButton"] { display: none !important; visibility: hidden !important; }
    /* Hide the error overlay completely if it appears */
    [data-testid="stErrorDialog"] { display: none !important; }
    [role="dialog"] { display: none !important; }
    .stAlert:has(.vg-loader) { display: block !important; }

    /* Sidebar */
    [data-testid="stSidebar"] {
        background: linear-gradient(180deg, #0c0c1d 0%, #08080f 100%);
        border-right: 1px solid rgba(255,255,255,0.06);
    }
    [data-testid="stSidebar"] h2 { color: #00ff87 !important; font-weight: 700; }
    [data-testid="stSidebar"] label { color: #aaa !important; font-weight: 500; }

    /* Buttons */
    .stButton > button {
        background: linear-gradient(135deg, #00ff87 0%, #00cc6a 100%) !important;
        color: #08080f !important;
        border: none !important;
        border-radius: 10px !important;
        font-weight: 700 !important;
        font-size: 15px !important;
        letter-spacing: 0.3px !important;
        padding: 10px 24px !important;
        transition: all 0.2s ease !important;
        box-shadow: 0 0 20px rgba(0,255,135,0.15) !important;
    }
    .stButton > button:hover {
        transform: translateY(-2px) !important;
        box-shadow: 0 0 30px rgba(0,255,135,0.35) !important;
    }

    /* Select boxes & inputs */
    [data-testid="stSelectbox"] > div > div, .stTextInput > div > div > input {
        border-radius: 8px !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        background: rgba(255,255,255,0.03) !important;
    }

    /* Sliders */
    [data-testid="stSlider"] .st-ae { background: #00ff87 !important; }

    /* Metrics */
    [data-testid="stMetric"] {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 12px;
        padding: 12px 16px !important;
        backdrop-filter: blur(8px);
    }
    [data-testid="stMetric"] label { color: #888 !important; font-weight: 500; }
    [data-testid="stMetric"] [data-testid="stMetricValue"] {
        color: #00ff87 !important;
        font-weight: 800 !important;
    }

    /* Tabs */
    [data-testid="stTabs"] button {
        font-weight: 600 !important;
        border-radius: 10px 10px 0 0 !important;
    }
    .stTabs [aria-selected="true"] {
        color: #00ff87 !important;
        border-bottom: 3px solid #00ff87 !important;
    }

    /* Dataframes */
    [data-testid="stDataFrame"] {
        border-radius: 12px !important;
        overflow: hidden !important;
        border: 1px solid rgba(255,255,255,0.06) !important;
    }

    /* Spinner */
    .stSpinner > div { border-color: #00ff87 transparent transparent transparent !important; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

    /* ---- Custom glass card ---- */
    .glass-card {
        background: linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        padding: 20px 24px;
        backdrop-filter: blur(20px);
        transition: all 0.3s ease;
    }
    .glass-card:hover {
        border-color: rgba(0,255,135,0.3);
        box-shadow: 0 8px 32px rgba(0,255,135,0.08);
        transform: translateY(-2px);
    }

    /* ---- Hero header ---- */
    .hero-header {
        background: linear-gradient(135deg, rgba(0,255,135,0.05) 0%, rgba(124,58,237,0.05) 50%, rgba(6,182,212,0.05) 100%);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 18px;
        padding: 24px 32px;
        margin-bottom: 24px;
        position: relative;
        overflow: hidden;
    }
    .hero-header::before {
        content: '';
        position: absolute;
        top: -50%;
        left: -50%;
        width: 200%;
        height: 200%;
        background: conic-gradient(from 0deg, transparent, rgba(0,255,135,0.03), transparent, rgba(124,58,237,0.03), transparent);
        animation: heroSpin 20s linear infinite;
    }
    @keyframes heroSpin { 100% { transform: rotate(360deg); } }
    .hero-header > * { position: relative; z-index: 1; }

    /* ---- Neon badge ---- */
    .neon-badge {
        display: inline-block;
        padding: 4px 14px;
        border-radius: 20px;
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .neon-badge-green {
        background: rgba(0,255,135,0.12);
        color: #00ff87;
        border: 1px solid rgba(0,255,135,0.25);
    }
    .neon-badge-red {
        background: rgba(255,71,87,0.12);
        color: #ff4757;
        border: 1px solid rgba(255,71,87,0.25);
    }
    .neon-badge-amber {
        background: rgba(255,193,7,0.12);
        color: #ffc107;
        border: 1px solid rgba(255,193,7,0.25);
    }

    /* ---- Custom animated loader (replaces ugly st.spinner) ---- */
    .vg-loader {
        display: flex; align-items: center; justify-content: center;
        gap: 14px; padding: 28px; margin: 20px 0;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(0,255,135,0.15);
        border-radius: 14px;
    }
    .vg-loader-text {
        color: #ddd; font-weight: 600; font-size: 0.95rem;
        letter-spacing: 0.3px;
    }
    .vg-loader-spinner {
        width: 28px; height: 28px;
        border: 3px solid rgba(0,255,135,0.15);
        border-top-color: #00ff87;
        border-radius: 50%;
        animation: vg-spin 0.8s linear infinite;
    }
    .vg-loader-bar {
        display: inline-block; width: 4px; height: 18px;
        background: #00ff87; margin: 0 2px;
        border-radius: 2px;
        animation: vg-bounce 1.2s ease-in-out infinite;
    }
    .vg-loader-bar:nth-child(2) { animation-delay: 0.15s; }
    .vg-loader-bar:nth-child(3) { animation-delay: 0.3s; }
    .vg-loader-bar:nth-child(4) { animation-delay: 0.45s; }
    @keyframes vg-spin { to { transform: rotate(360deg); } }
    @keyframes vg-bounce {
        0%, 100% { transform: scaleY(0.4); opacity: 0.4; }
        50% { transform: scaleY(1); opacity: 1; }
    }

    /* ---- Hide Streamlit's default spinners and status widgets ---- */
    [data-testid="stSpinner"] { display: none !important; }
    .stSpinner { display: none !important; }
    .stAlert:has(.vg-loader) { background: transparent !important; }

    /* ---- Premium pitch visualizer ---- */
    .vg-pitch-wrap {
        position: relative; width: 100%;
        background: #1a472a;
        border-radius: 14px;
        overflow: hidden;
        box-shadow:
            inset 0 0 60px rgba(0,0,0,0.35),
            0 8px 32px rgba(0,0,0,0.5),
            0 0 0 1px rgba(255,255,255,0.05);
        margin: 16px 0;
    }
    .vg-pitch {
        position: relative; width: 100%;
        aspect-ratio: 68 / 105;
        background:
            repeating-linear-gradient(
                0deg,
                #2d8a3e 0px, #2d8a3e 60px,
                #1e6b2c 60px, #1e6b2c 120px
            );
    }
    .vg-pitch-line {
        position: absolute; border: 1.5px solid rgba(255,255,255,0.55);
        pointer-events: none;
    }
    .vg-pitch-center-line { top: 50%; left: 0; right: 0; height: 0; }
    .vg-pitch-center-circle {
        top: 50%; left: 50%; width: 18%; aspect-ratio: 1;
        transform: translate(-50%, -50%);
        border-radius: 50%;
    }
    .vg-pitch-center-dot {
        top: 50%; left: 50%; width: 6px; height: 6px;
        transform: translate(-50%, -50%);
        background: rgba(255,255,255,0.55);
        border: none; border-radius: 50%;
    }
    .vg-pitch-penalty-top {
        top: 0; left: 18%; right: 18%; height: 16%;
        border-bottom: 0;
    }
    .vg-pitch-penalty-bot {
        bottom: 0; left: 18%; right: 18%; height: 16%;
        border-top: 0;
    }
    .vg-pitch-six-top {
        top: 0; left: 36%; right: 36%; height: 6%;
        border-bottom: 0;
    }
    .vg-pitch-six-bot {
        bottom: 0; left: 36%; right: 36%; height: 6%;
        border-top: 0;
    }
    .vg-pitch-arc-top {
        top: 14%; left: 30%; right: 30%; height: 8%;
        border: 0; border-top: 1.5px solid rgba(255,255,255,0.55);
        border-radius: 50% 50% 0 0 / 100% 100% 0 0;
    }
    .vg-pitch-arc-bot {
        bottom: 14%; left: 30%; right: 30%; height: 8%;
        border: 0; border-bottom: 1.5px solid rgba(255,255,255,0.55);
        border-radius: 0 0 50% 50% / 0 0 100% 100%;
    }
    .vg-pitch-corner {
        position: absolute; width: 8px; height: 8px;
        border: 1.5px solid rgba(255,255,255,0.55);
        border-radius: 50%;
    }
    .vg-pitch-corner.tl { top: -1px; left: -1px; }
    .vg-pitch-corner.tr { top: -1px; right: -1px; }
    .vg-pitch-corner.bl { bottom: -1px; left: -1px; }
    .vg-pitch-corner.br { bottom: -1px; right: -1px; }

    /* ---- Player card on pitch ---- */
    .vg-player {
        position: absolute;
        transform: translate(-50%, -50%);
        min-width: 90px; max-width: 110px;
        padding: 8px 10px;
        border-radius: 10px;
        color: #fff;
        text-align: center;
        font-family: 'Inter', sans-serif;
        box-shadow:
            0 4px 12px rgba(0,0,0,0.45),
            0 0 0 1.5px rgba(255,255,255,0.25);
        backdrop-filter: blur(4px);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        cursor: default;
    }
    .vg-player:hover {
        transform: translate(-50%, -50%) scale(1.08);
        box-shadow:
            0 8px 24px rgba(0,0,0,0.6),
            0 0 0 2px rgba(255,255,255,0.4);
        z-index: 10;
    }
    .vg-player.gk { background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%); color: #1a1a2e; }
    .vg-player.def { background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%); }
    .vg-player.mid { background: linear-gradient(135deg, #00ff87 0%, #00cc6a 100%); color: #1a1a2e; }
    .vg-player.fwd { background: linear-gradient(135deg, #ff4757 0%, #d63031 100%); }
    .vg-player-name {
        font-size: 0.78rem; font-weight: 700; line-height: 1.1;
        margin-bottom: 3px;
    }
    .vg-player-xp {
        font-size: 0.62rem; font-weight: 600; opacity: 0.9;
    }

    /* ---- Transfer cards ---- */
    .transfer-in {
        background: linear-gradient(135deg, rgba(0,255,135,0.08), rgba(0,255,135,0.02));
        border: 1px solid rgba(0,255,135,0.15);
        border-left: 4px solid #00ff87;
        border-radius: 10px;
        padding: 12px 16px;
        margin-bottom: 8px;
    }
    .transfer-out {
        background: linear-gradient(135deg, rgba(255,71,87,0.08), rgba(255,71,87,0.02));
        border: 1px solid rgba(255,71,87,0.15);
        border-left: 4px solid #ff4757;
        border-radius: 10px;
        padding: 12px 16px;
        margin-bottom: 8px;
    }

    /* ---- Pulse animation ---- */
    @keyframes pulse-glow {
        0%, 100% { box-shadow: 0 0 8px rgba(0,255,135,0.3); }
        50% { box-shadow: 0 0 24px rgba(0,255,135,0.6); }
    }
    .pulse-glow {
        animation: pulse-glow 2s ease-in-out infinite;
    }

    /* ---- Chip badge ---- */
    .chip-card {
        background: rgba(255,255,255,0.03);
        border: 2px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        padding: 16px;
        text-align: center;
        transition: all 0.3s ease;
    }
    .chip-card.active {
        border-color: rgba(0,255,135,0.4);
        box-shadow: 0 0 20px rgba(0,255,135,0.10);
    }

    /* ---- Captain cards ---- */
    .captain-card {
        background: linear-gradient(135deg, rgba(0,255,135,0.10), rgba(0,255,135,0.02));
        border: 1px solid rgba(0,255,135,0.2);
        border-radius: 14px;
        padding: 18px;
        text-align: center;
    }
    .vice-card {
        background: linear-gradient(135deg, rgba(6,182,212,0.10), rgba(6,182,212,0.02));
        border: 1px solid rgba(6,182,212,0.2);
        border-radius: 14px;
        padding: 18px;
        text-align: center;
    }

    /* ---- FDR ticker ---- */
    .fdr-cell {
        border-radius: 4px;
        padding: 6px 10px;
        text-align: center;
        font-size: 0.72rem;
        font-weight: 600;
        color: #fff;
    }
    .fdr-1 { background: #2d7a2d; }
    .fdr-2 { background: #5baa3a; }
    .fdr-3 { background: #666666; }
    .fdr-4 { background: #c0392b; }
    .fdr-5 { background: #8b0000; }
    .fdr-blank { background: #1a1a2e; opacity: 0.4; color: #555; }

    /* ---- Price change ---- */
    .price-rise { color: #00ff87; font-weight: 600; }
    .price-fall { color: #ff4757; font-weight: 600; }
    .price-stable { color: #888; }

    /* ---- Welcome hero ---- */
    .welcome-card {
        text-align: center;
        padding: 80px 40px;
        background: linear-gradient(180deg, rgba(0,255,135,0.03) 0%, transparent 100%);
        border-radius: 20px;
        border: 1px solid rgba(255,255,255,0.05);
    }

    /* ---- Bench ---- */
    .bench-card {
        border-radius: 10px;
        padding: 14px;
        text-align: center;
        color: white;
        margin-bottom: 8px;
        border: 1px solid rgba(255,255,255,0.1);
    }

    /* ---- Section titles ---- */
    .section-title {
        color: #fff;
        font-weight: 800;
        border-left: 4px solid #00ff87;
        padding-left: 14px;
        margin: 24px 0 16px 0;
    }

    /* ---- Subtitle ---- */
    .subtitle {
        color: #888;
        font-size: 0.82rem;
        font-weight: 400;
        margin-bottom: 16px;
    }
    </style>
    """, unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Color Palette
# ---------------------------------------------------------------------------

PITCH_GREEN = "#0a4a0a"
PITCH_LINES = "rgba(255,255,255,0.08)"
GK_COLOR = "#ffc107"
DEF_COLOR = "#2196F3"
MID_COLOR = "#00ff87"
FWD_COLOR = "#ff4757"

POS_COLORS = {"GK": GK_COLOR, "DEF": DEF_COLOR, "MID": MID_COLOR, "FWD": FWD_COLOR}
POS_EMOJI = {"GK": "🧤", "DEF": "🛡️", "MID": "⚡", "FWD": "🎯"}
POS_ICONS_HTML = {"GK": "&#x1F9E4;", "DEF": "&#x1F6E1;", "MID": "&#x26A1;", "FWD": "&#x1F3AF;"}

FDR_COLORS = {1: "#2d7a2d", 2: "#5baa3a", 3: "#555", 4: "#c0392b", 5: "#8b0000", 0: "#1a1a2e"}

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
# Branding
# ============================================================================

def render_loader(text: str):
    """Render a custom animated loader (replaces Streamlit's default spinner)."""
    st.markdown(f"""
    <div class="vg-loader">
        <div class="vg-loader-spinner"></div>
        <div class="vg-loader-text">{text}</div>
    </div>
    """, unsafe_allow_html=True)


def render_header():
    st.markdown("""
    <div class="hero-header">
        <div style="display: flex; align-items: center; justify-content: space-between;">
            <div>
                <h1 style="color: #00ff87; margin: 0; font-size: 2.6rem; font-weight: 900; letter-spacing: -0.5px;">
                    ⚽ VibeGaffer
                </h1>
                <p style="color: #999; margin: 6px 0 0 0; font-size: 0.9rem; font-weight: 400;">
                    <span style="color: #7c3aed; font-weight: 700;">Astraiva</span>
                    &nbsp;·&nbsp;
                    <span style="color: #ddd;">Tushant Sharma</span>
                    &nbsp;·&nbsp;
                    <span style="color: #666;">FPL Intelligence Engine</span>
                </p>
            </div>
            <div style="text-align: right;">
                <span class="neon-badge neon-badge-green pulse-glow" style="font-size:0.8rem;">v1.3 LIVE</span>
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)


def render_footer():
    st.markdown("---")
    st.markdown("""
    <div style="text-align: center; padding: 20px; color: #555; font-size: 0.75rem;">
        <strong style="color: #00ff87;">VibeGaffer</strong> &nbsp;·&nbsp;
        &copy; 2025 <strong style="color: #7c3aed;">Astraiva</strong> &nbsp;·&nbsp;
        Built by <strong style="color: #ddd;">Tushant Sharma</strong>
        <br><span style="color: #444;">FPL optimization &bull; official API &amp; open-source data</span>
    </div>
    """, unsafe_allow_html=True)


# ============================================================================
# Sidebar
# ============================================================================

def render_sidebar() -> Dict[str, Any]:
    st.sidebar.markdown("""
    <div style="text-align:center; margin-bottom:16px;">
        <span style="font-size:1.8rem; font-weight:900; color:#00ff87;">⚽ VibeGaffer</span>
    </div>
    """, unsafe_allow_html=True)

    team_id_input = st.sidebar.text_input("FPL Team ID", value="", placeholder="Enter your Team ID")
    try:
        team_id = int(team_id_input) if team_id_input.strip() else 0
    except ValueError:
        team_id = 0

    current_gw = get_current_gameweek()
    gameweek = st.sidebar.selectbox("Gameweek", range(1, 39), index=current_gw - 1)
    free_transfers = st.sidebar.selectbox("Free Transfers", [1, 2], index=0)
    bank_override = st.sidebar.number_input("Bank Override (£m)", min_value=0.0, max_value=100.0, value=0.0, step=0.1)
    horizon = st.sidebar.slider("xP Horizon (GWs)", 3, 5, 3)

    st.sidebar.markdown("---")
    st.sidebar.markdown("### 🔌 Data Status")
    status = get_data_status()
    for source, state in status.items():
        icon = "🟢" if state in ("Connected", "Active (TTL=3600s)") else "🔴"
        st.sidebar.markdown(f"{icon} **{source}**: {state}")

    st.sidebar.markdown("---")
    fetch_clicked = st.sidebar.button("🚀 Fetch & Optimize", use_container_width=True)

    if not team_id:
        st.sidebar.caption("💡 *Leave blank for GW1 Draft Mode*")

    return {
        "team_id": team_id, "gameweek": gameweek,
        "free_transfers": free_transfers, "bank_override": bank_override if bank_override > 0 else None,
        "horizon": horizon, "fetch_clicked": fetch_clicked
    }


# ============================================================================
# Executive Recommendation Banner
# ============================================================================

def render_recommendation_banner(result: Dict[str, Any]):
    mode = result.get("mode", "draft")
    st.markdown('<div class="section-title">📋 Executive Recommendation</div>', unsafe_allow_html=True)

    cols = st.columns(4)
    mode_label = "Draft" if mode == "draft" else "Transfer"
    mode_color = "#00ff87" if mode == "draft" else "#7c3aed"
    transfers_count = len(result.get("transfers_in", []))
    hit = result.get("hit_cost", 0)
    hit_label = f"-{hit} pts" if hit > 0 else "✓ None"
    net = result.get("net_after_hit", result.get("total_xp", 0))
    net_label = f"+{net:.1f}" if net > 0 else f"{net:.1f}"

    metric_cards = [
        ("MODE", mode_label, mode_color),
        ("Transfers", str(transfers_count), "#00ff87"),
        ("Hit Cost", hit_label, "#00ff87" if hit == 0 else "#ff4757"),
        ("Net xP Gain", net_label, "#00ff87" if net >= 0 else "#ff4757"),
    ]

    for i, (label, value, color) in enumerate(metric_cards):
        with cols[i]:
            st.markdown(f"""
            <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
                        border-radius: 12px; padding: 16px; height: 80px;
                        display: flex; flex-direction: column; justify-content: center;">
                <div style="color: #888; font-size: 0.75rem; font-weight: 600;
                            text-transform: uppercase; letter-spacing: 0.5px;">{label}</div>
                <div style="color: {color}; font-size: 1.8rem; font-weight: 800;
                            margin-top: 2px; line-height: 1.1;">{value}</div>
            </div>
            """, unsafe_allow_html=True)

    # Transfers
    transfers_in = result.get("transfers_in", [])
    transfers_out = result.get("transfers_out", [])
    if transfers_in or transfers_out:
        t_cols = st.columns(2)
        with t_cols[0]:
            st.markdown("#### 🔄 Transfers IN")
            for p in transfers_in:
                st.markdown(f"""
                <div class="transfer-in">
                    <strong style="color:#00ff87;">{p.get('name','Unknown')}</strong>
                    <span style="color:#aaa;font-size:0.78rem;float:right;">+xP {p.get('total_xp',0):.1f}</span><br>
                    <span style="color:#777;font-size:0.72rem;">
                        {p.get('position','')} · £{p.get('price',0):.1f}m
                    </span>
                </div>
                """, unsafe_allow_html=True)
        with t_cols[1]:
            st.markdown("#### 📤 Transfers OUT")
            for p in transfers_out:
                st.markdown(f"""
                <div class="transfer-out">
                    <strong style="color:#ff4757;">{p.get('name','Unknown')}</strong>
                    <span style="color:#aaa;font-size:0.78rem;float:right;">-£{p.get('price',0):.1f}m</span><br>
                    <span style="color:#777;font-size:0.72rem;">{p.get('position','')}</span>
                </div>
                """, unsafe_allow_html=True)

    # Captaincy
    captain = result.get("captain_choices", {}).get("captain")
    vice = result.get("captain_choices", {}).get("vice_captain")
    if captain or vice:
        st.markdown("#### 🏅 Captaincy")
        cc = st.columns(2)
        with cc[0]:
            if captain:
                st.markdown(f"""
                <div class="captain-card pulse-glow">
                    <div style="font-size:0.7rem;color:#ffc107;font-weight:700;letter-spacing:1px;">★ CAPTAIN</div>
                    <div style="font-size:1.2rem;font-weight:800;color:#fff;margin:6px 0;">{captain.get('name','N/A')}</div>
                    <div style="font-size:0.78rem;color:#aaa;">{captain.get('position','')} · xP <span style="color:#00ff87;font-weight:700;">{captain.get('xp',0):.1f}</span></div>
                </div>
                """, unsafe_allow_html=True)
        with cc[1]:
            if vice:
                st.markdown(f"""
                <div class="vice-card">
                    <div style="font-size:0.7rem;color:#06b6d4;font-weight:700;letter-spacing:1px;">☆ VICE-CAPTAIN</div>
                    <div style="font-size:1.2rem;font-weight:800;color:#fff;margin:6px 0;">{vice.get('name','N/A')}</div>
                    <div style="font-size:0.78rem;color:#aaa;">{vice.get('position','')} · xP <span style="color:#06b6d4;font-weight:700;">{vice.get('xp',0):.1f}</span></div>
                </div>
                """, unsafe_allow_html=True)

    # Chip Advice
    chip_advice = result.get("chip_advice", {})
    if chip_advice:
        st.markdown("#### 💎 Chip Advice")
        chips = [
            ("TC", "#ffc107", chip_advice.get("triple_captain", {})),
            ("BB", "#2196F3", chip_advice.get("bench_boost", {})),
            ("WC", "#7c3aed", chip_advice.get("wildcard", {})),
            ("FH", "#ff4757", chip_advice.get("free_hit", {}))
        ]
        cc = st.columns(4)
        for i, (label, accent, advice) in enumerate(chips):
            rec = advice.get("recommend", False)
            with cc[i]:
                cls = "active pulse-glow" if rec else ""
                st.markdown(f"""
                <div class="chip-card {cls}" style="border-color:{accent if rec else 'rgba(255,255,255,0.08)'};">
                    <div style="font-size:1.4rem;font-weight:900;color:{accent};">{label}</div>
                    <div style="font-size:0.8rem;font-weight:700;color:{'#00ff87' if rec else '#666'};margin:4px 0;">
                        {'PLAY NOW!' if rec else 'Hold'}
                    </div>
                    <div style="font-size:0.68rem;color:#777;">{advice.get('reason','')}</div>
                </div>
                """, unsafe_allow_html=True)


# ============================================================================
# Pitch Visualizer
# ============================================================================

def draw_pitch_html():
    """Return the HTML for a realistic football pitch with grass stripes,
       proper markings, penalty boxes, six-yard boxes, center circle, and arcs."""
    return """
    <div class="vg-pitch-wrap">
        <div class="vg-pitch">
            <div class="vg-pitch-line vg-pitch-center-line"></div>
            <div class="vg-pitch-line vg-pitch-center-circle"></div>
            <div class="vg-pitch-line vg-pitch-center-dot"></div>
            <div class="vg-pitch-line vg-pitch-penalty-top"></div>
            <div class="vg-pitch-line vg-pitch-penalty-bot"></div>
            <div class="vg-pitch-line vg-pitch-six-top"></div>
            <div class="vg-pitch-line vg-pitch-six-bot"></div>
            <div class="vg-pitch-line vg-pitch-arc-top"></div>
            <div class="vg-pitch-line vg-pitch-arc-bot"></div>
            <div class="vg-pitch-corner tl"></div>
            <div class="vg-pitch-corner tr"></div>
            <div class="vg-pitch-corner bl"></div>
            <div class="vg-pitch-corner br"></div>
    """


def render_pitch(starting_xi: List[Dict], formation: Dict[str, int]):
    """
    Render a premium football pitch with player cards positioned in formation.
    Uses pure HTML/CSS for realistic grass texture, proper markings, and
    shadowed player cards with hover effects.
    """
    gk_players = [p for p in starting_xi if p.get("position_id") == 1 or p.get("position") == "GK"]
    def_players = [p for p in starting_xi if p.get("position_id") == 2 or p.get("position") == "DEF"]
    mid_players = [p for p in starting_xi if p.get("position_id") == 3 or p.get("position") == "MID"]
    fwd_players = [p for p in starting_xi if p.get("position_id") == 4 or p.get("position") == "FWD"]
    nd, nm, nf = formation.get("DEF", len(def_players)), formation.get("MID", len(mid_players)), formation.get("FWD", len(fwd_players))

    # Player positions (x% from left, y% from top) — attacking from bottom up
    GK_Y = 92
    DEF_Y = 75
    MID_Y = 50
    FWD_Y = 25

    def x_positions(n, x_min=8, x_max=92):
        if n == 1: return [50]
        return [x_min + (x_max - x_min) * i / (n - 1) for i in range(n)]

    groups = [
        (gk_players[:1], "gk", GK_Y, x_positions(1)),
        (def_players[:nd], "def", DEF_Y, x_positions(nd)),
        (mid_players[:nm], "mid", MID_Y, x_positions(nm)),
        (fwd_players[:nf], "fwd", FWD_Y, x_positions(nf))
    ]

    html = draw_pitch_html()
    for players, pos_class, y_pct, x_coords in groups:
        for i, player in enumerate(players):
            if i >= len(x_coords): break
            name = player.get("name", "Unknown")
            # Use last name for compactness
            parts = name.split()
            short_name = parts[-1] if len(parts) > 1 else name
            if len(short_name) > 10:
                short_name = short_name[:10]
            xp = player.get("total_xp", 0)
            html += f"""
                <div class="vg-player {pos_class}" style="left:{x_coords[i]}%; top:{y_pct}%;">
                    <div class="vg-player-name">{short_name}</div>
                    <div class="vg-player-xp">xP {xp:.1f}</div>
                </div>
            """
    html += "</div></div>"
    st.markdown(html, unsafe_allow_html=True)


def render_bench(bench: List[Dict]):
    if not bench: return
    st.markdown("#### 🪑 Bench (Priority Order)")
    bc = st.columns(min(len(bench), 4))
    for i, player in enumerate(bench):
        with bc[i]:
            name = player.get("name", "Unknown")
            pos = player.get("position", "")
            xp = player.get("total_xp", 0)
            price = player.get("price", player.get("now_cost", 0))
            color = POS_COLORS.get(pos, "#666")
            st.markdown(f"""
            <div class="bench-card" style="background:{color};">
                <div style="font-size:0.62rem;opacity:0.7;font-weight:600;">BENCH {i+1}</div>
                <div style="font-weight:800;font-size:0.92rem;">{name}</div>
                <div style="font-size:0.7rem;opacity:0.85;">{pos} · £{price:.1f}m · xP {xp:.1f}</div>
            </div>
            """, unsafe_allow_html=True)


# ============================================================================
# Player Comparison (Radar + Table)
# ============================================================================

def render_player_comparison(gameweek: int, horizon: int):
    st.markdown('<div class="section-title">🔍 Player Comparison</div>', unsafe_allow_html=True)
    st.markdown('<p class="subtitle">Compare up to 3 players on 6 key metrics — radar chart + stat table</p>', unsafe_allow_html=True)

    players_df = get_players_df()
    if players_df.empty:
        st.warning("Player data unavailable.")
        return

    player_names = sorted(players_df["full_name"].tolist())
    selected = st.multiselect(
        "Search & select players to compare (max 3):",
        options=player_names, max_selections=3,
        placeholder="Start typing player name..."
    )

    if not selected:
        st.info("Select 2-3 players above to compare their projected stats.")
        return

    fig = go.Figure()
    for pname in selected:
        match = players_df[players_df["full_name"] == pname]
        if match.empty: continue
        pid = int(match.iloc[0]["id"])
        xp_data = compute_multi_gw_xp(pid, gameweek, horizon)
        form = compute_player_form(pid)
        avg_fdr = sum(g.get("fdr", 3) for g in xp_data.get("gw_details", [])) / max(len(xp_data.get("gw_details", [])), 1)

        vals = [
            round(xp_data.get("total_xp", 0), 1),
            round(form.get("form_ppg", 0), 1),
            round(form.get("minutes_avg", 0), 0) / 90,
            round(xp_data["player_info"]["price"], 1),
            round(xp_data.get("total_xp", 0) / max(xp_data["player_info"]["price"], 4.0), 2),
            round(avg_fdr, 1)
        ]
        labels = ["Total xP", "Form PPG", "Mins/90", "Price (£m)", "xP/£m", "Avg FDR"]
        vals += vals[:1]
        labels += labels[:1]
        fig.add_trace(go.Scatterpolar(r=vals, theta=labels, fill="toself", name=pname,
                       line=dict(width=2)))

    fig.update_layout(
        polar=dict(
            radialaxis=dict(visible=True, gridcolor="rgba(255,255,255,0.08)",
                          tickfont=dict(color="#888", size=9)),
            bgcolor="rgba(0,0,0,0)"
        ),
        paper_bgcolor="rgba(0,0,0,0)",
        font=dict(color="#ddd"),
        height=440, margin=dict(l=40, r=40, t=20, b=20)
    )
    st.plotly_chart(fig, use_container_width=True)

    if len(selected) >= 2:
        st.markdown("#### 📊 Stat Table")
        rows = []
        for pname in selected:
            match = players_df[players_df["full_name"] == pname]
            if match.empty: continue
            pid = int(match.iloc[0]["id"])
            xp_data = compute_multi_gw_xp(pid, gameweek, horizon)
            form = compute_player_form(pid)
            fixt = get_next_fixture_text(xp_data.get("gw_details", []))
            rows.append({
                "Player": pname, "Pos": xp_data["player_info"]["position"],
                "Price": f"£{xp_data['player_info']['price']:.1f}m",
                "xP": f"{xp_data.get('total_xp', 0):.1f}",
                "Form": f"{form.get('form_ppg', 0):.1f}",
                "xP/£m": f"{xp_data.get('total_xp', 0) / max(xp_data['player_info']['price'], 4.0):.2f}",
                "Next": fixt
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)


# ============================================================================
# Price Change Predictor
# ============================================================================

def render_price_changes():
    st.markdown('<div class="section-title">💷 Price Change Predictor</div>', unsafe_allow_html=True)
    st.markdown('<p class="subtitle">Who rises or falls tonight? FPL price changes trigger ~01:00 GMT based on net transfers.</p>', unsafe_allow_html=True)

    risks = get_price_change_risks()
    if risks.empty:
        st.warning("Price change data unavailable. Try during an active gameweek.")
        return

    rising = risks[risks["risk"].isin(["rising_tonight", "likely_rise"])].head(10)
    falling = risks[risks["risk"].isin(["falling_tonight", "likely_fall"])].head(10)

    c1, c2 = st.columns(2)
    with c1:
        st.markdown("#### 🔺 Likely Risers")
        if rising.empty:
            st.info("No clear risers.")
        else:
            for _, row in rising.iterrows():
                badge = '<span class="neon-badge neon-badge-green pulse-glow">RISING</span>' if row["risk"] == "rising_tonight" else '<span class="neon-badge neon-badge-green">Likely</span>'
                st.markdown(f"""
                <div class="glass-card" style="padding:10px 16px;border-left:3px solid #00ff87;margin-bottom:6px;">
                    <strong style="color:#fff;">{row.get('full_name','N/A')}</strong>
                    {badge}
                    <br><span style="color:#777;font-size:0.7rem;">
                        {row.get('position_name','')} · £{row.get('now_cost',0):.1f}m · +{row.get('net_transfers',0):,} net
                    </span>
                </div>
                """, unsafe_allow_html=True)
    with c2:
        st.markdown("#### 🔻 Likely Fallers")
        if falling.empty:
            st.info("No clear fallers.")
        else:
            for _, row in falling.iterrows():
                badge = '<span class="neon-badge neon-badge-red pulse-glow">FALLING</span>' if row["risk"] == "falling_tonight" else '<span class="neon-badge neon-badge-red">Likely</span>'
                st.markdown(f"""
                <div class="glass-card" style="padding:10px 16px;border-left:3px solid #ff4757;margin-bottom:6px;">
                    <strong style="color:#fff;">{row.get('full_name','N/A')}</strong>
                    {badge}
                    <br><span style="color:#777;font-size:0.7rem;">
                        {row.get('position_name','')} · £{row.get('now_cost',0):.1f}m · {row.get('net_transfers',0):,} net
                    </span>
                </div>
                """, unsafe_allow_html=True)


# ============================================================================
# Fixture Difficulty Ticker
# ============================================================================

def render_fixture_ticker(gameweek: int):
    st.markdown('<div class="section-title">📅 Fixture Difficulty Ticker</div>', unsafe_allow_html=True)
    st.markdown(f'<p class="subtitle">Next 8 gameweeks starting GW{gameweek}. Green = easy · Red = hard · Shows opponent & venue.</p>', unsafe_allow_html=True)

    ticker = build_fixture_ticker(gameweek, 8)
    if ticker.empty:
        st.warning("Fixture data unavailable.")
        return

    gw_cols = sorted([c for c in ticker.columns if c.startswith("GW") and not c.endswith("_opp") and not c.endswith("_h")],
                     key=lambda x: int(x.replace("GW", "")))

    html = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.72rem;"><tr style="background:rgba(255,255,255,0.03);">'
    html += '<th style="padding:8px 10px;text-align:left;color:#00ff87;font-weight:700;">Team</th>'
    for gw in gw_cols:
        gn = gw.replace("GW", "")
        html += f'<th style="padding:6px 8px;text-align:center;color:#aaa;font-weight:600;">GW{gn}</th>'
    html += '</tr>'

    for _, row in ticker.iterrows():
        html += '<tr>'
        html += f'<td style="padding:6px 10px;font-weight:700;color:#ccc;">{row["Team"]}</td>'
        for gw in gw_cols:
            fdr = int(row.get(gw, 3))
            opp_key = gw + "_opp"
            h_key = gw + "_h"
            opp = row.get(opp_key, "")
            venue = row.get(h_key, "")
            cls = f"fdr-{fdr}" if fdr > 0 else "fdr-blank"
            label = f"{opp} {venue}" if opp else "—"
            html += f'<td style="padding:3px 5px;"><div class="fdr-cell {cls}">{label}</div></td>'
        html += '</tr>'
    html += '</table></div>'
    st.markdown(html, unsafe_allow_html=True)
    st.caption("FDR: 1–2 = easy (green) · 3 = neutral · 4–5 = hard (red) · H = Home · A = Away · — = Blank")


# ============================================================================
# Differential Picks
# ============================================================================

def render_differential_picks(gameweek: int, horizon: int):
    st.markdown('<div class="section-title">💎 Differential Picks</div>', unsafe_allow_html=True)
    st.markdown('<p class="subtitle">Low ownership (<5%) + high projected xP. Hidden gems to climb the ranks.</p>', unsafe_allow_html=True)

    diffs = get_differential_picks(gameweek, horizon, max_ownership=5.0, min_xp=8.0)
    if diffs.empty:
        st.warning("Differential data unavailable.")
        return

    teams_df = get_teams_df()
    team_map = dict(zip(teams_df["id"], teams_df["short_name"])) if not teams_df.empty else {}
    diffs["Team"] = diffs["team_id"].map(team_map).fillna("?")

    display = diffs.rename(columns={
        "name": "Player", "position": "Pos", "price": "Price",
        "total_xp": "xP", "xp_per_price": "xP/£m",
        "ownership": "Own%", "minutes_prob": "Mins%"
    })
    cols = ["Player", "Pos", "Team", "Price", "xP", "xP/£m", "Own%", "Mins%"]
    available = [c for c in cols if c in display.columns]
    st.dataframe(
        display[available],
        column_config={
            "Own%": st.column_config.NumberColumn(format="%.1f%%"),
            "Price": st.column_config.NumberColumn(format="£%.1fm"),
            "xP": st.column_config.NumberColumn(format="%.1f"),
            "xP/£m": st.column_config.NumberColumn(format="%.2f"),
            "Mins%": st.column_config.NumberColumn(format="%.0f%%")
        },
        use_container_width=True, hide_index=True
    )


# ============================================================================
# Optimization Runner
# ============================================================================

def run_optimization(config: Dict[str, Any]):
    team_id = config["team_id"]
    gameweek = config["gameweek"]
    free_transfers = config["free_transfers"]
    bank_override = config["bank_override"]
    horizon = config["horizon"]

    try:
        _run_optimization_inner(team_id, gameweek, free_transfers, bank_override, horizon)
    except Exception as e:
        st.error(f"⚠️ Optimization failed: {type(e).__name__}: {e}")
        st.info("Try a different gameweek, or check your internet connection.")


def _run_optimization_inner(team_id, gameweek, free_transfers, bank_override, horizon):

    loader = st.empty()
    loader.markdown("""
    <div class="vg-loader">
        <div class="vg-loader-spinner"></div>
        <div class="vg-loader-text">Computing xP projections across all players...</div>
    </div>
    """, unsafe_allow_html=True)
    xp_df = compute_all_players_xp(gameweek, horizon)
    loader.empty()
    if xp_df.empty:
        st.error("Failed to compute xP data. Check your internet connection.")
        return

    if team_id <= 0 or gameweek == 1:
        loader.markdown("""
        <div class="vg-loader">
            <div class="vg-loader-spinner"></div>
            <div class="vg-loader-text">Solving draft squad optimization...</div>
        </div>
        """, unsafe_allow_html=True)
        result = solve_draft_squad(xp_df, 100.0)
        loader.empty()
        if result["status"] != "optimal":
            st.error(f"Optimization failed: {result.get('message', 'Unknown error')}")
            return
        starting, bench = select_starting_xi(result["squad"])
        formation = find_optimal_formation(starting)
        captain_choices = get_captain_choices(starting)
        fixtures_df = get_fixtures_df()
        chip_advice = evaluate_chips(result["squad"], starting, bench, gameweek, fixtures_df)
        full_result = {
            "mode": "draft", "gameweek": gameweek,
            "total_cost": result["total_cost"], "budget_remaining": result["budget_remaining"],
            "total_xp": result["total_xp"], "formation": formation,
            "starting_xi": starting, "bench": bench,
            "captain_choices": captain_choices, "chip_advice": chip_advice,
            "transfers_in": [], "transfers_out": [], "hit_cost": 0,
            "net_after_hit": result["total_xp"]
        }
    else:
        team_info = get_user_team_info(team_id)
        if not team_info:
            st.error(f"Team ID {team_id} not found. Check your FPL Team ID.")
            return
        current_squad = get_squad_with_details(team_id, gameweek)
        if current_squad.empty:
            st.error("Could not fetch current squad. Try a different gameweek.")
            return
        bank = bank_override if bank_override else team_info.get("last_deadline_bank", 0) / 10.0
        loader.markdown("""
        <div class="vg-loader">
            <div class="vg-loader-spinner"></div>
            <div class="vg-loader-text">Solving transfer optimization...</div>
        </div>
        """, unsafe_allow_html=True)
        result = solve_transfers(current_squad, xp_df, bank, free_transfers, horizon)
        loader.empty()
        if result["status"] != "optimal":
            st.error("Transfer optimization failed.")
            return
        best = result["best_plan"]
        out_ids = [p["id"] for p in best.get("transfers_out", [])]
        full_squad_data = []
        for _, row in current_squad.iterrows():
            pid = int(row.get("element", 0))
            if pid not in out_ids:
                player_data = row.to_dict()
                xp_match = xp_df[xp_df["id"] == pid]
                if not xp_match.empty:
                    player_data["total_xp"] = float(xp_match.iloc[0]["total_xp"])
                    player_data["name"] = xp_match.iloc[0].get("name", player_data.get("web_name", ""))
                    player_data["position"] = xp_match.iloc[0].get("position", player_data.get("position_name", ""))
                full_squad_data.append(player_data)
        for p_in in best.get("transfers_in", []):
            full_squad_data.append(p_in)
        starting, bench = select_starting_xi(full_squad_data)
        formation = find_optimal_formation(starting)
        captain_choices = get_captain_choices(starting)
        fixtures_df = get_fixtures_df()
        chip_advice = evaluate_chips(full_squad_data, starting, bench, gameweek, fixtures_df)
        full_result = {
            "mode": "transfer", "gameweek": gameweek, "team_id": team_id,
            "recommended_transfers": result["recommended_transfers"],
            "transfers_in": best.get("transfers_in", []),
            "transfers_out": best.get("transfers_out", []),
            "hit_cost": best.get("hit_cost", 0),
            "net_xp_gain": best.get("net_xp_gain", 0),
            "net_after_hit": best.get("net_after_hit", 0),
            "bank": round(bank, 1), "formation": formation,
            "starting_xi": starting, "bench": bench,
            "captain_choices": captain_choices, "chip_advice": chip_advice
        }

    st.session_state["result"] = full_result


# ============================================================================
# Main
# ============================================================================

def main():
    inject_css()
    render_header()
    config = render_sidebar()

    if config["fetch_clicked"]:
        run_optimization(config)

    result = st.session_state.get("result")

    if result:
        tabs = st.tabs([
            "📋 Squad & Pitch",
            "🔍 Compare",
            "💷 Prices",
            "📅 Fixtures",
            "💎 Differentials"
        ])

        with tabs[0]:
            render_recommendation_banner(result)
            st.markdown("---")
            starting = result.get("starting_xi", [])
            formation = result.get("formation", {"DEF": 4, "MID": 4, "FWD": 2})
            if starting:
                st.markdown(f"""
                <div style="text-align:center;margin-bottom:12px;">
                    <span style="font-size:1.3rem;font-weight:800;color:#00ff87;">⚽ Starting XI</span>
                    <span style="color:#666;font-size:0.85rem;margin-left:8px;">
                        {formation.get('DEF',0)}-{formation.get('MID',0)}-{formation.get('FWD',0)}
                    </span>
                </div>
                """, unsafe_allow_html=True)
                render_pitch(starting, formation)
            bench = result.get("bench", [])
            if bench:
                render_bench(bench)
            if result.get("mode") == "draft":
                st.info(f"**Draft**: £{result.get('total_cost',0):.1f}m spent · £{result.get('budget_remaining',0):.1f}m left · Squad xP: {result.get('total_xp',0):.1f}")

        with tabs[1]:
            render_player_comparison(config["gameweek"], config["horizon"])

        with tabs[2]:
            render_price_changes()

        with tabs[3]:
            render_fixture_ticker(config["gameweek"])

        with tabs[4]:
            render_differential_picks(config["gameweek"], config["horizon"])

    else:
        st.markdown("""
        <div class="welcome-card">
            <div style="font-size:4.5rem;margin-bottom:16px;">⚽</div>
            <h2 style="color:#00ff87;font-weight:800;margin-bottom:8px;">Welcome to VibeGaffer</h2>
            <p style="color:#aaa;font-size:1.05rem;max-width:500px;margin:0 auto 8px auto;">
                Your <strong style="color:#fff;">FPL intelligence engine</strong> — squad optimization,
                transfer recommendations, price predictions, fixture analysis & more.
            </p>
            <p style="color:#666;font-size:0.85rem;">
                Enter your <strong style="color:#7c3aed;">FPL Team ID</strong> in the sidebar →
                select a gameweek, then hit <strong style="color:#00ff87;">Fetch & Optimize</strong>.
            </p>
            <p style="color:#555;font-size:0.75rem;">
                No Team ID? Leave it blank for <strong>GW1 Draft Mode</strong> — builds a 15-player squad from scratch.
            </p>
        </div>
        """, unsafe_allow_html=True)

    render_footer()


if __name__ == "__main__":
    main()
