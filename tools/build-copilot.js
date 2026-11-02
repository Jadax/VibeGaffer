// Builds the FPL Copilot userscript: copilot/copilot.js with docs/app.js and
// docs/data.js embedded unchanged, versioned from package.json. Output is
// served from the site so Tampermonkey can install and self-update it.
//
// usage: node tools/build-copilot.js          (writes the file)
//        node tools/build-copilot.js --check  (exit 1 if it is stale)
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "docs", "copilot", "fpl-copilot.user.js");

function build() {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const read = f => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
  const indent = s => s.split("\n").map(l => (l ? "    " + l : l)).join("\n");
  const engine = indent(`// ---- docs/app.js ----\n${read("docs/app.js")}\n// ---- docs/data.js ----\n${read("docs/data.js")}`);
  const template = read("copilot/copilot.js");
  if (!template.includes("/*__ENGINE__*/")) throw new Error("copilot.js lost its /*__ENGINE__*/ marker");
  return template.replace(/__VERSION__/g, version).replace("/*__ENGINE__*/", () => engine);
}

const built = build();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== built) {
    console.error("docs/copilot/fpl-copilot.user.js is stale: run npm run build:copilot");
    process.exit(1);
  }
  console.log("copilot userscript is up to date");
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, built);
  console.log("wrote", path.relative(root, out), (built.length / 1024).toFixed(0) + " KB");
}
