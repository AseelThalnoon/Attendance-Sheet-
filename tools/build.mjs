// Builds the copy of the app that is published.
//
//   node tools/build.mjs            -> dist/
//   node tools/build.mjs --out DIR  -> DIR
//
// The source runs as it is: open index.html from any static server and that is
// the app, with nothing to compile. That has not changed, and local work and
// the test suites all run on the source. What changed (2026-11-15, the owner's
// decision, replacing "no build step -- deployment is a file copy") is what is
// PUBLISHED. app.js is a third commentary by weight and index.html carries
// 400KB of commented stylesheet; both were going out to every phone as written.
// This makes the published copy from the source instead of copying it:
//
//   * scripts and styles are minified -- whitespace and comments go, the code
//     is rewritten into its shortest equivalent form, and names are KEPT, so a
//     crash report from the field still reads `at handleSignedIn`, not `at a`;
//   * only the files the app loads are published. The source tree's tests,
//     migrations, design notes and audit report were being served alongside
//     the app for no reason other than living in the same folder;
//   * every build is stamped as its own release. The label becomes
//     "<label>-<hash of the built files>", written into index.html and sw.js
//     together, so two different builds can never share a name and nobody has
//     to remember to move it on (see tools/stamp-release.mjs for why a release
//     that does not change sw.js never reaches an installed app).
//
// It is deliberately a transform of each file in place, not a bundle: the
// published folder has the same files at the same paths as the source, so
// index.html's preload hints and sw.js's list of what to save mean the same
// thing in both, and there is no second arrangement of the app to keep right.
//
// tests/regression/build-output.js builds with this and checks the result is
// the same app: every element styled the same, and it boots and works.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellFiles, shellFingerprint } from "./stamp-release.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// esbuild is installed with the test tooling (tests/package.json), which is
// the one place this repository keeps its development dependencies.
const esbuild = createRequire(path.join(ROOT, "tests", "package.json"))("esbuild");

const read = (root, file) => fs.readFileSync(path.join(root, file));
const text = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
function write(root, file, data){
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

// Whitespace and syntax, not names. charset utf8 keeps "—" as one character
// rather than six; every one of these files is served and read as UTF-8.
const JS = { minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false,
  legalComments: "none", charset: "utf8", target: "es2022" };

async function minifyModule(source, sourcefile){
  return (await esbuild.transform(source, { ...JS, loader: "js", format: "esm", sourcefile })).code;
}
// theme-boot.js and sw.js are classic scripts, not modules: no format is
// given, so nothing about their top level is rearranged.
async function minifyScript(source, sourcefile){
  return (await esbuild.transform(source, { ...JS, loader: "js", sourcefile })).code;
}
async function minifyCss(source){
  return (await esbuild.transform(source, { loader: "css", minify: true, legalComments: "none", charset: "utf8" })).code;
}

// index.html: the stylesheet minified, the comments removed, the markup left
// exactly as written otherwise. Collapsing whitespace between tags is where
// HTML minifiers change what a page looks like -- a space between two inline
// elements is content -- and gzip already makes indentation nearly free.
async function buildPage(source){
  const open = source.indexOf("<style>"), close = source.indexOf("</style>");
  if(open === -1 || close === -1 || source.indexOf("<style>", open + 1) !== -1){
    throw new Error("index.html: expected exactly one <style> block");
  }
  const css = await minifyCss(source.slice(open + "<style>".length, close));
  const strip = html => html
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n").map(line => line.replace(/\s+$/, "")).filter(line => line.trim() !== "").join("\n");
  return strip(source.slice(0, open)) + "\n<style>" + css.trim() + "</style>" + strip(source.slice(close + "</style>".length)) + "\n";
}

// Every file the page asks for by a relative address, plus the manifest's.
function referencedFiles(root){
  const html = text(root, "index.html").replace(/<!--[\s\S]*?-->/g, "");
  const out = new Set();
  for(const m of html.matchAll(/\s(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)){
    if(!/^(?:[a-z]+:|\/\/|#)/i.test(m[1])) out.add(m[1].replace(/^\.\//, ""));
  }
  for(const m of html.matchAll(/url\("([^"]+)"\)/g)){
    if(!/^(?:data:|[a-z]+:)/i.test(m[1])) out.add(m[1].replace(/^\.\//, ""));
  }
  const manifest = JSON.parse(text(root, "manifest.json"));
  const add = src => out.add(String(src).split(/[?#]/)[0].replace(/^\.\//, ""));
  (manifest.icons || []).forEach(i => add(i.src));
  (manifest.shortcuts || []).forEach(s => (s.icons || []).forEach(i => add(i.src)));
  return out;
}

export async function build(outDir = path.join(ROOT, "dist")){
  const sw = text(ROOT, "sw.js");
  const shell = shellFiles(sw).map(f => f.replace(/^\.\//, ""));
  const files = new Set([...shell, ...referencedFiles(ROOT)]);
  files.delete("");
  const missing = [...files].filter(f => !fs.existsSync(path.join(ROOT, f)));
  if(missing.length) throw new Error("referenced but not in the repository: " + missing.join(", "));

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Everything but the page and the worker, which both carry the label.
  for(const file of files){
    if(file === "index.html") continue;
    if(file === "vendor/supabase-js.min.js"){ write(outDir, file, read(ROOT, file)); continue; }   // already minified
    if(file === "theme-boot.js") write(outDir, file, await minifyScript(text(ROOT, file), file));
    else if(file.endsWith(".js")) write(outDir, file, await minifyModule(text(ROOT, file), file));
    else if(file.endsWith(".json")) write(outDir, file, JSON.stringify(JSON.parse(text(ROOT, file))));
    else write(outDir, file, read(ROOT, file));
  }

  // 2. The page, still carrying the source's label, so the hash below is of
  //    content alone and the same source always builds to the same release.
  const sourceLabel = (/const CACHE_NAME = "attendance-ledger-shell-([^"]+)";/.exec(sw) || [])[1];
  if(!sourceLabel) throw new Error("sw.js: CACHE_NAME not found");
  const scriptTag = `<script type="module" src="app.js?v=${sourceLabel}"></script>`;
  let page = await buildPage(text(ROOT, "index.html"));
  if(page.split(scriptTag).length !== 2) throw new Error(`index.html: expected exactly one ${scriptTag}`);
  write(outDir, "index.html", page);
  const content = createHash("sha256");
  for(const file of shell){ content.update(file).update("\0").update(read(outDir, file)).update("\0"); }
  content.update(sw);
  const label = `${sourceLabel}-${content.digest("hex").slice(0, 8)}`;

  // 3. The label into the page; then the fingerprint of the finished shell,
  //    and both into the worker, which is minified last.
  page = page.replace(scriptTag, scriptTag.replace(sourceLabel, label));
  write(outDir, "index.html", page);
  const fingerprint = shellFingerprint(outDir, shell.map(f => "./" + f));
  const stamped = sw
    .replace(/const CACHE_NAME = "attendance-ledger-shell-[^"]+";/, `const CACHE_NAME = "attendance-ledger-shell-${label}";`)
    .replace(/const SHELL_FINGERPRINT = "[^"]*";/, `const SHELL_FINGERPRINT = "${fingerprint}";`);
  if(!stamped.includes(`shell-${label}"`) || !stamped.includes(`"${fingerprint}"`)) throw new Error("sw.js: could not stamp the build");
  write(outDir, "sw.js", await minifyScript(stamped, "sw.js"));

  // 4. What install() in sw.js will check, checked here first: every file it
  //    is going to save exists, and the page names this build.
  const builtSw = text(outDir, "sw.js");
  for(const file of shell){
    if(!fs.existsSync(path.join(outDir, file))) throw new Error("built shell is missing " + file);
    if(!builtSw.includes(`"./${file}"`)) throw new Error("built sw.js no longer lists ./" + file);
  }
  if(!text(outDir, "index.html").includes(`app.js?v=${label}"`)) throw new Error("built index.html does not name build " + label);

  const size = (root, list) => list.reduce((sum, f) => {
    const bytes = read(root, f);
    return { raw: sum.raw + bytes.length, gzip: sum.gzip + gzipSync(bytes, { level: 9 }).length };
  }, { raw: 0, gzip: 0 });
  // What a first visit downloads before the app can run.
  const first = ["index.html", "app.js", "theme-boot.js", "vendor/supabase-js.min.js", ...shell.filter(f => f.startsWith("src/"))];
  return { outDir, label, fingerprint, files: [...files, "sw.js"].sort(),
    firstLoad: { source: size(ROOT, first), built: size(outDir, first) },
    perFile: ["index.html", "app.js", "sw.js", "theme-boot.js"].map(f => ({ file: f, source: size(ROOT, [f]), built: size(outDir, [f]) })) };
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const i = process.argv.indexOf("--out");
  const result = await build(i !== -1 ? path.resolve(process.argv[i + 1]) : undefined);
  const kb = n => (n / 1024).toFixed(0).padStart(5) + " KB";
  console.log(`built release ${result.label} into ${path.relative(process.cwd(), result.outDir) || "."} (${result.files.length} files)`);
  for(const f of result.perFile){
    console.log(`  ${f.file.padEnd(14)} ${kb(f.source.raw)} -> ${kb(f.built.raw)}   gzip ${kb(f.source.gzip)} -> ${kb(f.built.gzip)}`);
  }
  const { source, built } = result.firstLoad;
  console.log(`  first visit    ${kb(source.raw)} -> ${kb(built.raw)}   gzip ${kb(source.gzip)} -> ${kb(built.gzip)}  (page, scripts and library)`);
}
