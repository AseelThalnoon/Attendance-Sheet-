// Stamps a release: moves the build label on and records the shell's
// fingerprint in sw.js.
//
//   node tools/stamp-release.mjs               label v47 -> v48, then stamp
//   node tools/stamp-release.mjs --keep-label  stamp only (label already moved)
//   node tools/stamp-release.mjs --check       say whether a stamp is due; change nothing
//
// Why this exists. The service worker opens the app from its saved copy and
// does not ask the network (see the head of sw.js). A new release therefore
// reaches an installed app in exactly one way: the browser notices that sw.js
// itself has changed. Change app.js and leave sw.js alone, and everybody who
// already has the app keeps the old one, indefinitely, with nothing anywhere
// to say so.
//
// So sw.js carries a fingerprint of every file it saves, and
// tests/regression/service-worker.js recomputes it. Touch any of those files
// and that suite fails until this has been run, which changes sw.js -- and
// that is the whole mechanism. The fingerprint is not read by the worker.
//
// The published copy does not depend on anyone remembering: tools/build.mjs
// stamps its own output on every deploy. This is for the source tree, and for
// the day the app is published straight from it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const LABEL = /const CACHE_NAME = "attendance-ledger-shell-([^"]+)";/;
const FINGERPRINT = /const SHELL_FINGERPRINT = "([^"]*)";/;

// The paths sw.js saves, read out of sw.js so there is one list. "./" is the
// folder's own address -- the same bytes as index.html, fetched twice.
export function shellFiles(swSource){
  const start = swSource.indexOf("const SHELL_FILES = [");
  const end = swSource.indexOf("];", start);
  if(start === -1 || end === -1) throw new Error("sw.js: SHELL_FILES not found");
  return [...swSource.slice(start, end).matchAll(/^\s*"(\.\/[^"]*)"/gm)]
    .map(m => m[1])
    .filter(p => p !== "./");
}

// Each file's path and bytes, in the order sw.js lists them. The path is part
// of it so that two files swapping contents is a change too.
// `files` defaults to the list in root's own sw.js; tools/build.mjs passes the
// list it has already read, because its sw.js is written last.
export function shellFingerprint(root = ROOT, files){
  files = files || shellFiles(readFileSync(path.join(root, "sw.js"), "utf8"));
  const hash = createHash("sha256");
  for(const file of files){
    hash.update(file).update("\0").update(readFileSync(path.join(root, file))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function readStamp(root = ROOT){
  const sw = readFileSync(path.join(root, "sw.js"), "utf8");
  const label = (LABEL.exec(sw) || [])[1];
  const recorded = (FINGERPRINT.exec(sw) || [])[1];
  if(!label) throw new Error("sw.js: CACHE_NAME not found");
  if(recorded === undefined) throw new Error("sw.js: SHELL_FINGERPRINT not found");
  return { label, recorded, actual: shellFingerprint(root) };
}

// Writes `label` into sw.js and index.html, then the fingerprint of the result
// into sw.js. index.html is one of the fingerprinted files, so the order
// matters: the label first, the fingerprint last.
export function stamp(root, label){
  const swPath = path.join(root, "sw.js"), htmlPath = path.join(root, "index.html");
  let sw = readFileSync(swPath, "utf8");
  let html = readFileSync(htmlPath, "utf8");
  const script = /(<script type="module" src="app\.js\?v=)[^"]+(")/;
  if(!LABEL.test(sw) || !FINGERPRINT.test(sw)) throw new Error("sw.js: label or fingerprint line not found");
  if(!script.test(html)) throw new Error('index.html: <script type="module" src="app.js?v=..."> not found');
  writeFileSync(htmlPath, html.replace(script, `$1${label}$2`));
  writeFileSync(swPath, sw.replace(LABEL, `const CACHE_NAME = "attendance-ledger-shell-${label}";`));
  const fingerprint = shellFingerprint(root);
  sw = readFileSync(swPath, "utf8");
  writeFileSync(swPath, sw.replace(FINGERPRINT, `const SHELL_FINGERPRINT = "${fingerprint}";`));
  return { label, fingerprint };
}

function nextLabel(label){
  const m = /^v(\d+)$/.exec(label);
  if(!m) throw new Error(`label "${label}" is not vNN -- move it by hand and rerun with --keep-label`);
  return "v" + (Number(m[1]) + 1);
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const args = new Set(process.argv.slice(2));
  const now = readStamp();
  if(args.has("--check")){
    if(now.recorded === now.actual){ console.log(`release ${now.label} is stamped and the shell has not changed since`); }
    else { console.log(`the shell has changed since ${now.label} was stamped (recorded ${now.recorded}, now ${now.actual})`); process.exitCode = 1; }
  } else if(now.recorded === now.actual && !args.has("--keep-label")){
    console.log(`nothing to do: release ${now.label} is stamped and the shell has not changed since`);
  } else {
    const done = stamp(ROOT, args.has("--keep-label") ? now.label : nextLabel(now.label));
    console.log(`stamped release ${done.label} (${done.fingerprint})`);
  }
}
