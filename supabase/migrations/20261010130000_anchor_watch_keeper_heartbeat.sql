-- Shore Watch: the crew are told when the boat's phone goes quiet, and a watch
-- can run for a week (2026-10-10, build 126, plan 126-03b).
--
-- What it does
-- ────────────
-- 1. The phone keeping an anchor watch checks in. While its watch is armed
--    and shared, the boat's phone calls record_anchor_watch_heartbeat about
--    once a minute ('watching'), and once more when the watch stands down
--    ('ended': anchor weighed, or the watch handed to the Pi).
-- 2. A server watchdog for a phone-kept watch. Until now only a Pi-kept watch
--    had one (check_pi_anchor_watch_health, job 'shore-watch-health'). A
--    phone-kept watch broadcast straight over Realtime and the server saw
--    nothing, so a locked shore phone heard nothing when the boat's phone
--    died. check_anchor_phone_watch_health pages every Shore Watch phone once
--    per outage, after 5 minutes without a check-in, as the EXISTING
--    'contact_lost' kind with watchkeeper = 'phone'. No new alarm kind: every
--    shipped app (125 and older) reads an unknown kind as a DRAG.
-- 3. A watch lives while its keeper is alive. A phone check-in or a Pi
--    heartbeat rolls the session's expiry to now() + 23 hours (never
--    backwards, never reviving an expired one). 23, not 24: an installed Pi
--    refuses any session ending more than 24 h after its own clock, so the
--    hour is room for clock skew. The Pi's lease cap goes from 48 hours to
--    7 days after the skipper's phone last authorised it, and the "ends soon"
--    warning moves to 12 hours before that cap. The skipper's phone
--    re-authorises on its own every hour and whenever Thalassa comes to the
--    front, so a Pi watch runs as long as that phone opens Thalassa at least
--    once a week.
-- 4. The vessel phone's own drag inserts are marked watchkeeper = 'phone', so
--    send-anchor-alarm judges them on time alone and no longer against a
--    silent Pi binding left behind by a refused hand-off (where a drag push
--    was resolved as "recovered" and never sent).
-- 5. The code and the membership are bounded on their own, now that the
--    24-hour session cap no longer bounds them: a session code admits
--    newcomers only in a watch's first 24 hours (the owner and existing
--    members may always rejoin), and Leave gives a crew member's membership
--    up (leave_anchor_watch_session).
--
-- Behaviour, by state
-- ───────────────────
-- * A phone keeping a shared watch: the session's vessel_state is 'watching'
--   and vessel_heartbeat_at is at most a minute old (written at most every
--   20 s). The minute job pages once when the beat is more than 5 minutes
--   old: one anchor_alarm_events row (contact_lost, watchkeeper 'phone'),
--   delivered by the existing notify_anchor_alarm trigger and retried for an
--   hour by retry-pending-anchor-alarm. The next beat clears the flag and
--   resolves that event, so a later outage pages again. No repeat reminders
--   for a phone outage in this build: the incident machinery is keyed on Pi
--   relays.
-- * Weighed anchor, or the watch handed to the Pi: 'ended'. The job ignores
--   the session. If 'ended' never arrived (no signal while weighing), the
--   phone retries it on its next activity. A hand-off also makes the skipper
--   a 'shore' member, and the job pages only while the owner is still the
--   session's 'vessel' member, so a hand-off never pages even then.
-- * A watch blocked on the phone (paused) sends no beat, so the crew are told
--   within about 5 minutes: a blocked watch is not keeping watch.
-- * Older apps (125 and before) never call the heartbeat: vessel_state stays
--   NULL, the job never looks at them and their sessions end at 24 h as now.
-- * An expired session is never paged about and never revived.
-- * An owner tombstoned for account deletion is skipped (every write to their
--   rows is fenced). Any other failure in one watch is contained in its own
--   EXCEPTION block, stamped on the session (last_error_at, the SQLSTATE
--   only), and every other watch still pages. The same per-row handler now
--   wraps check_pi_anchor_watch_health, so one failing binding can no longer
--   stop alarms for every boat (20261009075000's open follow-up).
-- * check_pi_anchor_watch_health: contact_lost unchanged (60 s without a Pi
--   heartbeat). session_expiring now fires once when authorised_at + 7 days
--   is within 12 hours, instead of 15 minutes before a 24 h session end that
--   can no longer come while the Pi is alive. A re-authorise clears it, and
--   the Pi's next heartbeat then resolves the warning's event, which is how a
--   crew phone (asking every 5 minutes) learns the skipper renewed.
-- * record_pi_anchor_heartbeat: same signature. It rolls the session (at
--   most once a minute) before it reads the session's expiry, and caps the
--   lease at LEAST(now() + 6 h, session expiry, authorised_at + 7 days).
--   This reverses "the hard session expiry is NEVER renewed by the Pi"
--   (20260923170000): the Pi still cannot extend anything past the owner's
--   own last authorisation plus 7 days, so the owner's phone stays the bound.
-- * The insert policy for anchor_alarm_events: a client may mark its row
--   'phone' or leave it NULL, never 'pi'.
--
-- Who may do what
-- ───────────────
--   record_anchor_watch_heartbeat   authenticated. Only the session's owner,
--                                   as its 'vessel' member, may report
--                                   'watching'; the owner alone may report
--                                   'ended' (the hand-off makes them 'shore').
--   check_anchor_phone_watch_health service_role and the cron job only.
--   join_anchor_watch_session       authenticated, as before. Newcomers only
--                                   in a watch's first 24 hours; the owner
--                                   and existing members at any time.
--   leave_anchor_watch_session      authenticated. The caller's own row,
--                                   never the owner's, once none of their
--                                   devices is registered for the watch.
--   anchor_watch_sessions           unchanged: members read their own session
--                                   (now including the beat, so the shore
--                                   view can say the phone is being watched).
--
-- Cost: one indexed update a minute per phone-kept watch; the job reads only
-- sessions with a phone beat (partial index), every minute.
--
-- Undo
-- ────
-- The OFF switch (the phone watchdog only; the Pi job is untouched):
--     SELECT cron.unschedule('anchor-phone-watch-health');
-- To pause it instead, keeping the job:
--     SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'anchor-phone-watch-health'), active := false);
-- The columns are additive and harmless left in place. join_anchor_watch_session's
-- previous body is in 20260723090000 (the 24-hour newcomer rule is the only change).
--
-- Written, NOT pushed: Shane says yes first (with the session rule and the
-- 5-minute threshold), then send-anchor-alarm is deployed straight after.
-- anchor-relay needs no change. Safe to re-run: IF NOT EXISTS, CREATE OR
-- REPLACE, DROP ... IF EXISTS before every policy and constraint, and the
-- cron job is left alone when it is already exactly this job, left PAUSED
-- (with a NOTICE) when somebody paused it, and otherwise unscheduled before it
-- is scheduled. Job 26 ('shore-watch-health') is not touched. No BEGIN or
-- COMMIT: the CLI applies the file as one batch; lock_timeout is set for the
-- session (SET LOCAL is a no-op outside a transaction block) and reset at the
-- end. For a rolled-back rehearsal, run it inside begin ... rollback.

SET lock_timeout = '5s';

-- ── 1. The phone's check-in, on the session ──────────────────────────────────

ALTER TABLE public.anchor_watch_sessions
    ADD COLUMN IF NOT EXISTS vessel_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vessel_state TEXT CHECK (vessel_state IN ('watching', 'ended')),
    ADD COLUMN IF NOT EXISTS phone_quiet_alarm_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error_sqlstate TEXT
        CHECK (last_error_sqlstate IS NULL OR last_error_sqlstate ~ '^[0-9A-Z]{5}$');

CREATE INDEX IF NOT EXISTS anchor_watch_sessions_phone_beat_idx
    ON public.anchor_watch_sessions (vessel_heartbeat_at)
    WHERE vessel_heartbeat_at IS NOT NULL;

-- ── 2. Which keeper raised an alarm ──────────────────────────────────────────

ALTER TABLE public.anchor_alarm_events
    ADD COLUMN IF NOT EXISTS watchkeeper TEXT CHECK (watchkeeper IS NULL OR watchkeeper IN ('pi', 'phone'));

-- The vessel phone may insert its own drag events, marked 'phone' (126 and
-- later) or unmarked (125 and older). Never 'pi': only the server speaks for
-- the Pi.
DROP POLICY IF EXISTS anchor_event_vessel_insert ON public.anchor_alarm_events;
CREATE POLICY anchor_event_vessel_insert ON public.anchor_alarm_events FOR INSERT TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND (watchkeeper IS NULL OR watchkeeper = 'phone')
    AND EXISTS (
        SELECT 1 FROM public.anchor_watch_members m
        JOIN public.anchor_watch_sessions s USING (session_code)
        WHERE m.session_code = anchor_alarm_events.session_code
          AND m.user_id = auth.uid() AND m.role = 'vessel' AND s.expires_at > now()
    )
);

-- ── 3. The check-in itself ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_anchor_watch_heartbeat(p_session_code TEXT, p_state TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    caller UUID := auth.uid();
    session_row public.anchor_watch_sessions%ROWTYPE;
    caller_role TEXT;
    new_expiry TIMESTAMPTZ;
BEGIN
    IF caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_state IS NULL OR p_state NOT IN ('watching', 'ended') THEN
        RAISE EXCEPTION 'The state must be watching or ended' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO session_row FROM public.anchor_watch_sessions
    WHERE session_code = p_session_code FOR UPDATE;
    SELECT m.role INTO caller_role FROM public.anchor_watch_members m
    WHERE m.session_code = p_session_code AND m.user_id = caller;
    -- One answer for a missing session, someone else's, and a crew member's:
    -- only the phone that keeps this watch may report it.
    IF session_row.session_code IS NULL OR session_row.owner_user_id <> caller OR caller_role IS NULL
        OR (p_state = 'watching' AND caller_role <> 'vessel') THEN
        RAISE EXCEPTION 'Only the phone keeping this watch may report it' USING ERRCODE = '42501';
    END IF;
    -- An ended session is never revived, and nothing pages about it.
    IF session_row.expires_at <= now() THEN
        RETURN NULL;
    END IF;

    IF p_state = 'watching' THEN
        -- Bounded writes: at most one every 20 s, unless the state or the
        -- alarm flag has to change. The expiry rolls with each write.
        UPDATE public.anchor_watch_sessions SET
            vessel_heartbeat_at = now(),
            vessel_state = 'watching',
            phone_quiet_alarm_at = NULL,
            expires_at = GREATEST(expires_at, now() + interval '23 hours')
        WHERE session_code = p_session_code
          AND (vessel_heartbeat_at IS NULL OR vessel_heartbeat_at <= now() - interval '20 seconds'
               OR vessel_state IS DISTINCT FROM 'watching' OR phone_quiet_alarm_at IS NOT NULL)
        RETURNING expires_at INTO new_expiry;
    ELSE
        UPDATE public.anchor_watch_sessions SET
            vessel_heartbeat_at = NULL,
            vessel_state = 'ended',
            phone_quiet_alarm_at = NULL
        WHERE session_code = p_session_code
        RETURNING expires_at INTO new_expiry;
    END IF;

    -- The phone is back (or stood down on purpose): its outage is over.
    UPDATE public.anchor_alarm_events SET resolved_at = now()
    WHERE session_code = p_session_code AND user_id = session_row.owner_user_id AND resolved_at IS NULL
      AND watchkeeper = 'phone' AND alarm_kind = 'contact_lost';

    RETURN jsonb_build_object('expires_at', COALESCE(new_expiry, session_row.expires_at));
END;
$$;
REVOKE ALL ON FUNCTION public.record_anchor_watch_heartbeat(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_anchor_watch_heartbeat(TEXT, TEXT) TO authenticated;

-- ── 4. The phone watchdog ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_anchor_phone_watch_health()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    watch RECORD;
    failed_state TEXT;
BEGIN
    FOR watch IN
        SELECT s.session_code, s.owner_user_id
        FROM public.anchor_watch_sessions AS s
        WHERE s.vessel_state = 'watching'
          AND s.vessel_heartbeat_at < now() - interval '5 minutes'
          AND s.phone_quiet_alarm_at IS NULL
          AND s.expires_at > now()
          -- A hand-off makes the skipper a shore member: the Pi keeps it now.
          AND EXISTS (
              SELECT 1 FROM public.anchor_watch_members AS m
              WHERE m.session_code = s.session_code AND m.user_id = s.owner_user_id AND m.role = 'vessel'
          )
          AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = s.owner_user_id)
        FOR UPDATE OF s SKIP LOCKED
    LOOP
        BEGIN
            UPDATE public.anchor_watch_sessions SET phone_quiet_alarm_at = now()
            WHERE session_code = watch.session_code;
            -- notify_anchor_alarm delivers it; retry-pending-anchor-alarm retries it.
            INSERT INTO public.anchor_alarm_events(session_code, user_id, alarm_kind, watchkeeper, distance_m, swing_radius_m)
            VALUES (watch.session_code, watch.owner_user_id, 'contact_lost', 'phone', 0, 0);
        EXCEPTION WHEN OTHERS THEN
            failed_state := SQLSTATE;
            RAISE WARNING 'check_anchor_phone_watch_health skipped one watch (SQLSTATE %)', failed_state;
            BEGIN
                UPDATE public.anchor_watch_sessions
                SET last_error_at = now(), last_error_sqlstate = failed_state
                WHERE session_code = watch.session_code;
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'check_anchor_phone_watch_health could not record that failure (SQLSTATE %)', SQLSTATE;
            END;
        END;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.check_anchor_phone_watch_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_anchor_phone_watch_health() TO service_role;

-- ── 5. The Pi's lease: 7 days from the skipper's phone, sessions rolling ─────

-- Every live row is within 48 hours (read-only count, 2026-10-10: none over),
-- so the wider CHECK validates at once.
ALTER TABLE public.pi_anchor_sessions DROP CONSTRAINT IF EXISTS pi_anchor_sessions_expiry_bounded;
ALTER TABLE public.pi_anchor_sessions ADD CONSTRAINT pi_anchor_sessions_expiry_bounded
    CHECK (expires_at > authorised_at AND expires_at <= authorised_at + INTERVAL '7 days');

-- Called only AFTER the edge function verifies the scoped Pi credential.
-- Lock the binding so stop/revoke and heartbeat renewal cannot resurrect it.
CREATE OR REPLACE FUNCTION public.record_pi_anchor_heartbeat(
    p_relay_id TEXT, p_session_code TEXT, p_owner_id UUID,
    p_gps_available BOOLEAN, p_drag BOOLEAN,
    p_distance_m REAL, p_swing_radius_m REAL, p_lat REAL, p_lon REAL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.pi_anchor_sessions%ROWTYPE; hard_expiry TIMESTAMPTZ; lease_expiry TIMESTAMPTZ;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    SELECT * INTO b FROM public.pi_anchor_sessions WHERE relay_id = p_relay_id FOR UPDATE;
    IF NOT FOUND OR b.owner_id <> p_owner_id OR b.session_code <> p_session_code OR b.expires_at <= now() THEN
        RETURN NULL;
    END IF;

    -- A Pi that is still reporting keeps its owner's session alive, rolling at
    -- most 23 hours ahead (an installed Pi refuses a session more than 24 h
    -- out), at most once a minute. Never an expired session: that one ended.
    UPDATE public.anchor_watch_sessions AS s
    SET expires_at = GREATEST(s.expires_at, now() + interval '23 hours')
    FROM public.pi_diary_relays AS r
    WHERE s.session_code = p_session_code AND s.owner_user_id = p_owner_id AND s.expires_at > now()
      AND s.expires_at < now() + interval '23 hours' - interval '1 minute'
      AND r.relay_id = p_relay_id AND r.enabled AND r.owner_id = p_owner_id;

    SELECT s.expires_at INTO hard_expiry FROM public.anchor_watch_sessions s
    JOIN public.pi_diary_relays r ON r.relay_id = p_relay_id AND r.enabled AND r.owner_id = p_owner_id
    WHERE s.session_code = p_session_code AND s.owner_user_id = p_owner_id AND s.expires_at > now();
    IF hard_expiry IS NULL THEN RETURN NULL; END IF;

    -- The phone is not needed for six-hour lease renewal. The Pi keeps the
    -- session rolling while it reports, but never past 7 days after the
    -- skipper's phone last authorised it, nor revives an expired binding.
    lease_expiry := LEAST(now() + interval '6 hours', hard_expiry, b.authorised_at + INTERVAL '7 days');
    UPDATE public.pi_anchor_sessions SET
        expires_at = lease_expiry, last_heartbeat_at = now(), gps_available = p_gps_available,
        is_dragging = p_gps_available AND p_drag,
        contact_alarm_at = NULL,
        gps_alarm_at = CASE WHEN p_gps_available THEN NULL ELSE COALESCE(gps_alarm_at, now()) END
    WHERE relay_id = p_relay_id;

    -- A re-authorise clears expiry_alarm_at (anchor-relay): the week was
    -- renewed, so a standing "ends soon" is answered. Crew phones read that.
    UPDATE public.anchor_alarm_events SET resolved_at = now()
    WHERE session_code = p_session_code AND user_id = p_owner_id AND resolved_at IS NULL
        AND (alarm_kind = 'contact_lost' OR (p_gps_available AND alarm_kind = 'gps_lost')
            OR (p_gps_available AND NOT p_drag AND alarm_kind = 'drag')
            OR (alarm_kind = 'session_expiring' AND b.expiry_alarm_at IS NULL));

    IF NOT p_gps_available AND b.gps_alarm_at IS NULL THEN
        INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m)
        VALUES(p_session_code,p_owner_id,p_relay_id,'gps_lost',0,0);
    END IF;
    IF p_gps_available AND p_drag AND NOT EXISTS (
        SELECT 1 FROM public.anchor_alarm_events WHERE session_code = p_session_code
        AND alarm_kind = 'drag' AND created_at > now() - interval '10 minutes'
        AND resolved_at IS NULL
    ) THEN
        INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m,vessel_lat,vessel_lon)
        VALUES(p_session_code,p_owner_id,p_relay_id,'drag',GREATEST(0,p_distance_m),GREATEST(0,p_swing_radius_m),p_lat,p_lon);
    END IF;
    RETURN jsonb_build_object('expires_at',lease_expiry,'session_expires_at',hard_expiry);
END;
$$;
REVOKE ALL ON FUNCTION public.record_pi_anchor_heartbeat(TEXT,TEXT,UUID,BOOLEAN,BOOLEAN,REAL,REAL,REAL,REAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pi_anchor_heartbeat(TEXT,TEXT,UUID,BOOLEAN,BOOLEAN,REAL,REAL,REAL,REAL) TO service_role;

-- A server watchdog is necessary: neither a closed phone nor a disconnected
-- Pi can report its own loss of contact. One alert per outage, reset on contact.
CREATE OR REPLACE FUNCTION public.check_pi_anchor_watch_health()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b RECORD; failed_state TEXT;
BEGIN
    FOR b IN
        SELECT p.*,s.expires_at AS session_expires_at FROM public.pi_anchor_sessions p
        JOIN public.anchor_watch_sessions s ON s.session_code = p.session_code AND s.owner_user_id = p.owner_id
        JOIN public.pi_diary_relays r ON r.relay_id = p.relay_id AND r.owner_id = p.owner_id AND r.enabled
        WHERE s.expires_at > now() AND p.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = p.owner_id)
        FOR UPDATE OF p SKIP LOCKED
    LOOP
        BEGIN
            IF COALESCE(b.last_heartbeat_at,b.authorised_at) < now() - interval '60 seconds'
                AND b.contact_alarm_at IS NULL THEN
                UPDATE public.pi_anchor_sessions SET contact_alarm_at = now() WHERE relay_id = b.relay_id;
                INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m)
                VALUES(b.session_code,b.owner_id,b.relay_id,'contact_lost',0,0);
            END IF;
            -- Once, 12 hours before the 7-day cap from the skipper's last
            -- authorisation. Any re-authorise clears the flag (anchor-relay).
            IF b.authorised_at + INTERVAL '7 days' <= now() + interval '12 hours' AND b.expiry_alarm_at IS NULL THEN
                UPDATE public.pi_anchor_sessions SET expiry_alarm_at = now() WHERE relay_id = b.relay_id;
                INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m)
                VALUES(b.session_code,b.owner_id,b.relay_id,'session_expiring',0,0);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            failed_state := SQLSTATE;
            RAISE WARNING 'check_pi_anchor_watch_health skipped one binding (SQLSTATE %)', failed_state;
            BEGIN
                UPDATE public.anchor_watch_sessions
                SET last_error_at = now(), last_error_sqlstate = failed_state
                WHERE session_code = b.session_code AND owner_user_id = b.owner_id;
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'check_pi_anchor_watch_health could not record that failure (SQLSTATE %)', SQLSTATE;
            END;
        END;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.check_pi_anchor_watch_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pi_anchor_watch_health() TO service_role;

-- ── 6. Bound the code and the membership, not the watch ──────────────────────
--
-- Until now a session died at 24 hours, and that cap was all that bounded two
-- credentials: the session code (anyone signed in who holds it may join) and
-- membership (live position, the Realtime channel, alarm events), which
-- nothing ever removed. With sessions rolling while the keeper checks in, both
-- would live as long as the watch. So:
--   * the code admits NEWCOMERS only in the watch's first 24 hours, exactly
--     as long as it could before. The owner may always (re)join (the Pi
--     hand-off rejoins the owner as shore), and so may an existing member
--     (a crew phone reconnecting on day 3). Same answer, false, for an
--     expired, unknown or closed code, as before.
--   * Leave gives the membership up: leave_anchor_watch_session deletes the
--     caller's own row, never the owner's, and only once no device of theirs
--     is still registered for the watch's pushes (the app deletes this
--     device's token first), so another of their devices keeps watching.

CREATE OR REPLACE FUNCTION public.join_anchor_watch_session(p_session_code TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.anchor_watch_sessions AS s
        WHERE s.session_code = p_session_code AND s.expires_at > now()
          AND (s.owner_user_id = auth.uid()
               OR s.created_at > now() - interval '24 hours'
               OR EXISTS (
                   SELECT 1 FROM public.anchor_watch_members AS m
                   WHERE m.session_code = s.session_code AND m.user_id = auth.uid()
               ))
    ) THEN
        RETURN false;
    END IF;
    INSERT INTO public.anchor_watch_members(session_code, user_id, role)
    VALUES (p_session_code, auth.uid(), 'shore')
    ON CONFLICT (session_code, user_id) DO UPDATE SET role = 'shore';
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.join_anchor_watch_session(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_anchor_watch_session(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.leave_anchor_watch_session(p_session_code TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    -- Another of this account's devices is still keeping Shore Watch.
    IF EXISTS (
        SELECT 1 FROM public.anchor_alarm_tokens AS t
        WHERE t.session_code = p_session_code AND t.user_id = auth.uid()
    ) THEN
        RETURN false;
    END IF;
    DELETE FROM public.anchor_watch_members AS m
    USING public.anchor_watch_sessions AS s
    WHERE m.session_code = p_session_code AND m.user_id = auth.uid()
      AND s.session_code = m.session_code AND s.owner_user_id <> auth.uid();
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.leave_anchor_watch_session(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_anchor_watch_session(TEXT) TO authenticated;

-- ── 7. Every minute, as its own job ──────────────────────────────────────────
--
-- Not appended to job 26: one failing statement in a job skips the job's
-- other statements (20261009075000). The same guard as that file: exactly
-- this job and active is left alone; a PAUSED job stays paused; anything else
-- of this name is unscheduled and the job scheduled afresh. No other job is
-- touched. Without pg_cron (a bare local database) nothing is scheduled.

DO $schedule$
DECLARE
    job_name CONSTANT TEXT := 'anchor-phone-watch-health';
    want_schedule CONSTANT TEXT := '* * * * *';
    want_command CONSTANT TEXT := 'SELECT public.check_anchor_phone_watch_health()';
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

-- ── 8. Fail the push unless the result is exactly as stated ──────────────────
-- Catches a drift policy on either table (none on 2026-10-10, read-only), an
-- open policy, and a grant on the new functions that crept wider.

DO $check$
DECLARE
    expected_policies CONSTANT JSONB := jsonb_build_object(
        'anchor_alarm_events', jsonb_build_array('anchor_event_member_read', 'anchor_event_vessel_insert'),
        'anchor_watch_sessions', jsonb_build_array('anchor_sessions_member_read')
    );
    table_name TEXT;
    actual JSONB;
    wanted JSONB;
    open_policies TEXT;
BEGIN
    FOR table_name IN SELECT jsonb_object_keys(expected_policies) LOOP
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || table_name)::regclass) THEN
            RAISE EXCEPTION 'anchor heartbeat: RLS is off on public.%', table_name;
        END IF;
        SELECT COALESCE(jsonb_agg(policyname::text ORDER BY policyname::text COLLATE "C"), '[]'::jsonb)
        INTO actual
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = table_name;
        SELECT jsonb_agg(p.policy_name ORDER BY p.policy_name COLLATE "C")
        INTO wanted
        FROM jsonb_array_elements_text(expected_policies -> table_name) AS p(policy_name);
        IF actual IS DISTINCT FROM wanted THEN
            RAISE EXCEPTION 'anchor heartbeat: public.% has policies %, expected %', table_name, actual, wanted;
        END IF;
    END LOOP;

    SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO open_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('anchor_alarm_events', 'anchor_watch_sessions')
      AND (cmd = 'ALL' OR qual = 'true' OR with_check = 'true' OR roles && ARRAY['public', 'anon']::name[]);
    IF open_policies IS NOT NULL THEN
        RAISE EXCEPTION 'anchor heartbeat: open policies: %', open_policies;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'anchor_alarm_events' AND policyname = 'anchor_event_vessel_insert'
          AND with_check LIKE '%watchkeeper%'
    ) THEN
        RAISE EXCEPTION 'anchor heartbeat: the insert policy does not restrict watchkeeper';
    END IF;

    IF has_function_privilege('anon', 'public.record_anchor_watch_heartbeat(text, text)', 'EXECUTE')
        OR NOT has_function_privilege('authenticated', 'public.record_anchor_watch_heartbeat(text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anchor heartbeat: record_anchor_watch_heartbeat must be signed-in only';
    END IF;
    IF has_function_privilege('anon', 'public.check_anchor_phone_watch_health()', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.check_anchor_phone_watch_health()', 'EXECUTE') THEN
        RAISE EXCEPTION 'anchor heartbeat: check_anchor_phone_watch_health must not be callable by clients';
    END IF;
    IF has_function_privilege('anon', 'public.join_anchor_watch_session(text)', 'EXECUTE')
        OR NOT has_function_privilege('authenticated', 'public.join_anchor_watch_session(text)', 'EXECUTE')
        OR has_function_privilege('anon', 'public.leave_anchor_watch_session(text)', 'EXECUTE')
        OR NOT has_function_privilege('authenticated', 'public.leave_anchor_watch_session(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anchor heartbeat: joining and leaving a watch must be signed-in only';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = 'public.join_anchor_watch_session(text)'::regprocedure AND prosrc LIKE '%24 hours%'
    ) THEN
        RAISE EXCEPTION 'anchor heartbeat: the session code must admit newcomers for 24 hours only';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.pi_anchor_sessions'::regclass AND conname = 'pi_anchor_sessions_expiry_bounded'
          AND pg_get_constraintdef(oid) LIKE '%7 days%'
    ) THEN
        RAISE EXCEPTION 'anchor heartbeat: the Pi lease cap is not 7 days';
    END IF;
END;
$check$;

RESET lock_timeout;
