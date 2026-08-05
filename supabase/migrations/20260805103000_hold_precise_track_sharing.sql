-- Hold precise voyage-track sharing for the public beta.
--
-- Both legacy tables contain complete recorded geometry. Neither schema has
-- an explicit audience or consent contract, so a row must be visible only to
-- its owner until the feature is redesigned. Service-role account deletion
-- remains able to clean up rows because it bypasses RLS deliberately.

BEGIN;

ALTER TABLE public.shared_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_tracks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view shared tracks" ON public.shared_tracks;
DROP POLICY IF EXISTS "Users can insert own tracks" ON public.shared_tracks;
DROP POLICY IF EXISTS "Users can delete own tracks" ON public.shared_tracks;
DROP POLICY IF EXISTS "Users can update own tracks" ON public.shared_tracks;
DROP POLICY IF EXISTS "shared_tracks_owner_select" ON public.shared_tracks;
DROP POLICY IF EXISTS "shared_tracks_owner_insert" ON public.shared_tracks;
DROP POLICY IF EXISTS "shared_tracks_owner_update" ON public.shared_tracks;
DROP POLICY IF EXISTS "shared_tracks_owner_delete" ON public.shared_tracks;

CREATE POLICY "shared_tracks_owner_select"
    ON public.shared_tracks
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "shared_tracks_owner_insert"
    ON public.shared_tracks
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "shared_tracks_owner_update"
    ON public.shared_tracks
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "shared_tracks_owner_delete"
    ON public.shared_tracks
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

ALTER TABLE public.community_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_tracks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read community tracks" ON public.community_tracks;
DROP POLICY IF EXISTS "Users can insert their own tracks" ON public.community_tracks;
DROP POLICY IF EXISTS "Users can update their own tracks" ON public.community_tracks;
DROP POLICY IF EXISTS "Users can delete their own tracks" ON public.community_tracks;
DROP POLICY IF EXISTS "community_tracks_owner_select" ON public.community_tracks;
DROP POLICY IF EXISTS "community_tracks_owner_insert" ON public.community_tracks;
DROP POLICY IF EXISTS "community_tracks_owner_update" ON public.community_tracks;
DROP POLICY IF EXISTS "community_tracks_owner_delete" ON public.community_tracks;

CREATE POLICY "community_tracks_owner_select"
    ON public.community_tracks
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "community_tracks_owner_insert"
    ON public.community_tracks
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "community_tracks_owner_update"
    ON public.community_tracks
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "community_tracks_owner_delete"
    ON public.community_tracks
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- Make table reachability explicit: anonymous clients have no privilege and
-- authenticated clients can perform only row-level owner operations.
REVOKE ALL PRIVILEGES ON TABLE public.shared_tracks FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.community_tracks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shared_tracks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.community_tracks TO authenticated;

-- This SECURITY DEFINER counter bypasses RLS and is only useful for public
-- downloads. Remove every client grant while downloads are held.
REVOKE ALL ON FUNCTION public.increment_download_count(UUID) FROM PUBLIC, anon, authenticated;

COMMIT;
