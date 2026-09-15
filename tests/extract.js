// Pulls blocks of code verbatim out of the live index.html so the tests
// exercise shipping code instead of a reimplementation of it.
//
// Blocks are located by content anchors rather than line numbers: index.html is
// one big file that shifts constantly, and a stale line range would silently
// test the wrong code. A missing anchor throws instead.
const fs = require("fs");
const path = require("path");

// ATTENDANCE_SRC points the suites at a different copy of index.html — used to
// confirm a test actually fails against the revision that had the bug, e.g.
//   git show HEAD:index.html > /tmp/head.html
//   ATTENDANCE_SRC=/tmp/head.html npm run test:clock
const SRC = process.env.ATTENDANCE_SRC || path.join(__dirname, "..", "index.html");

// The application JavaScript moved out of index.html into app.js so the page
// could ship a real Content-Security-Policy (an inline module would have forced
// script-src 'unsafe-inline'). Anchors are matched across BOTH files so JS
// anchors resolve in app.js and CSS/markup anchors still resolve in index.html,
// and every existing suite keeps working unchanged.
const APP_SRC = process.env.ATTENDANCE_APP_SRC || path.join(__dirname, "..", "app.js");

// app.js is being taken apart a piece at a time (it reached ten thousand lines
// in one IIFE), and the pieces land in src/ as ES modules. Reading the whole
// directory rather than naming files keeps this from needing an edit per
// extraction. Sorted so the concatenation is stable between runs -- a slice()
// that spans two files would otherwise capture different text depending on
// readdir order, which is the kind of failure that reproduces on one machine
// out of three.
//
// The modules are appended AFTER app.js on purpose. Every anchor pair that
// reaches into moved code now has both ends inside the same module, so nothing
// spans the boundary; the one pair that did (DEFAULT_SETTINGS to the Auth
// banner, in regression/audit-logic.js) was re-anchored when the constants
// moved rather than left to silently swallow the file.
const SRC_DIR = path.join(__dirname, "..", "src");

function moduleSources(){
  if(!fs.existsSync(SRC_DIR)) return [];
  return fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith(".js"))
    .sort()
    .map(f => fs.readFileSync(path.join(SRC_DIR, f), "utf8"));
}

function source(){
  const parts = [];
  if(fs.existsSync(APP_SRC)) parts.push(fs.readFileSync(APP_SRC, "utf8"));
  parts.push(...moduleSources());
  parts.push(fs.readFileSync(SRC, "utf8"));
  return parts.join("\n").split("\n");
}

// Returns the lines from the one starting with `from` up to (not including)
// the one starting with `to`. Both are matched on the trimmed line so
// indentation changes don't break extraction.
function slice(from, to){
  const lines = source();
  const start = lines.findIndex(l => l.trim().startsWith(from));
  if(start === -1) throw new Error(`extract: start anchor not found in index.html: ${from}`);
  const rest = lines.slice(start + 1).findIndex(l => l.trim().startsWith(to));
  if(rest === -1) throw new Error(`extract: end anchor not found in index.html: ${to}`);
  return lines.slice(start, start + 1 + rest).join("\n");
}

// A single line, matched the same way. For pulling one CSS rule or one
// statement without dragging its neighbours along.
function line(match){
  const found = source().filter(l => l.trim().startsWith(match));
  if(!found.length) throw new Error(`extract: line not found in index.html: ${match}`);
  if(found.length > 1) throw new Error(`extract: line is ambiguous (${found.length} matches): ${match}`);
  return found[0];
}

module.exports = { SRC, APP_SRC, source, slice, line };
