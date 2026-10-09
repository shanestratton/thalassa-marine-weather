-- The Pi's night-watch alarms in the cloud (build 126, package 126-04b).
--
-- What it is for
-- ──────────────
-- The boat's Pi grades every AIS target all night (126-04a). When it raises a
-- collision or distress alarm, pi-alarm-relay (the Pi, with its pairing
-- credential; the function writes with the service role) turns it into a push
-- for the Pi's owner through push_notification_queue and send-push. This
-- table is that relay's memory: one row per (relay, alarm key), so
--   * the re-send rules and the caps are the server's (a new alarm pushes at
--     once; an open, unacknowledged one again every 2 min, close quarters
--     every 60 s, at most 10 re-sends; each hour at most 30 new alarms and
--     20 re-sends, counted apart; a 'blind' or 'no-fix' notice at most
--     every 30 min);
--   * an acknowledgement made ashore (acknowledge_pi_alarm below) reaches the
--     Pi in the relay's next answer, which stops the re-sends and silences the
--     card on every phone aboard;
--   * a phone that was asleep can show the open alarms as cards 'from the Pi'
--     when it wakes (the owner reads his own rows).
--
-- Who may do what
-- ───────────────
--   service_role  everything (pi-alarm-relay only).
--   authenticated SELECT, and RLS lets an account see only rows it owns.
--                 No INSERT, UPDATE or DELETE: acknowledging goes through
--                 acknowledge_pi_alarm, which touches only acked_at/acked_by
--                 on the caller's own unresolved rows.
--   anon, PUBLIC  nothing. Supabase still grants every privilege on a NEW
--                 public table to anon and authenticated by default
--                 (pg_default_acl, open on 2026-10-09), so the grants are
--                 revoked here explicitly and checked before COMMIT.
--
-- The alarm key is the Pi's own (pi-cache/src/aisWatch.ts):
-- kind:mmsi:raisedAt-in-ms, one alarm per vessel per encounter. Notices and
-- tests have no MMSI ('blind::1760026440000'). The CHECK is the same pattern
-- pi-alarm-relay/parse.ts enforces, so a row the relay would refuse cannot
-- exist. payload holds the bounded numbers the push words are built from and
-- the vessel's AIS name (at most 40 characters, cleaned by the relay); never
-- any other text from the Pi.
--
-- Retention: the relay deletes resolved rows older than 30 days, a bounded
-- batch at a time, on its hourly probe. No cron.
--
-- Nothing is written by this file. Safe to re-run: IF NOT EXISTS, CREATE OR
-- REPLACE, DROP POLICY IF EXISTS. One transaction, so the lock timeout holds
-- (20261009150000's SET LOCAL ran outside one and did nothing). For a
-- rolled-back replay, run the body without its BEGIN/COMMIT inside
-- begin ... rollback.
--
-- Deploy order (Shane's yes at the time): this file, then the new function
-- pi-alarm-relay (default verify_jwt), then send-push with the three new
-- types. A relay deployed before send-push knows the types still queues rows
-- that send-push delivers as ordinary pushes: safe, not loud.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. The table ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pi_alarm_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    relay_id TEXT NOT NULL CHECK (relay_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    alarm_key TEXT NOT NULL CHECK (
        char_length(alarm_key) <= 64
        AND alarm_key ~ '^(collision|close-quarters|distress|blind|no-fix|test):[0-9]{0,9}:[0-9]{10,13}$'
    ),
    kind TEXT NOT NULL CHECK (kind IN ('collision', 'close-quarters', 'distress', 'blind', 'no-fix', 'test')),
    mmsi INTEGER CHECK (mmsi IS NULL OR (mmsi >= 1000000 AND mmsi < 1000000000)),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
        jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 2048
    ),
    raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_pushed_at TIMESTAMPTZ,
    pushed_count INTEGER NOT NULL DEFAULT 0 CHECK (pushed_count BETWEEN 0 AND 100),
    acked_at TIMESTAMPTZ,
    acked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    UNIQUE (relay_id, alarm_key),
    CHECK (split_part(alarm_key, ':', 1) = kind)
);

COMMENT ON TABLE public.pi_alarm_events IS
    'The boat Pi''s night-watch alarms as pi-alarm-relay heard them (126-04b): one row per (relay, alarm key). '
    'Written by the relay (service role) only; the owner reads his own and acknowledges through acknowledge_pi_alarm.';

CREATE INDEX IF NOT EXISTS pi_alarm_events_owner_raised_idx ON public.pi_alarm_events (owner_id, raised_at DESC);
-- The relay's own reads: a relay's open alarms, and its newest notice or test of a kind.
CREATE INDEX IF NOT EXISTS pi_alarm_events_relay_open_idx
    ON public.pi_alarm_events (relay_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS pi_alarm_events_relay_kind_pushed_idx
    ON public.pi_alarm_events (relay_id, kind, last_pushed_at DESC);

-- ── 2. Who may read it ───────────────────────────────────────────────────────

ALTER TABLE public.pi_alarm_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pi_alarm_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.pi_alarm_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pi_alarm_events TO service_role;

DROP POLICY IF EXISTS pi_alarm_events_owner_read ON public.pi_alarm_events;
CREATE POLICY pi_alarm_events_owner_read ON public.pi_alarm_events FOR SELECT TO authenticated
USING (owner_id = (SELECT auth.uid()));

-- ── 3. Acknowledge, from any of the owner's devices ──────────────────────────
--
-- Only an alarm a phone can show (collision, close quarters, distress), only
-- the caller's own, only while it is open. The first acknowledgement stands:
-- a second tap, or a second device, changes nothing. Returns how many rows it
-- acknowledged (0 when there was nothing open to acknowledge).

CREATE OR REPLACE FUNCTION public.acknowledge_pi_alarm(p_alarm_key TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    caller UUID := auth.uid();
    acknowledged INTEGER;
BEGIN
    IF caller IS NULL THEN RAISE EXCEPTION 'sign in to acknowledge' USING ERRCODE = '42501';
    END IF;
    IF p_alarm_key IS NULL
        OR char_length(p_alarm_key) > 64
        OR p_alarm_key !~ '^(collision|close-quarters|distress):[0-9]{7,9}:[0-9]{10,13}$' THEN
        RAISE EXCEPTION 'not an alarm key' USING ERRCODE = '22023';
    END IF;

    UPDATE public.pi_alarm_events
    SET acked_at = COALESCE(acked_at, now()), acked_by = COALESCE(acked_by, caller)
    WHERE owner_id = caller AND alarm_key = p_alarm_key AND resolved_at IS NULL;
    GET DIAGNOSTICS acknowledged = ROW_COUNT;
    RETURN acknowledged;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_pi_alarm(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_pi_alarm(TEXT) TO authenticated;

-- ── 4. The push fails unless all of the above is exactly so ─────────────────

DO $check$
DECLARE
    privileges TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    grantee TEXT;
    privilege TEXT;
    held BOOLEAN;
    stray TEXT;
    fn RECORD;
BEGIN
    IF current_setting('server_version_num')::int >= 170000 THEN
        privileges := array_append(privileges, 'MAINTAIN');
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pi_alarm_events'::regclass) THEN
        RAISE EXCEPTION 'pi_alarm_events: RLS is off';
    END IF;

    -- Table and column grants both count: has_any_column_privilege is true for a table grant too.
    FOREACH grantee IN ARRAY ARRAY['anon', 'public', 'authenticated'] LOOP
        FOREACH privilege IN ARRAY privileges LOOP
            IF privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN
                held := has_any_column_privilege(grantee, 'public.pi_alarm_events', privilege);
            ELSE
                held := has_table_privilege(grantee, 'public.pi_alarm_events', privilege);
            END IF;
            IF grantee = 'authenticated' AND privilege = 'SELECT' THEN
                IF NOT has_table_privilege(grantee, 'public.pi_alarm_events', privilege) THEN
                    RAISE EXCEPTION 'pi_alarm_events: authenticated must keep SELECT';
                END IF;
            ELSIF held THEN
                RAISE EXCEPTION 'pi_alarm_events: % still holds %', grantee, privilege;
            END IF;
        END LOOP;
    END LOOP;

    SELECT string_agg(policyname, ', ') INTO stray
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pi_alarm_events' AND policyname <> 'pi_alarm_events_owner_read';
    IF stray IS NOT NULL THEN
        RAISE EXCEPTION 'pi_alarm_events: unexpected policies %', stray;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'pi_alarm_events' AND policyname = 'pi_alarm_events_owner_read'
          AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
    ) THEN
        RAISE EXCEPTION 'pi_alarm_events: the owner-read policy is missing or widened';
    END IF;

    SELECT p.prosecdef, p.proconfig INTO fn
    FROM pg_proc p
    WHERE p.oid = 'public.acknowledge_pi_alarm(text)'::regprocedure;
    IF NOT fn.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (fn.proconfig)) THEN
        RAISE EXCEPTION 'acknowledge_pi_alarm: not a definer with its search_path pinned';
    END IF;
    IF has_function_privilege('anon', 'public.acknowledge_pi_alarm(text)', 'EXECUTE')
        OR has_function_privilege('public', 'public.acknowledge_pi_alarm(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'acknowledge_pi_alarm: anon or PUBLIC may execute it';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.acknowledge_pi_alarm(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'acknowledge_pi_alarm: authenticated may not execute it';
    END IF;
END;
$check$;

COMMIT;
