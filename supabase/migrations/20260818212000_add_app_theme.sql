-- ===========================================================================
-- Org-wide UI theme, chosen by an administrator in the Admin console.
--
-- This is NOT the per-user light/dark preference — that stays in each
-- browser's localStorage and is nobody else's business. This column is the
-- organisation's visual style, so it belongs with the other app-wide
-- settings (announcement, registration toggle) that one admin sets for
-- everyone.
--
-- 'ledger' is the default and is the design system documented in DESIGN.md:
-- no scroll-driven motion, everything renders resolved. 'kinetic' adds the
-- scroll-driven reveal. New themes need this CHECK extended -- deliberate,
-- matching how profiles.role and entries.type are constrained, so the
-- database stays the authority on what is a valid value rather than
-- trusting whatever the client sends.
--
-- Additive and reversible: existing rows take the default, and no other
-- column or policy is touched. The existing RLS already does the right
-- thing here -- app_settings_select_auth lets every signed-in user READ
-- the theme (they have to, it styles their page), while
-- app_settings_update_admin keeps WRITING it admin-only.
-- ===========================================================================

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'ledger';

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_theme_check;

ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_theme_check
  CHECK (theme IN ('ledger', 'kinetic'));
