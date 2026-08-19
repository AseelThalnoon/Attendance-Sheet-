-- ===========================================================================
-- Third org-wide theme: 'velocity'.
--
-- A full visual redesign (dark carbon surfaces, 3D motion, a marketing-style
-- hero) rather than a variation on the ledger identity. Deliberately does not
-- follow DESIGN.md — it is an alternative world an admin can opt into, and
-- 'ledger' remains the default that DESIGN.md documents.
--
-- Extending the CHECK is the intended way to add a theme: the database stays
-- the authority on what is a valid value, so a client can never persist a
-- theme the server hasn't agreed to.
-- ===========================================================================

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_theme_check;

ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_theme_check
  CHECK (theme IN ('ledger', 'kinetic', 'velocity'));
