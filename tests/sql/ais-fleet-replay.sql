\set ON_ERROR_STOP on
-- ISOLATED PostGIS database only. No network, provider key, production schema or real vessel data.
CREATE SCHEMA IF NOT EXISTS auth;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')THEN CREATE ROLE anon NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN CREATE ROLE authenticated NOLOGIN;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role')THEN CREATE ROLE service_role NOLOGIN BYPASSRLS;END IF;END$$;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_user::text$$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
\ir ../../supabase/migrations/20260318080000_ais_vessels.sql
CREATE TABLE public.vessel_telemetry(owner_id uuid PRIMARY KEY,lat double precision,lon double precision,reported_at timestamptz);
GRANT SELECT ON public.vessel_telemetry TO service_role;
\ir ../../supabase/migrations/20261016072703_ais_fleet_budget.sql
CREATE FUNCTION public.fixture_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'AIS fixture assertion: %',label;END IF;END$$;
SELECT public.fixture_assert(public.claim_ais_fleet_poll() IS NULL,'default licence hold');
SELECT public.fixture_assert(NOT has_function_privilege('authenticated','public.claim_ais_fleet_poll()','EXECUTE'),'claim is not a client API');
SELECT public.fixture_assert(NOT has_table_privilege('anon','public.vessels','SELECT'),'no public raw vessel table');
SELECT public.fixture_assert(NOT has_table_privilege('authenticated','public.ais_fleet_interests','SELECT'),'private fleet interests');
SELECT public.fixture_assert((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN('public.ais_fleet_control'::regclass,'public.ais_fleet_interests'::regclass,'public.ais_fleet_coverage'::regclass)),'RLS on every new table');
INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
UPDATE public.ais_fleet_control SET enabled=true;
SELECT public.fixture_assert(public.claim_ais_fleet_poll() IS NULL,'a flag without a reviewed licence reference is insufficient');
UPDATE public.ais_fleet_control SET licence_reference='FICTIONAL TEST ONLY - NOT A LIVE APPROVAL';
SELECT public.request_ais_fleet_area('00000000-0000-4000-8000-000000000001',50.1234,0.1111);
SELECT public.request_ais_fleet_area('00000000-0000-4000-8000-000000000001',60,20);
SELECT public.fixture_assert((SELECT lat=50 AND lon=0 FROM public.ais_fleet_interests),'coarse interests and no per-pan writes');
INSERT INTO public.vessel_telemetry VALUES('00000000-0000-4000-8000-000000000002',-45,170,now());
SELECT public.claim_ais_fleet_poll() AS claim \gset
SELECT public.fixture_assert(jsonb_array_length(:'claim'::jsonb->'centres')=2,'active fleet includes fresh Pi and phone/view interests');
SELECT public.fixture_assert(public.claim_ais_fleet_poll() IS NULL,'a second replica cannot spend the same minute');
SELECT public.fixture_assert((SELECT next_allowed_at>now()+interval '170 seconds' FROM public.ais_fleet_control),'crash cooldown persists');
SELECT public.finish_ais_fleet_poll((:'claim'::jsonb->>'token')::uuid,'{"key":"fictional-area","latMin":46,"latMax":54,"lonMin":-8,"lonMax":8}'::jsonb,'ok',100,1);
SELECT public.fixture_assert((SELECT next_allowed_at>=now()+interval '60 seconds' FROM public.ais_fleet_control),'completion starts a full new minute');
SELECT public.fixture_assert(public.claim_ais_fleet_poll() IS NULL,'restart does not re-poll immediately');
SELECT public.fixture_assert(public.request_ais_fleet_area('00000000-0000-4000-8000-000000000001',50,0)->>'state'='recent','actual receipt covers map centre');
SELECT public.fixture_assert(public.request_ais_fleet_area('00000000-0000-4000-8000-000000000002',-45,170)->>'state'='queued','unpolled distant water stays explicitly queued');

UPDATE public.ais_fleet_control SET hour_write_limit=3,day_write_limit=5;
SELECT public.fixture_assert((public.merge_vessels_bounded(jsonb_build_array(jsonb_build_object('mmsi',123456789,'name','FICTIONAL ALPHA','location','SRID=4326;POINT(0 50)','position_at',now()-interval '8 minutes','data_source','aishub','sog',0.1)))->>'written')::integer=1,'first actual position is written');
SELECT public.fixture_assert((public.merge_vessels_bounded(jsonb_build_array(jsonb_build_object('mmsi',123456789,'location','SRID=4326;POINT(0 50)','position_at',now()-interval '7 minutes','data_source','aishub','sog',0.2)))->>'written')::integer=0,'restart no-op and stationary jitter do not rewrite');
SELECT public.fixture_assert((public.merge_vessels_bounded('[{"mmsi":123456789,"draught_m":1.8,"eta":"10-20 12:00"}]'::jsonb)->>'written')::integer=1,'static change writes once');
SELECT public.fixture_assert((public.merge_vessels_bounded('[{"mmsi":123456789,"draught_m":1.8,"eta":"10-20 12:00"}]'::jsonb)->>'written')::integer=0,'repeat static data is not a write');
SELECT public.fixture_assert((SELECT position_at<now()-interval '7 minutes' AND draught_m=1.8 AND eta='10-20 12:00' FROM public.vessels WHERE mmsi=123456789),'static update never refreshes the observed position clock');
SELECT public.fixture_assert((public.vessels_nearby_v135(50,0,370400,500)->0->>'updated_at')::timestamptz<now()-interval '7 minutes','nearby API returns observation age, not write age');
SELECT public.fixture_assert((public.merge_vessels_bounded(jsonb_build_array(jsonb_build_object('mmsi',123456789,'location','SRID=4326;POINT(0.01 50)','position_at',now(),'data_source','aishub','sog',3)))->>'written')::integer=1,'material movement is retained');
SELECT public.fixture_assert((public.merge_vessels_bounded(jsonb_build_array(jsonb_build_object('mmsi',987654321,'location','SRID=4326;POINT(0 50)','position_at',now(),'data_source','aishub')))->>'limited')::boolean,'hourly write budget applies across instances');
SELECT public.fixture_assert((SELECT count(*)=1 FROM public.vessels),'exhausted budget cannot insert another row');
SELECT public.fixture_assert(public.request_ais_fleet_area('00000000-0000-4000-8000-000000000001',50,0)->>'state'='limited','write exhaustion is visible to the viewer');
UPDATE public.ais_fleet_control SET hour_write_limit=1000,day_write_limit=5,hour_writes=0;
SELECT public.merge_vessels_bounded(jsonb_build_array(jsonb_build_object('mmsi',970111111,'safety_text','SART ACTIVE','safety_text_at',now())));
SELECT public.fixture_assert((SELECT location IS NULL AND position_at IS NULL FROM public.vessels WHERE mmsi=970111111),'message14 never invents a position');
SELECT public.merge_vessels_bounded(jsonb_build_array(jsonb_build_object('mmsi',970111111,'location','SRID=4326;POINT(0.1 50)','position_at',now(),'data_source','receiver','nav_status',14)));
SELECT public.fixture_assert((SELECT safety_text='SART ACTIVE' AND location IS NOT NULL FROM public.vessels WHERE mmsi=970111111),'a later real position joins the silent relayed message');
SELECT public.fixture_assert((public.merge_vessels_bounded('[{"mmsi":123456789,"name":"FICTIONAL BETA"}]'::jsonb)->>'limited')::boolean,'daily ceiling survives an hourly reset');
DO $$BEGIN PERFORM public.vessels_nearby_v135(91,0,1000,500);RAISE EXCEPTION 'invalid coordinate accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM='invalid coordinate accepted' THEN RAISE;END IF;END$$;
DO $$BEGIN PERFORM public.vessels_nearby_v135(0,0,370401,500);RAISE EXCEPTION 'unbounded radius accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM='unbounded radius accepted' THEN RAISE;END IF;END$$;
UPDATE public.ais_fleet_control SET enabled=false;
SELECT public.fixture_assert(public.vessels_nearby_v135(50,0,370400,500)='[]'::jsonb,'live display hold is enforced in the database');
-- Prepare the isolated race harness; its first command resets the clock, never waits a real minute.
UPDATE public.ais_fleet_control SET enabled=true,next_allowed_at='-infinity',day_write_limit=20000,hour_write_limit=1000,day_writes=0,hour_writes=0;
\echo AIS fleet replay passed
