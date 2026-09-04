// Regenerates the palette blocks inside index.html from tools/palettes.mjs.
//
// The generated region is delimited by the two comments the splice writes, so
// this can be re-run any number of times without eating the hand-written CSS
// on either side of it. Run it after changing a palette:
//
//   node tools/palettes.mjs --report   # must be clean first
//   node tools/apply-palettes.mjs
//   node tests/regression/palette-contrast.js
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "index.html");
const START = '  html[data-palette="atrium"], .theme-preview[data-palette="atrium"]{';
const END = "  /* ---- Theme plumbing";

const css = execSync("node " + JSON.stringify(path.join(HERE, "palettes.mjs")), { encoding: "utf8" }).trimEnd();

let html = fs.readFileSync(INDEX, "utf8");
const from = html.indexOf(START);
const to = html.indexOf(END);
if(from === -1 || to === -1 || to < from){
  throw new Error("generated palette region not found in index.html — has the delimiter comment changed?");
}
html = html.slice(0, from) + css + "\n\n" + html.slice(to);
fs.writeFileSync(INDEX, html);
console.log("palette blocks regenerated in index.html");
