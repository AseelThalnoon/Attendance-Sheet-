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

  var KEY = "attendance.appearance";
  var PALETTES = ["atrium", "slate", "terracotta", "studio", "moss", "plum"];
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
  window.__applyThemeColor = function () {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var v = getComputedStyle(root).getPropertyValue("--rail").trim();
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
