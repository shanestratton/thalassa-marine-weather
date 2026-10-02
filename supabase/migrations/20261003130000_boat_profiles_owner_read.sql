-- boat_profiles becomes owner-only to read (Shane 2026-10-03: "yes fix the
-- privacy leak too").
--
-- The leak: boat_profiles_member_read (20260727120000) let every boat member
-- SELECT the boat's whole profile JSON over REST, and every accepted crew
-- member is a boat member through the bridge trigger. The JSON is the full
-- VesselProfile the settings store sends: the EPIRB hex ID (a credential AMSA
-- verifies against), both shore contacts (third parties' numbers), the
-- skipper's mobile and satellite phone, free-text safety notes and the crew
-- roster's ages. assert_valid_vessel_profile_input checks only name, type and
-- model, so all of it is stored. The repository is public, so the policy is
-- discoverable.
--
-- After this:
--   - the boat's owner (boats.owner_id = auth.uid(), via is_boat_owner) reads
--     the profile, as before, through boat_profiles_owner_read below AND the
--     unchanged boat_profiles_owner_manage (FOR ALL);
--   - crew read only the allow-list in public.get_crew_vessel_view
--     (20261003120000), a SECURITY DEFINER read that RLS does not narrow.
--
-- Readers audited 2026-10-03 (repository and live catalogue, read-only):
--   - No client, hook, component, edge function, Pi service, public page or
--     test reads boat_profiles over REST or realtime. The app reads profiles
--     only through the owner RPCs get_owned_vessel_fleet and friends.
--   - Every live function that reads boat_profiles is SECURITY DEFINER and
--     owner-scoped (_owned_vessel_fleet_rows, create_default_boat_profile,
--     create_owned_vessel_profile, patch_owned_vessel_profile,
--     project_selected_boat_to_vessel_identity, undo_vessel_release).
--   - No view reads it, and it is not in a realtime publication.
--   - The only boat_members role besides 'crew' is 'owner', and every 'owner'
--     row is the boats.owner_id, so there is no owner-equivalent member role
--     to keep.
--   - Service-role readers bypass RLS and are unaffected.
--
-- Order matters, so the skipper never loses his own read, whether this is
-- pushed after 20261003120000 or on its own:
--   1. the owner read policy is created FIRST (CREATE POLICY itself fails if
--      is_boat_owner is missing, before anything is dropped);
--   2. only then is the member read dropped;
--   3. the guard refuses to finish unless an owner read remains and no other
--      SELECT/ALL policy can read the table.
-- Crew are not broken by B alone either: no client reads the raw row, and
-- until 20261003120000 is pushed the app's crewing view reads vessel_identity
-- and boat_members, never boat_profiles.
--
-- Written, NOT pushed: Shane says "yes, push it" first.

DROP POLICY IF EXISTS boat_profiles_owner_read ON public.boat_profiles;
CREATE POLICY boat_profiles_owner_read
    ON public.boat_profiles FOR SELECT TO authenticated
    USING (public.is_boat_owner(boat_id));

DROP POLICY IF EXISTS boat_profiles_member_read ON public.boat_profiles;

COMMENT ON POLICY boat_profiles_owner_read ON public.boat_profiles IS
    'Only the boat''s owner reads its profile (2026-10-03). Crew read the allow-list through get_crew_vessel_view.';

DO $$
BEGIN
    IF to_regprocedure('public.is_boat_owner(uuid)') IS NULL THEN
        RAISE EXCEPTION 'public.is_boat_owner(uuid) is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies AS policy
         WHERE policy.schemaname = 'public'
           AND policy.tablename = 'boat_profiles'
           AND policy.cmd IN ('SELECT', 'ALL')
           AND policy.qual ~ '^(public\.)?is_boat_owner\(boat_id\)$'
    ) THEN
        RAISE EXCEPTION 'boat_profiles has no owner read policy; refusing to leave the skipper without his profile';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies AS policy
         WHERE policy.schemaname = 'public'
           AND policy.tablename = 'boat_profiles'
           AND policy.cmd IN ('SELECT', 'ALL')
           AND COALESCE(policy.qual, '') !~ '^(public\.)?is_boat_owner\(boat_id\)$'
    ) THEN
        RAISE EXCEPTION 'boat_profiles still has a read policy other than the owner''s';
    END IF;
END;
$$;
