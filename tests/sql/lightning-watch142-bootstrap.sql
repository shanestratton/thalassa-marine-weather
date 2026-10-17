-- Shared disposable schema; original position transport remains synthetic.
CREATE SCHEMA auth;
CREATE SCHEMA fixture;
CREATE SCHEMA private_weather_watch;
CREATE SCHEMA cron;
DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,archived_at timestamptz,released_at timestamptz,name text DEFAULT 'Fixture boat');
CREATE TABLE public.account_deletion_jobs(user_id uuid PRIMARY KEY);
CREATE TABLE public.push_notification_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_user_id uuid REFERENCES auth.users,notification_type text,title text,body text,data jsonb,created_at timestamptz DEFAULT now());
GRANT SELECT,UPDATE ON public.boats TO authenticated;
GRANT ALL ON public.push_notification_queue TO service_role;
CREATE TABLE fixture.positions(boat_id uuid PRIMARY KEY,owner_id uuid,revision uuid,lat double precision,lon double precision,measured_at timestamptz,enabled boolean DEFAULT true);
CREATE FUNCTION private_weather_watch.weather_position_current(p_boat uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('revision',p.revision,'lat',p.lat,'lon',p.lon,'at',floor(extract(epoch FROM p.measured_at)*1000),'zone','UTC')
    FROM fixture.positions p JOIN public.boats b ON b.id=p.boat_id AND b.owner_id=p.owner_id AND b.archived_at IS NULL
    WHERE p.boat_id=p_boat AND p.enabled AND p.measured_at<=now() AND p.measured_at>now()-interval '15 minutes'
$$;
CREATE FUNCTION private_weather_watch.weather_watch_service() RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')='service_role'
$$;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,schedule text,command text,active boolean);
CREATE TABLE cron.job_run_details(jobid bigint,status text,end_time timestamptz);
CREATE TABLE fixture.state(key text PRIMARY KEY,document jsonb);
GRANT USAGE ON SCHEMA fixture TO authenticated,service_role;
GRANT ALL ON fixture.state TO service_role;
CREATE FUNCTION fixture.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'PASS %',label; END $$;
CREATE FUNCTION fixture.error(sql text,code text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
    BEGIN EXECUTE sql; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE; END;
    PERFORM fixture.assert(state=code,label);
END $$;
\ir ../../supabase/migrations/20261005160000_tombstone_fence_fails_closed.sql
\ir lightning-retirement142.sql
\ir ../../supabase/migrations/20261017103100_licensed_lightning_watch.sql
