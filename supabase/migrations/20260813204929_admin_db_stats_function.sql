-- STATUS: APPLIED to the live project on 2026-08-13.
--
-- Reconstructed on 2026-08-20 from the live schema to fix "remote migration
-- version not found" on merge: this project's early schema changes were
-- applied directly via the Supabase MCP tools before any migration file was
-- committed to git, so the remote's tracked history (this exact version) had
-- no local file to match. The body below is pulled from the function as it
-- exists on the live database today, not the literal original text -- later
-- migrations in this folder are untouched and still apply their fixes on
-- top of it in the same order they always have.
--
-- is_admin() is the gate every admin-only RPC in this file (and every later
-- one) checks first, so it's created here alongside the very first one.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Admin System tab: DB size, table row counts, connection usage, Postgres
-- version. Nothing here is per-row data, so a single SECURITY DEFINER RPC
-- gated on is_admin() is simpler than exposing pg_stat_* via RLS.
CREATE OR REPLACE FUNCTION public.admin_db_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can view database statistics';
  END IF;

  SELECT jsonb_build_object(
    'db_size_bytes', pg_database_size(current_database()),
    'active_connections', (SELECT count(*) FROM pg_stat_activity),
    'max_connections', (SELECT setting::int FROM pg_settings WHERE name = 'max_connections'),
    'postgres_version', (SELECT current_setting('server_version')),
    'tables', (
      SELECT coalesce(jsonb_agg(t ORDER BY t->>'name'), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'name', c.relname,
          'total_bytes', pg_total_relation_size(c.oid),
          'rows', coalesce(s.n_live_tup, 0)
        ) AS t
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      ) sub
    ),
    'counts', jsonb_build_object(
      'profiles', (SELECT count(*) FROM public.profiles),
      'entries', (SELECT count(*) FROM public.entries),
      'admins', (SELECT count(*) FROM public.profiles WHERE role = 'admin')
    ),
    'generated_at', now()
  ) INTO result;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_db_stats() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_db_stats() TO authenticated;
