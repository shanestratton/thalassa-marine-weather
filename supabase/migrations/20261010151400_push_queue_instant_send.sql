-- Pushes go out the moment they are queued (2026-10-10, build 126, package
-- 126-19, live drift finding B-04 = C4).
--
-- Approved by Shane, 2026-10-10 ~06:05, verbatim: "1 - yes, 2 - yes"
-- (1 = turn the background weather alerts back on, 20261010151900;
--  2 = send pushes instantly, this file).
--
-- Not pushed with this commit: it goes in the 126 release push, after
-- 20261010151300.
--
-- Why
-- ───
-- 20260306_push_queue_trigger.sql declared an AFTER INSERT trigger
-- (on_push_queue_insert → notify_push_queue) that posted each new
-- push_notification_queue row straight to send-push. Live records it as
-- applied, but neither the trigger nor the function exists there (read-only
-- drift scan, 2026-10-10): the only trigger on the table is
-- account_deletion_write_fence. So every push, SOS, anchor drag, Guardian and
-- DM included, waits for the once-a-minute retry-pending-push drain. Measured
-- over 30 days: queue to send p50 36 s, p90 53 s, max 61 s.
--
-- What
-- ────
-- * A precheck: invoke_edge_function(text, integer, jsonb) (20260813060000,
--   the one vault credential path) and claim_push_notification(uuid) must
--   exist, or the file stops before changing anything.
-- * The 2026-03-06 trigger and function are dropped if present, so a database
--   rebuilt from the migrations matches live. (That function posted the whole
--   row and had no pinned search_path.)
-- * push_queue_send_now(): an AFTER INSERT trigger, only for rows not yet
--   sent, that posts {"record": {"id": <row id>}} to send-push through
--   invoke_edge_function, with a 30 s timeout. Only the id leaves the
--   database; send-push reads the row itself. pg_net sends the request after
--   the inserting transaction commits, so send-push always finds the row, and
--   a rolled-back insert sends nothing.
-- * Any failure (vault secret missing, pg_net down) is swallowed with a
--   WARNING: an insert never fails because of this, and the row waits for the
--   minute drain exactly as today.
-- * No double sends: send-push claims every row through
--   claim_push_notification (sent_at IS NULL and no claim in the last 5 min)
--   before it sends, so when the instant call and the minute drain race for a
--   row, one of them gets 409 and sends nothing.
-- * retry-pending-push stays as it is, as the fallback; the self-check proves
--   it is still active. No cron job is changed.
-- Behaviour note: a Guardian broadcast to N sailors now makes N send-push
-- calls at once, instead of the drain taking 50 a minute.
--
-- Undo
-- ────
--     DROP TRIGGER IF EXISTS push_queue_send_now ON public.push_notification_queue;
-- (pushes go back to waiting for the minute drain).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs the DDL twice to prove a re-run is a no-op. A rehearsal must never
-- insert into push_notification_queue: the trigger would queue a real call.
-- lock_timeout is set for the session and reset at the end.

SET lock_timeout = '5s';

DO $precheck$
BEGIN
    IF to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'push_queue_instant_send: invoke_edge_function(text, integer, jsonb) is missing';
    END IF;
    IF to_regprocedure('public.claim_push_notification(uuid)') IS NULL THEN
        RAISE EXCEPTION 'push_queue_instant_send: claim_push_notification(uuid) is missing; a double post could double-send';
    END IF;
END;
$precheck$;

DROP TRIGGER IF EXISTS on_push_queue_insert ON public.push_notification_queue;
DROP FUNCTION IF EXISTS public.notify_push_queue();

CREATE OR REPLACE FUNCTION public.push_queue_send_now()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    BEGIN
        PERFORM public.invoke_edge_function('send-push', 30000, jsonb_build_object('record', jsonb_build_object('id', NEW.id)));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'push_queue_send_now: % (the minute drain will send it)', SQLERRM;
    END;
    RETURN NULL;
END;
$$;

-- A trigger body only: nobody calls it directly.
REVOKE ALL ON FUNCTION public.push_queue_send_now() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS push_queue_send_now ON public.push_notification_queue;
CREATE TRIGGER push_queue_send_now
    AFTER INSERT ON public.push_notification_queue
    FOR EACH ROW
    WHEN (NEW.sent_at IS NULL)
    EXECUTE FUNCTION public.push_queue_send_now();

DO $check$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.push_notification_queue'::regclass
           AND tgname = 'on_push_queue_insert'
    ) THEN
        RAISE EXCEPTION 'push_queue_instant_send: the 2026-03-06 trigger is still present';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.push_notification_queue'::regclass
           AND tgname = 'push_queue_send_now' AND NOT tgisinternal AND tgenabled <> 'D'
           AND tgfoid = 'public.push_queue_send_now()'::regprocedure
    ) THEN
        RAISE EXCEPTION 'push_queue_instant_send: push_queue_send_now is missing or disabled';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-pending-push' AND active) THEN
        RAISE EXCEPTION 'push_queue_instant_send: retry-pending-push (the fallback) is not active';
    END IF;
END;
$check$;

RESET lock_timeout;
