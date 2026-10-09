-- The account-deletion write fence covers three more user-owned tables
-- (2026-10-10, build 126, package 126-19, live drift finding C11).
--
-- Not pushed with this commit: it goes in the 126 release push.
--
-- Why
-- ───
-- 20260806120000_account_deletion_durability.sql put
-- account_deletion_write_fence on every table that then had a foreign key to
-- auth.users, so an account mid-deletion (tombstoned in account_deletion_jobs)
-- cannot gain new rows. Tables made later each had to add the fence
-- themselves; five did not. The read-only drift scan of 2026-10-10 found them
-- unfenced on live: ais_watch, log_passage_memberships, vessel_telemetry,
-- guardian_alert_recipients and founding_skipper_reviewers. So, for example,
-- the telemetry relay could still write Pi telemetry for an owner being
-- deleted, after the scrub had removed it.
--
-- What
-- ────
-- The fence, as 20260806120000 installs it (BEFORE INSERT OR UPDATE,
-- block_tombstoned_account_write with the owner column), on:
--   ais_watch                (user_id)  the AIS contributor ledger, own row only
--   log_passage_memberships  (user_id)  passage display grouping, own rows only
--   vessel_telemetry         (owner_id) written by the telemetry relay for the owner
-- Each is written one owner's row at a time (record_ais_watch for the caller,
-- the app for its own rows, the telemetry relay per owner), so a fenced row
-- can only refuse that owner's own write. sweep_ais_watch only deletes, and
-- the fence does not fire on DELETE. Since 20261005160000 the fence fails
-- closed for the service role too, outside the deletion scrub itself.
--
-- Deliberately left out:
-- * guardian_alert_recipients: rows are written in the Guardian broadcast
--   fan-out loop, one per recipient; a fence there would abort the whole
--   broadcast because one recipient is mid-deletion.
-- * founding_skipper_reviewers: managed by admins, not by the sailor.
--
-- Undo
-- ────
-- DROP TRIGGER IF EXISTS account_deletion_write_fence ON each of the three.
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $fence$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT * FROM (VALUES ('ais_watch', 'user_id'), ('log_passage_memberships', 'user_id'), ('vessel_telemetry', 'owner_id')) AS t(tbl, owner_col)
    LOOP
        IF to_regclass(format('public.%I', target.tbl)) IS NULL THEN
            RAISE EXCEPTION 'account_deletion_fence_coverage: public.% is missing', target.tbl;
        END IF;
        EXECUTE format('DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.%I', target.tbl);
        EXECUTE format('CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write(%L)', target.tbl, target.owner_col);
    END LOOP;
END;
$fence$;

DO $check$
BEGIN
    IF (
        SELECT count(*)
          FROM pg_trigger
         WHERE tgname = 'account_deletion_write_fence'
           AND NOT tgisinternal
           AND tgenabled <> 'D'
           AND tgrelid IN ('public.ais_watch'::regclass, 'public.log_passage_memberships'::regclass, 'public.vessel_telemetry'::regclass)
    ) <> 3 THEN
        RAISE EXCEPTION 'account_deletion_fence_coverage: a fence did not install';
    END IF;
END;
$check$;

RESET lock_timeout;
