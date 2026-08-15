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
| `vendor/supabase-js.min.js` | The one runtime dependency, pinned to **2.58.0** and committed. Built with esbuild from the npm package. |
| `sw.js` | Service worker. Caches the app shell so an installed PWA can boot offline. |
| `manifest.json`, `*.png` | PWA manifest and icons. |
| `supabase/migrations/` | Database schema, policies, functions and triggers. |
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

> **`20260815020000_pending_data_integrity_and_hardening.sql` has not been
> applied yet.** It adds the `entries` CHECK constraints, lets users own their
> own schedule settings, and enforces the registration toggle server-side. The
> front end already expects the settings-ownership half, so **schedule saves by
> non-admin users will be rejected by RLS until this migration is run.**

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
| `clock` | Punch serialisation and button state under load |
| `regression/audit-logic` | Hours arithmetic, leave, streak, week start, long-shift guard |
| `regression/audit-dom` | Boot failure, banner rendering, contrast, ARIA, CSP |
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

- **Needs a connection.** There is no offline queue; a punch made offline is
  lost. The service worker caches the shell, not the data.
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
