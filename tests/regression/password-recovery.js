// Regression test for a real bug: opening a password-reset email link signed
// the visitor straight into the app on their OLD password instead of showing
// the "choose a new password" form.
//
// Root cause: supabase-js fires a ONE-SHOT "PASSWORD_RECOVERY" event during
// its own async initialization, which begins the instant createClient() runs
// at the top of app.js — long before the real onAuthStateChange handler near
// the bottom of that ~7800-line module has been registered. By the time it
// registers, the one-shot event has already fired to nobody, and supabase-js
// replays the now-saved session to the new listener as a generic
// "INITIAL_SESSION" — indistinguishable, to that handler, from an ordinary
// restored sign-in. The fix is two verbatim blocks pulled from app.js below:
// an early listener that catches the one-shot event before it can be missed,
// and a check in the real handler that treats a replayed INITIAL_SESSION as
// recovery when the early listener already saw one.
//
// This test reproduces the exact subscriber-ordering race with a fake auth
// client rather than a real network — the bug is in listener registration
// order, not in any particular network response — and evaluates the SHIPPED
// characters of both blocks (see extract.js) so a regression here fails this
// test rather than silently reintroducing the original symptom.
const vm = require("vm");
const { slice } = require("../extract");

const EARLY_LISTENER = slice(
  "var __earlyRecoverySession = null;",
  "(function(){"
);
const MAIN_CONDITION = slice(
  'if(event === "PASSWORD_RECOVERY" || (event === "INITIAL_SESSION" && __earlyRecoverySession)){',
  "// handleSignedIn() is a full cold start:"
);

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

// A minimal stand-in for supabase-js's auth client: onAuthStateChange just
// appends to a subscriber list, matching the one property this bug actually
// depends on — multiple independent listeners can be registered, and each
// only sees events fired after it subscribes.
function fakeAuthClient(){
  const subscribers = [];
  return {
    auth: { onAuthStateChange(cb){ subscribers.push(cb); } },
    fire(event, session){ subscribers.slice().forEach(cb => cb(event, session)); }
  };
}

function run(scenario){
  const client = fakeAuthClient();
  const sandbox = {
    supabase: client,
    supabaseConfigured: true,
    console
  };
  vm.createContext(sandbox);
  // Registers the early listener exactly as app.js does at module load.
  vm.runInContext(EARLY_LISTENER, sandbox);

  scenario.beforeMainListenerRegisters(client);

  // The real handler's dependencies, stood up fresh per scenario so each run
  // starts from a clean "nobody signed in yet" state.
  Object.assign(sandbox, {
    currentUser: null,
    recoverySessionUser: undefined,
    resetScreenShown: false,
    signedInWith: null,
    showResetPasswordScreen(){ sandbox.resetScreenShown = true; },
    handleSignedIn(user){ sandbox.signedInWith = user; }
  });
  // The real callback body, wrapping the extracted condition exactly the way
  // the shipped onAuthStateChange(function(event, session){ ... }) does —
  // falling through to a plain sign-in when the condition does not match,
  // the same shape the full handler has below this block in app.js.
  vm.runInContext(
    `function mainListener(event, session){
      ${MAIN_CONDITION}
      if(session && session.user) handleSignedIn(session.user);
    }`,
    sandbox
  );
  client.auth.onAuthStateChange(sandbox.mainListener);

  scenario.afterMainListenerRegisters(client);
  return sandbox;
}

// ---- 1. The actual bug's shape: PASSWORD_RECOVERY fires before the real
// listener exists, then gets replayed as INITIAL_SESSION. ------------------
{
  const recoverySession = { user: { id: "u1", email: "a@example.com" } };
  const out = run({
    beforeMainListenerRegisters(client){
      client.fire("PASSWORD_RECOVERY", recoverySession);
    },
    afterMainListenerRegisters(client){
      client.fire("INITIAL_SESSION", recoverySession);
    }
  });
  ok(out.resetScreenShown, "a recovery event missed by the late listener still opens the reset form");
  ok(!out.signedInWith, "it does not also sign the visitor in on their old password",
    `signedInWith: ${JSON.stringify(out.signedInWith)}`);
  ok(out.recoverySessionUser && out.recoverySessionUser.id === "u1",
    "the recovered session's user is captured for the reset form to hand off to");
}

// ---- 2. Timing is fine: PASSWORD_RECOVERY reaches the real listener directly.
{
  const recoverySession = { user: { id: "u2", email: "b@example.com" } };
  const out = run({
    beforeMainListenerRegisters(){ /* no early race this time */ },
    afterMainListenerRegisters(client){
      client.fire("PASSWORD_RECOVERY", recoverySession);
    }
  });
  ok(out.resetScreenShown, "a directly-received PASSWORD_RECOVERY still opens the reset form");
  ok(!out.signedInWith, "and still does not also sign in");
}

// ---- 3. An ORDINARY restored session must still boot normally — the fix
// must not treat every INITIAL_SESSION as a recovery. ----------------------
{
  const ordinarySession = { user: { id: "u3", email: "c@example.com" } };
  const out = run({
    beforeMainListenerRegisters(){ /* no PASSWORD_RECOVERY ever fires */ },
    afterMainListenerRegisters(client){
      client.fire("INITIAL_SESSION", ordinarySession);
    }
  });
  ok(!out.resetScreenShown, "an ordinary restored session does not open the reset form");
  ok(out.signedInWith && out.signedInWith.id === "u3", "and signs in normally instead");
}

console.log(`  password-recovery  pass ${pass}   fail ${fail}`);
if(fail){
  failures.forEach(f => console.log("  FAIL " + f));
  process.exitCode = 1;
}
