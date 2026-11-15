// The CSV a person downloads, as the spreadsheet that opens it will read it.
//
// Two things were wrong with "Export CSV", and neither showed in the app:
//
//   * A note is free text, and a spreadsheet runs any cell that starts with
//     = + - or @ as a formula. The activity-log export already defused those;
//     the attendance export did not, and it is the one opened by somebody
//     other than the author -- an administrator exporting a teammate's record
//     opens that teammate's notes.
//   * The file carried no byte-order mark, so Excel read it in the machine's
//     legacy code page and a note or a name in Arabic came out as mojibake.
//
// The figures must stay figures while that is fixed: "-0.50" in the Diff
// column is a number, and quoting it into text would break every sum drawn
// over it. And a file exported here has to import here again unchanged.
const fs = require("fs");
const { boot, settle, DESKTOP } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Ex Porter" });
const pad = n => String(n).padStart(2, "0");
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return ds(d); };

const ARABIC = "اجتماع مع العميل، ثم العودة";
const NOTES = [
  '=HYPERLINK("http://example.invalid","click")',
  "+1+1",
  "-2 hours agreed",
  "@SUM(A1:A9)",
  "\t=1+1",
  ARABIC,
  'Left early, "dentist"',
  "'already quoted",
  "plain note"
];
// One short day (07:30 worked against 8h, so Diff is negative) per note.
const entries = NOTES.map((note, i) => ({ id: "x" + i, user_id: me.id, date: dayAgo(NOTES.length - i),
  clock_in: "08:00", clock_out: "15:30", type: "regular", note, updated_at: "2026-01-01T00:00:00Z" }));
// Every day of the week is a working day here, so each row has a real target
// whatever weekday the suite happens to run on.
const settings = Object.assign({}, D.SETTINGS, { workDays: [0, 1, 2, 3, 4, 5, 6] });
const seed = () => ({ profiles: [me], entries: entries.map(e => Object.assign({}, e)),
  user_settings: [{ user_id: me.id, settings }] });

// A real CSV reader, independent of the app's own: quoted fields, doubled
// quotes, CRLF.
function parse(text){
  const rows = []; let row = [], cell = "", q = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(q){
      if(c === '"'){ if(text[i + 1] === '"'){ cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if(c === '"') q = true;
    else if(c === ","){ row.push(cell); cell = ""; }
    else if(c === "\r" || c === "\n"){
      if(c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if(cell.length || row.length){ row.push(cell); rows.push(row); }
  return rows;
}

async function grab(page, buttonId){
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(id => document.getElementById(id).click(), buttonId)
  ]);
  return fs.readFileSync(await download.path());
}

// Closed in the finally below whatever happens: a step that throws must fail
// the run, not leave a browser open and the process waiting on it for ever.
let h = null;

(async () => {
  h = await boot({ viewport: DESKTOP, meId: me.id, seed: seed() });
  const { page } = h;

  // ---- What is in the file ----------------------------------------------------
  const bytes = await grab(page, "exportCsvBtn");
  ok(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
    "the export opens with a UTF-8 byte-order mark, so Excel reads it as UTF-8",
    [...bytes.slice(0, 3)].map(b => b.toString(16)).join(" "));
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  const rows = parse(text);
  const head = rows[0];
  const col = name => head.indexOf(name);
  ok(col("Note") !== -1 && col("Diff (h)") !== -1 && col("Date") !== -1, "the header names its columns", head.join("|"));
  ok(rows.length === NOTES.length + 1, "one row per day", "rows=" + rows.length);

  const noteByDate = {};
  rows.slice(1).forEach(r => { noteByDate[r[col("Date")]] = r[col("Note")]; });
  const exported = entries.map(e => noteByDate[e.date]);

  const DANGEROUS = /^[=+\-@\t\r]/;
  const live = exported.filter(n => DANGEROUS.test(n));
  ok(live.length === 0, "no note cell starts with a character a spreadsheet would run", JSON.stringify(live));
  NOTES.forEach((orig, i) => {
    const want = DANGEROUS.test(orig) ? "'" + orig : orig;
    ok(exported[i] === want, `note ${i + 1} is ${DANGEROUS.test(orig) ? "defused with a leading apostrophe" : "written as typed"}`,
      `typed ${JSON.stringify(orig)} -> file ${JSON.stringify(exported[i])}`);
  });
  ok(exported.includes(ARABIC), "the Arabic note survives byte for byte");

  // The raw text, not the parsed cell: the figure must not have been quoted
  // or prefixed on its way out.
  const diffs = rows.slice(1).map(r => r[col("Diff (h)")]);
  ok(diffs.every(d => d === "-0.50"), "a negative figure is still a bare number", JSON.stringify(diffs.slice(0, 3)));
  ok(/,-0\.50,/.test(text) && !/'-0\.50/.test(text), "and is not quoted or apostrophised in the file itself");
  const bare = text.split("\r\n")[1].split(",")[0];
  ok(/^\d{4}-\d{2}-\d{2}$/.test(bare), "dates stay bare too, so the file sorts and filters as before", bare);

  // ---- The same file, back in -------------------------------------------------
  // Blank the notes server-side first, so what comes back can only have come
  // from the file.
  h.backend.state.entries.forEach(e => { e.note = ""; });
  await page.setInputFiles("#importCsvFile", { name: "attendance-export.csv", mimeType: "text/csv", buffer: bytes });
  await page.waitForSelector(".modal-overlay .modal-confirm", { timeout: 5000 });
  const asked = await page.evaluate(() => document.querySelector(".modal-overlay .modal-msg").textContent);
  ok(new RegExp("Found " + NOTES.length + " days").test(asked), "the exported file is read back as the same days", asked);
  await page.click(".modal-overlay .modal-confirm");
  await settle(page, 1500);
  const back = entries.map(e => (h.backend.state.entries.find(x => x.date === e.date) || {}).note);
  NOTES.forEach((orig, i) => {
    ok(back[i] === orig, `note ${i + 1} imports back as it was typed`,
      `typed ${JSON.stringify(orig)} -> imported ${JSON.stringify(back[i])}`);
  });

  // ---- The template a person fills in -----------------------------------------
  const tpl = await grab(page, "csvTemplateBtn");
  ok(tpl[0] === 0xEF && tpl[1] === 0xBB && tpl[2] === 0xBF, "the import template carries the mark as well");

  ok(h.errors.length === 0, "no script errors", h.errors.join(" | "));
})().catch(err => { fail++; failures.push("suite threw: " + (err && err.message || err)); })
  .finally(async () => {
    if(h) await h.close().catch(() => {});
    console.log(`  csv-export  pass ${pass}   fail ${fail}`);
    if(failures.length){
      failures.forEach(f => console.log("  FAIL " + f));
      process.exitCode = 1;
    }
  });
