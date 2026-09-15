// Runs every suite, whatever any of them does.
//
// This replaces a chain of twenty `node x.js && node y.js` commands, and the
// reason is a bug that chain hid for as long as it had been failing. `&&`
// stops at the first non-zero exit, so one red suite silently takes every
// suite behind it out of the run -- they do not fail, they do not appear, they
// simply never execute. regression/collisions was failing on a calendar label,
// and behind it hostile, all four mobile suites and apple had not run at all.
// hostile was not merely unexercised: it was crashing outright, having been
// broken by an extraction that moved a constant into src/. Nothing said so,
// because nothing got that far.
//
// A test runner whose coverage silently depends on whether an earlier test
// passed is worse than no runner, because it reports green shrinking as green.
// Every suite runs here, the failures are collected, and the summary at the
// end names them.
//
// Sequential on purpose. These are browser suites that each bind their own
// fixed port (8951-8955, 8961) and drive a real Chromium or WebKit; running
// them at once would collide on the ports and compete for the machine, and
// the wall-clock saving is not worth an intermittent suite.
const { spawnSync } = require("child_process");
const path = require("path");

// Explicit rather than discovered: tests/ also holds harnesses, fixtures,
// builders and two scan tools (mobile/scan.js, hostile/scan.js) that are
// developer instruments rather than suites, and a glob would run those too.
// Order is the one the && chain used, cheapest first, so a quick logic break
// still reports in seconds.
const SUITES = [
  "parsers/test-parsers.js",
  "modal/test-modal.js",
  "clock/test-clock.js",
  "push/test-push-actions.js",
  "regression/audit-logic.js",
  "regression/audit-dom.js",
  "regression/admin-tab.js",
  "regression/palette-contrast.js",
  "regression/one-screen.js",
  "regression/shared-avatars.js",
  "regression/password-recovery.js",
  "regression/crash-handler.js",
  "regression/ios.js",
  "regression/collisions.js",
  "mobile/form-grid.js",
  "mobile/controls.js",
  "mobile/collision.js",
  "mobile/touch-floor.js",
  "hostile/hostile.js",
  "apple/devices.js"
];

const results = [];

for(const suite of SUITES){
  const started = Date.now();
  // stdio inherited so each suite prints its own line as it goes, exactly as
  // it did under the chain -- the summary below adds to that output, it does
  // not replace it.
  const run = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    cwd: __dirname,
    stdio: "inherit"
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // A suite killed by a signal (a hung browser reaped by CI, an OOM) reports
  // status null, which is neither 0 nor a number to print. That is a failure,
  // and naming the signal is the only clue anyone gets about it.
  const ok = run.status === 0;
  results.push({
    suite,
    ok,
    seconds,
    detail: run.signal ? `killed by ${run.signal}`
          : run.error ? String(run.error.message)
          : ok ? "" : `exit ${run.status}`
  });
  if(!ok) console.log(`  !! ${suite} ${run.signal ? "killed by " + run.signal : "exited " + run.status}`);
}

const failed = results.filter(r => !r.ok);
const slowest = results.slice().sort((a, b) => b.seconds - a.seconds).slice(0, 3);

console.log("");
console.log(`  ${results.length - failed.length}/${results.length} suites passed` +
  `  (slowest: ${slowest.map(s => `${s.suite} ${s.seconds}s`).join(", ")})`);

if(failed.length){
  console.log("");
  console.log(`  ${failed.length} suite${failed.length === 1 ? "" : "s"} failed:`);
  failed.forEach(f => console.log(`    ${f.suite}  ${f.detail}`));
  process.exit(1);
}
