#!/usr/bin/env bash
# Compare engine-constant variants on the backtest. Each arg is a JSON override.
#   bash tools/sweep.sh '{}' '{"congestion":false}' '{"startK":2}'
cd "$(dirname "$0")/.."
for v in "$@"; do
  VG_MODEL="$v" node tools/backtest.js "${FROM:-2}" "${TO:-8}" >/dev/null 2>&1
  node -e "
const {perGW,rows}=require('./tools/.cache/last-run.json');
const m=a=>a.reduce((s,x)=>s+x,0)/a.length;
const rel=rows.filter(p=>p.own>=1||p.minsSoFar>=90);
const team=perGW.reduce((s,r)=>s+r.team.model,0);
const bias=m(rel.map(p=>p.proj))/m(rel.map(p=>p.act));
const ps=m(rel.filter(p=>p.fixtures===1).map(p=>p.comp.minsProb))/m(rel.filter(p=>p.fixtures===1).map(p=>p.a_.starts||0));
console.log(process.argv[1].padEnd(48),'rho',m(perGW.map(r=>r.rhoModel)).toFixed(3),' team',team,' level',bias.toFixed(2),' pStart',ps.toFixed(2));" "$v"
done
