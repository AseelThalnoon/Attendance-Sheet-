// The sign-up journey, from Create Account to the first screen after the
// emailed link.
//
// It failed at both ends. signUp() sent no emailRedirectTo, so the link in the
// confirmation email fell back to the project's Site URL and a person who had
// just confirmed their address landed somewhere that was not this app. And in
// between, the only trace of the email was one line of green text: no way to
// send it again, no answer for an address that already had an account (where
// Supabase sends nothing at all), and a sign-in refused as "not confirmed"
// offered nothing but the refusal.
//
// Each case drives the real page against the scripted backend, with the auth
// endpoints answered the way GoTrue answers them.
const { boot, settle } = require("../hostile/harness");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}
const shown = (page, id) => page.evaluate(sel => {
  const el = document.getElementById(sel);
  return !!(el && el.getClientRects().length);
}, id);
const text = (page, id) => page.evaluate(sel => document.getElementById(sel).textContent, id);

// GoTrue's shapes. A new address: a user with one identity and no session.
// An address that already has a confirmed account: the same success, with
// identities empty and no email sent.
function signupUser(identities){
  return { id: D.UUID(77), email: "new@example.com", aud: "authenticated", role: "",
    identities, user_metadata: { full_name: "New Person" }, created_at: new Date().toISOString() };
}

// Records what the app sent, and answers /signup, /resend and /token as the
// test case says. Registered after the backend's own catch-all, so it wins.
async function authStub(page, answers){
  const calls = [];
  await page.route(/\/auth\/v1\/(signup|resend|token)/, async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.split("/").pop();
    calls.push({ name, url: req.url(), body: JSON.parse(req.postData() || "{}") });
    const a = answers[name] || { status: 200, body: {} };
    await route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
  });
  return calls;
}

async function openRegister(page){
  await page.waitForSelector("#signInForm", { state: "visible" });
  await page.click("#showRegisterBtn");
  await page.fill("#regName", "New Person");
  await page.fill("#regEmail", "new@example.com");
  await page.fill("#regPassword", "correct-horse-battery");
  await page.fill("#regPassword2", "correct-horse-battery");
}

(async () => {

// ---- 1. Create Account → check your inbox -----------------------------------
{
  let calls;
  const t = await boot({ signedOut: true, waitForApp: false,
    beforeLoad: async ({ page }) => { calls = await authStub(page, {
      signup: { status: 200, body: signupUser([{ id: "i1", provider: "email" }]) },
      resend: { status: 200, body: {} }
    }); } });
  try{
    await settle(t.page, 600);
    await openRegister(t.page);
    await t.page.click("#registerBtn");
    await settle(t.page, 500);

    const signup = calls.find(c => c.name === "signup");
    ok(!!signup, "Create Account calls signUp");
    const redirect = signup && new URL(signup.url).searchParams.get("redirect_to");
    const origin = await t.page.evaluate(() => location.origin + location.pathname);
    ok(redirect === origin,
      "the confirmation link is told to come back to this app, not the project's Site URL",
      `redirect_to = ${redirect}, expected ${origin}`);
    ok(signup && signup.body.data && signup.body.data.full_name === "New Person",
      "the name typed on the form travels with the sign-up");

    ok(await shown(t.page, "checkEmailPanel"), "a check-your-inbox screen replaces the form");
    ok(!(await shown(t.page, "registerForm")), "and the form is gone, so it cannot be submitted twice");
    ok((await text(t.page, "checkEmailAddress")) === "new@example.com",
      "the screen names the address the email went to");
    const focused = await t.page.evaluate(() => document.activeElement && document.activeElement.id);
    ok(focused === "checkEmailTitle", "focus moves to the new heading", `focused: ${focused}`);

    const resend = await t.page.evaluate(() => {
      const b = document.getElementById("resendConfirmBtn"); return { disabled: b.disabled, label: b.textContent };
    });
    ok(resend.disabled && /in \d+s/.test(resend.label),
      "Resend counts down the minute Supabase would refuse it for", JSON.stringify(resend));

    // Skip the minute rather than wait it out.
    await t.page.evaluate(() => { const b = document.getElementById("resendConfirmBtn"); b.disabled = false; });
    await t.page.click("#resendConfirmBtn");
    await settle(t.page, 400);
    const r = calls.find(c => c.name === "resend");
    ok(r && r.body.type === "signup" && r.body.email === "new@example.com",
      "Resend asks for another sign-up confirmation to the same address", r && JSON.stringify(r.body));
    ok(r && new URL(r.url).searchParams.get("redirect_to") === origin,
      "and the resent link comes back to this app too", r && r.url);
    ok(/sent again/i.test(await text(t.page, "checkEmailSuccess")), "and says it was sent");

    // A typo is the commonest reason the email never arrives.
    await t.page.click("#checkEmailChangeBtn");
    await settle(t.page, 200);
    ok(await shown(t.page, "registerForm"), "Use a different email reopens the form");
    ok((await t.page.inputValue("#regName")) === "New Person", "with the name still filled in");

    const hard = t.errors.filter(e => !e.startsWith("console: "));
    ok(hard.length === 0, "no script error through the sign-up journey", hard.join("\n     "));
  } finally { await t.close(); }
}

// ---- 2. An address that already has an account ------------------------------
{
  const t = await boot({ signedOut: true, waitForApp: false,
    beforeLoad: async ({ page }) => { await authStub(page, { signup: { status: 200, body: signupUser([]) } }); } });
  try{
    await settle(t.page, 600);
    await openRegister(t.page);
    await t.page.click("#registerBtn");
    await settle(t.page, 500);
    ok(!(await shown(t.page, "checkEmailPanel")),
      "an existing account is not told to wait for an email that is never sent");
    ok(/already an account/i.test(await text(t.page, "registerError")),
      "it is told to sign in instead", await text(t.page, "registerError"));
  } finally { await t.close(); }
}

// ---- 3. Signing in before confirming -----------------------------------------
{
  let calls;
  const t = await boot({ signedOut: true, waitForApp: false,
    beforeLoad: async ({ page }) => { calls = await authStub(page, {
      token: { status: 400, body: { code: "email_not_confirmed", error_code: "email_not_confirmed", msg: "Email not confirmed" } },
      resend: { status: 200, body: {} }
    }); } });
  try{
    await settle(t.page, 600);
    ok(!(await shown(t.page, "signInResendBtn")), "the resend button is not on the ordinary sign-in screen");
    await t.page.fill("#siEmail", "new@example.com");
    await t.page.fill("#siPassword", "correct-horse-battery");
    await t.page.click("#signInBtn");
    await settle(t.page, 500);
    ok(/confirm your email/i.test(await text(t.page, "signInError")),
      "an unconfirmed sign-in says why it was refused", await text(t.page, "signInError"));
    ok(await shown(t.page, "signInResendBtn"), "and offers the confirmation email again");
    await t.page.click("#signInResendBtn");
    await settle(t.page, 500);
    const r = calls.find(c => c.name === "resend");
    ok(r && r.body.email === "new@example.com" && r.body.type === "signup",
      "which resends to the address on the form", r && JSON.stringify(r.body));
    ok(await shown(t.page, "checkEmailPanel"), "and moves on to the check-your-inbox screen");
  } finally { await t.close(); }
}

// ---- 4. A spent confirmation link ------------------------------------------
{
  const SPENT = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
  const t = await boot({ signedOut: true, waitForApp: false, hash: SPENT,
    beforeLoad: async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("attendance_ledger_pending_confirm_v1",
        JSON.stringify({ email: "new@example.com", at: Date.now() })));
    } });
  try{
    await settle(t.page, 900);
    const msg = await text(t.page, "signInError");
    ok(/expired|already been used/i.test(msg) && /just sign in/i.test(msg),
      "a spent link says so, and that an already-confirmed person can simply sign in", msg);
    ok(/resend confirmation/i.test(msg) && /forgot password/i.test(msg),
      "and names both ways to a fresh link, since it cannot tell which kind of link this was", msg);
    ok(await shown(t.page, "signInResendBtn"), "a fresh confirmation is one tap away");
    ok((await t.page.inputValue("#siEmail")) === "new@example.com",
      "with the address this browser registered already filled in");
  } finally { await t.close(); }
}

// ---- 5. Back from the email, confirmed -------------------------------------
{
  const people = D.roster(2); people[0].full_name = "New Person";
  const hash = "#access_token=test-access-token&expires_in=3600&expires_at=" +
    (Math.floor(Date.now() / 1000) + 3600) + "&refresh_token=test-refresh&token_type=bearer&type=signup";
  const t = await boot({ signedOut: true, meId: people[0].id, hash, waitForApp: false,
    seed: { profiles: people, user_settings: [], entries: [] },
    beforeLoad: async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("attendance_ledger_pending_confirm_v1",
        JSON.stringify({ email: "person1@example.com", at: Date.now() })));
    } });
  try{
    await t.page.waitForSelector("#appShell:not([style*='display: none'])", { timeout: 15000 }).catch(() => {});
    await settle(t.page, 900);
    ok(await shown(t.page, "appShell"), "the confirmation link signs the new person straight into the app");
    const toasts = await t.page.evaluate(() => [...document.querySelectorAll("#toastStack *")].map(e => e.textContent).join(" | "));
    ok(/email confirmed/i.test(toasts) && /New/.test(toasts),
      "and welcomes them by name, so they know the link worked", toasts);
    const pending = await t.page.evaluate(() => localStorage.getItem("attendance_ledger_pending_confirm_v1"));
    ok(pending === null, "the pending confirmation is forgotten once they are in", pending);
  } finally { await t.close(); }
}

console.log(`  onboarding  pass ${pass}   fail ${fail}`);
if(fail){
  failures.forEach(f => console.log("  ✗ " + f));
  process.exit(1);
}
})().catch(e => { console.error(e); process.exit(1); });
