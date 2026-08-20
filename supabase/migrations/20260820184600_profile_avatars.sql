-- ===========================================================================
-- Profile photos.
--
-- The Atrium redesign puts people's faces in the interface: a portrait on the
-- person hero card, avatars in the Team roster, the admin People list, and the
-- rail's user chip. Until now the only avatar in the app was two initials on a
-- flat tile, and profiles had nowhere to store an image.
--
-- This is the project's FIRST Supabase Storage bucket, so it sets up the
-- bucket and its object-level policies from scratch rather than following an
-- existing pattern.
--
-- Authorisation shape matches the rest of the app: you may write your own,
-- an admin may write anyone's, and public.is_admin() is the gate — the same
-- `id = auth.uid() OR public.is_admin()` predicate profiles_update_own uses.
-- The UI hides controls you cannot use, but the database is what enforces it.
--
-- Path convention: avatars/<user-id>/<filename>. The owning user id is the
-- first path segment, which is what the policies below check with
-- (storage.foldername(name))[1]. Keeping the id in the path (rather than
-- trusting storage.objects.owner) means an admin can upload on someone else's
-- behalf and the object still belongs, by path, to the person it depicts.
-- ===========================================================================

-- 1. The column. Stores a path/URL string, not the image itself.
alter table public.profiles add column if not exists avatar_url text;

-- 2. Make it writable through the API. The 2026-08-15 privilege-escalation fix
--    revoked blanket UPDATE on profiles and re-granted exactly one column
--    (full_name), so without this line the new column is readable but every
--    write silently fails the column grant. Re-granting names BOTH columns:
--    a column-level GRANT is not additive across statements in a way that
--    would keep full_name if it were omitted here.
grant update (full_name, avatar_url) on public.profiles to authenticated;

-- guard_profile_columns() still pins id/email and guards role on every UPDATE;
-- avatar_url is deliberately not pinned, since it is meant to be writable.

-- 3. The bucket. Public read: avatars are shown throughout the signed-in UI,
--    and a public bucket keeps rendering to a plain <img src> with no signed
--    URL to refresh. Nothing sensitive lives here — but note that means an
--    avatar URL is guessable-by-path and readable without auth, which is the
--    accepted trade for this internal, small-team tool.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true, 2097152,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 4. Object policies. storage.objects has RLS enabled by default in Supabase.
drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select to public
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert_own_or_admin on storage.objects;
create policy avatars_insert_own_or_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_admin()
    )
  );

drop policy if exists avatars_update_own_or_admin on storage.objects;
create policy avatars_update_own_or_admin on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_admin()
    )
  )
  with check (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_admin()
    )
  );

drop policy if exists avatars_delete_own_or_admin on storage.objects;
create policy avatars_delete_own_or_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_admin()
    )
  );
