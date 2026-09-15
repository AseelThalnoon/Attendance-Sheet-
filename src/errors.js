// Turning a failure into a sentence someone can act on.
//
// This is the translation layer, not the reporting one: it handles the
// failures the app EXPECTS -- a Postgres error code, a dead connection, an
// expired token. Unexpected exceptions are a different job and belong to the
// crash handler at the top of app.js.
//
// The rule that shapes both functions is that a failure must never reach a
// person as the database's own words. Backend errors were surfaced verbatim
// once, so people were shown things like 'new row violates row-level security
// policy for table "entries"'. But the fallback is still the raw text rather
// than a generic apology: hiding a failure nobody anticipated makes it
// unreportable, and an ugly sentence beats a useless one.

// Backend errors were surfaced verbatim, so users saw strings like
// 'new row violates row-level security policy for table "entries"'. Map the
// ones we understand to a sentence that says what to do; fall back to the raw
// text rather than hiding a failure we didn't anticipate.
// An error that already carries a sentence written for the person who will
// read it. friendlyError exists to translate the ones that don't — a
// Postgres code, a fetch failure — and it must not re-translate these,
// because its patterns match on wording and a good explanation can contain
// the same words as the failure it is explaining. Notably: the message for
// a push service that could not be registered with says the cause is
// usually the network, which friendlyError's own /network/i catch-all then
// replaced with "Couldn't reach the server" — burying the specific
// explanation under the generic one it was written to replace.
function explainedError(text){
  var e = new Error(text);
  e.explained = true;
  return e;
}
function friendlyError(err){
  if(!err) return "Something went wrong.";
  if(err.explained) return err.message;
  var code = err.code || "";
  var msg  = err.message || String(err);

  if(code === "23505" || /duplicate key/i.test(msg))
    return "There's already an entry for that date.";
  if(code === "42501" || /row-level security|permission denied|Only admin/i.test(msg))
    return "You don't have permission to do that.";
  if(code === "23514" || /violates check constraint/i.test(msg)){
    if(/clock_(in|out)/.test(msg)) return "That clock time isn't a valid time of day.";
    if(/entries_type/.test(msg))   return "That day type isn't recognised.";
    if(/entries_note/.test(msg))   return "That note is too long (500 characters maximum).";
    if(/entries_date/.test(msg))   return "That date is outside the range this app accepts.";
    return "That entry didn't pass validation.";
  }
  if(code === "23503" || /foreign key/i.test(msg))
    return "That record no longer exists — try reloading the page.";
  if(code === "PGRST301" || /JWT|token is expired/i.test(msg))
    return "Your session expired. Sign in again to continue.";
  if(code === "TIMEOUT")
    return "The server took too long to respond. Check your connection and try again.";
  if(/Failed to fetch|NetworkError|network/i.test(msg))
    return "Couldn't reach the server. Check your connection and try again.";

  // Auth. These reach the reader at the least forgiving moment in the app —
  // locked out at the front door, with nothing else on screen — and they were
  // the one family still shown as the provider wrote them: "Invalid login
  // credentials" is a status line, not a sentence to a person who cannot get
  // in. Deliberately silent about WHICH half is wrong: whether an address has
  // an account is not something a signed-out stranger gets to probe.
  if(/invalid login credentials|invalid email or password/i.test(msg))
    return "That email and password don't match an account.";
  if(/email not confirmed/i.test(msg))
    return "Confirm your email address first — check your inbox for the link.";
  if(/user already registered|already been registered/i.test(msg))
    return "There's already an account with that email. Try signing in instead.";
  if(/signups? not allowed|signup is disabled/i.test(msg))
    return "New accounts are turned off. Ask an administrator to create one for you.";
  if(err.code === "over_email_send_rate_limit" || /email rate limit/i.test(msg))
    return "Too many reset emails have gone out from this app in the last hour. Wait an hour and try again.";
  if(/rate limit|only request this after|too many requests/i.test(msg))
    return "Too many attempts just now. Wait a minute and try again.";
  if(/same as the old password|should be different/i.test(msg))
    return "That's the password you already have. Choose a different one.";
  return msg;
}
export { explainedError, friendlyError };
