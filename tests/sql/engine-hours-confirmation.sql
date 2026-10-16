-- Disposable PostgreSQL fixture only. Never run against a product database.
\set ON_ERROR_STOP on
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
CREATE TABLE public.vessel_engine_hours(user_id uuid PRIMARY KEY REFERENCES auth.users(id), hours integer NOT NULL CHECK(hours >= 0));
-- The unchanged production meter table already has its own RLS/write guards.
-- This fixture isolates the new RPC/receipt/carry behavior.
\ir ../../supabase/migrations/20261016175740_confirmed_voyage_engine_hours.sql
INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
INSERT INTO public.vessel_engine_hours VALUES('00000000-0000-4000-8000-000000000001',100),('00000000-0000-4000-8000-000000000002',500);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
DO $$ DECLARE r jsonb; BEGIN
    r := public.confirm_voyage_engine_hours('first',1800,'log',100);
    IF r <> '{"applied":true,"hours":100,"hoursAfterConfirmation":100,"remainderSeconds":1800}'::jsonb THEN RAISE EXCEPTION 'First half hour lost'; END IF;
    r := public.confirm_voyage_engine_hours('first',1800,'log',100);
    IF (r->>'applied')::boolean THEN RAISE EXCEPTION 'Same voyage counted twice'; END IF;
    r := public.confirm_voyage_engine_hours('second',1800,'rpm',100);
    IF (r->>'hours')::integer <> 101 OR (r->>'remainderSeconds')::integer <> 0 THEN RAISE EXCEPTION 'Fractional hours not carried'; END IF;
    r := public.confirm_voyage_engine_hours('first',1800,'log',100);
    IF (r->>'applied')::boolean OR (r->>'hours')::integer <> 101 THEN RAISE EXCEPTION 'Old expected meter prevents idempotent retry'; END IF;
    BEGIN
        PERFORM public.confirm_voyage_engine_hours('first',1801,'log',101);
        RAISE EXCEPTION 'Changed confirmed seconds accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    BEGIN
        PERFORM public.confirm_voyage_engine_hours('conflict',3600,'log',100);
        RAISE EXCEPTION 'Stale meter was overwritten';
    EXCEPTION WHEN serialization_failure THEN NULL; END;
    BEGIN
        PERFORM public.confirm_voyage_engine_hours('bad',3600,'forecast',101);
        RAISE EXCEPTION 'Estimated source accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    BEGIN
        PERFORM public.confirm_voyage_engine_hours('bad',-1,'log',101);
        RAISE EXCEPTION 'Negative seconds accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    BEGIN
        INSERT INTO public.voyage_engine_hours_carry VALUES(auth.uid(),101,3599);
        RAISE EXCEPTION 'Direct carry mutation accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        DELETE FROM public.voyage_engine_hours_receipts;
        RAISE EXCEPTION 'Receipt deletion accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    IF (SELECT count(*) FROM public.voyage_engine_hours_receipts) <> 2 THEN RAISE EXCEPTION 'Failed calls left receipts'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
DO $$ BEGIN
    IF EXISTS(SELECT FROM public.voyage_engine_hours_receipts) OR EXISTS(SELECT FROM public.voyage_engine_hours_carry) THEN RAISE EXCEPTION 'Other account read engine receipts'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
    IF has_function_privilege('anon','public.confirm_voyage_engine_hours(text,integer,text,integer)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous caller has execute'; END IF;
    IF (SELECT hours FROM public.vessel_engine_hours WHERE user_id='00000000-0000-4000-8000-000000000002') <> 500 THEN RAISE EXCEPTION 'Wrong boat meter changed'; END IF;
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SELECT public.confirm_voyage_engine_hours('third',1800,'log',101);
RESET ROLE;
UPDATE public.vessel_engine_hours SET hours=120 WHERE user_id='00000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT public.confirm_voyage_engine_hours('fourth',1800,'log',120);
DO $$ BEGIN
    IF (SELECT seconds FROM public.voyage_engine_hours_carry) <> 1800 THEN RAISE EXCEPTION 'Manual meter edit retained stale fractional estimate'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','',false);
DO $$ BEGIN
    BEGIN
        PERFORM public.confirm_voyage_engine_hours('signedout',3600,'log',120);
        RAISE EXCEPTION 'Signed-out caller accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
UPDATE public.vessel_engine_hours SET hours=999999 WHERE user_id='00000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
DO $$ BEGIN
    BEGIN
        PERFORM public.confirm_voyage_engine_hours('overflow',3600,'log',999999);
        RAISE EXCEPTION 'Hour meter overflow accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
RESET ROLE;
UPDATE public.vessel_engine_hours SET hours=200 WHERE user_id='00000000-0000-4000-8000-000000000001';
SELECT 'ENGINE HOURS TRANSACTION AND PRIVACY CHECKS PASSED';
