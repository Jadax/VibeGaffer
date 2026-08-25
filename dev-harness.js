// Dev harness: load the engine exactly like the app does, then run analyses.
// Usage: node dev-harness.js
const fs = require("fs");
global.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.window = {};
global.fetch = async (url) => {
  // Serve same-origin data files so the real loaders work offline.
  const m = String(url).match(/data\/([a-z-]+\.json)$/);
  if (m) {
    const f = "docs/data/" + m[1];
    if (fs.existsSync(f)) return { ok: true, json: async () => JSON.parse(fs.readFileSync(f, "utf8")) };
  }
  return { ok: false, status: 404, json: async () => { throw new Error("404"); } };
};
global.VG = {};
const source = fs.readFileSync("docs/app.js", "utf8").replace("const VG = {};", "");
new Function(source)();
new Function(fs.readFileSync("docs/data.js", "utf8"))();

(async () => {
  const bootstrap = JSON.parse(fs.readFileSync("docs/data/bootstrap.json", "utf8"));
  const fixtures = JSON.parse(fs.readFileSync("docs/data/fixtures.json", "utf8"));
  VG.buildMaps(bootstrap);
  VG.allFixtures = fixtures;
  await VG.loadUnderstat();
  const allXP = VG.computeAllXP(1, 5, fixtures);
  console.log("=== TOP 20 by totalXP (GW1, horizon 5, understat loaded) ===");
  allXP.slice(0, 20).forEach((p, i) => console.log(String(i + 1).padStart(2) + ".", p.name.padEnd(14), p.position.padEnd(4), "| xP", p.totalXP.toFixed(1), "| xMins", p.xMins.toFixed(0), "| ep", p.epNext, "| £" + p.price));
  console.log();
  ["Haaland", "Salah", "Palmer", "Saka", "Dasilva", "De Cuyper", "Egan"].forEach(n => {
    const p = allXP.find(x => x.name === n);
    if (p) console.log(n.padEnd(12), "rank", String(allXP.indexOf(p) + 1).padStart(3), "| xP", p.totalXP.toFixed(1), "| xMins", p.xMins.toFixed(0));
    else console.log(n.padEnd(12), "not in pool");
  });
})();
