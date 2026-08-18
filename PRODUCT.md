# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner/admin and their own small team (a handful of trusted people, not a
multi-organisation customer base). Confirmed: this is an internal tool for
one team, not a product meant for other organisations to adopt — single
tenant is an acceptable permanent constraint, not a gap to close.

## Product Purpose

A personal and small-team attendance record: clock in/out or hand-enter days,
compute hours against a configurable daily target, track punctuality and
annual leave, and produce a printable timesheet with signature lines.

Confirmed success criterion: this is low-stakes, personal-habit-tracking
territory — visibility into hours, punctuality, and leave for the owner and a
small crew — not a payroll-grade system of record that has to survive a
formal dispute or payroll run.

## Positioning

A static front end with no build step and no framework, backed by Supabase
Postgres for auth/data, where Row Level Security (not the client) is the
actual authority over who can see or change what. Deployment is a file copy
to GitHub Pages.

## Operating Context

- Installed as a standalone PWA (portrait-primary), used primarily on mobile
  to clock in/out, with a desktop-capable admin console.
- Admin work (people, org defaults, company-wide days, activity log, storage)
  lives in one dedicated Admin screen, not the tab strip used for the
  individual's own attendance views.
- Offline is out of scope: no offline queue: a punch made offline is lost. The
  service worker caches the shell only.

## Capabilities and Constraints

- Single tenant by design (confirmed, not a gap): every admin sees every
  user; there is no organisation/department boundary in the schema, and none
  is planned.
- No cross-tab sync; no optimistic concurrency (two admins editing the same
  day overwrite each other, `updated_at` exists but is unchecked).
- Punch times come from the device clock and are therefore unverifiable —
  acceptable given the confirmed low-stakes/personal-tracking success bar.
- English only, no RTL layout; user-authored text is bidi-isolated with
  `dir="auto"`.
- `is_admin()` gates every policy; `profiles.role` is not writable through
  the API (role changes go through `admin_set_user_role()`, which refuses to
  remove the last administrator); `audit_log` is append-only by construction.

## Evidence on Hand

- `README.md` documents the file layout, admin console, authorisation model,
  and known limitations in detail — treat it as current product truth
  alongside this file.
- `QA_Audit_Report.txt` (2026-08-15) is a full audit and remediation record;
  open findings tracked separately in project memory.
- No testimonials, case studies, or press exist or should be fabricated.

## Product Principles

- The database is the authority, not the client: every admin affordance in
  the UI must have a server-side check behind it, never rely on hiding a
  button.
- Low-stakes personal tracking, not payroll infrastructure: don't add
  ceremony (formal approval chains, dispute workflows, audit rigor beyond
  what's already built) that the confirmed success bar doesn't call for.
- Single tenant is permanent, not provisional: don't hedge designs or schema
  choices for a multi-org future that was explicitly ruled out.
- Mobile clock-in is the primary moment; the admin console is a secondary,
  more desktop-tolerant surface.

## Accessibility & Inclusion

No product-specific requirement beyond standard practice (contrast, ARIA,
keyboard operability) — confirmed no special accessibility mandate exists
today.
