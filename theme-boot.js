// Theme boot — runs BEFORE first paint, and does nothing else.
//
// This is a separate file rather than an inline <script> because the CSP in
// index.html is `script-src 'self'`: an inline block would be refused, and
// loosening the policy to 'unsafe-inline' or a hash for one line of theme
// setup would be trading a real protection for a cosmetic one.
//
// It is loaded synchronously in <head>, above the stylesheet's first use of
// the tokens, so the attributes it stamps are already on <html> when the page
// first paints. Deferred (or moved into app.js, which is a module and
// therefore deferred by definition) the page would paint in the default
// palette and then swap — the white flash that tells you a dark theme was
// bolted on. app.js reads this same contract back out of the DOM afterwards.
(function () {
  "use strict";

  // ---- Not inside somebody else's page ---------------------------------
  // The answer to clickjacking is a response header (frame-ancestors, or
  // X-Frame-Options), and this app is served by a host that cannot send one --
  // index.html's own comment on its Content-Security-Policy says as much, and
  // a <meta> policy is not allowed to carry that directive. So nothing this
  // app sent stopped another page loading it in an invisible frame and lining
  // somebody's click up with Delete, or Deactivate, or Grant Admin.
  //
  // Current browsers blunt that by handing a framed copy its own empty storage,
  // so it comes up signed out. That is the browser's protection, not this
  // app's: it is not in every browser still in use, and it does not apply to
  // a page on this same origin, which a github.io address shares with every
  // other project published from the account.
  //
  // This is the part that can be done from here: if the page is not the top
  // window, it marks itself, the stylesheet draws nothing, and app.js declines
  // to start, so there is no button under the cursor to be tricked onto. It is
  // done in this file because this is the first script to run, before the
  // first paint.
  //
  // A page on this machine is let through: a local preview or a design tool
  // may well show the app in a frame, and nobody is attacked from localhost.
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (framed && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) {
    document.documentElement.setAttribute("data-framed", "");
    return;
  }

  var KEY = "attendance.appearance";
  var PALETTES = ["atrium", "slate", "terracotta", "studio", "moss", "plum", "ledger"];
  var MODES = ["light", "dark", "system"];

  var palette = "atrium";
  var mode = "system";

  // localStorage throws rather than returning null in a few real situations —
  // Safari's private mode historically, and any browser set to block site
  // data — and a theme preference is never worth failing a boot over.
  try {
    var raw = window.localStorage.getItem(KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && PALETTES.indexOf(saved.palette) !== -1) palette = saved.palette;
      if (saved && MODES.indexOf(saved.mode) !== -1) mode = saved.mode;
    }
  } catch (e) { /* defaults stand */ }

  // "system" is resolved to a concrete light/dark here rather than left for
  // CSS to answer with prefers-color-scheme. Twelve compositions would
  // otherwise need twelve more media-query blocks saying the same thing, and
  // every one of them would be a place for the two answers to drift apart.
  // The stylesheet only ever sees data-theme="light" or data-theme="dark".
  function resolve(m) {
    if (m === "light" || m === "dark") return m;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  var root = document.documentElement;
  root.setAttribute("data-palette", palette);
  root.setAttribute("data-theme", resolve(mode));
  root.setAttribute("data-theme-mode", mode);

  // The PWA's status bar and the browser's own chrome read this, so it has to
  // move with the palette or an installed app keeps a near-black bar over a
  // Terracotta interface. It is set from the computed token rather than a
  // second table of hexes, so it cannot fall out of step with the palette.
  // --paper, not --rail: the rail is a desktop surface that does not exist on a
  // phone, and tinting the chrome to it put a near-black strip above a light
  // app. The page's own ground is what the strip actually adjoins.
  window.__applyThemeColor = function () {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var v = getComputedStyle(root).getPropertyValue("--paper").trim();
    if (v) meta.setAttribute("content", v);
  };

  // Applied once the stylesheet has parsed; at this point in <head> the
  // custom properties are not resolvable yet.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", window.__applyThemeColor, { once: true });
  } else {
    window.__applyThemeColor();
  }
})();
