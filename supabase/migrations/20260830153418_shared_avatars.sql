-- Moves avatars from device-local localStorage to a shared Supabase Storage
-- bucket, so a photo is visible to teammates instead of only to the browser
-- that uploaded it. See DESIGN.md's Avatar section for the product rationale.
--
-- Storage path convention: one object per user at "<user_id>/avatar.jpg",
-- deterministic and overwritten on every re-upload (upsert:true from the
-- client) rather than versioned — there is exactly one current photo per
-- person, never a history to keep.
--
-- The bucket is PRIVATE. Every other authority boundary in this schema is
-- RLS, not a public URL, and a public bucket would be the one exception —
-- readable by anyone with the link, signed in or not. avatar_updated_at
-- doubles as "does this user have a photo" (NULL = no) and as a cache key:
-- the client keys its in-memory blob cache off it, so a replaced photo
-- invalidates without any explicit cache-clearing logic.

-- 1. The flag/cache-key column. Nullable: NULL means no photo, exactly the
--    state a fresh signup is in.
ALTER TABLE public.profiles
  ADD COLUMN avatar_updated_at timestamptz;

-- Reuses the existing profiles_update_own policy (id = auth.uid() OR
-- is_admin()) from migration 20260815012052 — only the grant is new. Own
-- photo only in practice: the client never calls this for another user's id,
-- and RLS would allow an admin to but the UI does not offer it, same as
-- full_name.
GRANT UPDATE (avatar_updated_at) ON public.profiles TO authenticated;

-- 2. The bucket. file_size_limit is generous relative to what the client
--    ever sends (images are downscaled to a 256px square before upload) —
--    it exists as a hard backstop, not the real limit.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 2097152, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- 3. Storage RLS. Read is any signed-in user, for any object in the bucket —
--    that is the whole point of the migration, a teammate's photo has to be
--    visible to the rest of the team. Write is owner-only, enforced by
--    requiring the object's path to start with the caller's own uid: the
--    same shape as profiles_update_own, expressed in storage's path-prefix
--    idiom rather than a row's id column.
CREATE POLICY avatars_read_authenticated ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'avatars');

CREATE POLICY avatars_write_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

CREATE POLICY avatars_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

CREATE POLICY avatars_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);
