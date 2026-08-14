// showConfirm(): the Enter key must resolve according to which button actually
// holds focus. A danger dialog deliberately autofocuses Cancel, so Enter there
// must cancel — not confirm a destructive action the user never chose.
const { chromium } = require("playwright");
const { OUT } = require("./build-harness");

const PAGE = "file://" + OUT;

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label){
  if(actual === expected) pass++;
  else { fail++; failures.push(`${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
}

// Opens a dialog, waits past the 40ms autofocus timer, runs `action`, and
// returns what the promise resolved to plus what had focus at that moment.
async function run(page, opts, action){
  await page.goto(PAGE);
  const resultPromise = page.evaluate(o => window.showConfirm("Are you sure?", o), opts);
  await page.waitForSelector(".modal-overlay .modal-confirm");
  await page.waitForTimeout(120);
  const focusedAtPress = await action(page);
  return { result: await resultPromise, focusedAtPress };
}
const focusedClass = page => page.evaluate(() => document.activeElement ? document.activeElement.className : "(none)");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // --- default dialog: focus starts on Confirm ---
  let r = await run(page, {}, async p => { const f = await focusedClass(p); await p.keyboard.press("Enter"); return f; });
  eq(r.focusedAtPress.includes("modal-confirm"), true, "default dialog autofocuses Confirm");
  eq(r.result, true, "default dialog + Enter on Confirm resolves true");

  // --- danger dialog: focus deliberately starts on Cancel ---
  r = await run(page, { danger: true }, async p => { const f = await focusedClass(p); await p.keyboard.press("Enter"); return f; });
  eq(r.focusedAtPress.includes("modal-cancel"), true, "danger dialog autofocuses Cancel");
  eq(r.result, false, "danger dialog + Enter on Cancel resolves FALSE");

  // --- danger dialog, user moves to Confirm first ---
  r = await run(page, { danger: true }, async p => {
    await p.evaluate(() => document.querySelector(".modal-confirm").focus());
    const f = await focusedClass(p);
    await p.keyboard.press("Enter");
    return f;
  });
  eq(r.focusedAtPress.includes("modal-confirm"), true, "danger dialog: focus moved to Confirm");
  eq(r.result, true, "danger dialog + Enter on Confirm still resolves true");

  // --- default dialog, user moves to Cancel first ---
  r = await run(page, {}, async p => {
    await p.evaluate(() => document.querySelector(".modal-cancel").focus());
    await p.keyboard.press("Enter");
    return "";
  });
  eq(r.result, false, "default dialog + Enter on Cancel resolves false");

  // --- REGRESSION: Escape still cancels either kind ---
  r = await run(page, { danger: true }, async p => { await p.keyboard.press("Escape"); return ""; });
  eq(r.result, false, "Escape cancels danger dialog");
  r = await run(page, {}, async p => { await p.keyboard.press("Escape"); return ""; });
  eq(r.result, false, "Escape cancels default dialog");

  // --- REGRESSION: clicks still work ---
  r = await run(page, {}, async p => { await p.click(".modal-confirm"); return ""; });
  eq(r.result, true, "clicking Confirm resolves true");
  r = await run(page, { danger: true }, async p => { await p.click(".modal-cancel"); return ""; });
  eq(r.result, false, "clicking Cancel resolves false");

  // --- REGRESSION: the focus trap keeps Tab inside the modal ---
  await page.goto(PAGE);
  const trapPromise = page.evaluate(() => window.showConfirm("trap", {}));
  await page.waitForSelector(".modal-overlay");
  await page.waitForTimeout(120);
  const seen = [];
  for(let i = 0; i < 5; i++){
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => document.querySelector(".modal-card").contains(document.activeElement)));
  }
  eq(seen.every(Boolean), true, "Tab x5 never escapes the modal card");
  await page.keyboard.press("Escape");
  await trapPromise;

  await browser.close();
  console.log(`  modal     pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
