-- Fleet AIS is informational. Operator reviews display/transport rights before enabling.
-- AISHub terms 2026-10-08: https://www.aishub.net/terms ; one API request/minute.
CREATE TABLE public.ais_fleet_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 licence_reference text CHECK(length(licence_reference) BETWEEN 1 AND 200),
 next_allowed_at timestamptz NOT NULL DEFAULT '-infinity', lease_until timestamptz,
 claim_token uuid, issued_at timestamptz, cursor bigint NOT NULL DEFAULT 0,
 day_start date NOT NULL DEFAULT current_date, day_writes integer NOT NULL DEFAULT 0,
 hour_start timestamptz NOT NULL DEFAULT date_trunc('hour',now()), hour_writes integer NOT NULL DEFAULT 0,
 day_write_limit integer NOT NULL DEFAULT 20000 CHECK(day_write_limit BETWEEN 1 AND 20000),
 hour_write_limit integer NOT NULL DEFAULT 1000 CHECK(hour_write_limit BETWEEN 1 AND 1000)
);
INSERT INTO public.ais_fleet_control(singleton) VALUES(true);
CREATE TABLE public.ais_fleet_interests (
 owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90),
 lon double precision NOT NULL CHECK(lon BETWEEN -180 AND 180),
 touched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ais_fleet_interests_active ON public.ais_fleet_interests(touched_at DESC);
CREATE INDEX IF NOT EXISTS vessel_telemetry_active_ais ON public.vessel_telemetry(reported_at DESC)
 WHERE lat IS NOT NULL AND lon IS NOT NULL;
CREATE TABLE public.ais_fleet_coverage (
 box_key text PRIMARY KEY CHECK(length(box_key)<=120),
 lat_min double precision NOT NULL,lat_max double precision NOT NULL,
 lon_min double precision NOT NULL,lon_max double precision NOT NULL,
 polled_at timestamptz NOT NULL, limited boolean NOT NULL,
 bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 1048576), rows integer NOT NULL CHECK(rows BETWEEN 0 AND 500),
 CHECK(lat_min BETWEEN -90 AND 90 AND lat_max BETWEEN -90 AND 90 AND lat_max>lat_min AND lat_max-lat_min<=8),
 CHECK(lon_min BETWEEN -180 AND 180 AND lon_max BETWEEN -180 AND 180 AND lon_max>lon_min AND lon_max-lon_min<=16.001)
);
CREATE INDEX ais_fleet_coverage_age ON public.ais_fleet_coverage(polled_at DESC);
ALTER TABLE public.ais_fleet_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ais_fleet_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ais_fleet_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ais_fleet_control,public.ais_fleet_interests,public.ais_fleet_coverage FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ais_fleet_control,public.ais_fleet_interests,public.ais_fleet_coverage TO service_role;

ALTER TABLE public.vessels ADD COLUMN IF NOT EXISTS draught_m double precision CHECK(draught_m BETWEEN 0.1 AND 25.5),
 ADD COLUMN IF NOT EXISTS eta text CHECK(length(eta)<=11),
 ADD COLUMN IF NOT EXISTS position_at timestamptz,
 ADD COLUMN IF NOT EXISTS data_source text CHECK(data_source IN('aishub','receiver','aisstream')),
 ADD COLUMN IF NOT EXISTS safety_text text CHECK(length(safety_text)<=161),
 ADD COLUMN IF NOT EXISTS safety_text_at timestamptz;
-- No timestamp backfill: legacy write times are not evidence of when a position was observed.
CREATE INDEX vessels_position_age ON public.vessels(position_at DESC) WHERE location IS NOT NULL;
REVOKE ALL ON public.vessels FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.vessels TO service_role;

CREATE FUNCTION public.claim_ais_fleet_poll() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog,public,extensions AS $$
DECLARE c public.ais_fleet_control; token uuid; centres jsonb;
BEGIN
 SELECT * INTO c FROM public.ais_fleet_control WHERE singleton FOR UPDATE;
 IF NOT c.enabled OR c.licence_reference IS NULL OR c.next_allowed_at>clock_timestamp() THEN RETURN NULL; END IF;
 IF (c.day_start=current_date AND c.day_writes>=c.day_write_limit)
  OR (c.hour_start=date_trunc('hour',now()) AND c.hour_writes>=c.hour_write_limit) THEN RETURN NULL; END IF;
 token:=gen_random_uuid();
 -- Unfinished/crashed claims cool down for three minutes; normal completion starts a fresh61s cooldown.
 UPDATE public.ais_fleet_control SET claim_token=token,issued_at=clock_timestamp(),
  next_allowed_at=clock_timestamp()+interval '3 minutes',lease_until=clock_timestamp()+interval '2 minutes',cursor=cursor+1 WHERE singleton;
 DELETE FROM public.ais_fleet_interests WHERE owner_id IN(SELECT owner_id FROM public.ais_fleet_interests WHERE touched_at<now()-interval '1 hour' LIMIT 100);
 DELETE FROM public.vessels WHERE mmsi IN(SELECT mmsi FROM public.vessels WHERE updated_at<now()-interval '24 hours' LIMIT 100);
 SELECT coalesce(jsonb_agg(jsonb_build_object('lat',lat,'lon',lon)),'[]'::jsonb) INTO centres FROM (
  SELECT lat,lon FROM (
   SELECT DISTINCT ON(owner_id) owner_id,lat,lon,at FROM (
    SELECT owner_id,lat,lon,touched_at AS at FROM (SELECT * FROM public.ais_fleet_interests WHERE touched_at>now()-interval '30 minutes' ORDER BY touched_at DESC LIMIT 64) interests
    UNION ALL
    SELECT owner_id,round(lat::numeric*4)::double precision/4,round(lon::numeric*4)::double precision/4,reported_at
     FROM (SELECT * FROM public.vessel_telemetry WHERE reported_at>now()-interval '5 minutes' AND reported_at<=now()+interval '1 minute'
      AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY reported_at DESC LIMIT 64) telemetry
   ) s ORDER BY owner_id,at DESC
  ) d ORDER BY at DESC LIMIT 64
 ) bounded;
 RETURN jsonb_build_object('token',token,'cursor',c.cursor,'centres',centres,'issued_at',clock_timestamp());
END $$;
CREATE FUNCTION public.finish_ais_fleet_poll(claim_token uuid,polled_box jsonb,outcome text,byte_count integer,row_count integer)
 RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,extensions AS $$
DECLARE c public.ais_fleet_control;
BEGIN
 SELECT * INTO c FROM public.ais_fleet_control WHERE singleton FOR UPDATE;
 IF c.claim_token IS DISTINCT FROM finish_ais_fleet_poll.claim_token OR c.lease_until<clock_timestamp() THEN RETURN; END IF;
 UPDATE public.ais_fleet_control SET claim_token=NULL,lease_until=NULL,
  next_allowed_at=clock_timestamp()+interval '61 seconds' WHERE singleton;
 IF outcome NOT IN('ok','limited','failed','empty') OR byte_count NOT BETWEEN 0 AND 1048576 OR row_count NOT BETWEEN 0 AND 500 THEN RAISE EXCEPTION 'Invalid AIS receipt'; END IF;
 DELETE FROM public.ais_fleet_coverage WHERE polled_at<now()-interval '15 minutes';
 IF polled_box IS NOT NULL AND outcome IN('ok','limited') THEN
  INSERT INTO public.ais_fleet_coverage VALUES(polled_box->>'key',(polled_box->>'latMin')::double precision,(polled_box->>'latMax')::double precision,
   (polled_box->>'lonMin')::double precision,(polled_box->>'lonMax')::double precision,clock_timestamp(),outcome='limited',byte_count,row_count)
  ON CONFLICT(box_key) DO UPDATE SET polled_at=EXCLUDED.polled_at,limited=EXCLUDED.limited,bytes=EXCLUDED.bytes,rows=EXCLUDED.rows;
 END IF;
 DELETE FROM public.ais_fleet_coverage WHERE box_key IN(SELECT box_key FROM public.ais_fleet_coverage ORDER BY polled_at DESC OFFSET 256);
END $$;
CREATE FUNCTION public.request_ais_fleet_area(request_owner uuid,query_lat double precision,query_lon double precision)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,extensions AS $$
DECLARE c public.ais_fleet_control; coverage public.ais_fleet_coverage;
BEGIN
 IF query_lat NOT BETWEEN -90 AND 90 OR query_lon NOT BETWEEN -180 AND 180 OR query_lat IS NULL OR query_lon IS NULL OR request_owner IS NULL THEN RAISE EXCEPTION 'Invalid AIS interest'; END IF;
 SELECT * INTO c FROM public.ais_fleet_control WHERE singleton;
 IF NOT c.enabled OR c.licence_reference IS NULL THEN RETURN jsonb_build_object('state','held','radiusNm',200); END IF;
 INSERT INTO public.ais_fleet_interests VALUES(request_owner,round(query_lat::numeric*4)::double precision/4,round(query_lon::numeric*4)::double precision/4,clock_timestamp())
 ON CONFLICT(owner_id) DO UPDATE SET lat=EXCLUDED.lat,lon=EXCLUDED.lon,touched_at=EXCLUDED.touched_at
 WHERE ais_fleet_interests.touched_at<clock_timestamp()-interval '5 minutes';
 SELECT * INTO coverage FROM public.ais_fleet_coverage WHERE polled_at>now()-interval '15 minutes'
  AND query_lat BETWEEN lat_min AND lat_max AND query_lon BETWEEN lon_min AND lon_max ORDER BY polled_at DESC LIMIT 1;
 RETURN jsonb_build_object('state',CASE WHEN c.day_writes>=c.day_write_limit OR c.hour_writes>=c.hour_write_limit THEN 'limited'
  WHEN coverage.box_key IS NULL THEN 'queued' WHEN coverage.limited THEN 'limited' ELSE 'recent' END,
  'polledAt',coverage.polled_at,'radiusNm',200,'maxReportAgeSeconds',900,'informational',true);
END $$;

CREATE FUNCTION public.merge_vessels_bounded(rows jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog,public,extensions AS $$
DECLARE c public.ais_fleet_control; r jsonb; prior public.vessels; fresh public.vessels; changed boolean;
 written integer:=0; limited boolean:=false; position_new boolean;
BEGIN
 IF jsonb_typeof(rows)<>'array' OR jsonb_array_length(rows)>500 OR pg_column_size(rows)>524288 THEN RAISE EXCEPTION 'AIS batch limit'; END IF;
 SELECT * INTO c FROM public.ais_fleet_control WHERE singleton FOR UPDATE;
 IF c.singleton IS DISTINCT FROM true THEN RAISE EXCEPTION 'AIS write budget unavailable'; END IF;
 IF c.day_start<>current_date THEN c.day_start:=current_date;c.day_writes:=0; END IF;
 IF c.hour_start<>date_trunc('hour',now()) THEN c.hour_start:=date_trunc('hour',now());c.hour_writes:=0; END IF;
 FOR r IN SELECT jsonb_strip_nulls(value) FROM jsonb_array_elements(rows) LOOP
  IF (r->>'mmsi') IS NULL OR (r->>'mmsi')!~'^[1-9][0-9]{8}$' THEN RAISE EXCEPTION 'Invalid AIS MMSI'; END IF;
  SELECT * INTO prior FROM public.vessels WHERE mmsi=(r->>'mmsi')::bigint;
  fresh:=jsonb_populate_record(prior,r);
  IF NOT(r ? 'safety_text_at') OR fresh.safety_text_at<now()-interval '15 minutes' OR fresh.safety_text_at>now()+interval '1 minute'
   OR (prior.safety_text_at IS NOT NULL AND fresh.safety_text_at<prior.safety_text_at) THEN
   fresh.safety_text:=prior.safety_text;fresh.safety_text_at:=prior.safety_text_at;
  END IF;
  position_new:=r ? 'location' AND r ? 'position_at' AND fresh.position_at<=now()+interval '1 minute'
   AND fresh.position_at>now()-interval '15 minutes' AND (prior.position_at IS NULL OR fresh.position_at>=prior.position_at);
  IF NOT position_new THEN
   fresh.location:=prior.location;fresh.position_at:=prior.position_at;fresh.data_source:=prior.data_source;
   fresh.cog:=prior.cog;fresh.sog:=prior.sog;fresh.heading:=prior.heading;fresh.nav_status:=prior.nav_status;
  END IF;
  -- Physical/static changes survive restarts; repeat packets do not rewrite the heap/GIST/WAL.
  changed:=prior.mmsi IS NULL OR
   (to_jsonb(fresh)-ARRAY['updated_at','position_at','location','cog','sog','heading','nav_status','data_source','safety_text_at']) IS DISTINCT FROM
   (to_jsonb(prior)-ARRAY['updated_at','position_at','location','cog','sog','heading','nav_status','data_source','safety_text_at']);
  changed:=changed OR (fresh.safety_text_at IS NOT NULL AND (prior.safety_text_at IS NULL OR (fresh.safety_text_at>prior.safety_text_at AND prior.safety_text_at<now()-interval '10 minutes')));
  IF position_new THEN changed:=changed OR prior.location IS NULL OR ST_Distance(prior.location,fresh.location)>=25
   OR (coalesce(fresh.sog,0)>=0.5 AND fresh.sog IS DISTINCT FROM prior.sog)
   OR (coalesce(prior.sog,0)>=0.5 AND coalesce(fresh.sog,0)<0.5)
   OR fresh.nav_status IS DISTINCT FROM prior.nav_status
   OR abs(coalesce(fresh.heading,0)-coalesce(prior.heading,0))>=5
   OR (coalesce(fresh.sog,0)>=0.5 AND abs(coalesce(fresh.cog,0)-coalesce(prior.cog,0))>=5)
   OR prior.position_at<now()-interval '10 minutes'; END IF;
  IF NOT changed THEN CONTINUE; END IF;
  IF c.day_writes>=c.day_write_limit OR c.hour_writes>=c.hour_write_limit THEN limited:=true;CONTINUE; END IF;
  fresh.updated_at:=clock_timestamp();
  INSERT INTO public.vessels SELECT (fresh).* ON CONFLICT(mmsi) DO UPDATE SET
   name=EXCLUDED.name,call_sign=EXCLUDED.call_sign,ship_type=EXCLUDED.ship_type,destination=EXCLUDED.destination,imo_number=EXCLUDED.imo_number,
   location=EXCLUDED.location,cog=EXCLUDED.cog,sog=EXCLUDED.sog,heading=EXCLUDED.heading,nav_status=EXCLUDED.nav_status,
   dimension_a=EXCLUDED.dimension_a,dimension_b=EXCLUDED.dimension_b,dimension_c=EXCLUDED.dimension_c,dimension_d=EXCLUDED.dimension_d,
   draught_m=EXCLUDED.draught_m,eta=EXCLUDED.eta,position_at=EXCLUDED.position_at,data_source=EXCLUDED.data_source,
   safety_text=EXCLUDED.safety_text,safety_text_at=EXCLUDED.safety_text_at,updated_at=EXCLUDED.updated_at;
  written:=written+1;c.day_writes:=c.day_writes+1;c.hour_writes:=c.hour_writes+1;
 END LOOP;
 UPDATE public.ais_fleet_control SET day_start=c.day_start,day_writes=c.day_writes,hour_start=c.hour_start,hour_writes=c.hour_writes WHERE singleton;
 RETURN jsonb_build_object('written',written,'limited',limited);
END $$;
-- Keep old receivers compatible while giving their writes the same persisted global budget.
CREATE OR REPLACE FUNCTION public.merge_vessels(rows jsonb) RETURNS integer LANGUAGE sql SECURITY INVOKER
 SET search_path=pg_catalog,public,extensions AS $$SELECT (public.merge_vessels_bounded(rows)->>'written')::integer$$;

CREATE FUNCTION public.vessels_nearby_v135(query_lat double precision,query_lon double precision,radius_m double precision DEFAULT 46300,max_results integer DEFAULT 500)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,extensions AS $$
BEGIN
 IF query_lat IS NULL OR query_lon IS NULL OR query_lat NOT BETWEEN -90 AND 90 OR query_lon NOT BETWEEN -180 AND 180
  OR radius_m IS NULL OR radius_m NOT BETWEEN 926 AND 370400 OR max_results IS NULL OR max_results NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid AIS query bounds'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ais_fleet_control WHERE singleton AND enabled AND licence_reference IS NOT NULL) THEN RETURN '[]'::jsonb; END IF;
 RETURN (SELECT coalesce(jsonb_agg((to_jsonb(selected)-'location')||jsonb_build_object('lat',ST_Y(selected.location::geometry),'lon',ST_X(selected.location::geometry),'updated_at',selected.position_at)),'[]'::jsonb) FROM (
 SELECT v.* FROM public.vessels v WHERE v.position_at>now()-interval '15 minutes' AND v.position_at<=now()+interval '1 minute'
  AND ST_DWithin(v.location,ST_SetSRID(ST_MakePoint(query_lon,query_lat),4326)::geography,radius_m)
 ORDER BY ST_Distance(v.location,ST_SetSRID(ST_MakePoint(query_lon,query_lat),4326)::geography),v.mmsi LIMIT max_results) selected);
END $$;
CREATE OR REPLACE FUNCTION public.vessels_nearby(query_lat double precision,query_lon double precision,radius_m double precision DEFAULT 46300,max_results integer DEFAULT 250)
 RETURNS TABLE(mmsi bigint,name text,call_sign text,ship_type integer,destination text,lat double precision,lon double precision,cog double precision,sog double precision,heading integer,nav_status integer,updated_at timestamptz)
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,extensions AS $$
 SELECT v.mmsi,v.name,v.call_sign,v.ship_type,v.destination,v.lat,v.lon,v.cog,v.sog,v.heading,v.nav_status,v.updated_at
 FROM jsonb_to_recordset(public.vessels_nearby_v135(query_lat,query_lon,least(radius_m,185200),least(max_results,250))) AS v(mmsi bigint,name text,call_sign text,ship_type integer,destination text,lat double precision,lon double precision,cog double precision,sog double precision,heading integer,nav_status integer,updated_at timestamptz)$$;
REVOKE ALL ON FUNCTION public.claim_ais_fleet_poll(),public.finish_ais_fleet_poll(uuid,jsonb,text,integer,integer),
 public.request_ais_fleet_area(uuid,double precision,double precision),public.merge_vessels_bounded(jsonb),public.merge_vessels(jsonb),
 public.vessels_nearby_v135(double precision,double precision,double precision,integer),public.vessels_nearby(double precision,double precision,double precision,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ais_fleet_poll(),public.finish_ais_fleet_poll(uuid,jsonb,text,integer,integer),
 public.request_ais_fleet_area(uuid,double precision,double precision),public.merge_vessels_bounded(jsonb),public.merge_vessels(jsonb),
 public.vessels_nearby_v135(double precision,double precision,double precision,integer),public.vessels_nearby(double precision,double precision,double precision,integer) TO service_role;
