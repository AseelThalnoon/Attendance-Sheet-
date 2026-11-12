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
// Several suites at once (4 by default; --jobs N, or TEST_JOBS=N, and
// --jobs 1 for the old one-after-another run). Most of a suite's time is a
// browser waiting -- fixed pauses for the screen to settle were 79% of
// collisions.js -- not the machine working, so running four side by side
// cuts the wall clock without the suites competing for much. Ports do not
// collide: the suites with a fixed port each have their own (8951-8955,
// 8961), and the rest take a free one. Each suite's output is held and
// printed in one piece when it finishes, so lines never interleave.
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

// Explicit rather than discovered: tests/ also holds harnesses, fixtures,
// builders and two scan tools (mobile/scan.js, hostile/scan.js) that are
// developer instruments rather than suites, and a glob would run those too.
// Listed in the order the && chain used; the run itself starts the slowest
// first (SLOW_FIRST below), and the summary reports in this order.
const SUITES = [
  "parsers/test-parsers.js",
  "modal/test-modal.js",
  "clock/test-clock.js",
  "push/test-push-actions.js",
  "regression/audit-logic.js",
  "regression/clockout-reminders.js",
  "regression/service-worker.js",
  "regression/audit-dom.js",
  "regression/settings-swap.js",
  "regression/admin-tab.js",
  "regression/palette-contrast.js",
  "regression/one-screen.js",
  "regression/shared-avatars.js",
  "regression/password-recovery.js",
  "regression/onboarding.js",
  "regression/crash-handler.js",
  "regression/passkeys.js",
  "regression/whos-away.js",
  "regression/pull-refresh.js",
  "regression/ios.js",
  "regression/collisions.js",
  "mobile/form-grid.js",
  "mobile/controls.js",
  "mobile/collision.js",
  "mobile/touch-floor.js",
  "hostile/hostile.js",
  "apple/devices.js",
  "apple/ios-push.js"
];

// The slowest go first, so they overlap each other instead of one of them
// starting last and running alone at the end.
const SLOW_FIRST = ["hostile/hostile.js", "regression/collisions.js", "apple/ios-push.js",
  "apple/devices.js", "regression/passkeys.js", "regression/one-screen.js"];
const queue = SLOW_FIRST.filter(s => SUITES.includes(s))
  .concat(SUITES.filter(s => !SLOW_FIRST.includes(s)));

const argJobs = (() => {
  const i = process.argv.indexOf("--jobs");
  return i !== -1 ? process.argv[i + 1] : process.env.TEST_JOBS;
})();
const JOBS = Math.max(1, Math.min(parseInt(argJobs, 10) || 4, os.cpus().length || 1));

const results = [];
const runStarted = Date.now();

function runSuite(suite){
  return new Promise(resolve => {
    const started = Date.now();
    // --require no-network.js: every suite's browsers answer *.supabase.co
    // themselves rather than reaching the live project (see that file).
    const child = spawn(process.execPath, ["--require", path.join(__dirname, "no-network.js"), path.join(__dirname, suite)], {
      cwd: __dirname, stdio: ["ignore", "pipe", "pipe"]
    });
    const out = [];
    child.stdout.on("data", d => out.push(d));
    child.stderr.on("data", d => out.push(d));
    child.on("error", err => finish(null, null, err));
    child.on("close", (code, signal) => finish(code, signal, null));
    let done = false;
    function finish(code, signal, error){
      if(done) return;
      done = true;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0;
      process.stdout.write(Buffer.concat(out));
      // A suite killed by a signal (a hung browser reaped by CI, an OOM)
      // reports status null, which is neither 0 nor a number to print. That
      // is a failure, and naming the signal is the only clue anyone gets.
      const detail = signal ? `killed by ${signal}` : error ? String(error.message) : ok ? "" : `exit ${code}`;
      if(!ok) console.log(`  !! ${suite} ${detail}`);
      results.push({ suite, ok, seconds, detail });
      resolve();
    }
  });
}

async function worker(){
  while(queue.length) await runSuite(queue.shift());
}

(async () => {
  await Promise.all(Array.from({ length: JOBS }, worker));
  // Report in the listed order, whatever order they finished in.
  results.sort((a, b) => SUITES.indexOf(a.suite) - SUITES.indexOf(b.suite));
  report();
})();

function report(){
  const failed = results.filter(r => !r.ok);
  const slowest = results.slice().sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  const total = ((Date.now() - runStarted) / 1000).toFixed(0);

  console.log("");
  console.log(`  ${results.length - failed.length}/${results.length} suites passed in ${total}s, ${JOBS} at a time` +
    `  (slowest: ${slowest.map(s => `${s.suite} ${s.seconds}s`).join(", ")})`);

  if(failed.length){
    console.log("");
    console.log(`  ${failed.length} suite${failed.length === 1 ? "" : "s"} failed:`);
    failed.forEach(f => console.log(`    ${f.suite}  ${f.detail}`));
    process.exit(1);
  }
}
