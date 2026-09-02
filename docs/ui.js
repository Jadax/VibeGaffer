document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "run") return VG.run();
  if (action === "tab") return VG.switchTab(target.dataset.tab);
  if (action === "toggle-breakdown") {
    target.querySelector(".squad-breakdown")?.classList.toggle("show");
    return;
  }
  if (action === "what-if") return VG.runWhatIf(target.dataset.mode, Number(target.dataset.gw));
  const refreshTips = () => {
    const tips = document.getElementById("tipsContent");
    if (tips && VG.currentResult && VG.allXP && VG.allFixtures) tips.innerHTML = VG.render.tips(VG.currentResult, VG.allXP, VG.allFixtures, Number(document.getElementById("gameweek")?.value || 1));
  };
  if (action === "watch-toggle" || action === "watch-remove") {
    VG.toggleWatch(Number(target.dataset.playerId));
    if (action === "watch-toggle" && document.getElementById("compareSelect")) VG.renderComparison();
    refreshTips();
    return;
  }
  if (action === "watch-add") {
    const select = document.getElementById("watchAdd");
    if (!select?.value) return;
    VG.toggleWatch(Number(select.value));
    select.value = "";
    refreshTips();
  }
});

VG.switchTab = (name) => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`)?.classList.add('active');
  document.getElementById(`tab-${name}`)?.classList.add('active');
};

VG.init = async () => {
  const el = id => document.getElementById(id);
  VG._retries = 0;
  el("status").innerHTML = '<span class="status-dot warning"></span> Loading data...';
  try {
    VG.bootstrapData = await VG.loadBootstrap();
    VG.applyHistoryPriors(VG.bootstrapData, await VG.loadHistoryPriors());
    VG.buildMaps(VG.bootstrapData);
    VG.allFixtures = await VG.loadFixtures();
    VG.loadOdds(); // Optional , loads in background, non-blocking
    VG.loadUnderstat(); // Optional , loads in background, non-blocking
    VG.loadSetPieceData(); // Optional , bundled set-piece takers (non-blocking)
    VG.loadRecentForm(); // Optional , last-5-GW rotation-risk signal (non-blocking)
    const gwSel = el("gameweek");
    gwSel.innerHTML = "";
    for (let i = 1; i <= 38; i++) {
      gwSel.innerHTML += `<option value="${i}" ${i === VG.currentGW ? "selected" : ""}>GW${i}</option>`;
    }
    // Horizon options capped to the GWs actually left in the season (v5.8):
    // near the season's end a 12-GW horizon is impossible, so offer only the
    // remaining windows. Defaults to the largest useful window (max 12).
    const rem = VG.remainingGWs(VG.currentGW);
    const horizonSel = el("horizon");
    horizonSel.innerHTML = "";
    [3, 6, 8, 12].filter(n => n <= rem).forEach(n => {
      horizonSel.innerHTML += `<option value="${n}" ${n === Math.min(12, rem) ? "selected" : ""}>${n} GW${n > 1 ? 's' : ''}</option>`;
    });
    if (!horizonSel.innerHTML) {
      horizonSel.innerHTML = `<option value="${rem}" selected>${rem} GW${rem > 1 ? 's' : ''}</option>`;
    }
    el("status").innerHTML = '<span class="status-dot ok"></span> ' + VG.bootstrapData.elements.length + ' players loaded · GW' + VG.currentGW;
  } catch(e) {
    console.error("[VG] init failed:", e);
    VG._retries++;
    const secs = Math.min(VG._retries * 3, 30);
    el("status").innerHTML = '<span class="status-dot error"></span> Load failed (attempt ' + VG._retries + ') retrying in ' + secs + 's';
    setTimeout(VG.init, secs * 1000);
  }
};

VG.run = async () => {
  const el = id => document.getElementById(id);
  const loader = (t) => `<div class="vg-loader"><div class="vg-loader-spinner"></div><div class="vg-loader-text">${t}</div></div>`;

  try {
    el("welcome").style.display = "none";
    el("results").style.display = "block";
    el("squadContent").innerHTML = loader("Fetching player data...");

    if (!VG.bootstrapData || !VG.players) {
      VG.bootstrapData = await VG.loadBootstrap();
      VG.buildMaps(VG.bootstrapData);
    }
    VG.startDeadlineCountdown();
    if (!VG.allFixtures) VG.allFixtures = await VG.loadFixtures();
    if (!VG.understatLoaded) await VG.loadUnderstat();
    if (!VG.setPieces.teams || !Object.keys(VG.setPieces.teams).length) await VG.loadSetPieceData();
    if (!VG.recentFormLoaded) await VG.loadRecentForm();

    const gw = parseInt(el("gameweek").value);
    let horizon = parseInt(el("horizon").value);
    // Belt-and-braces: never project beyond the remaining GWs of the season.
    horizon = VG.clampHorizon(horizon, gw);
    const teamIdVal = el("teamId").value.trim();
    const teamId = teamIdVal ? parseInt(teamIdVal) : 0;
    VG.currentTeamId = teamId; // used by VG.analyzeLeague to spot "you" in the league race
    const bankOverride = el("bankOverride").value ? parseFloat(el("bankOverride").value) : null;

    el("squadContent").innerHTML = loader("Computing xP projections across " + horizon + " gameweeks...");
    await new Promise(r => setTimeout(r, 50)); // let UI paint

    const allXP = VG.computeAllXP(gw, horizon, VG.allFixtures);

    // Populate the "avoid teams" datalist from team short-codes (built once).
    const fillTeamCodes = () => {
      const dl = el("teamCodes");
      if (!dl || dl.childElementCount > 0) return;
      Object.values(VG.teams || {}).forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.short_name;
        dl.appendChild(opt);
      });
    };
    fillTeamCodes();

    // Translate the sidebar "Advanced" inputs into a constraints object that
    // shapes both the transfer optimizer and the chip team generators. Team
    // codes (e.g. "MCI") are resolved to numeric IDs because validTransfer
    // compares against p.teamId (numeric).
    const codeToId = (code) => {
      if (!code) return null;
      const t = Object.values(VG.teams || {}).find(t => t.short_name === code);
      return t ? t.id : null;
    };
    const buildConstraints = () => ({
      maxTransfers: el("maxTransfers").value ? parseInt(el("maxTransfers").value) : null,
      maxPrice: el("maxBuyPrice").value ? parseFloat(el("maxBuyPrice").value) : null,
      minEO: el("minEO").value ? parseFloat(el("minEO").value) : null,
      avoidTeams: el("avoidTeams").value
        ? el("avoidTeams").value.split(",").map(s => codeToId(s.trim())).filter(Number)
        : []
    });
    const constraints = buildConstraints();

    // Handler: whether the user asked for a Free Hit (single-GW optimal team)
    // or Wildcard (full horizon rebuild) via the Chip Generator dropdown.
    const chipMode = el("chipMode").value;
    const budgetChip = bankOverride !== null ? bankOverride : 100;

    // Draft builder shared by the no-team path AND the fallback when a real
    // squad can't be loaded (e.g. GW1 picks don't exist until the deadline
    // passes — the API 404s). Keeps "team ID + GW1" working all week.
    const buildDraft = async () => {
      const strategy = el("strategy").value;
      if (strategy === "all") {
        // Generate all 3 strategies and pick balanced as primary
        const strategies = VG.optimizeStrategies(allXP, 100, VG.allFixtures, gw, horizon);
        const draft = strategies.balanced;
        const chips = VG.evaluateChips(draft.squad, draft.gwPicks, VG.allFixtures);
        return { ...draft, chipAdvice: chips, transfersIn: [], transfersOut: [], hitCost: 0, gwTotalXP: draft.gwPicks?.[0]?.gwTotalXP || 0, mode: "draft", strategies };
      }
      const draft = strategy === "balanced"
        ? await VG.optimizeDraftILP(allXP, 100, VG.allFixtures, gw, horizon)
        : VG.optimizeStrategies(allXP, 100, VG.allFixtures, gw, horizon)[strategy];
      const chips = VG.evaluateChips(draft.squad, draft.gwPicks, VG.allFixtures);
      return { ...draft, chipAdvice: chips, transfersIn: [], transfersOut: [], hitCost: 0, gwTotalXP: draft.gwPicks?.[0]?.gwTotalXP || 0, mode: "draft" };
    };

    let result;
    // Chip generators (Free Hit / Wildcard) take priority over the normal
    // transfer/draft flow — they rebuild an optimal team, not incremental trades.
    // They only need the player pool + bank, so a squad fails to load → use the
    // default budget rather than erroring out (robust for pre-deadline GWs).
    const loadChipBank = async () => {
      if (bankOverride !== null) return bankOverride;
      if (teamId <= 0) return 100;
      try {
        const d = await VG.loadSquad(teamId, gw);
        VG.detectPrimaryLeague(d.info);
        return (d.info.last_deadline_bank || 0) / 10;
      } catch (e) {
        console.warn("[VG] chip mode: squad load failed, using default bank", e && e.message);
        return 100;
      }
    };
    if (chipMode === "free_hit") {
      const bank = await loadChipBank();
      const made = await VG.generateFreeHit(allXP, bank, VG.allFixtures, gw, 1, { constraints });
      const chips = VG.evaluateChips(made.squad, made.gwPicks, VG.allFixtures);
      result = { ...made, chipAdvice: chips, transfersIn: [], transfersOut: [], hitCost: 0,
        gwTotalXP: made.gwPicks?.[0]?.gwTotalXP || 0, gotCap: made.gotCap, gwPicks: made.gwPicks,
        squad: made.squad, mode: "free_hit", chip: "Free Hit" };
    } else if (chipMode === "wildcard") {
      const bank = await loadChipBank();
      const made = await VG.generateWildcard(allXP, bank, VG.allFixtures, gw, horizon, { constraints });
      const chips = VG.evaluateChips(made.squad, made.gwPicks, VG.allFixtures);
      result = { ...made, chipAdvice: chips, transfersIn: [], transfersOut: [], hitCost: 0,
        gwTotalXP: made.gwPicks?.[0]?.gwTotalXP || 0, gotCap: made.gotCap, gwPicks: made.gwPicks,
        squad: made.squad, mode: "wildcard", chip: "Wildcard" };
    } else if (teamId <= 0) {
      result = await buildDraft();
    } else {
      try {
        const squadData = await VG.loadSquad(teamId, gw);
        VG.detectPrimaryLeague(squadData.info);
        const currentSquad = squadData.picks.picks;
        const bank = bankOverride !== null ? bankOverride : (squadData.info.last_deadline_bank || 0) / 10;
        const freeTransfers = parseInt(el("freeTransfers").value);
        const transferResult = VG.optimizeTransfers(currentSquad, allXP, bank, freeTransfers, gw, 5, constraints);
        const transferOutIds = new Set(transferResult.transfersOut.map(p => p.id));
        const transferInIds = new Set(transferResult.transfersIn.map(p => p.id));
        const retainedIds = currentSquad.filter(p => !transferOutIds.has(p.element)).map(p => p.element);
        const fullIds = [...retainedIds, ...transferInIds];
        const allSquad = allXP.filter(p => fullIds.includes(p.id)).sort((a, b) => b.totalXP - a.totalXP);
        // Compute per-GW picks for transfer squad
        const gwPicks = [];
        const horizonGWs = [...new Set(VG.allFixtures.map(f => f.event))]
          .sort((a, b) => a - b)
          .filter(g => g >= gw && g < gw + horizon);
        horizonGWs.forEach(g => gwPicks.push(VG.computePerGWPicks(allSquad, g, VG.allFixtures)));
        const starting11 = gwPicks[0]?.starting || allSquad.slice(0, 11);
        const bench4 = gwPicks[0]?.bench || allSquad.slice(11, 15);
        const gotCap = gwPicks[0]?.gotCap || VG.topCaptainCandidates(starting11, "totalXP");
        const chips = VG.evaluateChips(allSquad, gwPicks, VG.allFixtures);
        result = {
          ...transferResult, chipAdvice: chips, starting: starting11, bench: bench4,
          totalCost: +allSquad.reduce((s, p) => s + (p.price || 0), 0).toFixed(1),
          budgetRemaining: bank, formation: gwPicks[0]?.formation || { DEF: 4, MID: 4, FWD: 2 },
          totalXP: +gwPicks.reduce((s, g) => s + g.gwTotalXP, 0).toFixed(1),
          gwTotalXP: gwPicks[0]?.gwTotalXP || 0,
          mode: "transfer", gotCap, gwPicks, squad: allSquad
        };
      } catch (squadErr) {
        // 404 = picks don't exist yet for this GW (pre-deadline): fall back to
        // a draft. Any other failure (network etc.) rethrows so the outer
        // retry logic still applies.
        if (!/404/.test(String(squadErr && squadErr.message))) throw squadErr;
        console.warn("[VG] squad picks not available (404), using draft fallback");
        result = await buildDraft();
      }
    }

    VG.currentResult = result;
    VG.currentGW = gw;
    VG.currentHorizon = horizon;
    VG.allXP = allXP;

    // Build HTML
    let html = '<div id="rankCard"></div>';

    // Live Rank tracker card (v5.6, LiveFPL/FFHub idea) , real OR when team ID set
    if (teamId > 0) {
      VG.fetchTeamRank(teamId, gw).then(rank => {
        if (!rank || !rank.name) return;
        const rk = rank.overallRank;
        const rkColor = rk != null ? (rk < 100000 ? '#00ff87' : rk < 500000 ? '#fbbf24' : '#94a3b8') : '#94a3b8';
        let box = `<div style="margin:16px 0;padding:12px;border:1px solid rgba(167,139,250,0.25);border-radius:12px;background:rgba(167,139,250,0.06);">`;
        box += `<div style="font-size:0.72rem;color:#a78bfa;font-weight:600;margin-bottom:4px;">📊 Live Rank · ${VG.esc(rank.name)}</div>`;
        if (rk != null) box += `<div style="font-size:1rem;color:${rkColor};font-weight:700;">OR ${rk.toLocaleString()}</div>`;
        else box += `<div style="color:#475569;font-size:0.75rem;">Overall rank not yet available</div>`;
        box += `<div style="font-size:0.68rem;color:#94a3b8;margin-top:4px;">GW${rank.ev} points: ${rank.gwPts != null ? rank.gwPts : '-'} · auto-refreshes every 5 min</div>`;
        box += `</div>`;
        const rkEl = document.getElementById("rankCard");
        if (rkEl) rkEl.innerHTML = box;
      });
    }

    // Draft-mode banner: the FPL API has no picks for this GW yet (deadline
    // hasn't passed), so the squad below is an OPTIMAL DRAFT we built from
    // projections — NOT the user's actual team. Be explicit so this is never
    // mistaken for their real squad.
    if (result.mode === "draft" && teamId > 0) {
      html += `<div style="margin:14px 0;padding:12px;border:1px solid rgba(251,191,36,0.4);border-radius:12px;background:rgba(251,191,36,0.08);">
        <div style="font-size:0.78rem;font-weight:700;color:#fbbf24;margin-bottom:4px;">⚠️ This is an OPTIMAL DRAFT, not your actual squad</div>
        <div style="font-size:0.72rem;color:#e2e8f0;">There are no FPL picks on record for GW${VG.esc(String(gw))} yet (the deadline hasn't passed / FPL hasn't published them), so we couldn't load your real team for that week. The squad below is the optimizer's recommended line-up from scratch. To analyze your <b>actual</b> squad, select a GW whose deadline has passed (e.g. GW1).</div>
      </div>`;
    }

    // Chip-team banner: a Free Hit / Wildcard rebuild is a projected squad, not
    // the user's current team — make that unmistakable so it's never read as a
    // real squad or a done transfer.
    if (result.mode === "free_hit" || result.mode === "wildcard") {
      const chipName = result.mode === "free_hit" ? "FREE HIT" : "WILDCARD";
      const chipDesc = result.mode === "free_hit"
        ? `This is a projected FREE HIT team built for GW${VG.esc(String(gw))} only — single-gameweek optimisation, no team value built, squad reverts after the GW.`
        : `This is a projected WILDCARD rebuild optimised across the next ${VG.esc(String(horizon))} GWs. When you activate your wildcard you can replicate this squad.`;
      html += `<div style="margin:14px 0;padding:12px;border:1px solid rgba(251,191,36,0.4);border-radius:12px;background:rgba(251,191,36,0.08);">
        <div style="font-size:0.78rem;font-weight:700;color:#fbbf24;margin-bottom:4px;">🎯 ${chipName} team — projected, not your current squad</div>
        <div style="font-size:0.72rem;color:#e2e8f0;">${chipDesc}</div>
      </div>`;
    }

    // Transfers — actionable advice up top so it's immediately visible.
    if (result.transfersIn?.length || result.transfersOut?.length) {
      html += '<div class="section-title">Transfers</div>';
      if (result.hitWarning) {
        html += `<div class="hit-warning">⚠️ ${VG.esc(result.hitWarning)}</div>`;
      }
      html += '<div class="transfer-grid">';
      html += '<div class="transfer-col"><h4 style="color:#00ff87;">IN</h4>';
      result.transfersIn.forEach(p => html += `<div class="transfer-item in"><div class="name" style="color:#00ff87;">${VG.esc(p.name)}</div><div class="meta">${VG.esc(p.position)} · £${p.price.toFixed(1)}m · ${(p.totalXP || 0).toFixed(1)} xP</div></div>`);
      html += '</div><div class="transfer-col"><h4 style="color:#ef4444;">OUT</h4>';
      result.transfersOut.forEach(p => html += `<div class="transfer-item out"><div class="name" style="color:#ef4444;">${VG.esc(p.name)}</div><div class="meta">${VG.esc(p.position)} · £${p.price.toFixed(1)}m</div></div>`);
      html += '</div></div>';
      // Approximate rank impact of these transfers (v5.5, FFHub AI idea)
      if (result.transfersIn?.length && result.transfersOut?.length) {
        const outXP = result.transfersOut.reduce((s, p) => s + (p.totalXP || 0), 0);
        const inXP = result.transfersIn.reduce((s, p) => s + (p.totalXP || 0), 0);
        const ri = VG.estimateRankImpact(inXP - outXP, { nGWs: 5 });
        if (ri.rankDelta !== 0) {
          const col = ri.rankDelta < 0 ? "#00ff87" : "#ef4444";
          html += `<div style="text-align:center;font-size:0.72rem;margin-top:6px;color:${col};">≈ projected rank ${ri.direction === 'gain' ? 'improvement' : 'loss'} of ${Math.abs(ri.rankDelta).toLocaleString()} (${ri.pts > 0 ? '+' : ''}${ri.pts} xP over 5 GW), estimate</div>`;
        }
      }
      if (result.hitCost > 0) {
        html += `<div style="text-align:center;color:#ef4444;font-size:0.75rem;font-weight:600;margin-top:8px;">Hit Cost: -${result.hitCost} pts</div>`;
        if (result.hitDetails?.length > 0) {
          result.hitDetails.forEach(h => {
            html += `<div style="text-align:center;color:#fbbf24;font-size:0.7rem;margin-top:2px;">↳ ${VG.esc(h.name)}: breaks even in ~${h.breakEvenGWs} GWs (${h.gwAvgGain} pts/GW avg)</div>`;
          });
        }
      } else if (result.freeTransfersUsed <= 1) {
        html += `<div style="text-align:center;color:#00ff87;font-size:0.72rem;margin-top:8px;">✓ Using free transfer only, champion strategy</div>`;
      }
    }

    // Chip Strategy — also up top with the transfers.
    if (result.chipAdvice) {
      html += '<div class="section-title">Chip Strategy</div>';
      html += '<div class="chip-sequence"><strong>Classic Sequence:</strong> Wildcard → Bench Boost → Free Hit → Triple Captain (GW32-38)</div>';
      html += '<div class="chips-grid">';
      html += VG.render.chipCard("TC", "#fbbf24", result.chipAdvice.triple_captain);
      html += VG.render.chipCard("BB", "#3b82f6", result.chipAdvice.bench_boost);
      html += VG.render.chipCard("WC", "#7c3aed", result.chipAdvice.wildcard);
      html += VG.render.chipCard("FH", "#ef4444", result.chipAdvice.free_hit);
      html += '</div>';

      // Chip Opportunity Timeline: per-GW score bars
      const gwScores = result.chipAdvice.gwScores;
      if (gwScores && gwScores.length > 1) {
        html += '<div style="margin-top:16px;font-size:0.72rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Chip Opportunity Timeline</div>';
        html += '<div style="display:grid;grid-template-columns:repeat(' + gwScores.length + ',1fr);gap:6px;margin-top:8px;">';
        gwScores.forEach(gs => {
          const isDGW = gs.isDGW;
          const isBGW = gs.isBGW;
          const gwLabel = 'GW' + gs.gw;
          const dgwTag = isDGW ? '<span style="color:#fbbf24;font-size:0.55rem;">DGW</span>' : isBGW ? '<span style="color:#ef4444;font-size:0.55rem;">BGW</span>' : '';
          html += `<div style="background:${isDGW ? 'rgba(251,191,36,0.08)' : isBGW ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.02)'};border-radius:6px;padding:8px 6px;text-align:center;">`;
          html += `<div style="font-weight:700;color:#e2e8f0;font-size:0.7rem;">${gwLabel}</div>`;
          html += dgwTag;
          // TC bar
          const tcH = Math.max((gs.tcScore / 100) * 40, 2);
          html += `<div style="margin-top:4px;display:flex;align-items:flex-end;justify-content:center;gap:2px;height:50px;">`;
          html += `<div title="TC: ${gs.tcScore}" style="width:6px;height:${tcH}px;background:#fbbf24;border-radius:2px 2px 0 0;"></div>`;
          // BB bar
          const bbH = Math.max((gs.bbScore / 100) * 40, 2);
          html += `<div title="BB: ${gs.bbScore}" style="width:6px;height:${bbH}px;background:#3b82f6;border-radius:2px 2px 0 0;"></div>`;
          // WC bar
          const wcH = Math.max((gs.wcScore / 100) * 40, 2);
          html += `<div title="WC: ${gs.wcScore}" style="width:6px;height:${wcH}px;background:#7c3aed;border-radius:2px 2px 0 0;"></div>`;
          // FH bar
          const fhH = Math.max((gs.fhScore / 100) * 40, 2);
          html += `<div title="FH: ${gs.fhScore}" style="width:6px;height:${fhH}px;background:#ef4444;border-radius:2px 2px 0 0;"></div>`;
          html += '</div>';
          // Captain info
          if (gs.capName) {
            html += `<div style="font-size:0.55rem;color:#64748b;margin-top:3px;">C: ${VG.esc(gs.capName)}</div>`;
          }
          html += '</div>';
        });
        html += '</div>';
        // Legend
        html += '<div style="display:flex;gap:12px;margin-top:6px;font-size:0.6rem;color:#64748b;justify-content:center;">';
        html += '<span><span style="display:inline-block;width:8px;height:8px;background:#fbbf24;border-radius:2px;margin-right:3px;"></span>TC</span>';
        html += '<span><span style="display:inline-block;width:8px;height:8px;background:#3b82f6;border-radius:2px;margin-right:3px;"></span>BB</span>';
        html += '<span><span style="display:inline-block;width:8px;height:8px;background:#7c3aed;border-radius:2px;margin-right:3px;"></span>WC</span>';
        html += '<span><span style="display:inline-block;width:8px;height:8px;background:#ef4444;border-radius:2px;margin-right:3px;"></span>FH</span>';
        html += '</div>';
      }
    }

    // Metrics
    const gwProjStarting = (result.starting?.length >= 11 ? result.starting : (result.gwPicks?.[0]?.starting || result.squad.slice(0, 11)));
    const mcMetric = (gwProjStarting && gwProjStarting.length >= 11) ? VG.render.gwProjection(gwProjStarting, VG.allFixtures, gw, result.gotCap?.[0]?.id) : null;
    html += VG.render.metrics(result, mcMetric);

    // Rate My Team (v5.8, FPL Review/FFix idea) , transparent component scores.
    html += VG.render.rateMyTeam(result, VG.allXP, VG.allFixtures, gw);

    // Transfer Roadmap: per-GW fixture grid + recommendations
    if ((result.mode === "draft" || result.mode === "free_hit" || result.mode === "wildcard") && result.squad?.length >= 11) {
      const roadmap = VG.computeTransferRoadmap(result.squad, allXP, VG.allFixtures, parseInt(el("gameweek").value), 5);
      if (roadmap && roadmap.length > 0) {
        html += '<div class="section-title" style="margin-top:24px;">Transfer Roadmap <span style="color:#475569;font-size:0.65rem;font-weight:400;margin-left:4px;">fixture outlook + swap suggestions</span></div>';

        // Fixture grid for squad
        const gwHeaders = roadmap.map(r => `GW${r.gw}`).join('</th><th style="text-align:center;">');
        html += '<table class="data-table" style="font-size:0.7rem;"><tr><th style="text-align:left;">Player</th><th>Pos</th><th style="text-align:center;">' + gwHeaders + '</th></tr>';
        result.squad.sort((a, b) => a.positionId - b.positionId || b.totalXP - a.totalXP).forEach(sp => {
          const pid = sp.element || sp.id;
          const xp = allXP.find(p => p.id === pid);
          if (!xp) return;
          const posCls = VG.POS_SHIRT[xp.positionId];
          html += `<tr><td style="color:#e2e8f0;"><span class="pos-badge ${posCls}" style="font-size:0.55rem;padding:1px 4px;">${VG.esc(xp.position)}</span> ${VG.esc(xp.name)}</td><td style="color:#475569;">£${xp.price.toFixed(1)}m</td>`;
          roadmap.forEach(r => {
            const p = r.players.find(pl => pl.id === pid);
            if (!p) { html += '<td style="text-align:center;color:#334155;">-</td>'; return; }
            const bg = p.fdr === 0 ? '#1e1b4b' : p.fdr <= 2 ? 'rgba(34,197,94,0.15)' : p.fdr === 3 ? 'rgba(255,255,255,0.03)' : p.fdr >= 4 ? 'rgba(239,68,68,0.15)' : 'transparent';
            const color = p.fdr === 0 ? '#475569' : VG.fdrColor(p.fdr);
            html += `<td style="text-align:center;background:${bg};color:${color};font-weight:600;">${VG.esc(p.oppName)}${p.isHome ? '' : ' (A)'}</td>`;
          });
          html += '</tr>';
        });
        html += '</table>';

        // Transfer recommendations per GW (only show GWs with recommendations)
        const recGWs = roadmap.filter(r => r.recommendations.length > 0);
        if (recGWs.length > 0) {
          html += '<div style="margin-top:12px;font-size:0.72rem;color:#94a3b8;font-weight:600;">Suggested Swaps</div>';
          recGWs.forEach(r => {
            r.recommendations.slice(0, 2).forEach(rec => {
              html += `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:0.7rem;">`;
              html += `<span style="color:#475569;font-weight:600;">GW${r.gw}</span>`;
              html += `<span style="color:#ef4444;text-decoration:line-through;">${VG.esc(rec.out)} <span style="color:#64748b;">(${VG.esc(rec.outOpp)}${rec.outFDR >= 4 ? ' ⚠' : ''})</span></span>`;
              html += `<span style="color:#475569;">→</span>`;
              html += `<span style="color:#00ff87;">${VG.esc(rec.in)} <span style="color:#64748b;">(${VG.esc(rec.inOpp)} £${rec.inPrice.toFixed(1)}m +${rec.gain})</span></span>`;
              html += `</div>`;
            });
          });
        }
      }
    }

    // Optimal Lineup Intelligence
    if (result.squad?.length >= 11) {
      const lineupAdvice = VG.computeLineupAdvice(result.squad, allXP, VG.allFixtures, gw);
      if (lineupAdvice) {
        html += '<div class="section-title" style="margin-top:24px;">Optimal Lineup <span style="color:#475569;font-size:0.65rem;font-weight:400;margin-left:4px;">suggested XI + reasoning for GW' + gw + '</span></div>';
        html += '<div class="chip-sequence" style="margin-bottom:10px;"><div class="chip-card"><div class="chip-label">Formation</div><div class="chip-score" style="color:#00ff87;font-size:0.8rem;">' + lineupAdvice.formation + '</div></div><div class="chip-card"><div class="chip-label">xP</div><div class="chip-score" style="color:#fbbf24;font-size:0.8rem;">' + lineupAdvice.totalXP + '</div></div></div>';
        
        // Starting XI with reasoning

        html += '<div style="font-size:0.72rem;color:#94a3b8;font-weight:600;margin-bottom:6px;">STARTING XI</div>';
        lineupAdvice.starting.forEach(p => {
          const fdrColor = VG.fdrColor(p.fdr);
          html += '<div class="lineup-player" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(30,41,59,0.4);border-radius:6px;margin-bottom:4px;border-left:3px solid ' + fdrColor + ';">';
          html += '<span class="pos-badge ' + VG.POS_SHIRT[p.positionId] + '" style="font-size:0.6rem;">' + p.position + '</span>';
          html += '<span style="color:#e2e8f0;font-weight:500;font-size:0.75rem;">' + VG.esc(p.name) + '</span>';
          html += '<span style="color:#64748b;font-size:0.65rem;">' + VG.esc(p.isHome === 'H' ? p.oppName : p.isHome === 'A' ? 'A ' + p.oppName : p.isHome + ' ' + p.oppName) + '</span>';
          html += '<span style="color:' + fdrColor + ';font-size:0.65rem;font-weight:600;">FDR ' + p.fdr + '</span>';
          html += '<span style="color:#00ff87;font-size:0.65rem;margin-left:auto;">' + p.totalXP.toFixed(1) + ' xP</span>';
          html += '</div>';
          // Reasoning row
          html += '<div style="margin:-2px 0 6px 16px;font-size:0.6rem;color:#64748b;font-style:italic;">';
          html += VG.esc(p.reasons.join(' · '));
          html += '</div>';
        });

        // Bench with reasoning
        if (lineupAdvice.bench.length > 0) {
          html += '<div style="font-size:0.72rem;color:#94a3b8;font-weight:600;margin:10px 0 6px;">BENCH</div>';
          lineupAdvice.bench.forEach(p => {
            const fdrColor = VG.fdrColor(p.fdr) === '#94a3b8' ? '#64748b' : VG.fdrColor(p.fdr);
            html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 10px;background:rgba(30,41,59,0.2);border-radius:4px;margin-bottom:2px;border-left:2px solid ' + fdrColor + ';">';
            html += '<span class="pos-badge ' + VG.POS_SHIRT[p.positionId] + '" style="font-size:0.55rem;padding:1px 3px;">' + p.position + '</span>';
            html += '<span style="color:#94a3b8;font-size:0.7rem;">' + VG.esc(p.name) + '</span>';
            html += '<span style="color:#64748b;font-size:0.6rem;">· ' + VG.esc(p.reasons[0]) + '</span>';
            html += '</div>';
          });
        }

        // Alternative formations
        if (lineupAdvice.altFormations.length > 0) {
          html += '<div style="margin-top:10px;font-size:0.65rem;color:#64748b;">Alternatives: ';
          html += lineupAdvice.altFormations.map(f => 
            '<span style="color:#94a3b8;margin-right:8px;">' + f.formation + ' (' + f.xP.toFixed(1) + ' xP)</span>'
          ).join('');
          html += '</div>';
        }
      }
    }

    // Captaincy
    if (result.gotCap?.length >= 2) {
      const c = result.gotCap[0];
      const v = result.gotCap[1];
      html += '<div class="section-title">Captaincy</div><div class="captaincy-row">';
      html += `<div class="cap-card primary"><div class="cap-role" style="color:#fbbf24;">Captain</div><div class="cap-name">${VG.esc(c.name)}</div><div class="cap-stats"><span style="color:#fbbf24;">${(c.gwXP || c.totalXP || 0).toFixed(1)} xP</span> · ${VG.esc(c.position)} · ${VG.esc(c.teamName)}${c.gwOpp ? ' · ' + VG.esc(c.gwVenue + ' vs ' + c.gwOpp) : ''}</div></div>`;
      html += `<div class="cap-card secondary"><div class="cap-role" style="color:#06b6d4;">Vice</div><div class="cap-name">${VG.esc(v.name)}</div><div class="cap-stats"><span style="color:#06b6d4;">${(v.gwXP || v.totalXP || 0).toFixed(1)} xP</span> · ${VG.esc(v.position)} · ${VG.esc(v.teamName)}${v.gwOpp ? ' · ' + VG.esc(v.gwVenue + ' vs ' + v.gwOpp) : ''}</div></div>`;
      html += '</div>';
      // Captain reasoning
      const capReason = VG.getCaptainReasoning(Object.assign({}, c, { isHome: c.gwVenue, oppName: c.gwOpp, fdr: c.gwFDR, gwXP: c.gwXP || c.totalXP }), VG.allFixtures, gw, v);
      if (capReason && capReason.details.length > 0) {
        html += '<div style="margin-top:8px;padding:10px 14px;background:rgba(251,191,36,0.05);border-radius:8px;border-left:3px solid #fbbf24;">';
        html += '<div style="font-size:0.7rem;color:#fbbf24;font-weight:600;">Why This Captain?</div>';
        html += '<div style="font-size:0.7rem;color:#e2e8f0;margin-top:4px;">' + VG.esc(capReason.summary) + '</div>';
        html += '<div style="margin-top:4px;font-size:0.65rem;color:#64748b;">' + VG.esc(capReason.details.join(' · ')) + '</div>';
        html += '</div>';
      }
    }

    // Captain Rotation Planner
    if (result.squad?.length >= 11) {
      const capRotation = VG.computeCaptainRotation(result.squad, allXP, VG.allFixtures, parseInt(el("gameweek").value), 5);
      if (capRotation && capRotation.length > 0) {
        html += '<div class="section-title" style="margin-top:20px;">Captain Rotation Planner</div>';
        html += '<table class="data-table" style="font-size:0.72rem;"><tr><th>GW</th><th>#1 Pick</th><th>xP</th><th>Opp (FDR)</th><th>#2 Pick</th><th>xP</th><th>Opp (FDR)</th><th>#3 Pick</th><th>xP</th><th>Opp (FDR)</th></tr>';
        capRotation.forEach(r => {
          const dgwTag = r.dgw ? ' <span style="color:#fbbf24;font-size:0.6rem;">DGW</span>' : '';
          html += `<tr><td style="font-weight:700;">GW${r.gw}${dgwTag}</td>`;
          r.top3.forEach((p, i) => {
            const fdrColor = VG.fdrColor(p.fdr);
            const fdrBg = p.fdr <= 2 ? 'rgba(34,197,94,0.12)' : p.fdr >= 4 ? 'rgba(239,68,68,0.12)' : 'transparent';
            html += `<td style="color:#e2e8f0;${i === 0 ? 'font-weight:700;' : ''}">${VG.esc(p.name)}</td>`;
            html += `<td style="color:#00ff87;font-weight:600;">${p.gwXP.toFixed(1)}</td>`;
            html += `<td style="background:${fdrBg};color:${fdrColor};font-weight:600;">${VG.esc(p.oppName)}${p.venue === 'A' ? ' (A)' : p.venue === 'H/A' ? ' (H/A)' : ''} (${p.fdr || '?'})</td>`;
          });
          html += '</tr>';
        });
        html += '</table>';
      }
    }

    // Strategy Comparison (when "Compare All" selected)
    if (result.strategies) {
      const strats = result.strategies;
      const stratKeys = ['balanced', 'premium', 'value'];
      html += '<div class="section-title">Strategy Comparison</div>';
      html += '<div class="strategy-grid">';
      stratKeys.forEach(key => {
        const s = strats[key];
        const info = VG.STRATEGIES[key];
        const isActive = key === 'balanced';
        html += `<div class="strategy-card ${isActive ? 'active' : ''}">`;
        html += `<div class="strategy-header"><span class="strategy-icon">${info.icon}</span><span class="strategy-name">${info.name}</span></div>`;
        html += `<div class="strategy-desc">${info.desc}</div>`;
        html += `<div class="strategy-stats">`;
        html += `<div class="strategy-stat"><span class="label">Total xP</span><span class="value">${s.totalXP.toFixed(1)}</span></div>`;
        html += `<div class="strategy-stat"><span class="label">Formation</span><span class="value">${s.formation.DEF}-${s.formation.MID}-${s.formation.FWD}</span></div>`;
        html += `<div class="strategy-stat"><span class="label">Cost</span><span class="value">£${s.totalCost.toFixed(1)}m</span></div>`;
        html += `<div class="strategy-stat"><span class="label">Captain</span><span class="value">${VG.esc(s.gotCap[0]?.name || '?')}</span></div>`;
        html += `</div>`;
        html += `<div class="strategy-players">`;
        s.starting.slice(0, 5).forEach(p => {
          html += `<div class="strategy-player">${VG.esc(p.name)} <span class="pos">${VG.esc(p.position)}</span> £${p.price.toFixed(1)}m</div>`;
        });
        html += `</div>`;
        html += `</div>`;
      });
      html += '</div>';
    }

    // Per-GW Breakdown
    if (result.gwPicks?.length > 0) {
      html += '<div class="section-title">Gameweek Breakdown</div>';
      html += '<div class="gw-breakdown">';
      result.gwPicks.forEach(gp => {
        const cap = gp.gotCap?.[0];
        const fmt = gp.formation;
        const fdrClass = gp.gwTotalXP >= 50 ? 'good' : gp.gwTotalXP >= 35 ? 'mid' : 'tough';
        html += `<div class="gw-card ${fdrClass}">`;
        html += `<div class="gw-card-header"><span class="gw-card-num">GW${gp.gw}</span><span class="gw-card-xp">${gp.gwTotalXP.toFixed(1)} xP</span></div>`;
        html += `<div class="gw-card-formation">${fmt.DEF}-${fmt.MID}-${fmt.FWD}</div>`;
        html += `<div class="gw-card-cap">C: ${VG.esc(cap?.name || '?')} ${cap?.gwOpp ? `<span class="${cap.gwVenue === 'H' ? 'home' : 'away'}">${VG.esc(cap.gwVenue + ' ' + cap.gwOpp)}</span>` : ''}</div>`;
        if (gp.dgwPlayers?.length > 0) html += `<div class="gw-card-dgw">DGW ⚡</div>`;
        html += '</div>';
      });
      html += '</div>';
    }

    // Pitch
    if (result.starting?.length) {
      const fmt = result.formation || { DEF: 4, MID: 4, FWD: 2 };
      html += `<div class="section-title">Starting XI <span style="color:#475569;font-size:0.7rem;font-weight:500;margin-left:6px;">${fmt.DEF}-${fmt.MID}-${fmt.FWD} · ${(result.totalXP || 0).toFixed(1)} xP</span></div>`;
      html += VG.render.pitch(result);
    }

    // Bench
    if (result.bench?.length) {
      html += VG.render.bench(result.bench);
    }

    // Full squad list with xP component breakdown
    if (result.squad?.length) {
      html += '<div class="section-title">Full Squad <span style="color:#475569;font-size:0.65rem;font-weight:400;margin-left:4px;">click player for xP breakdown</span></div><div class="squad-list">';
      result.squad.sort((a, b) => a.positionId - b.positionId || b.totalXP - a.totalXP).forEach((p, idx) => {
        const posCls = VG.POS_SHIRT[p.positionId];
        const xc = p.xpComponents || {};
        const total = p.totalXP || 1;
        const barCS = ((xc.xpCS || 0) / total * 100).toFixed(0);
        const barGoal = ((xc.xpGoals || 0) / total * 100).toFixed(0);
        const barAssist = ((xc.xpAssists || 0) / total * 100).toFixed(0);
        const barBonus = ((xc.xpBonus || 0) / total * 100).toFixed(0);
        const barDefcon = ((xc.xpDEFCON || 0) / total * 100).toFixed(0);
        const barApp = ((xc.xpAppearance || 0) / total * 100).toFixed(0);
        const barSaves = ((xc.xpSaves || 0) / total * 100).toFixed(0);
        html += `<div class="squad-item" data-action="toggle-breakdown" style="cursor:pointer;">`;
        html += `<div class="pos-badge ${posCls}">${VG.POSITIONS[p.positionId]}</div>`;
        html += `<div class="info"><div class="pname">${VG.esc(p.name)}</div><div class="pteam">${VG.esc(p.teamName)}</div></div>`;
        html += `<div class="pprice">£${p.price.toFixed(1)}m</div>`;
        html += `<div class="pxp">${(p.totalXP || 0).toFixed(1)}</div>`;
        html += `<div class="squad-breakdown">`;
        html += `<div class="xp-bar">`;
        if (barApp > 0) html += `<div class="xp-bar-seg" style="width:${barApp}%;background:#64748b;" title="Appearance: ${(xc.xpAppearance||0).toFixed(1)}"></div>`;
        if (barCS > 0) html += `<div class="xp-bar-seg" style="width:${barCS}%;background:#3b82f6;" title="Clean Sheet: ${(xc.xpCS||0).toFixed(1)}"></div>`;
        if (barGoal > 0) html += `<div class="xp-bar-seg" style="width:${barGoal}%;background:#22c55e;" title="Goals: ${(xc.xpGoals||0).toFixed(1)}"></div>`;
        if (barAssist > 0) html += `<div class="xp-bar-seg" style="width:${barAssist}%;background:#a78bfa;" title="Assists: ${(xc.xpAssists||0).toFixed(1)}"></div>`;
        if (barBonus > 0) html += `<div class="xp-bar-seg" style="width:${barBonus}%;background:#fbbf24;" title="Bonus: ${(xc.xpBonus||0).toFixed(1)}"></div>`;
        if (barDefcon > 0) html += `<div class="xp-bar-seg" style="width:${barDefcon}%;background:#f97316;" title="DEFCON: ${(xc.xpDEFCON||0).toFixed(1)}"></div>`;
        if (barSaves > 0) html += `<div class="xp-bar-seg" style="width:${barSaves}%;background:#06b6d4;" title="Saves: ${(xc.xpSaves||0).toFixed(1)}"></div>`;
        html += `</div>`;
        html += `<div class="xp-legend">`;
        if (xc.xpAppearance > 0.1) html += `<span><i class="dot" style="background:#64748b"></i>App ${(xc.xpAppearance||0).toFixed(1)}</span>`;
        if (xc.xpCS > 0.1) html += `<span><i class="dot" style="background:#3b82f6"></i>CS ${(xc.xpCS||0).toFixed(1)}</span>`;
        if (xc.xpGoals > 0.1) html += `<span><i class="dot" style="background:#22c55e"></i>Goals ${(xc.xpGoals||0).toFixed(1)}</span>`;
        if (xc.xpAssists > 0.1) html += `<span><i class="dot" style="background:#a78bfa"></i>Assists ${(xc.xpAssists||0).toFixed(1)}</span>`;
        if (xc.xpBonus > 0.1) html += `<span><i class="dot" style="background:#fbbf24"></i>Bonus ${(xc.xpBonus||0).toFixed(1)}</span>`;
        if (xc.xpDEFCON > 0.1) html += `<span><i class="dot" style="background:#f97316"></i>DEFCON ${(xc.xpDEFCON||0).toFixed(1)}</span>`;
        if (xc.xpSaves > 0.1) html += `<span><i class="dot" style="background:#06b6d4"></i>Saves ${(xc.xpSaves||0).toFixed(1)}</span>`;
        html += `</div>`;
        html += VG.playerProfileHTML(p, VG.allFixtures, gw);
        html += `</div></div>`;
      });
      html += '</div>';
    }

    el("squadContent").innerHTML = html;

    // Gameweek Briefing (v5.12, LazyFPL/fpl.team pre-deadline advisor): one
    // screen pulling together outlook, captain/VC, transfer (roll-vs-spend),
    // chip hint, price risk and injury watch.
    const briefingEl = document.getElementById("briefingContent");
    if (briefingEl) {
      const briefing = VG.buildBriefing(result, allXP, VG.allFixtures, gw);
      briefingEl.innerHTML = VG.render.briefing(briefing);
    }

    // Comparison select — sort a COPY: allXP is xP-ordered and shared with the
    // Differentials quartile math + watchlist pool downstream.
    const sel = el("compareSelect");
    sel.innerHTML = "";
    [...allXP].sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
      sel.innerHTML += `<option value="${p.id}">${VG.esc(p.name)} (${VG.esc(p.position)} · ${VG.esc(p.teamName)})</option>`;
    });
    sel.onchange = () => VG.renderComparison();
    VG.renderComparison();

    // Form vs Fixture Difficulty scatter (v5.12, FFix/FFScout classic): the
    // whole pool at a glance, so "in-form with an easy fixture" pops out.
    VG.render.formFixturesChart("formFixturesChart", allXP, VG.allFixtures, gw);

    // Run succeeded: clear the retry budget so unrelated future errors get
    // their own fresh 3 attempts.
    VG._runRetries = 0;
    VG.preloadTabs(gw);


  } catch(e) {
    console.error("[VG] run failed:", e);
    VG._runRetries = (VG._runRetries || 0) + 1;
    if (VG._runRetries < 3) {
      el("squadContent").innerHTML = loader("Retrying... (attempt " + VG._runRetries + "/3)");
      setTimeout(() => VG.run(), 2000);
    } else {
      el("squadContent").innerHTML = `<div style="background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.2);border-radius:12px;padding:20px;text-align:center;color:#ef4444;"><strong>Error:</strong> ${VG.esc(e.message)}<br><span style="font-size:0.75rem;color:#64748b;">Check console (F12) for details.</span></div>`;
      VG._runRetries = 0;
    }
  }
};

VG.preloadTabs = async (gw) => {
  const el = id => document.getElementById(id);

  try {
    const tickerData = VG.buildFixtureTicker(gw, 8, VG.allFixtures);
    const swings = VG.analyzeFixtureSwings(gw, 8, VG.allFixtures);
    let fixtureHTML = '';
    // DGW/BGW Season Planner (v5.5, Ben Crellin planner idea) , highlights
    // the first-half double/blank weeks. Base fixtures have none; becomes
    // live when postponements create them.
    const planner = VG.buildSeasonPlanner(VG.allFixtures);
    const dgwWeeks = planner.filter(p => p.dgwTeams.length > 0);
    const bgwWeeks = planner.filter(p => p.bgwTeams.length > 0);
    fixtureHTML += '<div class="section-title" style="font-size:0.8rem;">DGW/BGW Season Planner <span style="font-weight:400;color:#475569;font-size:0.68rem;">(Ben Crellin-style)</span></div>';
    if (dgwWeeks.length) {
      fixtureHTML += '<div style="margin:4px 0 8px;">';
      dgwWeeks.slice(0, 20).forEach(p => {
        const names = p.dgwTeams.map(t => VG.esc((VG.teams[t] || {}).short_name || t)).join(', ');
        fixtureHTML += `<span style="display:inline-block;margin:2px 4px;padding:3px 8px;border-radius:6px;background:rgba(0,255,135,0.12);color:#00ff87;font-size:0.68rem;">GW${p.gw} DGW: ${names}</span>`;
      });
      fixtureHTML += '</div>';
    }
    if (bgwWeeks.length) {
      fixtureHTML += '<div style="margin:4px 0 8px;">';
      bgwWeeks.slice(0, 20).forEach(p => {
        const names = p.bgwTeams.map(t => VG.esc((VG.teams[t] || {}).short_name || t)).join(', ');
        fixtureHTML += `<span style="display:inline-block;margin:2px 4px;padding:3px 8px;border-radius:6px;background:rgba(239,68,68,0.12);color:#ef4444;font-size:0.68rem;">GW${p.gw} BGW: ${names}</span>`;
      });
      fixtureHTML += '</div>';
    }
    if (!dgwWeeks.length && !bgwWeeks.length) {
      fixtureHTML += '<p style="color:#334155;font-size:0.7rem;">No doubles/blanks yet. Base fixtures have all 20 teams playing once weekly. Doubles appear after postponements; this planner will flag DGW/BGW chip windows automatically once they do.</p>';
    }
    // Team strength ratings from free Understat npxG priors (v5.4)
    const teamRatings = VG.computeTeamRatings();
    if (teamRatings) {
      fixtureHTML += '<div class="section-title" style="font-size:0.8rem;">Team Strength Ratings (Understat xG)</div>';
      fixtureHTML += '<p class="subtitle" style="margin-top:0;">100 = league average · higher attack/defence = stronger · 1-5 rating (5 = elite).</p>';
      fixtureHTML += VG.render.teamRatings(teamRatings);
      fixtureHTML += '<div class="section-title" style="margin-top:16px;font-size:0.8rem;">Fixture Difficulty Ticker</div>';
    }
    // Season-adaptive Elo (v5.10): re-ranks teams from finished-match results
    // and blends the drift back into the strength fields the xP engine reads.
    // Renders nothing pre-season (no finished fixtures), then ramps up to an
    // 85% results weight as games accumulate.
    const eloRows = VG.computeTeamElo(VG.allFixtures);
    const eloHTML = VG.eloRatingsHTML(eloRows);
    if (eloHTML) {
      fixtureHTML += '<div class="section-title" style="margin-top:16px;font-size:0.8rem;">Season-Adaptive Elo <span style="font-weight:400;color:#475569;font-size:0.68rem;">(results-driven strength)</span></div>';
      fixtureHTML += '<p class="subtitle" style="margin-top:0;">Attack/defence Elo re-ranked from finished fixtures. "Blend" = how much of the rating is results vs the API pre-season seed (ramps to 85%).</p>';
      fixtureHTML += eloHTML;
    }
    // Predicted lineups (v5.12, fpl.team/FFScout idea): projected XI per team
    // from the same xMins signal the xP engine trusts (start rate + recency +
    // availability + confidence). Unlocks once GW2+ results feed the recency
    // windows; renders a notice before that.
    fixtureHTML += '<div class="section-title" style="margin-top:16px;font-size:0.8rem;">Predicted Lineups <span style="font-weight:400;color:#475569;font-size:0.68rem;">(projected XI, xMins-weighted)</span></div>';
    fixtureHTML += VG.render.predictedLineups(VG.predictedLineups(gw, VG.allFixtures));
    // Clean-sheet / expected-conceded outlook (v5.12, FFHub/FFix metric): a
    // display-only Poisson model on the same 1000-scale strength the engine
    // uses, so "who keeps a cleanie" is one glance.
    fixtureHTML += '<div class="section-title" style="margin-top:16px;font-size:0.8rem;">Clean-Sheet & xGC Outlook <span style="font-weight:400;color:#475569;font-size:0.68rem;">(Poisson on team strength)</span></div>';
    fixtureHTML += '<p class="subtitle" style="margin-top:0;">P(CS) = e^(−xGC conceded) · xGF/xGC from team attack/defence strength. Sorted by clean-sheet odds.</p>';
    fixtureHTML += VG.render.teamDefensiveOutlook(VG.teamDefensiveOutlook(gw, VG.allFixtures));
    fixtureHTML += VG.render.ticker(tickerData, gw, 8);
    // Add fixture swing summary
    fixtureHTML += '<div class="section-title" style="margin-top:16px;font-size:0.8rem;">Fixture Swing Analysis</div>';
    fixtureHTML += '<div class="swing-grid">';
    // Best runs (avg FDR <= 2.5)
    const bestRuns = swings.filter(s => s.avgFDR <= 2.5).slice(0, 5);
    const worstRuns = swings.filter(s => s.avgFDR >= 3.5).slice(-5).reverse();
    fixtureHTML += '<div class="swing-col"><div class="swing-header" style="color:#00ff87;">Easy Runs</div>';
    if (bestRuns.length === 0) fixtureHTML += '<p style="color:#334155;font-size:0.7rem;">No clear easy runs</p>';
    bestRuns.forEach(s => {
      const runTag = s.maxEasyRun >= 3 ? `<span class="swing-run easy">🔥 ${s.maxEasyRun} GW run (GW${s.easyRunGWs})</span>` : '';
      fixtureHTML += `<div class="swing-card"><span class="swing-name">${VG.esc(s.name)}</span><span class="swing-avg">FDR ${s.avgFDR}</span>${runTag}</div>`;
    });
    fixtureHTML += '</div>';
    fixtureHTML += '<div class="swing-col"><div class="swing-header" style="color:#ef4444;">Hard Runs</div>';
    if (worstRuns.length === 0) fixtureHTML += '<p style="color:#334155;font-size:0.7rem;">No clear hard runs</p>';
    worstRuns.forEach(s => {
      const runTag = s.maxHardRun >= 3 ? `<span class="swing-run hard">💀 ${s.maxHardRun} GW run (GW${s.hardRunGWs})</span>` : '';
      fixtureHTML += `<div class="swing-card"><span class="swing-name">${VG.esc(s.name)}</span><span class="swing-avg">FDR ${s.avgFDR}</span>${runTag}</div>`;
    });
    fixtureHTML += '</div></div>';
    // Full-season FDR planner grid (v5.8): every team vs every GW, colour-
    // coded FDR cells with DGW/BGW markers. Consumes VG.teamSeasonRow, which
    // previously had no live caller.
    fixtureHTML += '<div class="section-title" style="margin-top:16px;font-size:0.8rem;">Full-Season Fixture Planner <span style="font-weight:400;color:#475569;font-size:0.68rem;">(DGW/BGW-aware)</span></div>';
    fixtureHTML += '<p class="subtitle" style="margin-top:0;">Cell = opponent (A = away) coloured by FDR. DGW = two fixtures that GW, BGW = blank.</p>';
    fixtureHTML += VG.render.seasonPlanner(VG.allFixtures, 1, 38, null);
    document.getElementById("fixtureContent").innerHTML = fixtureHTML;
  } catch(e) {
    console.warn("[VG] Fixture ticker:", e);
    document.getElementById("fixtureContent").innerHTML = '<p style="color:#475569;">Fixture data unavailable</p>';
  }

  try {
    const liveGW = parseInt(el("gameweek").value);
    const liveTeam = parseInt(el("teamId").value) || 0;
    const gwInProgress = VG.gwData && VG.gwData.some(g => g.is_current);
    // Cancel any pending self-rescheduling refresh from a previous run BEFORE
    // branching, so the "not live" path can't leave a stale timer polling.
    clearTimeout(VG._liveTimer);
    if (!gwInProgress) {
      document.getElementById("liveContent").innerHTML = '<p style="color:#475569;">Live tracking activates when a gameweek is in progress. Check back after the deadline.</p>';
    } else {
      document.getElementById("liveContent").innerHTML = '<div class="vg-loader"><div class="vg-loader-spinner"></div><div class="vg-loader-text">Fetching live GW data...</div></div>';
      // Non-blocking: let the other tabs render while live data streams in
      VG.renderLive(liveGW, liveTeam)
        .then(h => { document.getElementById("liveContent").innerHTML = h; })
        .catch(err => {
          console.warn("[VG] Live:", err);
          document.getElementById("liveContent").innerHTML = '<p style="color:#475569;">Live data unavailable.</p>';
        });
      // Auto-refresh every 5 min during a live GW. Self-reschedules so it
      // keeps polling rather than firing once; the clearTimeout above
      // cancels the whole chain when a new run supersedes this one.
      const scheduleLiveRefresh = () => {
        VG._liveTimer = setTimeout(() => {
          VG.renderLive(liveGW, liveTeam)
            .then(h => { document.getElementById("liveContent").innerHTML = h; })
            .catch(() => {})
            .finally(scheduleLiveRefresh);
        }, 5 * 60 * 1000);
      };
      scheduleLiveRefresh();
    }
  } catch(e) {
    console.warn("[VG] Live:", e);
    document.getElementById("liveContent").innerHTML = '<p style="color:#475569;">Live data unavailable.</p>';
  }

  try {
    const isPreseason = !VG.gwData || VG.gwData.every(g => !g.is_current);
    if (isPreseason) {
      document.getElementById("priceContent").innerHTML = '<p style="color:#475569;">Price changes available once the season starts.</p>';
    } else {
      const risks = await VG.getPriceRisk();
      let ph = '<div class="price-grid"><div><div class="section-title" style="font-size:0.8rem;">Risers</div>';
      const rising = risks.filter(r => r.risk === "rising" || r.risk === "likely_rise").slice(0, 10);
      const falling = risks.filter(r => r.risk === "falling" || r.risk === "likely_fall").slice(0, 10);
      if (!rising.length) ph += '<p style="color:#334155;">No clear risers</p>';
      rising.forEach(r => {
        ph += `<div class="price-card"><div><div class="name">${VG.esc(r.name)}</div><div class="detail">${VG.esc(r.pos)} · £${r.price.toFixed(1)}m</div></div><span class="risk-badge rise">${VG.esc(r.risk.replace('_',' '))}</span></div>`;
      });
      ph += '</div><div><div class="section-title" style="font-size:0.8rem;">Fallers</div>';
      if (!falling.length) ph += '<p style="color:#334155;">No clear fallers</p>';
      falling.forEach(r => {
        ph += `<div class="price-card"><div><div class="name">${VG.esc(r.name)}</div><div class="detail">${VG.esc(r.pos)} · £${r.price.toFixed(1)}m</div></div><span class="risk-badge fall">${VG.esc(r.risk.replace('_',' '))}</span></div>`;
      });
      ph += '</div></div>';
      document.getElementById("priceContent").innerHTML = ph;
    }
  } catch(e) {
    console.warn("[VG] Price risk:", e);
    document.getElementById("priceContent").innerHTML = '<p style="color:#334155;">Price data unavailable</p>';
  }

  try {
    if (VG.allXP) {
      // Differential score: xP * trend * ownership discount (lower ownership = higher score)
      const xpThreshold = VG.allXP.length > 50 ? VG.allXP[Math.floor(VG.allXP.length * 0.25)]?.totalXP || 5 : 5;
      const diffs = VG.allXP
        .filter(p => p.position !== 'GK' && (p.ownership || 100) <= 10 && p.totalXP >= xpThreshold)
        .map(p => {
          const ownDiscount = Math.max(0.1, 1.0 - (p.ownership || 0) / 50);
          const diffScore = (p.totalXP || 0) * (p.trend || 1) * ownDiscount;
          return { ...p, diffScore };
        })
        .sort((a, b) => b.diffScore - a.diffScore)
        .slice(0, 20);
      let dh = '<div class="section-title" style="font-size:0.8rem;margin-bottom:4px;">Differential Matrix</div>';
      dh += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:0.65rem;">';
      dh += '<span style="padding:3px 8px;border-radius:4px;background:rgba(0,255,135,0.1);color:#00ff87;">● Gold: low owned, high xP/£m (buy)</span>';
      dh += '<span style="padding:3px 8px;border-radius:4px;background:rgba(59,130,246,0.1);color:#3b82f6;">● Anchor: template, high xP/£m (safe)</span>';
      dh += '<span style="padding:3px 8px;border-radius:4px;background:rgba(251,191,36,0.1);color:#fbbf24;">● Wait: low owned, weak value</span>';
      dh += '<span style="padding:3px 8px;border-radius:4px;background:rgba(239,68,68,0.1);color:#ef4444;">● Trap: popular but weak value</span>';
      dh += '</div>';
      dh += '<table class="diff-table"><tr><th>Player</th><th>Pos</th><th>Team</th><th>Price</th><th>xP</th><th>xP/£m</th><th>Real xG/90</th><th>xG Reg</th><th>EP</th><th>Own%</th><th>EO</th><th>xMins</th><th>Zone</th><th>Market</th><th>Diff Score</th></tr>';
      diffs.forEach((p, i) => {
        const rank = i + 1;
        const ownColor = (p.ownership || 0) <= 2 ? '#00ff87' : (p.ownership || 0) <= 5 ? '#fbbf24' : '#94a3b8';
        const zone = VG.getDifferentialZone(p);
        const sp = p.setPiece || {};
        const spBadge = (sp.pen ? '<span style="color:#fbbf24;" title="Penalty taker">P</span>' : '') + (sp.fk ? '<span style="color:#60a5fa;" title="Free-kick taker">F</span>' : '') + (sp.cor ? '<span style="color:#a78bfa;" title="Corner/Set-piece">C</span>' : '');
        const market = VG.marketBadge(VG.getMarketTag(p));
        const isNewBadge = p.isNew ? '<span style="background:rgba(96,165,250,0.12);color:#60a5fa;padding:1px 6px;border-radius:4px;font-size:0.65rem;white-space:nowrap;">NEW</span>' : '';
        const transferBadge = p.transferred ? VG.transferBadge({ transferred: true, fromTeam: p.fromTeam ? { short_name: p.fromTeam } : null, toTeam: p.toTeam ? { short_name: p.toTeam } : null }) : '';
        dh += `<tr><td style="color:#e2e8f0;">${VG.watchToggle(p)} ${rank}. ${VG.esc(p.name)} ${isNewBadge}${transferBadge}</td><td>${VG.esc(p.position)}</td><td>${VG.esc(p.teamName)}</td><td>£${p.price.toFixed(1)}m</td><td style="color:#00ff87;">${(p.totalXP || 0).toFixed(1)}</td><td>${(p.xpPerPrice || 0).toFixed(2)}</td><td>${(p.realXG90 || 0).toFixed(2)}</td><td>${VG.regressionBadge(p.regression)}</td><td>${(p.epNext || 0).toFixed(1)}</td><td style="color:${ownColor};">${(p.ownership || 0).toFixed(1)}%</td><td style="color:#a78bfa;">${(p.eo || 0).toFixed(1)}${spBadge ? ' ' + spBadge : ''}</td><td>${(p.xMins || 0).toFixed(0)}</td><td><span style="color:${zone.color};">${VG.esc(zone.label)}</span></td><td>${market || '-'}</td><td style="color:#fbbf24;">${(p.diffScore || 0).toFixed(1)}</td></tr>`;
      });
      dh += '</table>';
      if (diffs.length === 0) dh = '<p style="color:#475569;">No differentials found matching criteria (low ownership + high xP)</p>';
      document.getElementById("diffContent").innerHTML = dh;
    }
  } catch(e) {
    console.warn("[VG] Differentials:", e);
  }

  try {
    if (VG.currentResult && VG.allXP && VG.allFixtures) {
      const squad = VG.currentResult.squad || [];
      const bank = VG.currentResult.budgetRemaining || 0;
      const gw = parseInt(el('gameweek').value);
      const horizon = parseInt(el('horizon').value);
      const plan = VG.computeTransferPlan(squad, VG.allXP, VG.allFixtures, gw, horizon, bank);
      if (plan && plan.schedule.length > 0) {
        let ph = '';
        // Summary card
        const s = plan.summary;
        ph += `<div class="chip-sequence">`;
        ph += `<div class="chip-card"><div class="chip-label">Squad xP</div><div class="chip-score" style="color:#00ff87;">${s.totalSquadXP}</div><div class="chip-advice">${horizon}-GW projection</div></div>`;
        ph += `<div class="chip-card"><div class="chip-label">Transfers</div><div class="chip-score" style="color:#60a5fa;">${s.totalTransfers}</div><div class="chip-advice">${s.freeTransfersUsed} free</div></div>`;
        ph += `<div class="chip-card"><div class="chip-label">Hits Taken</div><div class="chip-score" style="color:${s.totalHits > 0 ? '#ef4444' : '#00ff87'};">-${s.totalHits}</div><div class="chip-advice">${s.totalHits > 0 ? s.netGainFromHits + ' net gain' : 'Clean sheet'}</div></div>`;
        ph += `<div class="chip-card"><div class="chip-label">Avg xP/GW</div><div class="chip-score" style="color:#fbbf24;">${s.avgSquadXP}</div><div class="chip-advice">Per gameweek</div></div>`;
        ph += `</div>`;

        // Per-GW schedule
        plan.schedule.forEach(gwPlan => {
          if (gwPlan.transfers.length === 0) {
            ph += `<div style="margin:10px 0;padding:10px 14px;background:rgba(30,41,59,0.4);border-radius:8px;border-left:3px solid #334155;"><span style="color:#94a3b8;font-weight:600;">GW${gwPlan.gw}</span> <span style="color:#475569;font-size:0.75rem;">No changes, squad holds (${gwPlan.squadXP} xP)</span></div>`;
            return;
          }
          const border = gwPlan.hitCost > 0 ? '#ef4444' : '#00ff87';
          ph += `<div style="margin:10px 0;padding:12px 14px;background:rgba(30,41,59,0.5);border-radius:8px;border-left:3px solid ${border};">`;
          ph += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="color:#94a3b8;font-weight:600;">GW${gwPlan.gw}</span>`;
          ph += `<span style="font-size:0.68rem;color:#64748b;">${gwPlan.squadXP} xP · ${gwPlan.transfers.length} transfer${gwPlan.transfers.length > 1 ? 's' : ''}${gwPlan.hitCost > 0 ? ' · <span style="color:#ef4444;">-4 hit</span>' : ' · <span style="color:#00ff87;">Free</span>'}</span></div>`;
          gwPlan.transfers.forEach(t => {
            const hitTag = t.isHit ? ' <span style="color:#ef4444;font-size:0.65rem;">(HIT)</span>' : '';
            ph += `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:0.75rem;">`;
            ph += `<span style="color:#ef4444;text-decoration:line-through;">${VG.esc(t.out.name)}</span>`;
            ph += `<span style="color:#475569;">→</span>`;
            ph += `<span style="color:#00ff87;">${VG.esc(t.in.name)}</span>${hitTag}`;
            ph += `<span style="color:#64748b;margin-left:auto;">+${t.cumGain.toFixed(1)} xP</span>`;
            ph += `</div>`;
          });
          ph += `</div>`;
        });

        document.getElementById("planContent").innerHTML = ph;
      } else {
        document.getElementById("planContent").innerHTML = '<p style="color:#475569;">No transfer opportunities identified for this horizon.</p>';
      }
    } else {
      document.getElementById("planContent").innerHTML = '<p style="color:#475569;">Run a squad analysis first to see transfer recommendations.</p>';
    }
  } catch(e) {
    console.warn("[VG] Transfer Plan:", e);
    document.getElementById("planContent").innerHTML = '<p style="color:#475569;">Transfer plan unavailable.</p>';
  }


  try {
    const leagueId = VG.primaryLeagueId || 0;
    if (leagueId > 0) {
      const gw = parseInt(el("gameweek").value);
      const league = await VG.analyzeLeague(leagueId, gw, VG.allFixtures);
      if (league) {
        let lh = `<div class="chip-sequence">`;
        lh += `<div class="chip-card"><div class="chip-label">League</div><div class="chip-score" style="color:#e2e8f0;font-size:0.8rem;">${VG.esc(league.leagueName)}</div><div class="chip-advice">${league.fetchedSquads} of ${league.totalSquads} teams analyzed</div></div>`;
        lh += `<div class="chip-card"><div class="chip-label">Differentials</div><div class="chip-score" style="color:#00ff87;">${league.differentials.length}</div><div class="chip-advice">Low-owned picks in your squad</div></div>`;
        lh += `<div class="chip-card"><div class="chip-label">Template</div><div class="chip-score" style="color:#fbbf24;">${league.templateIds.length}</div><div class="chip-advice">Players ≥30% owned in league</div></div>`;
        lh += `<div class="chip-card"><div class="chip-label">Outliers</div><div class="chip-score" style="color:#ef4444;">${league.outliers.length}</div><div class="chip-advice">Popular picks you're missing</div></div>`;
        lh += `</div>`;

        // Race to the Top: Monte Carlo win probability among fetched squads
        if (league.raceSimulation && league.raceSimulation.entrants.length > 0) {
          const race = league.raceSimulation;
          lh += '<div style="margin-top:16px;"><div class="section-title" style="font-size:0.8rem;color:#fbbf24;">🏁 Race to the Top: GW' + gw + ' Win Probability</div>';
          lh += '<p class="subtitle" style="margin-top:-6px;">Monte Carlo simulation (1,500 draws) of this GW added to each manager\'s season total. Squads are simulated independently of each other.</p>';
          if (race.you) {
            const you = race.you;
            const leader = race.entrants[0];
            const isLeading = you.entry === leader.entry;
            lh += `<div class="chip-sequence">`;
            lh += `<div class="chip-card"><div class="chip-label">Your Win Prob.</div><div class="chip-score" style="color:${you.winProb >= 20 ? '#00ff87' : '#fbbf24'};">${you.winProb}%</div><div class="chip-advice">P(rank 1 this GW)</div></div>`;
            lh += `<div class="chip-card"><div class="chip-label">Your Top-3 Prob.</div><div class="chip-score" style="color:#60a5fa;">${you.top3Prob}%</div><div class="chip-advice">P(top 3 this GW)</div></div>`;
            lh += `<div class="chip-card"><div class="chip-label">${isLeading ? "You're Favored" : "Front-Runner"}</div><div class="chip-score" style="color:${isLeading ? '#00ff87' : '#ef4444'};font-size:0.8rem;">${VG.esc(isLeading ? you.name : leader.name)}</div><div class="chip-advice">${isLeading ? "highest win prob." : leader.winProb + "% win prob."}</div></div>`;
            lh += `</div>`;
          } else {
            lh += '<p style="color:#475569;font-size:0.72rem;margin-top:-4px;">Enter your FPL Team ID in the sidebar to see your own win probability. Showing the field below.</p>';
          }
          lh += '<table class="data-table" style="font-size:0.72rem;margin-top:8px;"><tr><th>#</th><th>Manager</th><th>Season Pts</th><th>GW Proj. (floor–ceiling)</th><th>Win %</th><th>Top-3 %</th></tr>';
          race.entrants.forEach((r, i) => {
            const isYou = race.you && r.entry === race.you.entry;
            const rowStyle = isYou ? 'background:rgba(0,255,135,0.06);' : '';
            lh += `<tr style="${rowStyle}"><td style="color:#94a3b8;">${i + 1}</td><td style="color:#e2e8f0;${isYou ? 'font-weight:700;' : ''}">${VG.esc(r.name)}${isYou ? ' <span style="color:#00ff87;font-size:0.62rem;">(you)</span>' : ''}</td><td style="color:#94a3b8;">${r.priorTotal}</td><td style="color:#64748b;">${r.gwMean} (${r.gwFloor}–${r.gwCeiling})</td><td style="color:${r.winProb >= 20 ? '#00ff87' : '#94a3b8'};font-weight:600;">${r.winProb}%</td><td style="color:#60a5fa;">${r.top3Prob}%</td></tr>`;
          });
          lh += '</table></div>';

          // What-If: Monte Carlo race scenarios against the same rivals (v5.8).
          // Test "what if I bring X in / captain Y" and see the impact on your
          // win probability , same draws for baseline and scenario so the delta
          // is attributable to the change, not simulation noise.
          if (race.you) {
            const you = race.you;
            lh += '<div style="margin-top:14px;"><div class="section-title" style="font-size:0.8rem;color:#60a5fa;">🔀 What-If Race Scenarios</div>';
            lh += '<p class="subtitle" style="margin-top:-6px;">Simulate a transfer or captaincy change and re-run the race against your rivals. Changes affect only your squad.</p>';
            lh += `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:0.7rem;">`;
            lh += `<select id="whatIfPlayer" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:5px 8px;font-size:0.68rem;max-width:300px;"><option value="">Select a player…</option>`;
            (VG.allXP || []).filter(p => p.position !== 'GK').slice(0, 300).forEach(p => {
              lh += `<option value="${p.id}">${VG.esc(p.name)} · ${VG.esc(p.teamName)} £${p.price.toFixed(1)}m (${p.totalXP.toFixed(1)} xP)</option>`;
            });
            lh += `</select>`;
            lh += `<button data-action="what-if" data-mode="transfer" data-gw="${gw}" style="background:#60a5fa;color:#0b1120;border:none;border-radius:6px;padding:6px 12px;font-size:0.68rem;font-weight:600;cursor:pointer;">Transfer In</button>`;
            lh += `<button data-action="what-if" data-mode="captain" data-gw="${gw}" style="background:#fbbf24;color:#0b1120;border:none;border-radius:6px;padding:6px 12px;font-size:0.68rem;font-weight:600;cursor:pointer;">Make Captain</button>`;
            lh += `<span style="color:#475569;font-size:0.62rem;">Your current win prob: <b style="color:#00ff87;">${you.winProb}%</b></span>`;
            lh += `</div>`;
            lh += `<div id="whatIfResult" style="margin-top:8px;"></div>`;
            lh += `</div>`;
          }
        }

        // Differentials
        if (league.differentials.length > 0) {
          lh += '<div style="margin-top:14px;"><div class="section-title" style="font-size:0.8rem;color:#00ff87;">Your Differentials</div>';
          lh += '<table class="data-table" style="font-size:0.72rem;"><tr><th>Player</th><th>Pos</th><th>League Own%</th><th>Captains</th></tr>';
          league.differentials.forEach(p => {
            lh += `<tr><td style="color:#e2e8f0;">${VG.esc(p.name)}</td><td>${VG.esc(p.position)}</td><td style="color:#00ff87;">${p.ownershipPct}%</td><td>${p.captains}</td></tr>`;
          });
          lh += '</table></div>';
        }

        // Outliers
        if (league.outliers.length > 0) {
          lh += '<div style="margin-top:14px;"><div class="section-title" style="font-size:0.8rem;color:#ef4444;">Popular Picks You\'re Missing</div>';
          lh += '<table class="data-table" style="font-size:0.72rem;"><tr><th>Player</th><th>Pos</th><th>League Own%</th><th>Captains</th></tr>';
          league.outliers.forEach(p => {
            lh += `<tr><td style="color:#e2e8f0;">${VG.esc(p.name)}</td><td>${VG.esc(p.position)}</td><td style="color:#ef4444;">${p.ownershipPct}%</td><td>${p.captains}</td></tr>`;
          });
          lh += '</table></div>';
        }

        // League standings mini-table
        if (league.squads.length > 0) {
          lh += '<div style="margin-top:14px;"><div class="section-title" style="font-size:0.8rem;">League Standings</div>';
          lh += '<table class="data-table" style="font-size:0.72rem;"><tr><th>#</th><th>Manager</th><th>GW</th><th>Total</th><th>Captain</th></tr>';
          league.squads.forEach(s => {
            lh += `<tr><td style="color:#94a3b8;">${VG.esc(s.rank || "-")}</td><td style="color:#e2e8f0;">${VG.esc(s.name)}</td><td>${VG.esc(s.gwPoints)}</td><td style="color:#fbbf24;">${VG.esc(s.totalPoints)}</td><td style="color:#94a3b8;">${VG.esc(s.captain)}</td></tr>`;
          });
          lh += '</table></div>';
        }

        document.getElementById("leagueContent").innerHTML = lh;
      } else {
        document.getElementById("leagueContent").innerHTML = '<p style="color:#475569;">Could not load league data. Check the League ID is correct and the league is public.</p>';
      }
    } else {
      document.getElementById("leagueContent").innerHTML = '<p style="color:#475569;">Enter a FPL Team ID to compare your squad against your own classic league automatically (no Mini-League ID needed).</p>';
    }
  } catch(e) {
    console.warn("[VG] League:", e);
    document.getElementById("leagueContent").innerHTML = '<p style="color:#475569;">League analysis unavailable.</p>';
  }

  try {
    document.getElementById("tipsContent").innerHTML = VG.render.tips(VG.currentResult, VG.allXP, VG.allFixtures, parseInt(el('gameweek').value));
  } catch(e) {
    console.warn("[VG] Tips:", e);
  }
};

// What-If race scenario runner (v5.8). Reuses analyzeLeague's cached league
// fetch, applies the change, re-runs the Monte Carlo race, renders the delta.
VG.runWhatIf = async (mode, gw) => {
  const resultEl = document.getElementById("whatIfResult");
  if (!resultEl) return;
  const playerId = parseInt(document.getElementById("whatIfPlayer")?.value || "0");
  if (!playerId) { resultEl.innerHTML = '<p style="color:#475569;">Select a player first.</p>'; return; }
  const leagueId = VG.primaryLeagueId || 0;
  if (!leagueId) return;
  try {
    resultEl.innerHTML = '<p style="color:#60a5fa;">Simulating…</p>';
    const league = await VG.analyzeLeague(leagueId, gw, VG.allFixtures);
    if (!league || !league.rawSquads) { resultEl.innerHTML = '<p style="color:#ef4444;">Could not reload league for scenario.</p>'; return; }
    const scenario = mode === 'captain' ? { captainId: playerId } : { addId: playerId };
    const result = VG.raceScenarioDelta(league.rawSquads, VG.allFixtures, gw, 1500, scenario);
    if (!result) { resultEl.innerHTML = '<p style="color:#ef4444;">Scenario unavailable (need 2+ squads and your team ID).</p>'; return; }
    const b = result.baseline, s = result.scenario;
    const delta = result.delta;
    const color = delta > 0 ? '#00ff87' : delta < 0 ? '#ef4444' : '#94a3b8';
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '-';
    const deltaTxt = `${arrow} ${delta >= 0 ? '+' : ''}${delta}pp`;
    const gain = s.winProb - b.winProb;
    resultEl.innerHTML = `<div class="chip-sequence">
      <div class="chip-card"><div class="chip-label">Baseline Win Prob.</div><div class="chip-score" style="color:#00ff87;">${b.winProb}%</div><div class="chip-advice">current squad</div></div>
      <div class="chip-card"><div class="chip-label">${mode === 'captain' ? 'New Captain Win Prob.' : 'With Transfer Win Prob.'}</div><div class="chip-score" style="color:${color};">${s.winProb}%</div><div class="chip-advice">${deltaTxt}</div></div>
      <div class="chip-card"><div class="chip-label">GW Mean</div><div class="chip-score" style="color:#60a5fa;">${b.gwMean} → ${s.gwMean}</div><div class="chip-advice">${gain >= 0 ? '+' : ''}${gain.toFixed(1)} xP</div></div>
    </div>
    <p style="color:#475569;font-size:0.62rem;margin-top:4px;">Baseline and scenario share the same 1,500 random draws, so the ${deltaTxt} is attributable to the change alone (first-order: rivals' squads are fixed).</p>`;
  } catch(e) {
    console.warn("[VG] What-If:", e);
    resultEl.innerHTML = '<p style="color:#ef4444;">Scenario simulation failed.</p>';
  }
};

VG.renderComparison = () => {
  const sel = document.getElementById("compareSelect");
  const selected = Array.from(sel.selectedOptions)
    .map(o => VG.allXP.find(x => x.id === parseInt(o.value)))
    .filter(Boolean).slice(0, 3);
  if (selected.length < 2) { document.getElementById("compareTable").innerHTML = ""; return; }
  const colors = ['#00ff87', '#7c3aed', '#fbbf24'];

  // ── Radar: xP components (the real comparison) ──
  const radarLabels = ["Appearance", "Clean Sheet", "Goals", "Assists", "Bonus", "DEFCON", "Saves"];
  const radarDatasets = [];
  selected.forEach((p, i) => {
    const xc = p.xpComponents || {};
    radarDatasets.push({
      label: p.name,
      data: [xc.xpAppearance || 0, xc.xpCS || 0, xc.xpGoals || 0, xc.xpAssists || 0, xc.xpBonus || 0, xc.xpDEFCON || 0, xc.xpSaves || 0],
      borderColor: colors[i], backgroundColor: colors[i] + "18", borderWidth: 2, pointRadius: 3
    });
  });

  const radarCtx = document.getElementById("radarChart");
  if (radarCtx._chart) radarCtx._chart.destroy();
  radarCtx._chart = new Chart(radarCtx, {
    type: 'radar',
    data: { labels: radarLabels, datasets: radarDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { r: { grid: { color: 'rgba(255,255,255,0.05)' }, pointLabels: { color: '#64748b', font: { size: 11, family: 'Inter' } }, ticks: { display: false }, suggestedMin: 0 } },
      plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11, family: 'Inter' } } } }
    }
  });

  // ── Stacked xP breakdown bar chart ──
  const barLabels = selected.map(p => p.name);
  const barComponents = ['xpAppearance', 'xpCS', 'xpGoals', 'xpAssists', 'xpBonus', 'xpDEFCON', 'xpSaves'];
  const barColors = ['#64748b', '#3b82f6', '#22c55e', '#a78bfa', '#fbbf24', '#f97316', '#06b6d4'];
  const barNames = ['Appearance', 'Clean Sheet', 'Goals', 'Assists', 'Bonus', 'DEFCON', 'Saves'];
  const barDatasets = barComponents.map((comp, ci) => ({
    label: barNames[ci],
    data: selected.map(p => p.xpComponents?.[comp] || 0),
    backgroundColor: barColors[ci]
  }));

  const barContainer = document.getElementById("compareBarContainer");
  if (barContainer) {
    if (barContainer._chart) barContainer._chart.destroy();
    barContainer._chart = new Chart(barContainer, {
      type: 'bar',
      data: { labels: barLabels, datasets: barDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 12, family: 'Inter', weight: 'bold' } } }
        },
        plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10, family: 'Inter' } } } }
      }
    });
  }

  // ── Table: raw stats + xP components ──
  let tableHtml = '<table class="data-table"><tr><th>Player</th><th>Pos</th><th>Price</th><th>Total xP</th><th>xP/£m</th><th>Real xG</th><th>xG/90</th><th>xG Reg</th><th>EO</th><th>SP</th><th>xMins</th><th>Rec</th><th>Market</th><th>App</th><th>CS</th><th>Goals</th><th>Assists</th><th>Bonus</th><th>DEFCON</th><th>Saves</th></tr>';
  selected.forEach((p) => {
    const xc = p.xpComponents || {};
    const spBadge = VG.setPieceBadge(p.setPiece || {});
    const market = VG.marketBadge(VG.getMarketTag(p));
    const isNewBadge = p.isNew ? '<span style="background:rgba(96,165,250,0.12);color:#60a5fa;padding:1px 6px;border-radius:4px;font-size:0.65rem;white-space:nowrap;">NEW</span>' : '';
    const transferBadge = p.transferred ? VG.transferBadge({ transferred: true, fromTeam: p.fromTeam ? { short_name: p.fromTeam } : null, toTeam: p.toTeam ? { short_name: p.toTeam } : null }) : '';
    const recLine = p.recency ? `<span title="Last-3-GW xGI/90: ${p.recency.xgi90} · pts/90: ${p.recency.pts90}" style="color:#a78bfa;">${p.recency.rounds}GW</span>` : '<span style="color:#475569;">-</span>';
    tableHtml += `<tr><td style="color:#e2e8f0;">${VG.watchToggle(p)} ${VG.esc(p.name)} ${isNewBadge}${transferBadge}</td><td>${VG.esc(p.position)}</td><td>£${p.price.toFixed(1)}m</td><td style="color:#00ff87;">${(p.totalXP || 0).toFixed(1)}</td><td>${(p.xpPerPrice || 0).toFixed(2)}</td>`;
    tableHtml += `<td>${(p.realXG || 0).toFixed(1)}</td><td>${(p.realXG90 || 0).toFixed(2)}</td>`;
    tableHtml += `<td>${VG.regressionBadge(p.regression)}</td>`;
    tableHtml += `<td style="color:#a78bfa;">${(p.eo || 0).toFixed(1)}</td>`;
    tableHtml += `<td style="color:#fbbf24;">${spBadge || '-'}</td>`;
    tableHtml += `<td>${(p.xMins || 0).toFixed(0)}</td>`;
    tableHtml += `<td>${recLine}</td>`;
    tableHtml += `<td>${market || '-'}</td>`;
    tableHtml += `<td>${(xc.xpAppearance || 0).toFixed(1)}</td>`;
    tableHtml += `<td>${(xc.xpCS || 0).toFixed(1)}</td>`;
    tableHtml += `<td>${(xc.xpGoals || 0).toFixed(1)}</td>`;
    tableHtml += `<td>${(xc.xpAssists || 0).toFixed(1)}</td>`;
    tableHtml += `<td>${(xc.xpBonus || 0).toFixed(1)}</td>`;
    tableHtml += `<td>${(xc.xpDEFCON || 0).toFixed(1)}</td>`;
    tableHtml += `<td>${(xc.xpSaves || 0).toFixed(1)}</td></tr>`;
  });
  tableHtml += '</table>';
  document.getElementById("compareTable").innerHTML = tableHtml;
};

VG.init();

// ── Deadline countdown timer ──────────────────────────────────────────
VG._deadlineTimer = null;
VG.startDeadlineCountdown = () => {
  const el = document.getElementById("deadlineCountdown");
  if (!el || !VG.bootstrapData) return;
  const evts = VG.bootstrapData.events || [];
  const current = evts.find(e => e.is_current) || evts.find(e => e.is_next) || evts[VG.currentGW - 1];
  if (!current || !current.deadline_time) { el.textContent = ""; return; }
  const dl = new Date(current.deadline_time);
  const gwNum = current.id || current.gameweek || "?";
  if (VG._deadlineTimer) clearInterval(VG._deadlineTimer);
  const tick = () => {
    const diff = dl - Date.now();
    if (diff <= 0) { el.textContent = "DEADLINE PASSED"; el.style.color = "#ef4444"; clearInterval(VG._deadlineTimer); return; }
    const d = Math.floor(diff / 864e5);
    const h = Math.floor((diff % 864e5) / 36e5);
    const m = Math.floor((diff % 36e5) / 6e4);
    const s = Math.floor((diff % 6e4) / 1e3);
    const urgent = diff < 36e5;
    el.style.color = urgent ? "#ef4444" : diff < 216e5 ? "#fbbf24" : "#94a3b8";
    el.textContent = `GW${gwNum} deadline: ${d > 0 ? d + "d " : ""}${h}h ${m}m ${s}s`;
  };
  tick();
  VG._deadlineTimer = setInterval(tick, 1000);
};
