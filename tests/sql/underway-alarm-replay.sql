-- Synthetic ephemeral PostgreSQL fixture only. Never run this on a project.
\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
\i supabase/migrations/20261010120000_pi_alarm_events.sql
\i supabase/held-migrations/20261015220000_underway_alarm_kinds.sql
-- A replay of the held migration must be safe as well.
\i supabase/held-migrations/20261015220000_underway_alarm_kinds.sql

INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
INSERT INTO public.pi_alarm_events (owner_id,relay_id,alarm_key,kind,payload) VALUES
('00000000-0000-0000-0000-000000000001','fixture-relay-00000001','off-route::1792100000000','off-route','{}'),
('00000000-0000-0000-0000-000000000002','fixture-relay-00000002','chart-ahead::1792100000000','chart-ahead','{"name":"","lat":null}');

DO $$
BEGIN
    BEGIN
        INSERT INTO public.pi_alarm_events (owner_id,relay_id,alarm_key,kind,mmsi)
        VALUES ('00000000-0000-0000-0000-000000000001','fixture-relay-00000001','off-route::1792100000001','off-route',211000001);
        RAISE EXCEPTION 'synthetic MMSI was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO public.pi_alarm_events (owner_id,relay_id,alarm_key,kind,payload)
        VALUES ('00000000-0000-0000-0000-000000000001','fixture-relay-00000001','chart-ahead::1792100000001','chart-ahead','{"lat":45.1}');
        RAISE EXCEPTION 'chart coordinates were accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO public.pi_alarm_events (owner_id,relay_id,alarm_key,kind,payload)
        VALUES ('00000000-0000-0000-0000-000000000001','fixture-relay-00000001','chart-ahead::1792100000002','chart-ahead','{"depth_m":1.2}');
        RAISE EXCEPTION 'unknown chart evidence was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO public.pi_alarm_events (owner_id,relay_id,alarm_key,kind)
        VALUES ('00000000-0000-0000-0000-000000000001','fixture-relay-00000001','off-route:211000001:1792100000001','off-route');
        RAISE EXCEPTION 'an underway MMSI key was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
END;
$$;

SET ROLE service_role;
DO $$ BEGIN
    IF public.pi_alarm_underway_capability() <> 1 THEN RAISE EXCEPTION 'service capability missing'; END IF;
END; $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
DO $$ BEGIN
    IF (SELECT count(*) FROM public.pi_alarm_events) <> 1 THEN RAISE EXCEPTION 'owner-only RLS failed'; END IF;
    IF public.acknowledge_pi_alarm('chart-ahead::1792100000000') <> 0 THEN RAISE EXCEPTION 'other owner acknowledged'; END IF;
    IF public.acknowledge_pi_alarm('off-route::1792100000000') <> 1 THEN RAISE EXCEPTION 'own acknowledgement failed'; END IF;
    BEGIN
        PERFORM public.pi_alarm_underway_capability();
        RAISE EXCEPTION 'authenticated received private schema capability';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM public.acknowledge_pi_alarm('test::1792100000000');
        RAISE EXCEPTION 'test key acknowledged';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END; $$;
RESET ROLE;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.pi_alarm_events WHERE owner_id='00000000-0000-0000-0000-000000000001'
        AND acked_by=owner_id AND acked_at IS NOT NULL) THEN RAISE EXCEPTION 'acknowledgement not stored'; END IF;
END; $$;
SET ROLE anon;
DO $$ BEGIN
    BEGIN
        PERFORM public.pi_alarm_underway_capability();
        RAISE EXCEPTION 'anon received private capability';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM public.acknowledge_pi_alarm('off-route::1792100000000');
        RAISE EXCEPTION 'anon acknowledged';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
\echo 'Underway alarm migration replay, privacy, capability, RLS and acknowledgement checks passed.'
