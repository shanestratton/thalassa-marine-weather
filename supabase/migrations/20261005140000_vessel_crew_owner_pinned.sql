-- A crew membership cannot be moved to another skipper, and nobody is their
-- own crew (found by the Sightings review, 2026-10-05).
--
-- The hole, live today (read from pg_policies and the trigger bodies, not
-- exercised): any signed-in account could make itself ACCEPTED crew of any
-- skipper whose user id it knew.
--   1. INSERT a vessel_crew row with owner_id = me AND crew_user_id = me.
--      'Owners can manage their crew' (owner_id = auth.uid()) allows it, and
--      guard_vessel_crew_acceptance returns early because the actor is the
--      crew member.
--   2. PATCH that row's owner_id to the victim, status 'accepted'. The
--      UPDATE's WITH CHECKs are OR'd across the permissive policies, and
--      'Crew can update own membership' (crew_user_id = auth.uid() AND status
--      IN ('accepted', 'declined')) admits the moved row. The member-update
--      guard only looked at callers who were the crew member and NOT the
--      owner, which a self-row is not; nothing pinned owner_id.
-- The attacker was then accepted crew of the victim's boat: every
-- crew-gated read (shared registers, the instrument panel, crew float plan
-- details, and the Sightings crew feed with exact positions), and the sync
-- trigger put them in the victim's boat_members.
--
-- The fix, two independent locks:
--   - CHECK (owner_id <> crew_user_id): a self-membership cannot exist. The
--     app never writes one (CrewService refuses "You can't invite yourself!",
--     redeem_manifest_invite refuses your own code). Live 2026-10-05: 0 such
--     rows of 1, so the check validates at once.
--   - guard_vessel_crew_member_update: for any caller with a JWT, a
--     membership keeps its skipper and its crew member. To move one, remove
--     it and invite again. Server writes with no JWT (auth.uid() NULL) pass,
--     as before. The app never changes either column (CrewService updates
--     status, role, registers and permissions only).
--   The rest of the guard is the live body (pg_get_functiondef on
--   2026-10-05, md5 8715255e..., == 20260723100000), unchanged, with the
--   search_path pinned as later guards pin it.
--
-- The trigger itself (trg_guard_vessel_crew_member_update, BEFORE UPDATE)
-- is unchanged and not re-created, so this takes no trigger lock.
--
-- Written, NOT pushed: Shane says "yes, push it" first. It goes up with, and
-- before, 20261005150000_sightings.sql, whose crew feed trusts vessel_crew.
-- Safe to re-run (DROP CONSTRAINT IF EXISTS, CREATE OR REPLACE). No BEGIN or
-- COMMIT: the pre-push replay runs this file inside a rolled-back transaction.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.vessel_crew DROP CONSTRAINT IF EXISTS vessel_crew_not_self;
ALTER TABLE public.vessel_crew
    ADD CONSTRAINT vessel_crew_not_self CHECK (owner_id <> crew_user_id);

CREATE OR REPLACE FUNCTION public.guard_vessel_crew_member_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- Nobody with a JWT moves a membership to another skipper or person.
    IF auth.uid() IS NOT NULL
       AND (
            NEW.owner_id IS DISTINCT FROM OLD.owner_id
            OR NEW.crew_user_id IS DISTINCT FROM OLD.crew_user_id
       ) THEN
        RAISE EXCEPTION 'A crew membership keeps its skipper and crew member: remove it and invite again';
    END IF;

    -- Captains manage their own rows. Crew may only answer a pending invite;
    -- they cannot promote themselves or alter permissions/ownership.
    IF auth.uid() = OLD.crew_user_id AND auth.uid() <> OLD.owner_id THEN
        IF OLD.status <> 'pending'
           OR NEW.status NOT IN ('accepted', 'declined')
           OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
           OR NEW.crew_user_id IS DISTINCT FROM OLD.crew_user_id
           OR NEW.crew_email IS DISTINCT FROM OLD.crew_email
           OR NEW.owner_email IS DISTINCT FROM OLD.owner_email
           OR NEW.shared_registers IS DISTINCT FROM OLD.shared_registers
           OR NEW.permissions IS DISTINCT FROM OLD.permissions
           OR NEW.role IS DISTINCT FROM OLD.role
           OR NEW.voyage_id IS DISTINCT FROM OLD.voyage_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'Crew members may only accept or decline a pending invite';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_vessel_crew_member_update() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_vessel_crew_member_update() IS
    'BEFORE UPDATE on vessel_crew: a JWT caller never changes owner_id or crew_user_id (2026-10-05); crew may only accept or decline a pending invite (20260723100000).';
