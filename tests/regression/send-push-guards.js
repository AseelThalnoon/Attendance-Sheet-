// The two questions send-push asks before it does anything: who is calling,
// and where is this about to be sent. Run as written -- the helpers are cut out
// of supabase/functions/send-push/index.ts, their TypeScript types stripped by
// Node, and exercised in a vm. Nothing here talks to Supabase or to a push
// service.
//
// Why these two. An endpoint is a URL the function makes a request to, and it
// comes from a row any signed-in account can write for itself; and the
// function used to run for any caller holding a token this project issued,
// which with sign-up open is anyone. Both checks are a handful of lines, and
// both are the kind that look right and are wrong by one character:
// "fcm.googleapis.com.example.org" ends with nothing on the list and starts
// with everything on it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { stripTypeScriptTypes } = require("module");

const SRC = path.join(__dirname, "..", "..", "supabase", "functions", "send-push", "index.ts");
const ts = fs.readFileSync(SRC, "utf8");
const from = ts.indexOf("function tokenRole(");
const to = ts.indexOf("Deno.serve(");
if(from === -1 || to === -1 || to < from){
  throw new Error("send-push/index.ts: extraction anchors not found");
}
const emitWarning = process.emitWarning;
process.emitWarning = () => {};
const js = stripTypeScriptTypes(ts.slice(from, to));
process.emitWarning = emitWarning;

// What callerMaySend() reaches for besides the request. Each test sets who
// the auth server says the token belongs to, and what role that person holds.
let authUser = null, authError = null, profileRole = null, lookups = 0;
const supabase = {
  auth: { getUser: async () => { lookups++; return { data: { user: authUser }, error: authError }; } },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profileRole ? { role: profileRole } : null }) }) }) })
};
const SERVICE_ROLE_KEY = "the-service-role-key";
const sandbox = { URL, JSON, Math, atob, supabase, SERVICE_ROLE_KEY };
vm.createContext(sandbox);
vm.runInContext(js + "\n;globalThis.__x = { tokenRole, callerMaySend, isPushService, UUID, CORS };", sandbox);
const { tokenRole, callerMaySend, isPushService, UUID, CORS } = sandbox.__x;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail){
  if(cond) pass++;
  else { fail++; failures.push(`${label}${detail !== undefined ? "\n     " + detail : ""}`); }
}

const b64url = obj => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = payload => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`;
const req = token => ({ headers: { get: name => (name === "Authorization" && token != null ? "Bearer " + token : null) } });

(async () => {
  // ---- Where a message may be sent -------------------------------------------
  const real = [
    "https://fcm.googleapis.com/fcm/send/abc123:APA91b",
    "https://android.googleapis.com/gcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
    "https://web.push.apple.com/QOabc123",
    "https://api.push.apple.com/3/device/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://FCM.GOOGLEAPIS.COM/fcm/send/abc"
  ];
  real.forEach(u => ok(isPushService(u) === true, "a real push service is accepted", u));

  const notOne = [
    ["http://fcm.googleapis.com/fcm/send/abc", "plain http"],
    ["https://fcm.googleapis.com.example.org/fcm/send/abc", "the right name as a prefix of somebody else's"],
    ["https://example.org/fcm.googleapis.com/send", "the right name in the path"],
    ["https://fcm.googleapis.com@example.org/send", "the right name as a username"],
    ["https://example.org/?h=web.push.apple.com", "the right name in the query"],
    ["https://evilpush.apple.com/x", "a lookalike that is not under push.apple.com"],
    ["https://notify.windows.com.example.org/", "a suffix moved to the middle"],
    ["https://mozilla.com/x", "a bare vendor domain that is not its push host"],
    ["https://169.254.169.254/latest/meta-data/", "a metadata address"],
    ["https://localhost/x", "this machine"],
    ["https://10.0.0.5/x", "a private address"],
    ["file:///etc/passwd", "a file"],
    ["javascript:alert(1)", "a script URL"],
    ["not a url", "not a URL at all"],
    ["", "nothing"]
  ];
  notOne.forEach(([u, why]) => ok(isPushService(u) === false, "refused: " + why, u));

  // ---- Who may call ----------------------------------------------------------
  ok(tokenRole(jwt({ role: "service_role" })) === "service_role", "reads the role out of a token's payload");
  ok(tokenRole(jwt({ role: "authenticated", sub: "u1" })) === "authenticated", "for a person's token too");
  ok(tokenRole("garbage") === null && tokenRole("") === null && tokenRole("a.b.c") === null,
    "and answers null, not an exception, for anything that is not one");

  lookups = 0;
  ok(await callerMaySend(req(null)) === false, "no token: refused");
  ok(await callerMaySend(req("")) === false, "an empty token: refused");
  ok(lookups === 0, "without asking the auth server about nothing");

  ok(await callerMaySend(req(SERVICE_ROLE_KEY)) === true, "the service-role key itself: allowed (the scheduler)");
  ok(await callerMaySend(req(jwt({ role: "service_role" }))) === true, "a service-role token: allowed (the scheduler)");

  authUser = { id: "u1" }; authError = null; profileRole = "admin";
  ok(await callerMaySend(req(jwt({ role: "authenticated", sub: "u1" }))) === true, "a signed-in administrator: allowed");

  profileRole = "user";
  ok(await callerMaySend(req(jwt({ role: "authenticated", sub: "u1" }))) === false, "a signed-in employee: refused");
  profileRole = null;
  ok(await callerMaySend(req(jwt({ role: "authenticated", sub: "u1" }))) === false, "an account with no profile: refused");

  authUser = null; authError = { message: "invalid JWT" }; profileRole = "admin";
  ok(await callerMaySend(req(jwt({ role: "authenticated", sub: "u1" }))) === false,
    "a token the auth server does not recognise: refused, whatever role is on file");
  ok(await callerMaySend(req(jwt({ role: "anon" }))) === false, "the public key's own token: refused");

  // A claim of "admin" in the token is not the question: profiles.role is.
  authUser = { id: "u1" }; authError = null; profileRole = "user";
  ok(await callerMaySend(req(jwt({ role: "authenticated", sub: "u1", app_metadata: { role: "admin" }, user_role: "admin" }))) === false,
    "a token that calls itself an admin is still judged by the database");

  // ---- The small things --------------------------------------------------------
  ok(UUID.test("0b7c0c0e-6a55-4d2e-9a43-1f2e3d4c5b6a") && !UUID.test("1; drop table") && !UUID.test("abc"),
    "a notification id has to be an id");
  ok(CORS["Access-Control-Allow-Origin"] === "*" && /authorization/i.test(CORS["Access-Control-Allow-Headers"]) &&
     /apikey/i.test(CORS["Access-Control-Allow-Headers"]) && /POST/.test(CORS["Access-Control-Allow-Methods"]),
    "a browser's preflight is told it may send the headers supabase-js sends", JSON.stringify(CORS));
  // The preflight is answered before the caller is checked, and before any
  // send can start: it carries no token and must not be mistaken for a tick.
  const serve = ts.slice(to);
  const iOptions = serve.indexOf('req.method === "OPTIONS"');
  const iAuth = serve.indexOf("callerMaySend(req)");
  const iClaim = serve.indexOf('.update({ status: "sending" })');
  ok(iOptions !== -1 && iAuth !== -1 && iClaim !== -1 && iOptions < iAuth && iAuth < iClaim,
    "order in the handler: preflight, then the caller, and only then the queue",
    JSON.stringify({ iOptions, iAuth, iClaim }));
  // And the reminder job, which nobody but the scheduler has any reason to run.
  const reminders = fs.readFileSync(path.join(path.dirname(path.dirname(SRC)), "check-clockout-reminders", "index.ts"), "utf8");
  const rServe = reminders.slice(reminders.indexOf("Deno.serve("));
  ok(/calledByScheduler\(req\)/.test(rServe) && rServe.indexOf("calledByScheduler(req)") < rServe.indexOf("supabase"),
    "check-clockout-reminders turns away every caller but the scheduler before it reads anything");

  console.log(`  send-push-guards  pass ${pass}   fail ${fail}`);
  if(failures.length){
    failures.forEach(f => console.log("  FAIL " + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
