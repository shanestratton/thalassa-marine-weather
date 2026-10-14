-- An invitee's date of birth beside their age (2026-10-14, build 129, package
-- 129-14). Shane: "in the vessel profile, can we change punters age for date
-- of birth. Otherwise we will have to change the age every year. This only
-- shows up in the float plan."
--
-- HELD. Written with 129, NOT pushed: supabase db push applies every pending
-- file in supabase/migrations, and Shane pushes this one himself. Release it
-- by moving it into supabase/migrations under a stamp newer than the newest
-- applied migration and, in the same commit, rewriting
-- tests/CrewFloatPlanDetailsDateOfBirthMigration.test.ts to read the released
-- file (the b85cd258d vault-limits release), then push.
--
-- Until it runs the app works as 128 did: an invitee's phone tries the
-- column, and on PostgREST's PGRST204 (or Postgres's 42703) naming it writes
-- the age-only row instead; the skipper's float plan reads without it the
-- same way (services/crew/dateOfBirthColumn.ts). Both remember that for an
-- hour.
--
-- What
-- ────
-- * date_of_birth DATE, nullable: a calendar date, no time and no zone, so it
--   never moves with a reader's clock. Bounded to 1900-2100 against typing
--   slips (a CHECK cannot compare with today: it must be immutable). The
--   person's own phone writes it, from their Settings → Vessel Profile; the
--   skipper's float plan prints the age it gives on the departure day, never
--   the date.
-- * age stays: rows written before 129, and 128 phones, which write age only.
--   A 129 phone writes both (the age as of today), so a skipper still on 128
--   reads an age. A write names date_of_birth only when that phone has one or
--   has cleared one, and an upsert sets only the columns it names, so a 128
--   phone's age-only write never wipes a date of birth.
-- * crew_float_plan_details_not_empty takes the new column in, so a row may
--   hold a date of birth alone, as it may an age alone.
--
-- Who reads it: exactly age's readers. The table's policies are row-level
-- (the person's own row; a skipper they are ACCEPTED crew for, read-only;
-- nobody else) and its grant is table-wide (20261004120000), so this adds no
-- policy, grant or function. get_crew_vessel_view, the public page and the
-- crew's view of the boat never read this table.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before
-- the ADD. ALTER TABLE takes an ACCESS EXCLUSIVE lock on a table of one row
-- per crew member; the lock wait is bounded, so a busy table fails the push
-- (retry it) instead of queueing the app behind it. Re-adding the CHECK
-- validates the existing rows, which all hold name, phone or age. No BEGIN or
-- COMMIT here: the pre-push replay runs this file inside a rolled-back
-- transaction.
--
-- Check it after the push, as the crew user and as their skipper in a
-- rolled-back transaction, printing counts only: the person reads their own
-- date_of_birth, the skipper reads his accepted crew's, another crew member
-- on the same boat reads no row.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.crew_float_plan_details
    ADD COLUMN IF NOT EXISTS date_of_birth DATE
        CONSTRAINT crew_float_plan_details_date_of_birth_bounded
        CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND DATE '2100-12-31');

ALTER TABLE public.crew_float_plan_details DROP CONSTRAINT IF EXISTS crew_float_plan_details_not_empty;
ALTER TABLE public.crew_float_plan_details
    ADD CONSTRAINT crew_float_plan_details_not_empty
    CHECK (full_name IS NOT NULL OR phone IS NOT NULL OR age IS NOT NULL OR date_of_birth IS NOT NULL);

COMMENT ON COLUMN public.crew_float_plan_details.date_of_birth IS
    'The person''s date of birth, a calendar date (2026-10-14, 129-14). Read as age is: by the person and by skippers they are accepted crew for. The float plan prints the age it gives on the departure day, never the date.';
