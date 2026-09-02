# Attendance Ledger

A personal and small-team attendance record. Clock in and out, or enter days by
hand; the app computes hours worked against a configurable daily target, tracks
punctuality and annual leave, and produces a printable timesheet with signature
lines.

Static front end on GitHub Pages, Supabase (Postgres) for auth and data. No
build step — deployment is a file copy.

## Files

| Path | What it is |
|---|---|
| `index.html` | Markup, styles, and the Content-Security-Policy. No inline script. |
| `app.js` | The entire application. Extracted from `index.html` so the page can ship a real CSP (an inline module would force `script-src 'unsafe-inline'`). |
| `theme-boot.js` | Reads the saved palette and light/dark choice and stamps them on `<html>`. Loaded **blocking, in `<head>`**, so the page never paints in the wrong theme first — and external for the same CSP reason as `app.js`. |
| `vendor/supabase-js.min.js` | The one runtime dependency, pinned to **2.58.0** and committed. Built with esbuild from the npm package. |
| `sw.js` | Service worker. Caches the app shell so an installed PWA can boot offline. |
| `manifest.json`, `*.png` | PWA manifest and icons. |
| `supabase/migrations/` | Database schema, policies, functions and triggers. |
| `tools/` | Authoring aids, not shipped and not a build step. `palettes.mjs` generates the six palettes' CSS and measures every pair against WCAG AA; `apply-palettes.mjs` writes the result into `index.html`. |
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

## Database

The schema is in `supabase/migrations/`. It was previously not in version
control at all, which meant the entire authorisation model existed only in the
live project with no review trail.

Apply migrations with the Supabase CLI:

```bash
supabase db push
```

…or paste a migration into **Dashboard → SQL Editor → Run**.

Both migrations are applied to the live project as of 2026-08-15. Each file's
header records what it covers and how it was verified. Note that the second
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
| `regression/admin-tab` | Admin console: admin-only gating, people/roles, health checks, defaults, log |
| `mobile/*` | Responsive grid, control sizing, collision scanning |

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
  each other's edits.
- **No optimistic concurrency.** Two admins editing the same day overwrite each
  other; `entries.updated_at` exists but is never compared.
- **Punch times come from the device clock** and are therefore unverifiable.
- **Single tenant.** Every admin sees every user; there is no organisation or
  department boundary in the schema.
- **English only.** No RTL layout. User-authored text is bidi-isolated with
  `dir="auto"`, but the interface itself is not translated.

## Audit

`QA_Audit_Report.txt` is a full audit from 2026-08-15 and the remediation record
that follows it.
