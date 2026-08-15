// Builds a standalone page around the real showConfirm() and its deps,
// extracted verbatim from index.html, with minimal stand-ins for the two
// shell containers it reads.
const fs = require("fs");
const path = require("path");
const { slice } = require("../extract");

const OUT = path.join(__dirname, "harness.html");

const html = `<!doctype html><meta charset="utf-8"><title>modal harness</title>
<style>.modal-overlay{position:fixed;inset:0}</style>
<div id="appShell"></div><div id="authScreen" style="display:none"></div>
<button id="trigger">trigger</button>
<script>
${slice("var BIDI_CONTROLS", "var TOAST_ICONS")}
${slice("// Promise-based modal.", "// Rolls a list of entries into one summary")}
window.showConfirm = showConfirm;
</script>
`;

fs.writeFileSync(OUT, html);
if(!/function showConfirm/.test(html)) throw new Error("harness is missing showConfirm");
if(!/function dialogRoot/.test(html)) throw new Error("harness is missing dialogRoot");
module.exports = { OUT };
