-- Signed-out callers lose log_service (2026-10-10, build 126, package
-- 126-19, live drift finding C10).
--
-- Not pushed with this commit: it goes in the 126 release push.
--
-- Why
-- ───
-- log_service(uuid, integer, text, numeric) runs as its owner (it logs a
-- maintenance service and moves the task's next due date). The app calls it
-- signed in (MaintenanceService). 20260728150000_harden_pre_hardening_definers.sql
-- revoked the implicit PUBLIC grant and granted authenticated, but anon held
-- its own grant, which REVOKE ... FROM PUBLIC does not touch: the read-only
-- drift scan of 2026-10-10 found anon can still execute it. The body refuses
-- a caller with no auth.uid() (it only reads the caller's own task), so this
-- closes a door that was already locked.
--
-- What
-- ────
-- REVOKE EXECUTE from anon, when the function exists. authenticated keeps
-- its grant, and the self-check proves both.
--
-- Undo
-- ────
--     GRANT EXECUTE ON FUNCTION public.log_service(uuid, integer, text, numeric) TO anon;
-- (not wanted).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $revoke$
BEGIN
    IF to_regprocedure('public.log_service(uuid,integer,text,numeric)') IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION public.log_service(uuid, integer, text, numeric) FROM anon;
    END IF;
END;
$revoke$;

DO $check$
BEGIN
    IF to_regprocedure('public.log_service(uuid,integer,text,numeric)') IS NULL THEN
        RAISE NOTICE 'log_service_anon_revoke: no log_service in this database; nothing to revoke';
        RETURN;
    END IF;
    IF has_function_privilege('anon', 'public.log_service(uuid,integer,text,numeric)', 'EXECUTE') THEN
        RAISE EXCEPTION 'log_service_anon_revoke: anon can still execute log_service';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.log_service(uuid,integer,text,numeric)', 'EXECUTE') THEN
        RAISE EXCEPTION 'log_service_anon_revoke: authenticated lost log_service';
    END IF;
END;
$check$;

RESET lock_timeout;
