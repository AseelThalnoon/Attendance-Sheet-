// A scripted Supabase, installed as a Playwright route handler.
//
// The point is not to reimplement PostgREST. It is to hold the app's own
// requests still so a suite can decide what comes back: a 200-character name,
// three thousand entries, a 500, a request that never answers. None of those
// are reachable against the live project, and every one of them is a state a
// real user can land in.
//
// Route interception sits below the page's Content-Security-Policy, so the
// app's connect-src stays exactly as it ships and the requests are answered
// locally anyway.
const PROJECT = "lxnfiszrlgddpcbwavfw";
const HOST = `https://${PROJECT}.supabase.co`;
const STORAGE_KEY = `sb-${PROJECT}-auth-token`;

// ---- PostgREST filter subset -------------------------------------------------
// eq, in and is are the only operators app.js uses. An unrecognised one throws
// rather than quietly matching everything, which would make a test pass by
// filtering nothing.
function matches(row, params){
  for(const [key, raw] of params){
    if(["select","order","limit","offset","on_conflict","columns"].includes(key)) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot), val = raw.slice(dot + 1);
    const cell = row[key];
    if(op === "eq"){ if(String(cell) !== val) return false; }
    else if(op === "in"){
      const list = val.replace(/^\(|\)$/g, "").split(",").map(s => s.replace(/^"|"$/g, ""));
      if(!list.includes(String(cell))) return false;
    }
    else if(op === "is"){ if(val === "null" ? cell != null : String(cell) !== val) return false; }
    else if(op === "neq"){ if(String(cell) === val) return false; }
    else if(op === "gt"){  if(!(String(cell) >  val)) return false; }
    else if(op === "gte"){ if(!(String(cell) >= val)) return false; }
    else if(op === "lt"){  if(!(String(cell) <  val)) return false; }
    else if(op === "lte"){ if(!(String(cell) <= val)) return false; }
    else if(op === "not"){ continue; }
    else throw new Error(`backend: unsupported PostgREST operator "${op}" on ${key}`);
  }
  return true;
}

function sortRows(rows, order){
  if(!order) return rows;
  const [col, dir] = order.split(".");
  return rows.slice().sort((a, b) => {
    const x = a[col], y = b[col];
    const c = x === y ? 0 : (x > y ? 1 : -1);
    return dir === "desc" ? -c : c;
  });
}

// Constraints the live schema enforces regardless of what a given query names
// as its on_conflict target — a plain `.insert()` still hits them.
const UNIQUE_KEYS = { entries: ["user_id", "date"] };

function createBackend(seed){
  const state = {
    // Tables, keyed the way PostgREST addresses them.
    entries: (seed && seed.entries) || [],
    profiles: (seed && seed.profiles) || [],
    user_settings: (seed && seed.user_settings) || [],
    app_settings: (seed && seed.app_settings) || [{ id: 1, default_settings: null, announcement: null, allow_signup: true }],
    audit_log: (seed && seed.audit_log) || [],
    // The push tables, so a suite can seed a send history or a set of
    // subscribed devices. Unseeded they behave like the empty tables they
    // are, which is what every suite that does not care about them wants.
    push_notifications: (seed && seed.push_notifications) || [],
    push_subscriptions: (seed && seed.push_subscriptions) || [],
    // Faults, keyed by a substring of the request path ("entries", "rpc/admin_list_users").
    // Value: {status, message} | "hang" | {delayMs, ...}
    faults: new Map(),
    // Every request the app made, so a test can assert on traffic (was a
    // second load fired? did the stale one land?).
    log: [],
    nextId: 100000
  };

  // A fault that applies to the next N matching requests only, so a test can
  // fail one load and let the retry succeed.
  function fail(key, spec, times){
    state.faults.set(key, Object.assign({ times: times == null ? Infinity : times }, spec));
  }
  function clearFaults(){ state.faults.clear(); }

  function takeFault(pathname){
    for(const [key, f] of state.faults){
      if(!pathname.includes(key)) continue;
      if(f.times <= 0) continue;
      f.times--;
      return f;
    }
    return null;
  }

  const json = (body, status, headers) => ({
    status: status || 200,
    contentType: "application/json",
    headers: Object.assign({ "Access-Control-Allow-Origin": "*" }, headers || {}),
    body: JSON.stringify(body)
  });

  async function handle(route, request){
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    state.log.push({ method, path, search: url.search, at: Date.now() });

    if(method === "OPTIONS"){
      return route.fulfill({ status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
      }});
    }

    const fault = takeFault(path + url.search);
    if(fault){
      if(fault.mode === "hang") return;                       // never fulfilled
      if(fault.mode === "offline") return route.abort("failed"); // what a dropped connection looks like
      if(fault.delayMs) await new Promise(r => setTimeout(r, fault.delayMs));
      if(fault.status){
        return route.fulfill(json({
          message: fault.message || "server error",
          code: fault.code || null, details: null, hint: null
        }, fault.status));
      }
    }

    if(path.startsWith("/auth/v1/")) return route.fulfill(json(authResponse(path, request)));
    if(path.startsWith("/storage/v1/")) return route.fulfill(json({ message: "Object not found" }, 404));
    if(path.startsWith("/rest/v1/rpc/")) return route.fulfill(rpc(path.split("/rpc/")[1], request));
    if(path.startsWith("/rest/v1/")) return route.fulfill(await table(path.split("/rest/v1/")[1], url, request));

    return route.fulfill(json({ message: "unhandled: " + path }, 500));
  }

  function authResponse(path, request){
    if(path.endsWith("/logout")) return {};
    if(path.endsWith("/user")) return state.profiles[0]
      ? { id: state.profiles[0].id, email: state.profiles[0].email }
      : {};
    return {};
  }

  function rpc(name, request){
    const args = JSON.parse(request.postData() || "{}");
    const me = state.profiles.find(p => p.id === state.meId);
    if(name.startsWith("admin_") && (!me || me.role !== "admin")){
      return json({ message: `Only admins can do that`, code: "42501" }, 403);
    }
    if(name === "admin_list_users"){
      return json(state.profiles.map(p => ({
        id: p.id, email: p.email, full_name: p.full_name, role: p.role,
        created_at: p.created_at || "2026-01-01T00:00:00Z",
        last_sign_in_at: p.last_sign_in_at || null,
        last_seen_at: p.last_seen_at || null,
        deactivated: !!p.deactivated,
        entry_count: state.entries.filter(e => e.user_id === p.id).length
      })));
    }
    // Counts only, the way the real SECURITY DEFINER function does -- a suite
    // seeds push_subscriptions and this reports the reach they add up to.
    if(name === "admin_push_reach"){
      const active = state.profiles.filter(p => !p.deactivated);
      const subs = state.push_subscriptions.filter(s => active.some(p => p.id === s.user_id));
      return json({
        people: active.length,
        subscribed: new Set(subs.map(s => s.user_id)).size,
        devices: subs.length
      });
    }
    if(name === "admin_db_stats"){
      return json({
        db_size_bytes: 41_943_040, active_connections: 4, max_connections: 60,
        postgres_version: "15.6",
        tables: [{ name: "entries", total_bytes: 2_097_152, rows: state.entries.length }],
        counts: {
          profiles: state.profiles.length,
          entries: state.entries.length,
          admins: state.profiles.filter(p => p.role === "admin").length
        },
        generated_at: new Date().toISOString()
      });
    }
    if(name === "admin_audit_log") return json(state.audit_log.slice(0, args.limit_n || 100));
    if(name === "admin_set_user_role"){
      const t = state.profiles.find(p => p.id === args.target_id);
      if(t) t.role = args.new_role;
      return json(null);
    }
    if(name === "admin_set_user_active" || name === "admin_delete_user") return json(null);
    return json({ message: "unknown rpc " + name }, 404);
  }

  async function table(rest, url, request){
    const name = rest.split("?")[0];
    const rows = state[name];
    if(!rows) return json({ message: `relation "${name}" does not exist` }, 404);

    const params = Array.from(url.searchParams.entries());
    const wantsObject = (request.headers()["accept"] || "").includes("pgrst.object");
    const prefer = request.headers()["prefer"] || "";
    const method = request.method();

    if(method === "GET" || method === "HEAD"){
      let out = rows.filter(r => matches(r, params));
      out = sortRows(out, url.searchParams.get("order"));
      if(prefer.includes("count=exact") || method === "HEAD"){
        return {
          status: 200, contentType: "application/json",
          headers: { "Content-Range": `0-${Math.max(0, out.length - 1)}/${out.length}`,
                     "Access-Control-Allow-Origin": "*" },
          body: method === "HEAD" ? "" : JSON.stringify(out)
        };
      }
      if(wantsObject){
        if(out.length === 1) return json(out[0]);
        // PGRST116 is what .single()/.maybeSingle() key off; returning an
        // array here instead would make "no settings row" look like success.
        return json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, 406);
      }
      return json(out);
    }

    const body = JSON.parse(request.postData() || "null");
    const incoming = Array.isArray(body) ? body : [body];

    if(method === "POST"){
      const onConflict = url.searchParams.get("on_conflict");
      // `entries` carries a real unique constraint on (user_id, date) whether
      // or not the query names it — sbUpsertEntry's plain `.insert()` (no
      // on_conflict) relies on exactly this to turn a second insert for the
      // same day into a 23505 rather than a second row. Only checking
      // `onConflict` here made every plain insert look conflict-free and let
      // ten rapid submits create ten rows for one date, which the live
      // database would have refused after the first.
      const keys = onConflict ? onConflict.split(",") : (UNIQUE_KEYS[name] || null);
      const saved = [];
      for(const row of incoming){
        let existing = null;
        if(keys){
          existing = rows.find(r => keys.every(k => String(r[k]) === String(row[k])));
        }
        if(existing && prefer.includes("resolution=merge-duplicates")){
          Object.assign(existing, row); saved.push(existing);
        } else if(existing){
          return json({ code: "23505", message: `duplicate key value violates unique constraint` }, 409);
        } else {
          const created = Object.assign({ id: state.nextId++ }, row);
          rows.push(created); saved.push(created);
        }
      }
      if(!prefer.includes("return=representation")) return json(null, 201);
      return wantsObject ? json(saved[0]) : json(saved);
    }

    if(method === "PATCH"){
      const hit = rows.filter(r => matches(r, params));
      hit.forEach(r => Object.assign(r, incoming[0]));
      if(!prefer.includes("return=representation")) return json(null, 204);
      return wantsObject ? json(hit[0]) : json(hit);
    }

    if(method === "DELETE"){
      const keep = rows.filter(r => !matches(r, params));
      state[name] = keep;
      return json(null, 204);
    }

    return json({ message: "unhandled method " + method }, 405);
  }

  // Signs the browser in without touching the auth endpoints: supabase-js
  // reads its session straight out of localStorage on construction.
  function sessionScript(user){
    const session = {
      access_token: "test-access-token", token_type: "bearer",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "test-refresh-token",
      user: {
        id: user.id, aud: "authenticated", role: "authenticated", email: user.email,
        app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z"
      }
    };
    return [STORAGE_KEY, JSON.stringify(session)];
  }

  async function install(page, meId){
    state.meId = meId || (state.profiles[0] && state.profiles[0].id);
    const me = state.profiles.find(p => p.id === state.meId) || { id: state.meId, email: "me@example.com" };
    const [key, value] = sessionScript(me);
    await page.addInitScript(([k, v]) => { try{ window.localStorage.setItem(k, v); }catch(e){} }, [key, value]);
    await page.route(`${HOST}/**`, handle);
  }

  return { state, install, fail, clearFaults, HOST };
}

module.exports = { createBackend, PROJECT, HOST, STORAGE_KEY };
