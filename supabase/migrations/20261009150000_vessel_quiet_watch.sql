-- The 'boat went quiet' watchdog (2026-10-09, build 125, plan 125-11 item 3).
--
-- What it does: when a skipper has opted in, and the boat's Pi has sent no
-- telemetry for 15 minutes, ONE push goes to the skipper (the owner of the
-- vessel_telemetry row) and to nobody else. Then nothing more until the Pi
-- reports again; that recovery re-arms the watch. Crew paging, the all-clear
-- and the in-app switch come later (127-05).
--
-- Why a server watchdog: a Pi that has lost power or internet cannot report
-- its own silence, and the skipper's phone may be closed ashore. Same reason
-- as check_pi_anchor_watch_health (20260923170000).
--
-- Design:
--   - Opt-in per skipper, OFF by default. vessel_telemetry is one row per
--     skipper (the Pi on their boat), so the watch is keyed the same way.
--     Releasing the vessel deletes the telemetry row (20260908170000), and a
--     watch with no telemetry row never pages ('never_heard'): "went quiet"
--     needs a boat that was talking.
--   - Last heard = vessel_telemetry.updated_at, the server's receipt clock
--     (the relay stamps it on every upsert); reported_at, the Pi's own clock,
--     only if updated_at were ever missing.
--   - A declared weekly quiet window (weekday, local start and end, IANA zone)
--     for a known weekly outage such as a router's scheduled reboot. The window
--     is evaluated in the vessel's own zone, never a fixed one. It may cross
--     midnight (end earlier than start), and is at most 12 hours. Inside it
--     nothing pages; after it closes, the silence clock restarts from the
--     close, so a reboot that runs a few minutes long does not page either.
--   - The silence clock also never starts before the watch was switched on
--     (armed_at), so switching it on while the boat is already quiet gives
--     the full 15 minutes rather than an instant page.
--   - Paged state is stored (paged_at, paged_last_heard_at) under a row lock
--     in the same transaction as the queue insert, so the every-minute job
--     cannot page twice for one outage. Any newer telemetry clears it. After
--     a recovery the next page waits at least 60 minutes from the last one
--     (last_paged_at), so a flapping link cannot page every quarter hour.
--   - Delivery is the existing path only: a row in push_notification_queue,
--     drained by retry-pending-push into send-push, which looks up the
--     recipient's own push_device_tokens. Nothing here makes a network call.
--     'boat_quiet' is not a critical type in send-push: it arrives as an
--     ordinary alert with send-push's default 6 hour APNs expiry.
--   - A watch that fails is never silent. Each row runs in its own exception
--     block so one bad row cannot stop the others, and pg_cron would then
--     report 'succeeded' every minute. So the handler also stamps
--     last_error_at and last_error_sqlstate on the row (state code only, no
--     message text), where a read-only query can see a broken watchdog.
--
-- What "quiet" means: no telemetry arrived. That is the Pi losing power or
-- internet, and also the Pi still running but not sending: Signal K down or no
-- fresh bus data, the phone's satellite mode (the Pi's internet switch) on,
-- the pairing lost, or the relay refusing it. The push says "no updates", not
-- "power lost", for that reason. A planned shutdown (laying up, a long Pi
-- install) pages too: switch the watch off first.
--
-- Nothing is switched on for any vessel by this file. The cron job runs every
-- minute from the moment it is applied, over zero enabled rows.
--
-- Written, NOT pushed: Shane says yes first. Safe to re-run: IF NOT EXISTS,
-- CREATE OR REPLACE, DROP ... IF EXISTS before every trigger and policy. The
-- cron job is left alone when it is already exactly this job, left PAUSED
-- (with a NOTICE) when somebody paused it, and otherwise unscheduled before it
-- is scheduled. No BEGIN or COMMIT: the migration runner supplies the
-- transaction.

SET LOCAL lock_timeout = '5s';

-- ── 1. The opt-in, the window and the paged state ────────────────────────────

CREATE TABLE IF NOT EXISTS public.vessel_quiet_watch (
    owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    quiet_after_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (quiet_after_minutes BETWEEN 15 AND 720),
    -- 0 = Sunday ... 6 = Saturday, as EXTRACT(DOW) and cron count them.
    window_dow SMALLINT CHECK (window_dow BETWEEN 0 AND 6),
    window_start TIME,
    window_end TIME,
    window_tz TEXT CHECK (window_tz IS NULL OR char_length(window_tz) BETWEEN 1 AND 64),
    armed_at TIMESTAMPTZ,
    paged_at TIMESTAMPTZ,
    paged_last_heard_at TIMESTAMPTZ,
    last_paged_at TIMESTAMPTZ,
    last_error_at TIMESTAMPTZ,
    last_error_sqlstate TEXT CHECK (last_error_sqlstate IS NULL OR last_error_sqlstate ~ '^[0-9A-Z]{5}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vessel_quiet_watch_window_complete CHECK (
        (window_dow IS NULL AND window_start IS NULL AND window_end IS NULL AND window_tz IS NULL)
        OR (window_dow IS NOT NULL AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_tz IS NOT NULL)
    ),
    CONSTRAINT vessel_quiet_watch_window_length CHECK (
        window_start IS NULL
        OR window_end IS NULL
        OR (
            window_start <> window_end
            AND CASE
                WHEN window_end > window_start THEN window_end - window_start
                ELSE window_end - window_start + interval '24 hours'
            END <= interval '12 hours'
        )
    )
);

COMMENT ON TABLE public.vessel_quiet_watch IS
    'Boat went quiet watchdog: per-skipper opt-in (default off), weekly quiet window in the vessel''s IANA zone, and the paged state that keeps it to one push per outage. 2026-10-09.';
COMMENT ON COLUMN public.vessel_quiet_watch.window_dow IS '0 = Sunday ... 6 = Saturday, local to window_tz.';
COMMENT ON COLUMN public.vessel_quiet_watch.window_tz IS 'IANA zone name (pg_timezone_names), e.g. Europe/Paris.';
COMMENT ON COLUMN public.vessel_quiet_watch.paged_last_heard_at IS 'The last-heard time the open page is about; newer telemetry means recovered.';
COMMENT ON COLUMN public.vessel_quiet_watch.last_error_at IS 'When the watchdog last failed on this row (it then skipped it). NULL = never since switch-on.';
COMMENT ON COLUMN public.vessel_quiet_watch.last_error_sqlstate IS 'The SQLSTATE of that failure. Code only, never the message.';

ALTER TABLE public.vessel_quiet_watch ENABLE ROW LEVEL SECURITY;

-- The skipper may set the switch and the window. The armed and paged columns
-- belong to the watchdog: no client grant reaches them.
REVOKE ALL ON TABLE public.vessel_quiet_watch FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.vessel_quiet_watch TO authenticated;
GRANT INSERT (owner_id, enabled, quiet_after_minutes, window_dow, window_start, window_end, window_tz)
    ON TABLE public.vessel_quiet_watch TO authenticated;
GRANT UPDATE (enabled, quiet_after_minutes, window_dow, window_start, window_end, window_tz)
    ON TABLE public.vessel_quiet_watch TO authenticated;

DROP POLICY IF EXISTS vessel_quiet_watch_owner_reads ON public.vessel_quiet_watch;
CREATE POLICY vessel_quiet_watch_owner_reads
    ON public.vessel_quiet_watch FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

DROP POLICY IF EXISTS vessel_quiet_watch_owner_inserts ON public.vessel_quiet_watch;
CREATE POLICY vessel_quiet_watch_owner_inserts
    ON public.vessel_quiet_watch FOR INSERT TO authenticated
    WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS vessel_quiet_watch_owner_updates ON public.vessel_quiet_watch;
CREATE POLICY vessel_quiet_watch_owner_updates
    ON public.vessel_quiet_watch FOR UPDATE TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS vessel_quiet_watch_owner_deletes ON public.vessel_quiet_watch;
CREATE POLICY vessel_quiet_watch_owner_deletes
    ON public.vessel_quiet_watch FOR DELETE TO authenticated
    USING (owner_id = auth.uid());

-- Switching on arms the clock and clears any old page and error; switching
-- off clears them too. The zone must be a real IANA name, checked once when
-- it changes, so the every-minute job never meets a zone it cannot read.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        RAISE EXCEPTION 'A quiet watch stays with its owner' USING ERRCODE = '42501';
    END IF;
    IF NEW.window_tz IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.window_tz IS DISTINCT FROM OLD.window_tz)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS zone WHERE zone.name = NEW.window_tz) THEN
        RAISE EXCEPTION 'Unknown time zone: use an IANA name such as Europe/Paris' USING ERRCODE = '22023';
    END IF;
    IF NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) THEN
        NEW.armed_at := now();
        NEW.paged_at := NULL;
        NEW.paged_last_heard_at := NULL;
        NEW.last_error_at := NULL;
        NEW.last_error_sqlstate := NULL;
    ELSIF NOT NEW.enabled THEN
        NEW.armed_at := NULL;
        NEW.paged_at := NULL;
        NEW.paged_last_heard_at := NULL;
        NEW.last_error_at := NULL;
        NEW.last_error_sqlstate := NULL;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vessel_quiet_watch_before_write ON public.vessel_quiet_watch;
CREATE TRIGGER vessel_quiet_watch_before_write
    BEFORE INSERT OR UPDATE ON public.vessel_quiet_watch
    FOR EACH ROW EXECUTE FUNCTION public.vessel_quiet_watch_before_write();

-- A deleted account's tombstone refuses new writes, as on every user-owned
-- table (20260806120000_account_deletion_durability.sql). Fires first (name order).
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.vessel_quiet_watch;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.vessel_quiet_watch
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

-- ── 2. The decision, as one pure expression ──────────────────────────────────
--
-- Kept apart from the job so it can be replayed read-only over synthetic rows
-- (the body is a single SELECT over its parameters). Verdicts:
--   off            the watch is switched off
--   never_heard    no telemetry row: nothing to go quiet
--   recovered      a page is open and the Pi has reported since: clear it
--   already_paged  a page is open and the Pi is still quiet: say nothing
--   in_window      inside the declared weekly quiet window: say nothing
--   within_grace   quiet for less than quiet_after_minutes, counted from the
--                  latest of last heard, switch-on and the last window close
--   cooldown       would page, but the last page was under 60 minutes ago
--   page           queue the one push
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_decision(
    p_now TIMESTAMPTZ,
    p_enabled BOOLEAN,
    p_armed_at TIMESTAMPTZ,
    p_last_heard_at TIMESTAMPTZ,
    p_paged_at TIMESTAMPTZ,
    p_paged_last_heard_at TIMESTAMPTZ,
    p_last_paged_at TIMESTAMPTZ,
    p_quiet_after_minutes INTEGER,
    p_window_dow INTEGER,
    p_window_start TIME,
    p_window_end TIME,
    p_window_tz TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    WITH clock AS (
        SELECT p_now AT TIME ZONE p_window_tz AS local_now
        WHERE p_window_tz IS NOT NULL AND p_window_dow IS NOT NULL
          AND p_window_start IS NOT NULL AND p_window_end IS NOT NULL
    ),
    this_week AS (
        SELECT local_now,
               (local_now::date - ((EXTRACT(DOW FROM local_now)::int - p_window_dow + 7) % 7)) + p_window_start AS opens_local
        FROM clock
    ),
    latest_opening AS (
        SELECT local_now,
               CASE WHEN opens_local > local_now THEN opens_local - interval '7 days' ELSE opens_local END AS opened_local
        FROM this_week
    ),
    occurrence AS (
        SELECT local_now,
               opened_local + CASE
                   WHEN p_window_end > p_window_start THEN p_window_end - p_window_start
                   ELSE p_window_end - p_window_start + interval '24 hours'
               END AS closes_local
        FROM latest_opening
    ),
    verdict_input AS (
        SELECT
            COALESCE((SELECT local_now < closes_local FROM occurrence), false) AS in_window,
            (SELECT (CASE WHEN local_now < closes_local THEN closes_local - interval '7 days' ELSE closes_local END)
                    AT TIME ZONE p_window_tz
             FROM occurrence) AS last_window_closed
    )
    SELECT CASE
        WHEN NOT COALESCE(p_enabled, false) THEN 'off'
        WHEN p_last_heard_at IS NULL THEN 'never_heard'
        WHEN p_paged_at IS NOT NULL
             AND p_last_heard_at > COALESCE(p_paged_last_heard_at, '-infinity'::timestamptz) THEN 'recovered'
        WHEN p_paged_at IS NOT NULL THEN 'already_paged'
        WHEN verdict_input.in_window THEN 'in_window'
        WHEN p_now - GREATEST(p_last_heard_at, p_armed_at, verdict_input.last_window_closed)
             < make_interval(mins => COALESCE(p_quiet_after_minutes, 15)) THEN 'within_grace'
        WHEN p_last_paged_at > p_now - interval '60 minutes' THEN 'cooldown'
        ELSE 'page'
    END
    FROM verdict_input
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_decision(
    TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
    INTEGER, INTEGER, TIME, TIME, TEXT
) FROM PUBLIC, anon, authenticated;

-- ── 3. The watchdog ──────────────────────────────────────────────────────────
--
-- One row's failure (a tombstoned account, an unreadable zone) is logged,
-- stamped on that row (last_error_at, last_error_sqlstate) and skipped; it
-- never stops the other boats being watched. Its page and paged state roll
-- back together, so a failed page is retried the next minute.
CREATE OR REPLACE FUNCTION public.check_vessel_quiet_watch()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    watch RECORD;
    verdict TEXT;
    quiet_minutes INTEGER;
    quiet_text TEXT;
    failed_state TEXT;
BEGIN
    FOR watch IN
        SELECT q.owner_id, q.enabled, q.armed_at, q.paged_at, q.paged_last_heard_at, q.last_paged_at,
               q.quiet_after_minutes, q.window_dow, q.window_start, q.window_end, q.window_tz,
               COALESCE(t.updated_at, t.reported_at) AS last_heard_at
        FROM public.vessel_quiet_watch AS q
        LEFT JOIN public.vessel_telemetry AS t ON t.owner_id = q.owner_id
        WHERE q.enabled
          AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = q.owner_id)
        FOR UPDATE OF q SKIP LOCKED
    LOOP
        BEGIN
            verdict := public.vessel_quiet_watch_decision(
                now(), watch.enabled, watch.armed_at, watch.last_heard_at,
                watch.paged_at, watch.paged_last_heard_at, watch.last_paged_at,
                watch.quiet_after_minutes, watch.window_dow, watch.window_start, watch.window_end, watch.window_tz
            );

            IF verdict = 'recovered' THEN
                UPDATE public.vessel_quiet_watch
                SET paged_at = NULL, paged_last_heard_at = NULL
                WHERE owner_id = watch.owner_id;
            ELSIF verdict = 'page' THEN
                quiet_minutes := GREATEST(1, floor(EXTRACT(EPOCH FROM now() - watch.last_heard_at) / 60))::int;
                quiet_text := CASE
                    WHEN quiet_minutes < 120 THEN quiet_minutes || ' minutes'
                    ELSE (quiet_minutes / 60) || ' hours'
                END;

                UPDATE public.vessel_quiet_watch
                SET paged_at = now(), paged_last_heard_at = watch.last_heard_at, last_paged_at = now()
                WHERE owner_id = watch.owner_id;

                -- The owner, and only the owner: recipient is the row's own key.
                INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
                VALUES (
                    watch.owner_id,
                    'boat_quiet',
                    'Your boat has gone quiet',
                    'Thalassa has had no updates from your boat for ' || quiet_text
                        || '. Its Pi may be off, offline or not reading the boat. No more alerts until it reports again.',
                    jsonb_build_object(
                        'kind', 'boat_quiet',
                        'last_heard_at', watch.last_heard_at,
                        'quiet_minutes', quiet_minutes
                    )
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            failed_state := SQLSTATE;
            RAISE WARNING 'check_vessel_quiet_watch skipped one watch (SQLSTATE %)', failed_state;
            BEGIN
                UPDATE public.vessel_quiet_watch
                SET last_error_at = now(), last_error_sqlstate = failed_state
                WHERE owner_id = watch.owner_id;
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'check_vessel_quiet_watch could not record that failure (SQLSTATE %)', SQLSTATE;
            END;
        END;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.check_vessel_quiet_watch() FROM PUBLIC, anon, authenticated;

-- ── 4. Every minute ──────────────────────────────────────────────────────────
--
-- The same guard as 20261009075000_shore_watch_health_cron: exactly this job
-- and active is left alone (job id and history kept); a PAUSED job stays
-- paused, because somebody paused it on purpose and a re-run (say after a
-- history repair) must not resume it behind their back; anything else of this
-- name is unscheduled and the job scheduled afresh. No other job is touched.
-- Without pg_cron (a bare local database) nothing is scheduled.

DO $schedule$
DECLARE
    job_name CONSTANT TEXT := 'vessel-quiet-watch';
    want_schedule CONSTANT TEXT := '* * * * *';
    want_command CONSTANT TEXT := 'SELECT public.check_vessel_quiet_watch()';
    total INTEGER;
    paused INTEGER;
    exact INTEGER;
    existing RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RETURN;
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE NOT active),
           count(*) FILTER (WHERE active
               AND schedule = want_schedule
               AND regexp_replace(btrim(command), '\s+', ' ', 'g') = want_command)
      INTO total, paused, exact
      FROM cron.job
     WHERE jobname = job_name;

    IF paused > 0 THEN
        RAISE NOTICE '% is paused; left paused. Resuming it is a deliberate step, not a migration.', job_name;
        RETURN;
    END IF;

    IF total = 1 AND exact = 1 THEN
        RETURN;
    END IF;

    FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job_name LOOP
        PERFORM cron.unschedule(existing.jobid);
    END LOOP;

    PERFORM cron.schedule(job_name, want_schedule, want_command);
END;
$schedule$;
