-- Restore public.user_name_parts (2026-10-02).
--
-- Field bug: a crew member tapping Accept on an invite got nothing. Replaying
-- the accept as the invitee (inside a rolled-back transaction) failed with
-- "function public.user_name_parts(uuid) does not exist". The bridge trigger
-- public.sync_vessel_crew_to_boat_members() (body from 20260908170000) calls
-- it to read the crew member's byline parts when an invite is accepted, so
-- every acceptance failed. 20260516150000 created it and the migration list
-- shows that migration applied, but the live database no longer had it: it
-- was removed outside the migrations. A live scan found no other function
-- calling a missing public helper.
--
-- Same body as 20260516150000, hardened like the other definers since
-- 20260728150000: a fixed search_path, and no direct callers. It reads
-- auth.users, so only the SECURITY DEFINER bridge trigger (owned by the same
-- role) may run it.
CREATE OR REPLACE FUNCTION public.user_name_parts(p_user_id UUID)
RETURNS TABLE(prefix TEXT, first_name TEXT, last_name TEXT, nickname TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    meta JSONB;
    email_local TEXT;
BEGIN
    SELECT u.raw_user_meta_data, split_part(u.email, '@', 1)
      INTO meta, email_local
      FROM auth.users AS u
     WHERE u.id = p_user_id;

    prefix     := NULLIF(meta->>'prefix', '');
    first_name := NULLIF(meta->>'first_name', '');
    last_name  := NULLIF(meta->>'last_name', '');
    nickname   := NULLIF(meta->>'nickname', '');

    -- Fallback for legacy / no-metadata users.
    IF first_name IS NULL THEN
        first_name := COALESCE(NULLIF(initcap(email_local), ''), 'Crew');
    END IF;

    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.user_name_parts(UUID) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.user_name_parts(UUID) IS
    'Byline parts for a user (auth metadata, email fallback). Called only by the vessel_crew -> boat_members bridge trigger; restored 2026-10-02 after it went missing outside the migrations and broke every crew-invite acceptance.';
