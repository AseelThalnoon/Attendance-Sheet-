-- Policies that call auth.uid() bare are re-evaluated for every row they
-- filter; inside a scalar subquery Postgres evaluates it once per statement.
-- Same rule, same result: only the plan changes. (Supabase performance
-- advisor 0003_auth_rls_initplan, flagged 2026-11-08.)
ALTER POLICY push_subscriptions_own ON public.push_subscriptions
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY notification_reads_own_select ON public.notification_reads
  USING (user_id = (select auth.uid()));
ALTER POLICY notification_reads_own_insert ON public.notification_reads
  WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY notification_reads_own_delete ON public.notification_reads
  USING (user_id = (select auth.uid()));
ALTER POLICY announcement_hides_own_select ON public.announcement_hides
  USING (user_id = (select auth.uid()));

-- Foreign keys with no index on the referencing column: deleting the
-- referenced row (a user, a notification) has to scan the whole referencing
-- table to find what cascades. (Advisor 0001_unindexed_foreign_keys.)
-- app_settings_updated_by_idx, which the advisor lists as unused, is the
-- index behind app_settings.updated_by's foreign key, so it stays.
CREATE INDEX IF NOT EXISTS client_errors_user_idx ON public.client_errors (user_id);
CREATE INDEX IF NOT EXISTS notification_reads_notification_idx ON public.notification_reads (notification_id);
CREATE INDEX IF NOT EXISTS push_deliveries_user_idx ON public.push_deliveries (user_id);
CREATE INDEX IF NOT EXISTS push_notifications_created_by_idx ON public.push_notifications (created_by);
