// Arabic, and the one place that knows which language is on screen.
//
// The owner's decisions (2026-11-22): each person chooses (a switch in
// Settings, kept on the device like the palette, starting in the phone's own
// language); Western digits; the Gregorian calendar; the app first, with the
// push notifications and the sign-up email left for a later step.
//
// How it works. Every string the app shows is written in English in the
// source, and the Arabic is looked up by that English (src/i18n-ar-*.js).
// Two routes reach the screen:
//   - Fixed text -- a label in index.html, a button whose textContent is set
//     to a constant -- is swapped where it lands, by translateTree() and the
//     observer watch() starts, matching whole text nodes and a few attributes.
//     Nothing in app.js has to know about it.
//   - Text built from parts ("3 days away", "Since 11 Aug") goes through t()
//     with {placeholders}, and counts through count(), because Arabic plurals
//     have six forms and English has two.
// Switching language reloads the page: it is chosen once in a while, and a
// reload is the one way every screen is guaranteed to be redrawn in it.
//
// No imports: src/time.js reads the language from here, and this must not
// read anything back.

var LANG_KEY = "attendance.language";
var lang = detect();
// AR is the app's own Arabic, as the dictionaries register it. DICT is what
// the screen reads now: in Arabic, AR with the team's Arabic wording laid
// over it; in English, only the team's English wording (Admin › Labels,
// 2026-11-22). OVR is that wording, {en: {...}, ar: {...}}, keyed by the
// app's English like everything else here.
var AR = {};
var DICT = {};
var OVR = { en: {}, ar: {} };
// Whether anything on screen needs swapping: always in Arabic, and in English
// only once the team has reworded something.
var active = lang === "ar";

// The same rule theme-boot.js applies before the first paint.
function detect(){
  try{
    var saved = localStorage.getItem(LANG_KEY);
    if(saved === "ar" || saved === "en") return saved;
  }catch(err){}
  var nav = (typeof navigator !== "undefined" && ((navigator.languages && navigator.languages[0]) || navigator.language)) || "";
  return /^ar\b/i.test(nav) ? "ar" : "en";
}
function getLang(){ return lang; }
function isArabic(){ return lang === "ar"; }
// What the person picked, or null while the phone's language is deciding.
function savedLang(){
  try{ var v = localStorage.getItem(LANG_KEY); return v === "ar" || v === "en" ? v : null; }catch(err){ return null; }
}
function setLang(v){
  try{ localStorage.setItem(LANG_KEY, v); }catch(err){}
}
// Saudi Arabic with the Gregorian calendar and Western digits. "ar-SA" alone
// gives the Umm al-Qura calendar and Arabic-Indic digits -- both declined.
var AR_LOCALE = "ar-SA-u-ca-gregory-nu-latn";
function locale(){ return lang === "ar" ? AR_LOCALE : undefined; }

// Entries with {placeholders} are also patterns: "{n} days logged" matches
// "92 days logged" on the screen and writes "{n} يومًا مسجلًا" with 92 in it,
// so a sentence app.js builds from parts needs no change there. Bucketed by
// the literal text at the start (or, for one that opens with a placeholder,
// at the end), so a text node is tried against a handful, not all of them.
var TEMPLATES = { pre: {}, post: {}, any: [] };
function bucketKey(s){ return s.slice(0, 3).toLowerCase(); }
// A placeholder's name says what it may match, so "{n}d" (16d) cannot eat
// "Logged": n... is a number, t... a clock time, h... a duration or anything
// that starts with a digit, and any other name is any text.
function slot(name){
  if(/^n/.test(name)) return "([-+−]?\\d[\\d.,]*)";
  if(/^t/.test(name)) return "(\\d{1,2}:\\d{2}(?:\\s?\\S+)?)";
  // A duration as minutesToHoursStr writes it: "8h 5m", "15m", "+1h 10m",
  // "8س 5د". Loose enough for both scripts, tight enough that "12 logged,
  // 11 live" is not one.
  if(/^h/.test(name)) return "([-+−]?\\d+(?:[.,]\\d+)?\\s?[A-Za-z\\u0600-\\u06FF]{1,3}(?:\\s\\d+\\s?[A-Za-z\\u0600-\\u06FF]{1,3})?)";
  return "(.+?)";
}
function addTemplate(en, ar){
  var parts = en.split(/(\{\w+\})/);
  var names = [];
  var re = "^" + parts.map(function(p){
    var m = /^\{(\w+)\}$/.exec(p);
    if(m){ names.push(m[1]); return slot(m[1]); }
    return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("") + "$";
  // The more literal text a pattern has, the more specific it is, and each
  // list is kept in that order: "usually about {x} a month" has to be tried
  // before "usually {r}", which would take the same sentence and leave half
  // of it in English.
  var lit = parts.filter(function(p){ return !/^\{\w+\}$/.test(p); }).join("").length;
  // A pattern that is little but joiners ("{a} and {b}", "{a} · {b}") only
  // applies when every part comes out in Arabic: half of an untranslated
  // English sentence with "و" spliced into it reads worse than the English.
  var strict = lit <= 8 && names.every(function(n){ return !/^[nth]/.test(n); });
  var tpl = { key: en, re: new RegExp(re), names: names, ar: ar, lit: lit, strict: strict };
  var list = templateList(en, true);
  // One pattern per key: the team's wording replaces the app's, not joins it.
  for(var i = list.length - 1; i >= 0; i--) if(list[i].key === en) list.splice(i, 1);
  list.push(tpl);
  list.sort(function(a, b){ return b.lit - a.lit; });
}
// The list a key's pattern lives in: by its literal start, else its literal
// end, else -- "{n} of {n2}", "{n}d": too little literal text to bucket by --
// the short list every lookup tries last, whose typed placeholders keep its
// few patterns from matching loosely.
function templateList(en, create){
  var parts = en.split(/(\{\w+\})/);
  var head = parts[0], tail = parts[parts.length - 1];
  if(head.length >= 3){ var hk = bucketKey(head); return TEMPLATES.pre[hk] || (create ? (TEMPLATES.pre[hk] = []) : []); }
  if(tail.length >= 3){ var tk = tail.slice(-3).toLowerCase(); return TEMPLATES.post[tk] || (create ? (TEMPLATES.post[tk] = []) : []); }
  return TEMPLATES.any;
}
function removeTemplate(en){
  var list = templateList(en, false);
  for(var i = list.length - 1; i >= 0; i--) if(list[i].key === en) list.splice(i, 1);
}
// What the screen shows for `en` from now on, or the app's default when
// `text` is null.
function setEntry(en, text){
  if(text == null){
    if(lang === "ar" && AR[en] != null) text = AR[en];
    else { delete DICT[en]; removeTemplate(en); return; }
  }
  DICT[en] = text;
  if(en.indexOf("{") !== -1) addTemplate(en, text); else removeTemplate(en);
}
function register(entries){
  for(var k in entries){
    if(!Object.prototype.hasOwnProperty.call(entries, k)) continue;
    AR[k] = entries[k];
    if(lang === "ar" && OVR.ar[k] == null) setEntry(k, entries[k]);
  }
}
function viaTemplate(key){
  var lists = [TEMPLATES.pre[bucketKey(key)] || [], TEMPLATES.post[key.slice(-3).toLowerCase()] || [], TEMPLATES.any];
  for(var l = 0; l < lists.length; l++){
    var list = lists[l];
    for(var i = 0; i < list.length; i++){
      var m = list[i].re.exec(key);
      if(!m) continue;
      var vars = {}, whole = true;
      for(var j = 0; j < list[i].names.length; j++){
        var v = m[j + 1];
        // A captured word that is itself on the list ("dark", "Thursday")
        // comes across translated; a number or a name comes across as is.
        var tr = DICT[v] != null ? DICT[v] : viaTemplate(v);
        if(tr == null && /[A-Za-z]{2,}/.test(v)) whole = false;
        vars[list[i].names[j]] = tr != null ? tr : v;
      }
      if(list[i].strict && !whole) continue;
      return fill(list[i].ar, vars);
    }
  }
  return null;
}
// {name} drops a value in; {name|noun} counts it in Arabic ("{n|day}" with 16
// is "16 يومًا", with 2 is "يومان"), through count() below.
function fill(s, vars){
  return s.replace(/\{(\w+)(?:\|([^}]+))?\}/g, function(m, k, noun){
    if(vars[k] == null) return m;
    if(noun){
      var num = Number(String(vars[k]).replace(/[,−]/g, function(c){ return c === "−" ? "-" : ""; }));
      if(!isNaN(num)) return count(num, noun);
    }
    return String(vars[k]);
  });
}
// The Arabic for an English string, or the English itself when there is none
// (a name, a number, a string nobody has translated yet).
function t(en, vars){
  var s = DICT[en] != null ? DICT[en] : en;
  return vars ? fill(s, vars) : s;
}

// "3 days": English one/other, Arabic by Intl.PluralRules -- one and two take
// their own words ("يوم واحد", "يومان"), 3-10 the plural, 11-99 the singular
// accusative, and so on. `noun` is the English singular; AR_NOUNS holds the
// Arabic forms for each noun the app counts.
var AR_NOUNS = {};
var PR = null;
function registerNouns(map){ for(var k in map) AR_NOUNS[k] = map[k]; }
function count(n, one, many){
  if(lang !== "ar" || !AR_NOUNS[one]){
    return n + " " + (n === 1 ? one : (many || one + "s"));
  }
  var f = AR_NOUNS[one];
  try{ PR = PR || new Intl.PluralRules("ar"); }catch(err){ PR = null; }
  var cat = PR ? PR.select(n) : (n === 1 ? "one" : n === 2 ? "two" : "other");
  var form = f[cat] != null ? f[cat] : f.other;
  return form.indexOf("{n}") === -1 ? form : form.replace("{n}", String(n));
}

// ---------- Fixed text, swapped where it lands ----------
var ATTRS = ["aria-label", "title", "placeholder", "alt", "data-tip"];
// Text people wrote themselves (names, notes, announcements) carries
// dir="auto" in this app, and must never be "translated" because it happens
// to read like a label.
function skip(el){
  for(var n = el; n && n.nodeType === 1; n = n.parentNode){
    var tag = n.nodeName;
    if(tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "CODE") return true;
    if(n.getAttribute("dir") === "auto" || n.hasAttribute("data-no-i18n")) return true;
  }
  return false;
}
function lookup(raw){
  var key = raw.trim();
  if(!key) return null;
  var hit = DICT[key];
  if(hit == null){
    // Collapsed whitespace, and no soft hyphens: the bottom bar writes
    // "Over&shy;view" so the word can break on a 320px phone.
    var squeezed = key.replace(/­/g, "").replace(/\s+/g, " ");
    if(squeezed !== key) hit = DICT[squeezed];
    // No letters, nothing to translate: times, figures, dates already in
    // Arabic. The common case on a busy screen, so it is decided first.
    if(hit == null && /[A-Za-z]/.test(squeezed)) hit = viaTemplate(squeezed);
  }
  return hit == null ? null : raw.replace(key, hit);
}
// Each swap remembers the English it replaced (__i18nEn on a text node,
// __i18nA on an element for its attributes), so when the team's wording
// changes while the app is open, retranslate() can put the English back and
// translate it again. __i18nOut is the text we wrote: seeing it again is our
// own write coming back through the observer, and anything else is app.js
// writing something new.
function translateText(node){
  var v = node.nodeValue;
  if(!v || !node.parentNode || skip(node.parentNode)) return;
  if(node.__i18nOut !== undefined && v === node.__i18nOut) return;
  var out = lookup(v);
  if(out != null && out !== v){ node.__i18nEn = v; node.__i18nOut = out; node.nodeValue = out; }
  else { node.__i18nEn = undefined; node.__i18nOut = undefined; }
}
function translateAttrs(el){
  // A search box is dir="auto" for the name typed into it, not for its own
  // placeholder ("Name or email"), which is the app's: for a field, only its
  // surroundings and its own data-no-i18n decide.
  var field = el.nodeName === "INPUT" || el.nodeName === "TEXTAREA";
  if(field ? (el.hasAttribute("data-no-i18n") || skip(el.parentNode)) : skip(el)) return;
  var seen = el.__i18nA || {};
  for(var i = 0; i < ATTRS.length; i++){
    var a = ATTRS[i], v = el.getAttribute(a);
    if(!v){ delete seen[a]; continue; }
    if(seen[a] && v === seen[a].out) continue;
    var out = lookup(v);
    if(out != null && out !== v){ seen[a] = { en: v, out: out }; el.setAttribute(a, out); }
    else delete seen[a];
  }
  el.__i18nA = seen;
  if(el.nodeName === "INPUT" && (el.type === "button" || el.type === "submit") && el.value){
    var vv = lookup(el.value);
    if(vv != null) el.value = vv;
  }
}
// Everything already on screen, again, from its English: for when the team's
// wording has just changed.
function retranslate(root){
  if(!root || typeof document === "undefined") return;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), node;
  while((node = walker.nextNode())){
    if(node.__i18nEn !== undefined){ node.__i18nOut = undefined; node.nodeValue = node.__i18nEn; }
  }
  if(root.querySelectorAll){
    var els = root.querySelectorAll("*");
    for(var i = 0; i < els.length; i++){
      var seen = els[i].__i18nA;
      if(!seen) continue;
      for(var a in seen) els[i].setAttribute(a, seen[a].en);
      els[i].__i18nA = {};
    }
  }
  ensureWatching();
  translateTree(root);
}
function translateTree(root){
  if(!active || !root) return;
  if(root.nodeType === 3){ translateText(root); return; }
  if(root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if(root.nodeType === 1) translateAttrs(root);
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  var node;
  while((node = walker.nextNode())) translateText(node);
  if(root.querySelectorAll){
    var els = root.querySelectorAll("[aria-label],[title],[placeholder],[alt],[data-tip],input[type=button],input[type=submit]");
    for(var i = 0; i < els.length; i++) translateAttrs(els[i]);
  }
}
// Everything app.js draws later passes through here on its way to the screen.
// Started at boot when there is anything to swap, and later -- by
// ensureWatching() -- if the team's English wording arrives after it.
var watchRoot = null, watching = false;
function watch(root){
  watchRoot = root;
  ensureWatching();
}
function ensureWatching(){
  if(watching || !active || !watchRoot || typeof MutationObserver === "undefined") return;
  watching = true;
  var root = watchRoot;
  new MutationObserver(function(muts){
    for(var i = 0; i < muts.length; i++){
      var m = muts[i];
      if(m.type === "childList"){
        for(var j = 0; j < m.addedNodes.length; j++) translateTree(m.addedNodes[j]);
      } else if(m.type === "characterData"){
        translateText(m.target);
      } else if(m.type === "attributes"){
        translateAttrs(m.target);
      }
    }
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// ---------- The team's own wording (Admin › Labels) ----------
// Strings only, and not absurd ones; anything else in the stored object is
// ignored rather than trusted.
function cleanSide(m){
  var out = {};
  if(!m || typeof m !== "object") return out;
  for(var k in m){
    if(!Object.prototype.hasOwnProperty.call(m, k)) continue;
    var v = m[k];
    if(typeof v === "string" && v.trim() && k.length <= 600 && v.length <= 600) out[k] = v;
  }
  return out;
}
function setOverrides(ov){
  ov = ov && typeof ov === "object" ? ov : {};
  var mine = OVR[lang];
  OVR = { en: cleanSide(ov.en), ar: cleanSide(ov.ar) };
  // Back to the app's own text for anything no longer reworded, then the
  // team's wording over it.
  for(var k in mine) if(OVR[lang][k] == null) setEntry(k, null);
  for(var k2 in OVR[lang]) setEntry(k2, OVR[lang][k2]);
  active = lang === "ar" || Object.keys(OVR.en).length > 0;
}
function getOverrides(){
  return { en: Object.assign({}, OVR.en), ar: Object.assign({}, OVR.ar) };
}
// The app's own Arabic for every text it has, keyed by its English: the list
// Admin › Labels edits, and what tests/regression/arabic.js checks.
function entries(){ var out = {}; for(var k in AR) out[k] = AR[k]; return out; }

export {
  getLang, isArabic, savedLang, setLang, locale, register, registerNouns, t, count,
  translateTree, retranslate, watch, entries, setOverrides, getOverrides, LANG_KEY
};
