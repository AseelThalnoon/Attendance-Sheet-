// Passkeys: adding one in Settings, signing in with it, removing it.
//
// Runs the real browser ceremony. Chromium's virtual authenticator (over CDP)
// stands in for Face ID / Touch ID / a fingerprint, so navigator.credentials
// .create() and .get() genuinely run, and a passkey made in step one is the
// one the device offers at sign-in. Supabase Auth's passkey endpoints are
// stood in for here: they hand out options and record what comes back, the
// signature checks being Supabase's job, not this app's.
//
// WebAuthn refuses an IP address as its relying party, so the app is opened
// as localhost rather than the harness's usual 127.0.0.1.
const { boot, settle, goTab } = require("../hostile/harness");
const { HOST } = require("../hostile/backend");
const D = require("../hostile/data");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const me = D.profile(1, { full_name: "Pat Key", email: "pat@example.com" });
const other = D.profile(2, { full_name: "Other Person" });
const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = () => b64url(require("crypto").randomBytes(32));

// The stand-in for Supabase Auth's /auth/v1/passkeys endpoints.
function passkeyServer(state){
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" };
  // Supabase Auth stamps every response with its API version; without it
  // supabase-js ignores the error "code" field, as it would for an old server.
  const json = (body, status) => ({ status: status || 200, contentType: "application/json",
    headers: Object.assign({ "X-Supabase-Api-Version": "2024-01-01",
      "Access-Control-Expose-Headers": "X-Supabase-Api-Version" }, cors), body: JSON.stringify(body) });
  let n = 0;
  return async (route, req) => {
    const m = req.method();
    const p = new URL(req.url()).pathname.replace(/^\/auth\/v1\/passkeys/, "");
    if(m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    state.log.push(m + " " + (p || "/"));
    if(!state.enabled) return route.fulfill(json({ code: "passkey_disabled", msg: "Passkey authentication is disabled" }, 422));
    const body = JSON.parse(req.postData() || "{}");
    if(p === "/registration/options"){
      return route.fulfill(json({ challenge_id: "reg" + (++n), options: {
        challenge: rand(), rp: { id: "localhost", name: "Attendance" },
        user: { id: b64url(Buffer.from(me.id)), name: me.email, displayName: me.full_name },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        timeout: 60000, attestation: "none" } }));
    }
    if(p === "/registration/verify"){
      const row = { id: "pk-" + (++n), credentialId: body.credential && body.credential.id,
        friendly_name: "Chrome on Linux", created_at: new Date().toISOString(), last_used_at: null };
      state.creds.push(row);
      return route.fulfill(json({ id: row.id, friendly_name: row.friendly_name, created_at: row.created_at }));
    }
    if(p === "/authentication/options"){
      return route.fulfill(json({ challenge_id: "auth" + (++n), options: {
        challenge: rand(), rpId: "localhost", userVerification: "required", timeout: 60000 } }));
    }
    if(p === "/authentication/verify"){
      const row = state.creds.find(c => c.credentialId === (body.credential && body.credential.id));
      if(!row) return route.fulfill(json({ code: "webauthn_credential_not_found", msg: "Credential not found" }, 404));
      row.last_used_at = new Date().toISOString();
      state.signIns++;
      return route.fulfill(json({ access_token: "test-access-token", token_type: "bearer", expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "test-refresh-token",
        user: { id: me.id, aud: "authenticated", role: "authenticated", email: me.email,
          app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" } }));
    }
    if(m === "GET" && !p){
      return route.fulfill(json(state.creds.map(c => ({ id: c.id, friendly_name: c.friendly_name,
        created_at: c.created_at, last_used_at: c.last_used_at }))));
    }
    if(m === "DELETE"){
      state.creds = state.creds.filter(c => "/" + c.id !== p);
      return route.fulfill(json({}));
    }
    return route.fulfill(json({ msg: "unhandled " + m + " " + p }, 500));
  };
}

// Boots with a virtual authenticator attached (unless opts.noWebAuthn, which
// removes the API the way a browser without it would look).
async function start(opts){
  opts = opts || {};
  const pk = { enabled: opts.enabled !== false, creds: opts.creds || [], log: [], signIns: 0, passwordSignIns: 0 };
  let cdp = null, authId = null;
  const h = await boot({ hostname: "localhost", meId: opts.meId || me.id, signedOut: !!opts.signedOut,
    waitForApp: !opts.signedOut, viewport: opts.viewport, device: opts.device,
    seed: { profiles: opts.profiles || [me], entries: [], user_settings: [{ user_id: me.id, settings: D.SETTINGS }] },
    beforeLoad: async ({ page }) => {
      await page.route(`${HOST}/auth/v1/passkeys**`, passkeyServer(pk));
      // Password sign-in: any password works, and it is counted.
      await page.route(`${HOST}/auth/v1/token**`, route => {
        pk.passwordSignIns++;
        return route.fulfill({ status: 200, contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*", "X-Supabase-Api-Version": "2024-01-01" },
          body: JSON.stringify({ access_token: "test-access-token", token_type: "bearer", expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "test-refresh-token",
            user: { id: me.id, aud: "authenticated", role: "authenticated", email: me.email,
              app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" } }) });
      });
      if(opts.noWebAuthn){
        await page.addInitScript(() => { delete window.PublicKeyCredential; });
        return;
      }
      cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      authId = (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", transport: opts.transport || "internal", hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })).authenticatorId;
    } });
  await settle(h.page, 900);
  return Object.assign(h, { pk, cdp: () => cdp, authId: () => authId });
}
const openPasskeys = async page => {
  await goTab(page, "settings");
  await page.evaluate(() => document.getElementById("cnav-passkeys").click());
  await settle(page, 700);
};
const view = page => page.evaluate(() => {
  const vis = id => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
  return {
    add: vis("passkeyAddBtn"), list: vis("passkeyListWrap"), others: vis("passkeyOthers"),
    hint: vis("passkeyHint") ? document.getElementById("passkeyHint").textContent : "",
    rows: [...document.querySelectorAll("#passkeyList .push-device")].map(r => r.innerText.replace(/\s+/g, " ").trim()),
    nav: document.getElementById("cnavDescPasskeys").textContent,
    toast: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" ")
  };
});
const authView = page => page.evaluate(() => {
  const vis = id => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
  const app = document.getElementById("appShell");
  return { button: vis("passkeySignInBtn"), or: vis("passkeyOr"),
    app: !!app && app.style.display !== "none",
    error: document.getElementById("signInError").textContent };
});

(async () => {
  // ---- Add one, sign out, sign back in with it, remove it -------------------
  {
    const h = await start();
    await openPasskeys(h.page);
    let v = await view(h.page);
    ok(v.add && !v.list && /^Off/.test(v.nav), "not set up yet: a Set Up button, nothing listed, and the menu says Off", JSON.stringify(v));

    await h.page.click("#passkeyAddBtn");
    await settle(h.page, 1200);
    v = await view(h.page);
    ok(h.pk.creds.length === 1 && h.pk.creds[0].credentialId, "Add creates a passkey on the device and registers it", JSON.stringify(h.pk.log));
    ok(v.list && v.rows.length === 1 && /Chrome on Linux/.test(v.rows[0]) && /Not used yet/.test(v.rows[0]),
      "and it is listed by name", JSON.stringify(v.rows));
    ok(/is set up/.test(v.toast), "with a toast saying so", v.toast);
    ok(v.nav === "On", "and the Settings menu says it is on", v.nav);
    const creds = (await h.cdp().send("WebAuthn.getCredentials", { authenticatorId: h.authId() })).credentials;
    ok(creds.length === 1 && creds[0].isResidentCredential && creds[0].rpId === "localhost",
      "the device holds it as a discoverable passkey, so sign-in needs no email", JSON.stringify(creds.map(c => [c.rpId, c.isResidentCredential])));

    // Sign out: the question mentions the passkey.
    await h.page.evaluate(() => document.getElementById("logoutBtn").click());
    await settle(h.page, 400);
    const q = await h.page.evaluate(() => document.querySelector(".modal-overlay .modal-msg").textContent);
    ok(/passkey/.test(q), "signing out says the passkey gets you back in", q);
    await h.page.evaluate(() => document.querySelector(".modal-overlay .modal-confirm").click());
    await settle(h.page, 1200);
    let a = await authView(h.page);
    ok(!a.app && a.button && a.or, "the sign-in screen offers Sign in with a passkey", JSON.stringify(a));

    await h.page.click("#passkeySignInBtn");
    await settle(h.page, 1800);
    a = await authView(h.page);
    ok(a.app && h.pk.signIns === 1, "tapping it signs in with the passkey, no email or password", JSON.stringify(a));

    await openPasskeys(h.page);
    v = await view(h.page);
    ok(v.rows.length === 1 && /Last used/.test(v.rows[0]), "the list now says when it was last used", JSON.stringify(v.rows));

    await h.page.click("#passkeyList [data-passkey-remove]");
    await settle(h.page, 400);
    const rq = await h.page.evaluate(() => document.querySelector(".modal-overlay .modal-title").textContent);
    ok(/^Remove .*sign-in\?$/.test(rq), "removing asks first", rq);
    await h.page.evaluate(() => document.querySelector(".modal-overlay .modal-confirm").click());
    await settle(h.page, 900);
    v = await view(h.page);
    ok(h.pk.creds.length === 0 && !v.list && v.add, "and Remove takes it off the account", JSON.stringify(v));
    ok(h.errors.length === 0, "no script errors", h.errors.join(" | "));
    await h.close();
  }

  // ---- Closing the device's prompt is not an error ---------------------------
  {
    const h = await start({ signedOut: true, creds: [] });
    // Closing Face ID / the passkey sheet rejects with NotAllowedError, in
    // Safari and Chrome alike.
    await h.page.evaluate(() => {
      navigator.credentials.get = () => Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
    });
    await h.page.click("#passkeySignInBtn");
    await settle(h.page, 1200);
    const a = await authView(h.page);
    ok(!a.app && !/[a-z]/i.test(a.error), "cancelled at the device: no error shown, still on sign-in", JSON.stringify(a));
    ok(h.pk.signIns === 0, "and nobody is signed in");
    await h.close();
  }

  // ---- A passkey the account no longer has ------------------------------------
  {
    const h = await start({ signedOut: true });
    // Make one on the device that the server does not know.
    await h.cdp().send("WebAuthn.addCredential", { authenticatorId: h.authId(), credential: {
      credentialId: Buffer.from("orphan-credential-0001").toString("base64"), isResidentCredential: true,
      rpId: "localhost", userHandle: Buffer.from(me.id).toString("base64"), signCount: 0,
      privateKey: require("crypto").generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") } });
    await h.page.click("#passkeySignInBtn");
    await settle(h.page, 1500);
    const a = await authView(h.page);
    ok(!a.app && /was removed from your account/.test(a.error) && /password/.test(a.error),
      "a passkey that was removed from the account: says so, and points at the password", a.error);
    await h.close();
  }

  // ---- Passkeys not switched on in Supabase yet -------------------------------
  {
    const h = await start({ enabled: false });
    await openPasskeys(h.page);
    const v = await view(h.page);
    ok(!v.add && /isn't switched on/.test(v.hint), "switched off on the server: Settings says so, no Add button", JSON.stringify(v));
    await h.close();

    const s = await start({ enabled: false, signedOut: true });
    await s.page.click("#passkeySignInBtn");
    await settle(s.page, 1000);
    const a = await authView(s.page);
    ok(!a.app && /isn't switched on/.test(a.error), "and the sign-in button says so too", a.error);
    await s.close();
  }

  // ---- A browser without passkeys --------------------------------------------
  {
    const s = await start({ noWebAuthn: true, signedOut: true });
    const a = await authView(s.page);
    ok(!a.button && !a.or, "no WebAuthn: no passkey button on sign-in", JSON.stringify(a));
    await s.close();
    const h = await start({ noWebAuthn: true });
    await openPasskeys(h.page);
    const v = await view(h.page);
    ok(!v.add && /can't use Face ID or fingerprint sign-in/.test(v.hint), "and Settings explains instead of offering a button that cannot work", JSON.stringify(v));
    await h.close();
  }

  // ---- An admin viewing someone else ----------------------------------------
  {
    const admin = D.profile(1, { full_name: "Pat Key", email: "pat@example.com", role: "admin" });
    const h = await start({ profiles: [admin, other] });
    await h.page.evaluate(id => {
      const sel = document.getElementById("viewerSelect");
      if(sel){ sel.value = id; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    }, other.id);
    await settle(h.page, 1200);
    await openPasskeys(h.page);
    const v = await view(h.page);
    ok(v.others && !v.add, "viewing someone else: passkeys are theirs to manage, no Add button", JSON.stringify(v));
    await h.close();
  }

  // ---- After a password sign-in: offer Face ID, once ----------------------
  {
    const offer = page => page.evaluate(() => {
      const o = document.querySelector(".modal-overlay");
      if(!o || !o.querySelector(".passkey-offer-error")) return null;
      return { title: o.querySelector(".modal-title").textContent,
        buttons: [...o.querySelectorAll(".modal-actions .btn")].map(b => b.textContent.trim()) };
    });
    const signInWithPassword = async page => {
      await page.fill("#siEmail", me.email);
      await page.fill("#siPassword", "correct-horse-battery");
      await page.click("#signInBtn");
      await settle(page, 2000);
    };
    const signOut = async page => {
      await page.evaluate(() => document.getElementById("logoutBtn").click());
      await settle(page, 400);
      await page.evaluate(() => document.querySelector(".modal-overlay .modal-confirm").click());
      await settle(page, 1200);
    };
    const { devices } = require("playwright");

    // iPhone: the offer names Face ID, and Use Face ID makes the passkey.
    const h = await start({ signedOut: true, device: devices["iPhone 15 Pro"] });
    await signInWithPassword(h.page);
    let o = await offer(h.page);
    ok(!!o && o.title === "Sign in faster with Face ID?" && o.buttons.join() === "Not Now,Use Face ID",
      "after typing a password on an iPhone, Face ID is offered", JSON.stringify(o));
    await h.page.tap(".modal-overlay .modal-confirm");
    await settle(h.page, 1500);
    ok(h.pk.creds.length === 1 && !(await offer(h.page)), "Use Face ID adds the passkey and closes the offer",
      JSON.stringify(h.pk.log));
    const toast = await h.page.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" "));
    ok(/tap Face ID on the sign-in screen/.test(toast), "and says where to find it next time", toast);
    await signOut(h.page);
    await h.page.click("#passkeySignInBtn");
    await settle(h.page, 1800);
    ok(h.pk.signIns === 1, "and the Face ID icon then signs straight in");
    ok(h.errors.length === 0, "offer: no script errors", h.errors.join(" | "));
    await h.close();

    // Not Now: gone for good on this device.
    const n = await start({ signedOut: true });
    await signInWithPassword(n.page);
    o = await offer(n.page);
    ok(!!o && o.title === "Sign in faster with a passkey?", "offered on a computer with a built-in sensor", JSON.stringify(o));
    await n.page.click(".modal-overlay .modal-cancel");
    await settle(n.page, 400);
    ok(!(await offer(n.page)) && n.pk.creds.length === 0, "Not Now closes it, nothing added");
    await signOut(n.page);
    await signInWithPassword(n.page);
    ok(n.pk.passwordSignIns === 2 && !(await offer(n.page)), "and the next password sign-in does not ask again");
    await n.close();

    // Not offered: a restored session, an existing passkey, no built-in sensor.
    const r = await start();
    await settle(r.page, 1500);
    ok(!(await offer(r.page)), "opening the app already signed in: no offer");
    await r.close();
    const has = await start({ signedOut: true, creds: [{ id: "pk-x", credentialId: "x", friendly_name: "iCloud Keychain",
      created_at: "2026-11-01T00:00:00Z", last_used_at: null }] });
    await signInWithPassword(has.page);
    ok(!(await offer(has.page)), "someone who already has a passkey: no offer");
    await has.close();
    const usb = await start({ signedOut: true, transport: "usb" });
    await signInWithPassword(usb.page);
    ok(!(await offer(usb.page)), "no Face ID / fingerprint sensor on this device: no offer");
    await usb.close();
    const off = await start({ signedOut: true, enabled: false });
    await signInWithPassword(off.page);
    ok(!(await offer(off.page)), "passkeys switched off on the server: no offer");
    await off.close();
  }

  // ---- On an iPhone, Settings says Face ID, never "passkey" ---------------
  {
    const { devices } = require("playwright");
    const h = await start({ device: devices["iPhone 15 Pro"] });
    await openPasskeys(h.page);
    const s = await h.page.evaluate(() => ({
      nav: document.querySelector("#cnav-passkeys .console-nav-title").textContent,
      head: document.querySelector("#csec-passkeys h3").textContent,
      intro: document.querySelector("#csec-passkeys .console-section-head p").textContent,
      add: document.getElementById("passkeyAddBtn").textContent,
      visible: document.getElementById("csec-passkeys").innerText
    }));
    ok(s.nav === "Face ID" && s.head === "Face ID" && s.add === "Set Up Face ID" && /^Sign in with Face ID/.test(s.intro),
      "iPhone: Settings calls it Face ID, with a Set Up Face ID button", JSON.stringify(s));
    ok(!/passkey/i.test(s.visible) && !/passkey/i.test(s.nav), "and the word passkey appears nowhere in it", s.visible.slice(0, 200));
    await h.close();
    const o = await start({ signedOut: true, device: devices["iPhone 15 Pro"] });
    const sub = await o.page.evaluate(() => document.querySelector("#signInForm .auth-sub").textContent);
    ok(sub === "Enter your email and password, or use Face ID.", "the sign-in subtitle mentions Face ID too", sub);
    await o.close();
  }

  // ---- The tap target: Face ID on iPhone, the right name elsewhere --------
  const { devices } = require("playwright");
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
  const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
  const cases = [
    ["iPhone SE", devices["iPhone SE"], "Face ID", "face"],
    ["iPhone 15 Pro", devices["iPhone 15 Pro"], "Face ID", "face"],
    ["Pixel 7", devices["Pixel 7"], "Fingerprint", "fingerprint"],
    ["Mac", { viewport: { width: 1280, height: 800 }, userAgent: MAC }, "Touch ID", "fingerprint"],
    ["Windows", { viewport: { width: 1280, height: 800 }, userAgent: WIN }, "Windows Hello", "face"]
  ];
  for(const [name, device, label, icon] of cases){
    const s = await start({ signedOut: true, device });
    const m = await s.page.evaluate(() => {
      const b = document.getElementById("passkeySignInBtn");
      const tile = b.querySelector(".auth-biometric-tile").getBoundingClientRect();
      const box = b.getBoundingClientRect();
      const form = document.getElementById("signInForm").getBoundingClientRect();
      // What is actually drawn, not a property: an SVG <g> has no .hidden.
      const shown = [...b.querySelectorAll("[data-bio]")]
        .filter(g => getComputedStyle(g).display !== "none" && g.getBoundingClientRect().width > 0)
        .map(g => g.getAttribute("data-bio"));
      return { label: document.getElementById("passkeySignInLabel").textContent, aria: b.getAttribute("aria-label"),
        shown, tileW: tile.width, tileH: tile.height, boxH: box.height,
        centred: Math.abs((box.left + box.right) / 2 - (form.left + form.right) / 2) < 1.5,
        inside: box.left >= 0 && box.right <= innerWidth, scrollX: document.documentElement.scrollWidth > innerWidth };
    });
    ok(m.label === label && m.aria === "Sign in with " + label && m.shown.join() === icon,
      `${name}: the button says ${label}, with the ${icon} icon`, JSON.stringify(m));
    ok(m.tileW >= 44 && m.tileH >= 44 && m.centred && m.inside && !m.scrollX,
      `${name}: a centred tap target at least 44px, on screen`, JSON.stringify(m));
    if(name === "iPhone 15 Pro"){
      // Tapping the icon itself is what signs in.
      await s.page.evaluate(() => {
        navigator.credentials.get = () => { window.__asked = true; return new Promise(() => {}); };
      });
      await s.page.tap("#passkeySignInBtn .auth-biometric-tile");
      await settle(s.page, 600);
      ok(await s.page.evaluate(() => !!window.__asked), "iPhone: tapping the Face ID icon opens the device's prompt");
    }
    await s.close();
  }

  console.log(`  passkeys  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
