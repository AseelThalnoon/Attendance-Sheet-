# Attendance Ledger

A personal and small-team attendance record. Clock in and out, or enter days by
hand; the app computes hours worked against a configurable daily target, tracks
punctuality and annual leave, and produces a printable timesheet with signature
lines.

Static front end on GitHub Pages, Supabase (Postgres) for auth and data. The
source runs exactly as it is written — open `index.html` from any static server
and that is the app, with nothing to compile. What is *published* is built from
it: a workflow minifies the scripts and styles and publishes only the files the
app loads (see **Publishing**).

## Files

| Path | What it is |
|---|---|
| `index.html` | Markup, styles, and the Content-Security-Policy. No inline script. |
| `app.js` | The entire application. Extracted from `index.html` so the page can ship a real CSP (an inline module would force `script-src 'unsafe-inline'`). |
| `theme-boot.js` | Reads the saved palette and light/dark choice and stamps them on `<html>`. Loaded **blocking, in `<head>`**, so the page never paints in the wrong theme first — and external for the same CSP reason as `app.js`. Being the first script to run, it is also where the page refuses to work inside another site's frame: GitHub Pages cannot send `frame-ancestors`, so the clickjacking guard lives here. |
| `vendor/supabase-js.min.js` | The one runtime dependency, pinned to **2.118.0** and committed (2.105+ is needed for passkeys). Built with esbuild from the npm package: `export { createClient } from "@supabase/supabase-js"`, bundled with `esbuild --bundle --format=esm --minify --platform=browser --target=es2020`. |
| `sw.js` | Service worker. Keeps a copy of the app shell and opens the app from it, at once, online or off; a new release is saved beside the running one and taken at a safe moment (see **Publishing**). |
| `manifest.json`, `*.png` | PWA manifest and icons. |
| `supabase/migrations/` | Database schema, policies, functions and triggers. |
| `tools/` | Not shipped. `palettes.mjs` generates the seven palettes' CSS and measures every pair against WCAG AA; `apply-palettes.mjs` writes the result into `index.html`. `build.mjs` makes the published copy; `stamp-release.mjs` moves the release label on (both under **Publishing**). |
| `tests/` | Regression suites. See below. |

## Running locally

Any static server works; the app needs `http://`, not `file://`, because it
loads an ES module.

```bash
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

Configuration lives at the top of `app.js` (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`). The anon key is designed to be public — authority comes
from Row Level Security, not from the key. **That means RLS is the only thing
protecting the data; treat changes to it as security-critical.**

## Publishing

Two rules here replaced earlier ones on 2026-11-15, both by the owner's
decision. They are written down because each undoes something this file used to
state as a principle.

**The published copy is built.** It used to be "no build step — deployment is a
file copy", and for the source that is still true. But `app.js` is a third
commentary by weight and `index.html` carries 400KB of commented stylesheet,
and both were going to every phone as written. `node tools/build.mjs` writes
`dist/`: each script and the stylesheet minified in place (names kept, so a
crash report from the field still reads `at handleSignedIn`), comments removed,
and nothing else from the repository — the tests, migrations and notes were
being served beside the app only because they shared a folder. A first visit
goes from about 400KB to about 200KB compressed. It is a transform of each
file, not a bundle: `dist/` has the same files at the same paths as the source,
so the preload hints and the service worker's list mean the same in both.

`.github/workflows/deploy.yml` runs it after the test workflow passes on `main`
and publishes `dist/`. **It publishes only once Pages is switched over:**
Settings → Pages → Build and deployment → Source → *GitHub Actions*. Until then
the workflow builds, says so, and stops, and Pages goes on publishing the
repository root exactly as before.

**The app opens from its saved copy.** The service worker used to ask the
network first and fall back to its copy after three seconds, so every launch
waited on a request for the page before anything could draw. It now answers
from the copy at once and does not ask. The cost is that a release no longer
arrives by itself: an installed app hears of one only because `sw.js` has
changed. So:

- `sw.js` carries a fingerprint of every file it saves, and the
  `service-worker` suite fails if any of them has changed since. Run
  `node tools/stamp-release.mjs` — it moves the label (`v47` → `v48`) in `sw.js`
  and `index.html` and records the new fingerprint. The build stamps `dist/` by
  itself on every deploy, so this is about the source tree staying honest.
- A new release is saved in the background beside the running one and never
  takes over underneath a page in use. The page moves onto it at launch if it
  was already waiting, on coming back after five minutes with nothing open, on
  Refresh, or on sign-out; until then a toast says it is ready.
- An install that fails, or whose page names a different release than its
  worker, is discarded whole. The release already running keeps its copy.

## Database

The schema is in `supabase/migrations/`. It was previously not in version
control at all, which meant the entire authorisation model existed only in the
live project with no review trail.

Apply migrations with the Supabase CLI:

```bash
supabase db push
```

…or paste a migration into **Dashboard → SQL Editor → Run**.

Each file's header records what it covers and how it was verified, and every
file here is applied to the live project, the newest
(`20261115135254_input_bounds_least_privilege_and_cron_history.sql`) on
2026-11-15. Each is named after the version the project recorded for it. Note that the second
file keeps its original `pending_` name so that its filename matches the version
recorded in the remote migration history — it is applied, not pending.

## The outbox

A punch is the one write that cannot be repeated later — the whole value of a
clock-in is the minute it happened, so "try again when you have signal" records
the wrong time by definition. Everything else the app writes can wait for a
connection and be retyped unchanged. That asymmetry is the whole justification
for the queue; it is not a general sync layer and should not grow into one.

- The queue holds **intentions** (*clock out at 06:12 on this date*), not rows.
  Storing a row would freeze that day's type, note and other half-shift at the
  moment the connection dropped, and uploading it later would silently revert
  whatever else had changed. On flush the current row is read and only the
  punched field is written over it.
- A queued punch is **shown in its day like any other**, because it is one — the
  record exists, only the upload is outstanding. A banner says so. Hiding it
  would show "not clocked in" to someone who just clocked in, and get them to
  punch again.
- The day is not editable or deletable while a punch on it is queued; the flush
  is about to write to it, and an edit made now would be overwritten silently.
- Flushes are triggered by the `online` event, by the app becoming visible (a
  phone that slept through the reconnection fires no event), and at sign-in.
- A punch the server *rejects* — as opposed to one it never received — is
  dropped rather than retried forever, loudly, with a toast naming the day.
  Retrying it would wedge every punch queued behind it.
- The queue is keyed by user id and survives sign-out, since an unsent punch is
  that person's record rather than this session's state.

## The Admin console

Everything an administrator can do lives in one screen, opened from the **Admin**
button in the header and visible only to admins. It is deliberately not a tab:
the tab strip holds views of your own attendance, and this manages the
organisation.

- **Overview** — database size, accounts, entries, connections, plus data-health
  checks that run as counted queries: open shifts from past days, blank working
  days, implausible dates, and people with no schedule of their own. Checks that
  pass are listed too, so an admin can see a check ran rather than guess.
- **People** — search and filter every account; grant or revoke admin; open
  someone's record; send a password reset; deactivate or delete. Accounts with no
  `user_settings` row of their own are flagged, since every figure the app shows
  them is otherwise measured against a fallback week.
- **Organisation Defaults** — edits `app_settings.default_settings`, the schedule
  `handle_new_user()` copies into each new account. It can also backfill people
  who have no schedule; it never overwrites one that exists.
- **Company-Wide Days**, **Announcement & Sign-Up**, **Activity Log** (filter by
  activity, person and date, page through, export CSV), and **Storage**.

The header button is hidden for employees, `renderAdmin()` refuses to paint for a
non-admin, and every RPC and RLS policy behind the screen re-checks `is_admin()`
server-side. The client-side half is convenience; the database is the authority.

### Signing out

Signing out reloads the page. Hiding the app was not enough: whatever the last
person had on screen — the Admin console's list of every account, say — stayed
in the page, and the next person to sign in on the same machine opened on it.
A fresh page has nothing in it to leave behind. The device is also taken off
that person's notifications on the way out, and put back without a prompt when
they sign in again.

### Authorisation model

- `is_admin()` drives every policy. Admins can read and write anyone's data.
- `profiles.role` is **not** writable through the API. `authenticated` holds a
  column grant on `full_name` only, and a `BEFORE UPDATE` trigger rejects role,
  id and email changes. Role changes go through `admin_set_user_role()`, which
  re-checks admin rights and refuses to remove the last administrator.
- `audit_log` is append-only by construction: there is no INSERT, UPDATE or
  DELETE policy, and rows are written solely by `SECURITY DEFINER` triggers.

## Tests

```bash
cd tests
npm install      # first time only (Playwright)
npm test         # everything
npm run test:regression   # just the audit regression suites
```

| Suite | Covers |
|---|---|
| `parsers` | CSV date/time/type parsing |
| `modal` | Confirm dialog, focus trap, keyboard handling |
| `clock` | Punch serialisation and button state under load; which calendar day an overnight clock-out lands on; the offline outbox |
| `regression/audit-logic` | Hours arithmetic, leave, streak, week start, long-shift guard |
| `regression/audit-dom` | Boot failure, banner rendering, contrast, ARIA, CSP |
| `regression/service-worker` | `sw.js` run as written: opening never waits on the network, a page and its files are always one release, a bad install is discarded whole, and `sw.js` cannot be left unstamped when the shell changes |
| `regression/app-update` | When an open page moves onto a new release: never mid-task, never on a password-reset link, never twice, and otherwise at the first moment it costs nothing |
| `regression/build-output` | The published copy is the same app: complete and consistent, every element styled as in the source on every screen measured, all fourteen palette compositions equal, and it boots and works |
| `regression/release-e2e` | One release replacing another, in a real browser with the real (built) service worker: installs, opens again without one request to the server, fetches the next release behind the open app, moves onto it on Refresh, and still opens with the server gone |
| `regression/admin-tab` | Admin console: admin-only gating, people/roles, health checks, defaults, log |
| `regression/stale-resume` | A page that outlives its copy of the record: a punch or a save refused because another device got there first reloads and says so; coming back to the app after five minutes re-reads quietly, and stands down for a form in progress |
| `regression/punch-flood` | The animation a saved punch plays: it starts at the control that was pressed and covers its stage (the screen on a phone, the clock panel or sticky bar above that), says the minute that was saved, turns back to where that control has moved to, leaves by itself, never passes a tap through, and is not built at all under reduced motion. Also the chime and the vibration: the notes asked for, the press tick and the two beats, nothing for a refused punch, and the two Settings switches |
| `regression/sign-out-clean` | Nothing of one person is left for the next: the page starts over after a sign-out (or is emptied by hand where it cannot), and the device stops receiving the last person's notifications |
| `regression/csv-export` | The exported file as a spreadsheet reads it: notes cannot run as formulas, figures stay figures, Arabic survives Excel, and the file imports back unchanged |
| `regression/frame-guard` | The app refuses to run inside another page's frame, on another site or its own origin; the description, no-index and no-JavaScript notices |
| `regression/send-push-guards` | `send-push` run as written: only the scheduler or an administrator may trigger it, and it only ever contacts a real push service |
| `mobile/*` | Responsive grid, control sizing, collision scanning |
| `hostile/hostile` | Boots the real app against a scripted Supabase (`hostile/backend.js`) to check what the golden path never exercises: a viewer-switch race, a failed/hung load left readable (not presented as an empty account, and not writable over), double-submit guards, hostile names (unbroken strings, emoji, RTL, CJK) not breaking layout, and PWA-specific cases — the offline outbox still queuing alongside a failing background load, and every portrait-width breakpoint of the header/sign-in screen reserving `env(safe-area-inset-top)` for an installed app's notch/Dynamic Island. `hostile/scan.js` is the exploratory sweep this suite's cases were found with, not an assertion suite itself — run it by hand (`npm run scan:hostile`) when hunting for more. |

Suites extract their subject **verbatim from the shipping source at run time**
rather than reimplementing it (see `tests/extract.js`). Anchors are matched
across both `app.js` and `index.html`. This is deliberate: an earlier version of
the regression suite reimplemented two functions and consequently could not see
the fixes it was meant to verify.

To confirm a test genuinely catches the bug it was written for, point it at an
older revision:

```bash
git show HEAD~1:app.js > /tmp/old-app.js
ATTENDANCE_APP_SRC=/tmp/old-app.js npm run test:regression
```

## Known limitations

- **Offline covers punches only.** A clock-in or clock-out made with no
  connection is queued on the device and uploads by itself when the connection
  returns (see *The outbox* below). Nothing else is queued: a hand-entered day,
  a settings change or an admin action still needs a connection. The service
  worker caches the shell, not the data.
- **No cross-tab sync.** Two open tabs hold independent state and will not see
  each other's edits as they happen. The gap closes by itself rather than
  waiting for a refresh: a page that has been in the background for five
  minutes re-reads the record when it comes back, and a save the server
  refuses because the screen was behind reloads it and says so.
- **No optimistic concurrency.** Two admins editing the same day overwrite each
  other; `entries.updated_at` exists but is never compared.
- **Punch times come from the device clock** and are therefore unverifiable.
- **Single tenant.** Every admin sees every user; there is no organisation or
  department boundary in the schema.
- **English only.** No RTL layout. User-authored text is bidi-isolated with
  `dir="auto"`, but the interface itself is not translated.
- **Ledger is the only pre-redesign world brought back.** The old codebase
  also shipped Kinetic (scroll-reveal motion) and Velocity (a full dark/3D
  alternate world with its own fonts) alongside it, switched by an
  admin-wide `app_settings.theme` column — deliberately not revived; see
  DESIGN.md's **Palettes and modes** for why Ledger runs through the same
  personal, per-browser mechanism as the other six instead.

## Audit

`QA_Audit_Report.txt` is a full audit from 2026-08-15 and the remediation record
that follows it.
