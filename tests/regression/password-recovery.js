// The password-reset journey, end to end, in a real browser against the real
// vendored supabase-js.
//
// This suite used to model the race with a fake auth client, and the model was
// wrong in the one way that mattered: it assumed PASSWORD_RECOVERY reaches the
// listeners FIRST and a replayed INITIAL_SESSION follows. The shipped client
// does the opposite. _initialize() broadcasts PASSWORD_RECOVERY from inside a
// setTimeout(..., 0) and resolves initializePromise straight away, while
// onAuthStateChange replays the session to each new subscriber as
// INITIAL_SESSION the moment that promise settles -- a microtask, which beats
// the macrotask. So every listener is handed INITIAL_SESSION for the recovery
// session first, carrying nothing that says what it is, and the app booted the
// dashboard on the visitor's OLD password; the PASSWORD_RECOVERY that landed a
// tick later could not take back a sign-in already under way. Production logs
// show exactly that: /verify 303, then the app's profile fetch, and no reset
// form ever seen.
//
// A mock cannot be trusted to get that ordering right -- it got it wrong for
// months -- so this suite boots the actual app at an actual recovery URL and
// asks what the visitor ends up looking at.
const { boot, settle } = require("../hostile/harness");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

// What Supabase's /verify endpoint redirects a reset link to: the session
// itself, in the fragment, with type=recovery naming the kind. The client
// needs all four token fields or it refuses the URL outright.
function recoveryHash(){
  return "#access_token=test-access-token&expires_in=3600" +
         "&refresh_token=test-refresh-token&token_type=bearer&type=recovery";
}
// What it redirects a link that has already been used, or expired, to.
const SPENT_HASH = "#error=access_denied&error_code=otp_expired" +
                   "&error_description=Email+link+is+invalid+or+has+expired";

// Visible means laid out, not merely un-hidden: #resetPasswordForm is a flex
// child of a screen that itself gets display:none, so reading its own style
// would call it visible while the whole auth screen was gone.
function shown(page, id){
  return page.evaluate(sel => {
    const el = document.getElementById(sel);
    return !!(el && el.getClientRects().length);
  }, id);
}

async function screenState(page){
  return {
    reset:  await shown(page, "resetPasswordForm"),
    signIn: await shown(page, "signInForm"),
    app:    await shown(page, "appShell")
  };
}

(async () => {

// ---- 1. Arriving from the emailed link. ---------------------------------
// Both the browser that has no session (the link opened elsewhere, the common
// case) and the one that does (same browser, already signed in) -- the second
// is the harsher test, because there is a stored session for INITIAL_SESSION
// to boot with.
for(const signedOut of [true, false]){
  const who = signedOut ? "in a browser with no session" : "in the browser already signed in";
  const t = await boot({ signedOut, hash: recoveryHash(), waitForApp: false });
  try{
    await settle(t.page, 900);          // well past the setTimeout(0) and the profile fetch
    const s = await screenState(t.page);
    ok(s.reset,   `the reset link opens the "choose a new password" form ${who}`);
    ok(!s.app,    `and does not sign the visitor in on their old password ${who}`,
       "#appShell is on screen -- the dashboard booted over the form");
    ok(!s.signIn, `and does not fall back to the sign-in form ${who}`);

    const hard = t.errors.filter(e => !e.startsWith("console: "));
    ok(hard.length === 0, `no script error on the recovery boot ${who}`, hard.join("\n     "));

    // Everything past here drives the form. If it is not on screen the suite
    // has already said so above, and pressing on would spend thirty seconds
    // per locator timing out and then abort before printing a single failure
    // -- the whole list, lost to the one that came first.
    if(!s.reset){
      ok(false, `cannot finish the reset journey ${who}`, "the reset form never appeared");
    } else if(signedOut){
      // Finish the journey: set the password and land in the app.
      await t.page.fill("#newPassword", "a-brand-new-password");
      await t.page.fill("#newPassword2", "a-brand-new-password");
      await t.page.click("#resetPasswordBtn");
      await settle(t.page, 900);
      const done = await screenState(t.page);
      ok(done.app,    "setting the new password lands in the app");
      ok(!done.reset, "and the reset form is gone once it succeeds");
    }else{
      // The other exit: backing out. The hold that keeps the dashboard from
      // booting has to be released here too, or the visitor is trapped -- and
      // released without booting them in, since they never reset anything.
      await t.page.click("#resetBackBtn");
      await settle(t.page, 900);
      const back = await screenState(t.page);
      ok(back.signIn, "backing out of the reset form returns to sign-in");
      ok(!back.reset, "and does not spring the reset form back open");
      ok(!back.app,   "and does not sign them in on the password they came to change");
    }
  } finally { await t.close(); }
}

// ---- 2. A link that has already been used, or has expired. ---------------
// Gmail's own link scanner fetches these, and a single-use token is spent by
// whoever reaches it first; production logs show the same token returning 403
// "One-time token not found" six times in ninety seconds. Supabase sends the
// reason back in the fragment. Nothing read it, so the visitor got the bare
// sign-in screen and concluded the link had done nothing at all.
{
  const t = await boot({ signedOut: true, hash: SPENT_HASH, waitForApp: false });
  try{
    await settle(t.page, 900);
    const s = await screenState(t.page);
    ok(s.signIn, "a spent reset link lands on the sign-in form");
    ok(!s.app,   "and does not sign anyone in");
    ok(!s.reset, "and does not offer a password form it has no session for");

    const msg = await t.page.textContent("#signInError");
    ok(/expired|already been used/i.test(msg || ""),
       "and says the link is spent rather than leaving the screen blank",
       `#signInError reads: ${JSON.stringify(msg)}`);
    ok(/forgot password/i.test(msg || ""),
       "and points at the control that issues a fresh one",
       `#signInError reads: ${JSON.stringify(msg)}`);
  } finally { await t.close(); }
}

// ---- 3. The fresh link must not inherit the dead one's fragment. ---------
// resetPasswordForEmail sent redirectTo: window.location.href, which carries
// whatever fragment is on the page -- including the "#error=...otp_expired"
// a spent link just left there. Supabase appends the new session to that URL,
// the browser keeps only the first fragment, and the new link arrives bearing
// the OLD error and no token. One dead link then broke every reset email after
// it for as long as the tab stayed open, which is the loop the logs record.
{
  const t = await boot({ signedOut: true, hash: SPENT_HASH, waitForApp: false });
  try{
    await settle(t.page, 900);
    const seen = [];
    t.page.on("request", r => { if(r.url().includes("/auth/v1/recover")) seen.push(r.url()); });

    await t.page.fill("#siEmail", "someone@example.com");
    await t.page.click("#forgotPasswordBtn");
    await settle(t.page, 900);

    ok(seen.length === 1, "asking for a new link sends one recover request", `sent ${seen.length}`);
    const target = seen[0] ? decodeURIComponent(new URL(seen[0]).searchParams.get("redirect_to") || "") : "";
    ok(target && target.indexOf("#") === -1,
       "and the address it tells Supabase to send them back to carries no fragment",
       `redirect_to: ${JSON.stringify(target)}`);
    ok(/\/index\.html$/.test(target),
       "and still points at this page rather than the project's Site URL",
       `redirect_to: ${JSON.stringify(target)}`);
  } finally { await t.close(); }
}

// ---- 4. An ordinary boot is untouched. -----------------------------------
// The hold is read off the fragment, so a page load with no fragment must
// behave exactly as it always did. Without this the fix could "pass" every
// test above by simply never booting the app.
{
  const t = await boot({});
  try{
    const s = await screenState(t.page);
    ok(s.app,    "an ordinary signed-in boot still reaches the app");
    ok(!s.reset, "and never shows the reset form");
  } finally { await t.close(); }
}

console.log(`  password-recovery  pass ${pass}   fail ${fail}`);
if(fail){
  failures.forEach(f => console.log("  FAIL " + f));
  process.exitCode = 1;
}

})().catch(e => { console.error(e); process.exitCode = 1; });
