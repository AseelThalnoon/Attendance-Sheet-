// Keeps the browser suites off the live Supabase project.
//
// Several suites serve the real app.js, and app.js carries the real project
// URL. Any request a suite does not answer itself goes to production: the
// project's logs for 2026-11-08 show HeadlessChrome calling
// rpc/public_app_flags 15 times and POSTing to client_errors 7 times in one
// afternoon of test runs, on every push in CI as well as locally. Those writes
// were refused only because signed-out crash reports were; once the table
// accepts them, every run would file junk crash reports against the real app.
//
// Loaded into every suite by run-all.js (node --require), and required by the
// suites known to need it so a direct `node regression/x.js` is covered too.
// It adds a browser-context route that answers any *.supabase.co request the
// suite did not answer itself. Playwright gives page.route() handlers
// precedence over context ones, so a suite's own scripted backend
// (hostile/backend.js and friends) is untouched; this only catches what would
// otherwise have left the machine. What it caught is listed when the suite
// exits, so a new leak shows up in the run instead of in production's logs.
const path = require("path");

let playwright;
try{
  playwright = require(require.resolve("playwright", { paths: [__dirname] }));
}catch(e){
  return;   // a non-browser suite, run somewhere playwright is not installed
}
if(playwright.__noNetwork) return;
playwright.__noNetwork = true;

const SUPABASE = /^https:\/\/[a-z0-9-]+\.supabase\.co\//i;
const caught = new Map();

// Answered rather than aborted: an aborted request prints a console error,
// and several suites assert a clean console. The shapes match what an
// unauthenticated client gets back for the same calls — an empty list for a
// read, an empty object otherwise — so the app takes its ordinary
// "nothing came back" path.
async function guard(context){
  await context.route(SUPABASE, route => {
    const req = route.request();
    const key = `${req.method()} ${req.url().split("?")[0]}`;
    caught.set(key, (caught.get(key) || 0) + 1);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: req.method() === "GET" ? "[]" : "{}"
    });
  });
}

function wrapBrowser(browser){
  // Browser.newPage() creates its context through this.newContext(), so
  // wrapping newContext covers both.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async function(...args){
    const context = await newContext(...args);
    await guard(context);
    return context;
  };
  return browser;
}

for(const name of ["chromium", "webkit", "firefox"]){
  const type = playwright[name];
  if(!type) continue;
  const launch = type.launch.bind(type);
  type.launch = async function(...args){ return wrapBrowser(await launch(...args)); };
  const persistent = type.launchPersistentContext && type.launchPersistentContext.bind(type);
  if(persistent){
    type.launchPersistentContext = async function(...args){
      const context = await persistent(...args);
      await guard(context);
      return context;
    };
  }
}

process.on("exit", () => {
  if(!caught.size) return;
  const total = [...caught.values()].reduce((a, b) => a + b, 0);
  const suite = path.relative(__dirname, process.argv[1] || "?");
  console.log(`  [no-network] ${suite}: kept ${total} request${total === 1 ? "" : "s"} off the live Supabase project`);
  for(const [key, n] of caught) console.log(`     ${n}x ${key}`);
});
