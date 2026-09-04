// The point of moving avatars off localStorage onto Supabase Storage: a
// teammate's photo has to reach someone else's browser, not just render as
// initials everywhere but the uploader's own screen (see DESIGN.md's Avatar
// section, migration 20260830153418).
//
// A real browser is the only way to check this — it needs the actual upload
// handler to run (canvas resize, Blob, the toast, the retry-safe write to
// profiles.avatar_updated_at) and the actual hydrateAvatars() pass to
// download and swap an <img> into a slot that started as initials. Reading
// the source would only confirm the code was written, not that a second
// person's browser ever sees the picture.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8954;
const MIME = {".html":"text/html", ".js":"text/javascript", ".json":"application/json",
  ".png":"image/png", ".css":"text/css", ".woff2":"font/woff2"};

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// A minimal but real in-memory Storage: upload/download/remove backed by a
// module-scoped object, gating writes on the caller's own id the way the RLS
// policy in the migration does (own-path-only), so a bug that let anyone
// write anyone's object would show up here as well as at the database.
function stubFor(signedInId){
  return `
const SIGNED_IN="${signedInId}";
const PROFILES = {
  "${ALICE}": {id:"${ALICE}", email:"alice@example.com", full_name:"Alice Admin", role:"admin", avatar_updated_at:null},
  "${BOB}":   {id:"${BOB}",   email:"bob@example.com",   full_name:"Bob Employee", role:"user",  avatar_updated_at:null}
};
globalThis.__PROFILES = PROFILES;
globalThis.__STORAGE = {};
function result(t,k,filters){
  if(t==="entries") return {data:[],error:null};
  if(t==="profiles") return k==="single" ? {data:PROFILES[(filters&&filters.id)||SIGNED_IN],error:null}
                                          : {data:Object.values(PROFILES),error:null};
  if(t==="user_settings") return {data:{settings:{}},error:null};
  if(t==="app_settings") return {data:{allow_registration:true,announcement_active:false,announcement:""},error:null};
  return {data:[],error:null};
}
function builder(t){
  let k="list", filters={}, updateVals=null;
  const proxy=new Proxy(function(){},{get(_,p){
    if(p==="eq") return (col,val)=>{filters[col]=val;return proxy;};
    if(p==="update") return (vals)=>{updateVals=vals;return proxy;};
    if(p==="then") return (r,j)=>{
      if(updateVals && t==="profiles" && filters.id) Object.assign(PROFILES[filters.id], updateVals);
      return Promise.resolve(result(t,k,filters)).then(r,j);
    };
    if(p==="catch") return f=>Promise.resolve(result(t,k,filters)).catch(f);
    if(p==="finally") return f=>Promise.resolve(result(t,k,filters)).finally(f);
    if(p==="single"||p==="maybeSingle") return ()=>{k="single";return proxy;};
    return ()=>proxy;
  }});
  return proxy;
}
const storageApi = {
  from(bucket){
    return {
      upload: async (objPath, blob, opts) => {
        const owner = objPath.split("/")[0];
        if(owner !== SIGNED_IN) return {data:null, error:{message:"new row violates row-level security policy"}};
        const buf = await blob.arrayBuffer();
        globalThis.__STORAGE[objPath] = {bytes:new Uint8Array(buf), contentType:(opts&&opts.contentType)||"image/jpeg"};
        return {data:{path:objPath}, error:null};
      },
      download: async (objPath) => {
        const obj = globalThis.__STORAGE[objPath];
        if(!obj) return {data:null, error:{message:"Object not found"}};
        return {data:new Blob([obj.bytes],{type:obj.contentType}), error:null};
      },
      remove: async (paths) => {
        paths.forEach(function(pth){
          const owner = pth.split("/")[0];
          if(owner === SIGNED_IN) delete globalThis.__STORAGE[pth];
        });
        return {data:[], error:null};
      }
    };
  }
};
export function createClient(){return{from:builder,rpc:()=>builder("rpc"),storage:storageApi,
  auth:{onAuthStateChange:(cb)=>{setTimeout(()=>cb("SIGNED_IN",{user:{id:SIGNED_IN,email:PROFILES[SIGNED_IN].email}}),0);
    return{data:{subscription:{unsubscribe(){}}}};},
  signInWithPassword:async()=>({data:{},error:null}), signUp:async()=>({data:{},error:null}),
  signOut:async()=>({error:null}), resetPasswordForEmail:async()=>({data:{},error:null}),
  updateUser:async()=>({data:{user:{id:SIGNED_IN}},error:null}),
  getSession:async()=>({data:{session:null},error:null})}};}`;
}

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail){
  if(cond) pass++; else { fail++; failures.push(`${name}${detail ? "\n      " + detail : ""}`); }
}

async function makeJpegBytes(page, text, hex){
  return page.evaluate(async ([text, hex]) => {
    const c = document.createElement("canvas"); c.width = c.height = 300;
    const g = c.getContext("2d");
    g.fillStyle = hex; g.fillRect(0, 0, 300, 300);
    g.fillStyle = "#fff"; g.font = "bold 40px sans-serif"; g.fillText(text, 20, 160);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, [text, hex]);
}

(async () => {
  const server = http.createServer((req, res) => {
    let u = req.url.split("?")[0];
    if(u === "/") u = "/index.html";
    const f = path.join(ROOT, u);
    if(!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"content-type": MIME[path.extname(f)] || "text/plain"});
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();

  // ---- Alice uploads her own photo through the real Settings flow ----
  const ctxA = await browser.newContext({viewport: {width: 1440, height: 900}});
  const pageA = await ctxA.newPage();
  const errsA = [];
  pageA.on("pageerror", e => errsA.push(String(e).slice(0, 160)));
  await pageA.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status: 200, contentType: "text/javascript", body: stubFor(ALICE)}));
  await pageA.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
  await pageA.waitForTimeout(900);

  await pageA.evaluate(() => document.querySelector('.tab-btn[data-tab="settings"]').click());
  await pageA.waitForTimeout(300);
  const aliceBytes = await makeJpegBytes(pageA, "A", "#2b5fa5");
  fs.writeFileSync(path.join(__dirname, "..", ".tmp-alice.jpg"), Buffer.from(aliceBytes));
  await pageA.setInputFiles("#photoInput", path.join(__dirname, "..", ".tmp-alice.jpg"));
  // The crop modal, not an immediate upload — see showAvatarCropper() in
  // app.js. Confirming with the default framing (no drag, no zoom) has to
  // reproduce the old auto-centre-crop exactly, so this is also the test
  // that the default stayed backward-compatible.
  await pageA.waitForSelector(".crop-modal-card .crop-confirm:not([disabled])", {timeout: 5000});
  const cropModalOk = await pageA.evaluate(() => ({
    hasStage: !!document.querySelector(".crop-stage img"),
    hasZoomSlider: !!document.querySelector('.crop-zoom-row input[type="range"]'),
  }));
  ok(cropModalOk.hasStage && cropModalOk.hasZoomSlider,
    "choosing a photo opens the crop modal with an image and a zoom control", JSON.stringify(cropModalOk));
  await pageA.click(".crop-modal-card .crop-confirm");
  await pageA.waitForTimeout(700);

  const afterUpload = await pageA.evaluate(() => ({
    toast: (document.querySelector(".toast-msg") || {}).textContent || "",
    settingsHasImg: !!document.querySelector("#settingsAvatar img"),
    railHasImg: !!document.querySelector("#railUserAvatar img"),
    stamp: globalThis.__PROFILES["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].avatar_updated_at,
  }));
  ok(!!afterUpload.stamp, "uploading writes profiles.avatar_updated_at", JSON.stringify(afterUpload));
  ok(afterUpload.settingsHasImg, "the Settings preview shows the new photo without a reload");
  ok(afterUpload.railHasImg, "the rail avatar shows the new photo without a reload");
  ok(/team can see/i.test(afterUpload.toast), "the save toast says the photo is shared, not device-local", afterUpload.toast);

  // A malicious/bugged write to someone else's path must be rejected, the way
  // the real RLS policy rejects it — not just "the UI doesn't offer this",
  // the server has to say no too.
  const crossWrite = await pageA.evaluate(async () => {
    const blob = new Blob([new Uint8Array([1,2,3])], {type: "image/jpeg"});
    const res = await supabaseStorageProbe(blob);
    return res;
    async function supabaseStorageProbe(b){
      const mod = await import("./vendor/supabase-js.min.js");
      const client = mod.createClient();
      const r = await client.storage.from("avatars").upload("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/avatar.jpg", b, {upsert:true});
      return {ok: !r.error};
    }
  });
  ok(crossWrite.ok === false, "writing to another user's avatar path is rejected");

  // The crop modal's actual point: dragging and zooming has to change what
  // gets uploaded, not just cosmetically move an image around. A photo with
  // four distinct colour quadrants makes the check unambiguous — pan toward
  // one quadrant after zooming in, and the uploaded avatar should read as
  // that colour, not an even mix of all four (which is what a square source
  // cover-fit to a square stage renders by default, with zero pan slack).
  await pageA.evaluate(() => document.querySelector('.tab-btn[data-tab="settings"]').click());
  await pageA.waitForTimeout(300);
  const quadBytes = await pageA.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = c.height = 800;
    const g = c.getContext("2d");
    g.fillStyle = "#e11"; g.fillRect(0, 0, 400, 400);
    g.fillStyle = "#1a1"; g.fillRect(400, 0, 400, 400);
    g.fillStyle = "#11e"; g.fillRect(0, 400, 400, 400);
    g.fillStyle = "#ee1"; g.fillRect(400, 400, 400, 400);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.98));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  fs.writeFileSync(path.join(__dirname, "..", ".tmp-quad.jpg"), Buffer.from(quadBytes));
  await pageA.setInputFiles("#photoInput", path.join(__dirname, "..", ".tmp-quad.jpg"));
  await pageA.waitForSelector(".crop-modal-card .crop-confirm:not([disabled])", {timeout: 5000});
  await pageA.waitForTimeout(200);

  await pageA.evaluate(() => {
    const el = document.querySelector(".crop-zoom-row input[type=range]");
    el.value = "2";
    el.dispatchEvent(new Event("input", {bubbles: true}));
  });
  await pageA.waitForTimeout(150);
  const stageBox = await pageA.locator(".crop-stage").boundingBox();
  const cx = stageBox.x + stageBox.width / 2, cy = stageBox.y + stageBox.height / 2;
  await pageA.mouse.move(cx, cy);
  await pageA.mouse.down();
  await pageA.mouse.move(cx + 140, cy + 140, {steps: 10});
  await pageA.mouse.up();
  await pageA.waitForTimeout(200);
  await pageA.click(".crop-modal-card .crop-confirm");
  await pageA.waitForTimeout(900);

  const dominant = await pageA.evaluate(async () => {
    const img = document.querySelector("#settingsAvatar img");
    if(!img) return null;
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const g = c.getContext("2d");
    if(!img.complete) await new Promise(r => { img.onload = r; });
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let r = 0, gg = 0, bl = 0, n = 0;
    for(let i = 0; i < d.length; i += 4){ r += d[i]; gg += d[i + 1]; bl += d[i + 2]; n++; }
    return {r: Math.round(r / n), g: Math.round(gg / n), b: Math.round(bl / n)};
  });
  // Pure red is (238,17,17); an even mix of all four quadrants is ~(127,110,72).
  // A strong red bias with green/blue held down confirms the pan actually
  // reached the red quadrant rather than leaving the default centred crop.
  ok(!!dominant && dominant.r > 180 && dominant.g < 80 && dominant.b < 80,
    "dragging after zooming in changes which part of the photo gets uploaded",
    JSON.stringify(dominant));

  // Cancel must not upload anything — the file input already cleared itself,
  // and the modal closing on Cancel/Escape/back must leave the profile
  // exactly as it was.
  await pageA.evaluate(() => document.querySelector('.tab-btn[data-tab="settings"]').click());
  await pageA.waitForTimeout(300);
  const beforeCancelStamp = await pageA.evaluate(() =>
    globalThis.__PROFILES["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].avatar_updated_at);
  await pageA.setInputFiles("#photoInput", path.join(__dirname, "..", ".tmp-quad.jpg"));
  await pageA.waitForSelector(".crop-modal-card");
  await pageA.click(".crop-cancel");
  await pageA.waitForTimeout(400);
  const afterCancel = await pageA.evaluate(() => ({
    modalGone: !document.querySelector(".crop-modal-card"),
    stamp: globalThis.__PROFILES["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].avatar_updated_at,
  }));
  ok(afterCancel.modalGone, "Cancel closes the crop modal");
  ok(afterCancel.stamp === beforeCancelStamp, "Cancel does not upload or change the profile", JSON.stringify(afterCancel));

  try{ fs.unlinkSync(path.join(__dirname, "..", ".tmp-quad.jpg")); }catch(e){}

  await pageA.close();
  await ctxA.close();

  // ---- A different signed-in user (Bob, non-admin) can still READ Alice's
  // photo directly through the same Storage API — the RLS boundary is
  // "any signed-in user may read", not "only the roster UI happens to allow
  // it", so this checks the boundary itself rather than one screen of UI. ----
  const seededForBob = stubFor(BOB)
    .replace(
      `"${ALICE}": {id:"${ALICE}", email:"alice@example.com", full_name:"Alice Admin", role:"admin", avatar_updated_at:null},`,
      `"${ALICE}": {id:"${ALICE}", email:"alice@example.com", full_name:"Alice Admin", role:"admin", avatar_updated_at:${JSON.stringify(afterUpload.stamp)}},`
    )
    .replace(
      "globalThis.__STORAGE = {};",
      `globalThis.__STORAGE = {"${ALICE}/avatar.jpg": {bytes:new Uint8Array(${JSON.stringify(aliceBytes)}), contentType:"image/jpeg"}};`
    );

  const ctxB = await browser.newContext({viewport: {width: 1440, height: 900}});
  const pageB = await ctxB.newPage();
  const errsB = [];
  pageB.on("pageerror", e => errsB.push(String(e).slice(0, 160)));
  await pageB.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status: 200, contentType: "text/javascript", body: seededForBob}));
  await pageB.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
  await pageB.waitForTimeout(900);

  const bobReadsAlice = await pageB.evaluate(async () => {
    const mod = await import("./vendor/supabase-js.min.js");
    const client = mod.createClient();
    const res = await client.storage.from("avatars")
      .download("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatar.jpg");
    return {ok: !res.error, size: res.data ? res.data.size : 0};
  });
  ok(bobReadsAlice.ok && bobReadsAlice.size > 0,
    "a different signed-in user can read someone else's avatar", JSON.stringify(bobReadsAlice));

  await pageB.close();
  await ctxB.close();

  // ---- The scenario the feature exists for: an admin's Team roster shows a
  // TEAMMATE's real photo, not just the admin's own. ----
  const bobBytes = await (async () => {
    const ctxTmp = await browser.newContext();
    const pTmp = await ctxTmp.newPage();
    const bytes = await makeJpegBytes(pTmp, "B", "#1e8a5f");
    await ctxTmp.close();
    return bytes;
  })();
  const seededForAliceRoster = stubFor(ALICE)
    .replace(
      `"${BOB}":   {id:"${BOB}",   email:"bob@example.com",   full_name:"Bob Employee", role:"user",  avatar_updated_at:null}`,
      `"${BOB}":   {id:"${BOB}",   email:"bob@example.com",   full_name:"Bob Employee", role:"user",  avatar_updated_at:${JSON.stringify(new Date().toISOString())}}`
    )
    .replace(
      "globalThis.__STORAGE = {};",
      `globalThis.__STORAGE = {"${BOB}/avatar.jpg": {bytes:new Uint8Array(${JSON.stringify(bobBytes)}), contentType:"image/jpeg"}};`
    );

  const ctxC = await browser.newContext({viewport: {width: 1440, height: 900}});
  const pageC = await ctxC.newPage();
  const errsC = [];
  pageC.on("pageerror", e => errsC.push(String(e).slice(0, 160)));
  await pageC.route("**/vendor/supabase-js.min.js",
    r => r.fulfill({status: 200, contentType: "text/javascript", body: seededForAliceRoster}));
  await pageC.goto(`http://localhost:${PORT}/index.html`, {waitUntil: "load"});
  await pageC.waitForTimeout(900);
  await pageC.evaluate(() => document.querySelector('.tab-btn[data-tab="team"]')?.click());
  await pageC.waitForTimeout(1100);

  const bobCard = await pageC.evaluate((bobId) => {
    const card = document.querySelector('.team-card[data-uid="' + bobId + '"]');
    const img = card && card.querySelector(".avatar img");
    return {cardFound: !!card, hasRealPhoto: !!img, naturalWidth: img ? img.naturalWidth : null};
  }, BOB);
  ok(bobCard.cardFound, "Bob's card renders in Alice's roster");
  ok(bobCard.hasRealPhoto, "Bob's card shows his real photo, not initials — the defect this feature fixes",
    JSON.stringify(bobCard));

  // The Overview portrait specifically: it repaints through renderAll(), which
  // calls renderPersonCard() directly and never through refreshAvatars()'s
  // trailing document-wide hydrate. hydrateAvatars() used to be scoped to the
  // slot element's DESCENDANTS only — but the portrait's data-avatar-id sits
  // on the slot itself, so this exact path (switch viewer, look at Overview)
  // silently never fetched anything and left the initials fallback standing
  // forever. Caught once; guarded here so it can't regress silently.
  await pageC.evaluate(() => document.querySelector('.tab-btn[data-tab="overview"]').click());
  await pageC.waitForTimeout(300);
  await pageC.evaluate((bobId) => {
    var sel = document.getElementById("viewerSelect");
    sel.value = bobId;
    sel.dispatchEvent(new Event("change"));
  }, BOB);
  await pageC.waitForTimeout(1200);
  const portraitAfterSwitch = await pageC.evaluate(() => ({
    hasImg: !!document.querySelector("#portraitMedia img"),
    name: (document.getElementById("personName") || {}).textContent,
  }));
  ok(portraitAfterSwitch.name === "Bob Employee",
    "the viewer switch actually changed who is on screen", JSON.stringify(portraitAfterSwitch));
  ok(portraitAfterSwitch.hasImg,
    "the Overview portrait hydrates a photo reached only through renderAll(), not just refreshAvatars()",
    JSON.stringify(portraitAfterSwitch));

  // Someone with no photo still renders cleanly — initials, no broken slot.
  const aliceOwnCard = await pageC.evaluate((aliceId) => {
    const card = document.querySelector('.team-card[data-uid="' + aliceId + '"]');
    const avatar = card && card.querySelector(".avatar");
    return {found: !!card, hasImg: !!(avatar && avatar.querySelector("img")),
      text: avatar ? avatar.textContent.trim() : null};
  }, ALICE);
  ok(aliceOwnCard.found && !aliceOwnCard.hasImg && aliceOwnCard.text === "AA",
    "a person with no photo renders initials, not an empty or broken slot", JSON.stringify(aliceOwnCard));

  await pageC.close();
  await ctxC.close();

  if(errsA.length) ok(false, "no console errors during Alice's upload flow", errsA.join(" | "));
  if(errsB.length) ok(false, "no console errors reading a cross-user avatar", errsB.join(" | "));
  if(errsC.length) ok(false, "no console errors rendering the roster", errsC.join(" | "));

  try{ fs.unlinkSync(path.join(__dirname, "..", ".tmp-alice.jpg")); }catch(e){}
  await browser.close();
  server.close();
  console.log(`  shared-avatars  pass ${pass}   fail ${fail}`);
  if(failures.length){ failures.forEach(f => console.log("  FAIL " + f)); process.exit(1); }
})();
