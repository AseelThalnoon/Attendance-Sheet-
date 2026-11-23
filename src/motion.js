// Small motions that show what just happened (2026-11-23, owner: "Do all",
// to a list of six): where a saved day landed, a row leaving and coming back,
// a month stepped from the side of the arrow pressed, a segmented control's
// highlight sliding to the choice, and a palette change crossfading.
//
// The rules every one of them keeps (see "Navigation and motion" in DESIGN.md):
//   - only on the person's own action, never on a background refresh, so a
//     screen does not twitch every time a sync lands;
//   - transform and opacity only, at the duration and easing tokens the
//     stylesheet already uses;
//   - nothing moves under reduced motion. The stylesheet's blanket rule
//     covers CSS; these are script-driven (the Web Animations API, the View
//     Transitions API), which that rule cannot reach, so each checks for itself.
// The clock's punch flood is not here: it has its own rules, in app.js.

function calm(){
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function rtl(){ return document.documentElement.dir === "rtl"; }
function token(name, fallback){
  var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function ms(name, fallback){
  var v = parseFloat(token(name, ""));
  return isNaN(v) ? fallback : v;
}

// A view stepped to the next or the previous period comes in from that side:
// 12px and the base duration, the hint of direction the phone's tab entrance
// already gives. dir 0 is a change with no side to it (Month to Year): a fade.
export function stepIn(el, dir){
  if(!el || !el.animate || calm()) return;
  var x = dir ? (dir > 0 ? 12 : -12) * (rtl() ? -1 : 1) : 0;
  el.animate([{ opacity: 0, transform: "translateX(" + x + "px)" }, { opacity: 1, transform: "none" }],
    { duration: ms("--dur-base", 200), easing: token("--ease-soft", "ease-out") });
}

// Where each row of a list is now, by the attribute that names it, so that
// after the list is drawn again each can be moved from there to where it went.
export function positions(list, attr){
  var out = {};
  if(!list) return out;
  Array.prototype.forEach.call(list.querySelectorAll("[" + attr + "]"), function(el){
    out[el.getAttribute(attr)] = el.getBoundingClientRect().top;
  });
  return out;
}
// The rows that were there before slide from their old place to their new
// one, so the list closes over a removed row, or opens for a returning one,
// instead of jumping.
export function slideFrom(list, attr, before){
  if(!list || !before || calm()) return;
  var dur = ms("--dur-slow", 320), ease = token("--ease-soft", "ease-out");
  Array.prototype.forEach.call(list.querySelectorAll("[" + attr + "]"), function(el){
    var was = before[el.getAttribute(attr)];
    if(was == null || !el.animate) return;
    var dy = was - el.getBoundingClientRect().top;
    if(Math.abs(dy) < 1) return;
    el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: dur, easing: ease });
  });
}
// Rows on their way out fade and slip toward the start edge. Resolves when
// they have gone, so whatever redraws the list waits for them.
export function leave(rows){
  rows = (rows || []).filter(Boolean);
  if(!rows.length || calm()) return Promise.resolve();
  var x = rtl() ? 16 : -16, dur = ms("--dur-base", 200);
  return Promise.all(rows.map(function(el){
    if(!el.animate) return null;
    var a = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(" + x + "px)" }],
      { duration: dur, easing: token("--ease-snap", "ease-in"), fill: "forwards" });
    return a.finished.catch(function(){});
  }));
}
// A row that has just been saved, or brought back, is brought into view and
// lit for a moment, so the eye lands on the result. Under reduced motion it
// is still brought into view and marked, without the fade.
//
// It waits for the form that saved the row to finish closing: the form steps
// the browser's history back as it closes (so a phone's back gesture closes
// it), and the browser's own scroll restoration for that step would undo a
// scroll made before it.
export function flash(row){
  if(!row) return;
  var still = calm(), cls = still ? "is-marked" : "is-flash";
  setTimeout(function(){
    if(!row.isConnected) return;
    row.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
    row.classList.remove(cls);
    void row.offsetWidth;
    row.classList.add(cls);
    setTimeout(function(){ row.classList.remove(cls); }, 1800);
  }, 220);
}
// A row coming back into a list (an Undo) grows in where it belongs.
export function enter(row){
  if(!row || !row.animate || calm()) return;
  row.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
    { duration: ms("--dur-slow", 320), easing: token("--ease-soft", "ease-out") });
}

// A segmented control's highlight is one pill that slides to the chosen
// option, instead of each option lighting up in place. The pill is drawn
// under the buttons and placed on the active one; the active button's own
// fill steps aside while the pill is there (.has-pill in index.html).
// A change of option slides it; a change of size (the control appearing,
// the window resizing, the text arriving in another language) places it
// without moving.
var ACTIVE = ".active, [aria-checked='true'], [aria-pressed='true']";
export function pill(tray){
  if(!tray || tray.__pill) return;
  var p = document.createElement("span");
  p.className = "seg-pill";
  p.setAttribute("aria-hidden", "true");
  tray.insertBefore(p, tray.firstChild);
  tray.__pill = p;
  function place(still){
    var on = tray.querySelector(":scope > " + ACTIVE.split(", ").join(", :scope > "));
    if(!on || !on.offsetWidth){ p.style.opacity = "0"; return; }
    if(still) p.classList.add("is-still");
    p.style.opacity = "";
    p.style.width = on.offsetWidth + "px";
    p.style.height = on.offsetHeight + "px";
    p.style.transform = "translate(" + on.offsetLeft + "px," + on.offsetTop + "px)";
    if(still){ void p.offsetWidth; p.classList.remove("is-still"); }
  }
  place(true);
  tray.classList.add("has-pill");
  if(window.ResizeObserver) new ResizeObserver(function(){ place(true); }).observe(tray);
  new MutationObserver(function(){ place(false); }).observe(tray, { subtree: true, attributes: true,
    attributeFilter: ["class", "aria-checked", "aria-pressed"] });
}

// A change that repaints the whole screen at once -- a palette, light or
// dark -- crossfades from the old look to the new instead of jumping. The
// View Transitions API does it; where a browser lacks it, or motion is
// reduced, the change is simply made.
export function crossfade(change){
  if(document.startViewTransition && !calm()){
    try{ document.startViewTransition(change); return; }catch(e){}
  }
  change();
}
