# VibeGaffer

**FPL Optimization Engine** | Powered by [Astraiva](https://astraiva.com) | Author: Tushant Sharma

---

## Overview

VibeGaffer is a Fantasy Premier League (FPL) optimization tool that combines multi-source data ingestion, mathematical expected-points ($xP$) projection, and integer linear programming (ILP) to deliver actionable weekly transfer, captaincy, and chip recommendations.

### Dual-Mode Workflow

| Mode | Trigger | Description |
|------|---------|-------------|
| **A: Draft Builder** | GW1 selected or no Team ID | Builds a full 15-player squad from scratch under £100m budget |
| **B: Transfer Advisor** | Valid FPL Team ID + GW2+ | Recommends 0/1/2 transfers with hit-cost analysis over a rolling 3–5 GW horizon |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   app.py (Streamlit)                 │
│   Pitch Visualizer │ Sidebar │ Session State │ UI    │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                 backend.py (FastAPI)                  │
│   REST Endpoints │ CORS │ Optimization Orchestration │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
┌───────┴──────┐ ┌─────┴──────┐ ┌────┴───────┐
│ data_loader  │ │ xp_engine  │ │ optimizer  │
│ Multi-source │ │ xP Math    │ │ PuLP ILP   │
│ Fetch + Cache│ │ Projections│ │ + Chips    │
└──────────────┘ └────────────┘ └────────────┘
```

### Data Sources (100% Free)

| Source | Data |
|--------|------|
| **FPL Official API** | Bootstrap static, fixtures, FDR, player availability, user squad |
| **Vaastav FPL Archive** | Historical player performance CSVs |
| **Olbauday Core Insights** | Team Elo ratings |
| **Martgra Time Series** | Multi-week momentum trends |

---

## File Structure

```
VibeGaffer/
├── README.md           # This file
├── requirements.txt    # Python dependencies
├── data_loader.py      # Multi-source data fetchers with @st.cache_data
├── xp_engine.py        # Expected Points mathematical engine
├── optimizer.py        # PuLP ILP solver + chip decision matrix
├── backend.py          # FastAPI backend (port 8000)
└── app.py              # Streamlit frontend (port 8501)
```

---

## Setup & Installation

### Prerequisites

- Python 3.10+
- pip
- Git

### Clone the Repository

```bash
git clone https://github.com/Jadax/VibeGaffer.git
cd VibeGaffer
```

### Install Dependencies

```bash
pip install -r requirements.txt
```

---

## Running the Application

### Terminal 1: Start the Backend (FastAPI)

```bash
uvicorn backend:app --host 0.0.0.0 --port 8000 --reload
```

### Terminal 2: Start the Frontend (Streamlit)

```bash
streamlit run app.py --server.port 8501
```

Then open **http://localhost:8501** in your browser.

---

## Features

### Executive Recommendation Banner
- Transfer IN/OUT cards with price and xP
- Captain / Vice-Captain picks
- Chip advice (TC, BB, WC, FH) with trigger reasoning

### Pitch Visualizer
- Interactive Plotly-based tactical pitch
- Formation-aware player positioning (3-4-3, 4-4-2, 4-3-3, etc.)
- Color-coded position cards (GK/DEF/MID/FWD)
- Player name, position, and xP on each card

### Bench View
- 4 bench players in priority order
- Color-coded cards matching position

### Chip Decision Matrix

| Chip | Trigger Condition |
|------|-------------------|
| **Triple Captain** | Top captain single-GW xP ≥ 11.5 OR Double Gameweek detected |
| **Bench Boost** | 4 bench players combined xP ≥ 14.5 |
| **Free Hit** | Blank Gameweek detected |
| **Wildcard** | ≥ 5 player changes yield ≥ +20 xP gain over 4 GWs |

### Transfer Hit Logic
- Only recommends a -4 pt hit if net xP gain over 3 GWs exceeds +4.0 pts
- Evaluates 0, 1, and 2-transfer plans simultaneously

### Player Comparison (Radar Chart)
- Compare up to 3 players side-by-side
- Spider/radar chart: Total xP, Form PPG, Minutes, Price, xP/£m, Avg FDR
- Stat comparison table with next fixtures

### Price Change Predictor
- Predict which players will rise/fall in price tonight
- Based on net transfer data from FPL live endpoint
- Separate "Likely Risers" and "Likely Fallers" panels

### Fixture Difficulty Ticker
- Color-coded 8-GW fixture grid for all 20 Premier League teams
- Green = easy, Gray = neutral, Red = hard
- Shows opponent and home/away for each gameweek

### Differential Picks
- Find low-ownership (<5%) high-xP players
- Ideal for gaining rank against template teams
- Sorted by total xP descending with ownership %, xP/£m, minutes probability

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | App info |
| GET | `/health` | Health check |
| GET | `/status` | Data source status |
| GET | `/current-gw` | Current gameweek |
| GET | `/players` | All players |
| GET | `/teams` | All teams |
| GET | `/fixtures` | All fixtures |
| GET | `/squad/{team_id}/{gw}` | User squad with details |
| GET | `/player-xp/{player_id}` | Player xP projection |
| POST | `/optimize/draft` | Mode A: Draft optimization |
| POST | `/optimize/transfers` | Mode B: Transfer optimization |

---

## Metadata

- **Application**: VibeGaffer v1.0
- **Company**: Astraiva
- **Author**: Tushant Sharma
- **License**: Proprietary
- **Year**: 2025
