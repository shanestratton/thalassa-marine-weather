-- An invitee's own name, phone and age go on their skipper's float plan
-- (Shane 2026-10-04: "the invitee needs to use the name and phone number and
-- age from the vessel profile in settings for the float plan, also the number
-- of pob's needs to include the invitee as well as the others on board").
--
-- The float plan is built on the SKIPPER'S phone (FloatPlanSheet), from his
-- vessel profile and his crew list. A crew member's own details live in
-- THEIR Settings (on their own profile they are the skipper: the Crew row
-- ranked Skipper, the first by default, for name and age; "Skipper mobile"),
-- which no other account can read: boat_profiles is owner-only since
-- 20261003130000, and settings are per device. So the crew member's app
-- writes them here, one row per person, and the skipper reads them.
--
-- Who sees a row:
--   - the person themselves (read, write, delete their own row only);
--   - a skipper they are ACCEPTED crew for (vessel_crew), read-only. Any
--     voyage scope counts, as the float plan's crew list counts it;
--   - nobody else. Other crew on the same boat never see each other's phones
--     or ages (get_crew_vessel_view gives them names and roles only), and
--     nothing here exposes the skipper's EPIRB, phones or contacts.
-- "Accepted" must mean the person said yes. Until now the skipper's own
-- policy ('Owners can manage their crew', FOR ALL) let him write status
-- 'accepted' himself: insert it for anyone whose id lookup_user_by_email
-- gave him, flip a pending or declined invite, or move an accepted row to
-- another account. That would have let any signed-in account read anyone's
-- shared details. So guard_vessel_crew_acceptance (below) lets only the
-- invited person make a membership accepted (their Accept, and redeeming a
-- crew code, which runs with their JWT); server writes with no JWT pass.
-- It also closes the same forgery into crew_profiles and boat_members.
-- A row can only be written while its owner is accepted crew somewhere, and
-- it is removed when their last accepted membership ends (left, removed, or
-- the skipper's account deleted), so a phone number does not outlive the
-- memberships it was shared for. A membership
-- scoped to a voyage that has finished still counts until the skipper
-- removes it or the person leaves: nothing ends those today, and limiting
-- the read to live voyages is a product call left for Shane. Deleting the
-- account removes the row (ON DELETE CASCADE), and a tombstoned account
-- cannot write it (account_deletion_write_fence).
--
-- Why not columns on vessel_crew: crew may update their own membership only
-- while it is pending ('Crew can update own membership'), and a person has
-- one row per boat and voyage; one row per person, shared with each of their
-- skippers, is what the app writes once.
--
-- Push approved by Shane 2026-10-05 ("yes push it, finish the float plan").
-- Safe to re-run: IF NOT EXISTS, CREATE OR REPLACE, and DROP ... IF EXISTS
-- before every trigger and policy. Live 2026-10-05: newest migration
-- 20261003140000; vessel_crew has exactly three triggers of its own
-- (account_deletion_write_fence and trg_guard_vessel_crew_member_update
-- BEFORE, trg_vessel_crew_to_boat_members AFTER), crew_user_id NOT NULL, and
-- status pending / accepted / declined; update_maintenance_tasks_updated_at()
-- and block_tombstoned_account_write() exist as used here. This adds two
-- triggers to vessel_crew (five in all).
--
-- DROP TRIGGER IF EXISTS takes an ACCESS EXCLUSIVE lock on vessel_crew even
-- when the trigger is absent, and every shared-register read goes through
-- vessel_crew: the lock wait is bounded, so a busy table fails the push
-- (retry it) instead of queueing the app behind it. No BEGIN or COMMIT here:
-- the pre-push replay runs this file inside a rolled-back transaction.
--
-- Before it is live the app is quiet: PGRST205 / 42P01 (and PGRST202 / 42883)
-- are "not pushed yet" on both sides (isNotPushedYet, services/crew/
-- floatPlanPeople.ts). The crew side remembers that for the session and stops
-- writing; the skipper's float plan reads once per open and keeps the names it
-- had. A skipper with no accepted crew never reads it at all.
--
-- Check it as each user in a rolled-back transaction, printing counts only,
-- before the push (the workflow's replay plan) and once after.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.crew_float_plan_details (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 1 AND 120),
    phone TEXT CHECK (phone IS NULL OR char_length(phone) BETWEEN 1 AND 40),
    age SMALLINT CHECK (age IS NULL OR age BETWEEN 1 AND 120),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT crew_float_plan_details_not_empty CHECK (full_name IS NOT NULL OR phone IS NOT NULL OR age IS NOT NULL)
);

ALTER TABLE public.crew_float_plan_details ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.crew_float_plan_details FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_float_plan_details TO authenticated;

COMMENT ON TABLE public.crew_float_plan_details IS
    'A crew member''s own name, phone and age for their skipper''s float plan (2026-10-04). Read by the person and by skippers they are accepted crew for; nobody else.';

DROP TRIGGER IF EXISTS trg_crew_float_plan_details_updated_at ON public.crew_float_plan_details;
CREATE TRIGGER trg_crew_float_plan_details_updated_at
    BEFORE UPDATE ON public.crew_float_plan_details
    FOR EACH ROW EXECUTE FUNCTION public.update_maintenance_tasks_updated_at();

-- A deleted account's tombstone refuses new writes, as on every user-owned
-- table (20260806120000_account_deletion_durability.sql).
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_float_plan_details;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_float_plan_details
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

-- The person: their own row only. Writing needs an accepted membership
-- (vessel_crew's own-row read, 'Crew can view own membership', answers it).
DROP POLICY IF EXISTS "Crew read own float plan details" ON public.crew_float_plan_details;
CREATE POLICY "Crew read own float plan details"
    ON public.crew_float_plan_details FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Crew share own float plan details" ON public.crew_float_plan_details;
CREATE POLICY "Crew share own float plan details"
    ON public.crew_float_plan_details FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.vessel_crew AS m
             WHERE m.crew_user_id = auth.uid() AND m.status = 'accepted'
        )
    );

DROP POLICY IF EXISTS "Crew update own float plan details" ON public.crew_float_plan_details;
CREATE POLICY "Crew update own float plan details"
    ON public.crew_float_plan_details FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.vessel_crew AS m
             WHERE m.crew_user_id = auth.uid() AND m.status = 'accepted'
        )
    );

DROP POLICY IF EXISTS "Crew delete own float plan details" ON public.crew_float_plan_details;
CREATE POLICY "Crew delete own float plan details"
    ON public.crew_float_plan_details FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- Only the invited person can make a membership accepted. The skipper keeps
-- everything else: inviting (pending), re-inviting after a decline, editing
-- an accepted member's role and registers, removing them. Server writes with
-- no JWT (auth.uid() NULL) pass. Invoker rights: it reads only the caller's
-- own JWT. Fires before the other guards in name order; either may refuse.
CREATE OR REPLACE FUNCTION public.guard_vessel_crew_acceptance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    actor UUID := auth.uid();
BEGIN
    IF actor IS NULL OR actor = NEW.crew_user_id OR NEW.status IS DISTINCT FROM 'accepted' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'Only the invited person can accept a crew invite' USING ERRCODE = '42501';
    END IF;
    IF OLD.status IS DISTINCT FROM 'accepted' OR OLD.crew_user_id IS DISTINCT FROM NEW.crew_user_id THEN
        RAISE EXCEPTION 'Only the invited person can accept a crew invite' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_vessel_crew_acceptance() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_vessel_crew_acceptance() IS
    'BEFORE INSERT OR UPDATE OF status, crew_user_id on vessel_crew: only the invited person (or a server write with no JWT) can make a membership accepted (2026-10-05).';

DROP TRIGGER IF EXISTS trg_guard_vessel_crew_acceptance ON public.vessel_crew;
CREATE TRIGGER trg_guard_vessel_crew_acceptance
    BEFORE INSERT OR UPDATE OF status, crew_user_id ON public.vessel_crew
    FOR EACH ROW EXECUTE FUNCTION public.guard_vessel_crew_acceptance();

-- The skipper: read-only, his accepted crew only ('Owners can manage their
-- crew' lets him read his own vessel_crew rows; the guard above means each
-- of those said yes themselves).
DROP POLICY IF EXISTS "Skippers read their crew's float plan details" ON public.crew_float_plan_details;
CREATE POLICY "Skippers read their crew's float plan details"
    ON public.crew_float_plan_details FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.vessel_crew AS m
             WHERE m.owner_id = auth.uid()
               AND m.crew_user_id = crew_float_plan_details.user_id
               AND m.status = 'accepted'
        )
    );

-- Removed when the person's last accepted membership ends. SECURITY DEFINER
-- because the actor may be the skipper removing them, who cannot delete
-- their row. Everything is inside one exception block, so nothing here can
-- fail or block a crew change (2026-10-02: one failing vessel_crew trigger
-- made every Accept do nothing); at worst it warns. An Accept (pending to
-- accepted) returns at the first test without touching anything.
CREATE OR REPLACE FUNCTION public.forget_crew_float_plan_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        IF OLD.crew_user_id IS NULL OR OLD.status IS DISTINCT FROM 'accepted' THEN
            RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.status = 'accepted' AND NEW.crew_user_id = OLD.crew_user_id THEN
                RETURN NULL;
            END IF;
        END IF;
        DELETE FROM public.crew_float_plan_details AS d
         WHERE d.user_id = OLD.crew_user_id
           AND NOT EXISTS (
               SELECT 1 FROM public.vessel_crew AS m
                WHERE m.crew_user_id = OLD.crew_user_id AND m.status = 'accepted'
           );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'forget_crew_float_plan_details: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forget_crew_float_plan_details() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.forget_crew_float_plan_details() IS
    'AFTER UPDATE OF status, crew_user_id OR DELETE on vessel_crew: drops a crew member''s float plan details when their last accepted membership ends. Never raises.';

DROP TRIGGER IF EXISTS trg_vessel_crew_forget_float_plan_details ON public.vessel_crew;
CREATE TRIGGER trg_vessel_crew_forget_float_plan_details
    AFTER UPDATE OF status, crew_user_id OR DELETE ON public.vessel_crew
    FOR EACH ROW EXECUTE FUNCTION public.forget_crew_float_plan_details();
