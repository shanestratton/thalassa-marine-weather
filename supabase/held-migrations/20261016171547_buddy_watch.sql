-- HELD 137-07. No cron/provider poll or delivery is enabled by this migration.
BEGIN;
CREATE SCHEMA private_buddy_watch;
REVOKE ALL ON SCHEMA private_buddy_watch FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private_buddy_watch TO service_role;
CREATE TABLE private_buddy_watch.control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 licence_reference text CHECK(length(licence_reference) BETWEEN 1 AND 200), entitlement_until timestamptz,
 function_version integer NOT NULL DEFAULT 0 CHECK(function_version BETWEEN 0 AND 1),
 delivery_version integer NOT NULL DEFAULT 0 CHECK(delivery_version BETWEEN 0 AND 1), succeeded_at timestamptz
);
INSERT INTO private_buddy_watch.control(singleton) VALUES(true);
CREATE FUNCTION private_buddy_watch.valid_configuration(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE a jsonb;
BEGIN
 IF jsonb_typeof(p)<>'object' OR NOT p ?& ARRAY['mmsi','label','enabled','area'] OR p-ARRAY['mmsi','label','enabled','area']<>'{}' OR
 jsonb_typeof(p->'mmsi')<>'number' OR (p->>'mmsi')!~'^[1-7][0-9]{8}$' OR jsonb_typeof(p->'enabled')<>'boolean' OR
 jsonb_typeof(p->'label')<>'string' OR length(p->>'label') NOT BETWEEN 1 AND 60 OR p->>'label'<>btrim(p->>'label') OR (p->>'label')~'[[:cntrl:]]' THEN RETURN false; END IF;
 a:=p->'area'; IF a='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(a)<>'object' OR NOT a ?& ARRAY['lat','lon','radiusNm','label'] OR a-ARRAY['lat','lon','radiusNm','label']<>'{}' OR
 jsonb_typeof(a->'lat')<>'number' OR jsonb_typeof(a->'lon')<>'number' OR jsonb_typeof(a->'radiusNm')<>'number' OR
 jsonb_typeof(a->'label')<>'string' OR length(a->>'label') NOT BETWEEN 1 AND 60 OR a->>'label'<>btrim(a->>'label') OR (a->>'label')~'[[:cntrl:]]' THEN RETURN false; END IF;
 RETURN (a->>'lat')::double precision BETWEEN -90 AND 90 AND (a->>'lon')::double precision BETWEEN -180 AND 180 AND (a->>'radiusNm')::double precision BETWEEN .2 AND 50;
END $$;
CREATE TABLE public.vessel_watchlist (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 boat_id uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
 revision uuid NOT NULL DEFAULT gen_random_uuid(), configuration jsonb NOT NULL CHECK(private_buddy_watch.valid_configuration(configuration) IS TRUE)
);
CREATE UNIQUE INDEX buddy_watch_owner_mmsi ON public.vessel_watchlist(owner_id,((configuration->>'mmsi')));
CREATE INDEX buddy_watch_boat ON public.vessel_watchlist(boat_id);
CREATE INDEX buddy_watch_active_id ON public.vessel_watchlist(id) WHERE (configuration->>'enabled')::boolean;
CREATE TABLE private_buddy_watch.states (
 watch_id uuid PRIMARY KEY REFERENCES public.vessel_watchlist(id) ON DELETE CASCADE,
 revision uuid NOT NULL DEFAULT gen_random_uuid(), state jsonb NOT NULL,
 notice_id uuid, notice_event text, notice_observed_at bigint, last_notice_at timestamptz
);
CREATE TABLE private_buddy_watch.quotas(owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,day_start date NOT NULL,used integer NOT NULL CHECK(used BETWEEN 0 AND 12));
ALTER TABLE public.vessel_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_buddy_watch.control ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_buddy_watch.states ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_buddy_watch.quotas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vessel_watchlist FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.vessel_watchlist TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.vessel_watchlist TO service_role;
CREATE POLICY buddy_owner_read ON public.vessel_watchlist FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.boats b WHERE b.id=boat_id AND b.owner_id=(SELECT auth.uid())));
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA private_buddy_watch TO service_role;
CREATE FUNCTION private_buddy_watch.permitted() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM private_buddy_watch.control c,public.ais_fleet_control f WHERE c.singleton AND f.singleton AND c.enabled AND c.licence_reference IS NOT NULL AND c.entitlement_until>now() AND c.delivery_version=1 AND f.enabled AND f.licence_reference IS NOT NULL);
$$;
CREATE FUNCTION private_buddy_watch.ready() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE scheduled boolean:=false;
BEGIN
 IF NOT private_buddy_watch.permitted() OR NOT EXISTS(SELECT 1 FROM private_buddy_watch.control WHERE function_version=1 AND succeeded_at>now()-interval '15 minutes') OR to_regclass('cron.job') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job WHERE active AND jobname=$1 AND schedule=$2 AND command=$3)' INTO scheduled USING 'buddy-watch','*/5 * * * *','SELECT public.invoke_edge_function(''buddy-watch'', 25000)';
 RETURN scheduled;
END $$;
CREATE FUNCTION public.buddy_watch_list(p_boat_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller uuid:=auth.uid(); rows jsonb;
BEGIN
 IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=p_boat_id AND owner_id=caller) THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'revision',w.revision,'configuration',w.configuration,'state',s.state)),'[]'::jsonb) INTO rows FROM public.vessel_watchlist w LEFT JOIN private_buddy_watch.states s ON s.watch_id=w.id WHERE w.owner_id=caller AND w.boat_id=p_boat_id;
 RETURN jsonb_build_object('schema',1,'ownerId',caller,'boatId',p_boat_id,'ready',private_buddy_watch.ready(),'checkedAt',floor(extract(epoch FROM statement_timestamp())*1000),'watches',rows);
END $$;
CREATE FUNCTION public.configure_buddy_watch(p_boat_id uuid,p_watch_id uuid,p_expected uuid,p_configuration jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller uuid:=auth.uid(); w public.vessel_watchlist%ROWTYPE; next_revision uuid:=gen_random_uuid();
BEGIN
 IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=p_boat_id AND owner_id=caller) THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('buddy-watch:'||caller::text,0));
 PERFORM 1 FROM public.boats WHERE id=p_boat_id AND owner_id=caller FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Vessel ownership changed' USING ERRCODE='42501'; END IF;
 -- Reclaim only this caller's no-longer-owned hull follows, so hidden rows
 -- cannot permanently strand the account's ten bounded slots.
 DELETE FROM public.vessel_watchlist old WHERE old.owner_id=caller AND NOT EXISTS(SELECT 1 FROM public.boats b WHERE b.id=old.boat_id AND b.owner_id=caller);
 IF p_watch_id IS NOT NULL THEN
  SELECT * INTO w FROM public.vessel_watchlist WHERE id=p_watch_id AND owner_id=caller AND boat_id=p_boat_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned watch required' USING ERRCODE='42501'; END IF;
  IF w.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Review current watch revision' USING ERRCODE='40001'; END IF;
 ELSIF p_expected IS NOT NULL THEN RAISE EXCEPTION 'New watch requires empty expected revision' USING ERRCODE='40001'; END IF;
 IF p_configuration IS NULL THEN
  IF w.id IS NULL THEN RAISE EXCEPTION 'Existing watch required' USING ERRCODE='22023'; END IF;
  DELETE FROM public.vessel_watchlist WHERE id=w.id; RETURN next_revision;
 END IF;
 IF private_buddy_watch.valid_configuration(p_configuration) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid fixed buddy configuration' USING ERRCODE='22023'; END IF;
 IF (p_configuration->>'enabled')::boolean AND NOT private_buddy_watch.ready() THEN RAISE EXCEPTION 'Buddy source or delivery capability held' USING ERRCODE='55000'; END IF;
 IF w.id IS NULL AND (SELECT count(*) FROM public.vessel_watchlist WHERE owner_id=caller)>=10 THEN RAISE EXCEPTION 'At most ten buddy boats' USING ERRCODE='54000'; END IF;
 IF w.id IS NULL THEN INSERT INTO public.vessel_watchlist(owner_id,boat_id,revision,configuration) VALUES(caller,p_boat_id,next_revision,p_configuration);
 ELSE UPDATE public.vessel_watchlist SET revision=next_revision,configuration=p_configuration WHERE id=w.id; DELETE FROM private_buddy_watch.states WHERE watch_id=w.id; END IF;
 RETURN next_revision;
END $$;
-- Only this fixed latest-state adapter sees provider coordinates, solely to
-- calculate distance from an explicitly selected private area. It returns no coordinate.
CREATE FUNCTION private_buddy_watch.facts(p_mmsi bigint,p_area jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v public.vessels%ROWTYPE; distance_nm double precision; spatial_schema text;
BEGIN
 SELECT * INTO v FROM public.vessels WHERE mmsi=p_mmsi AND data_source='aishub';
 IF NOT FOUND OR v.position_at IS NULL OR v.location IS NULL THEN RETURN NULL; END IF;
 IF p_area IS NOT NULL AND p_area<>'null'::jsonb THEN
  SELECT n.nspname INTO spatial_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='postgis';
  IF spatial_schema IS NOT NULL THEN EXECUTE format('SELECT %I.ST_Distance($1,%I.ST_SetSRID(%I.ST_MakePoint($2,$3),4326)::%I.geography)/1852.0',spatial_schema,spatial_schema,spatial_schema,spatial_schema) INTO distance_nm USING v.location,(p_area->>'lon')::double precision,(p_area->>'lat')::double precision; END IF;
 END IF;
 RETURN jsonb_build_object('at',floor(extract(epoch FROM v.position_at)*1000),'sog',CASE WHEN v.sog BETWEEN 0 AND 102.3 THEN v.sog ELSE NULL END,'navStatus',CASE WHEN v.nav_status BETWEEN 0 AND 15 THEN v.nav_status ELSE NULL END,'distanceNm',distance_nm);
END $$;
CREATE FUNCTION public.buddy_watch_work(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 32) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE rows jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'Bounded page required'; END IF;
 IF NOT private_buddy_watch.permitted() THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'revision',w.revision,'configuration',w.configuration,'stateRevision',s.revision,'state',s.state,'facts',private_buddy_watch.facts((w.configuration->>'mmsi')::bigint,w.configuration->'area')) ORDER BY w.id),'[]'::jsonb) INTO rows
 FROM (SELECT x.* FROM public.vessel_watchlist x JOIN public.boats b ON b.id=x.boat_id AND b.owner_id=x.owner_id WHERE (x.configuration->>'enabled')::boolean AND (p_after IS NULL OR x.id>p_after) ORDER BY x.id LIMIT p_limit) w LEFT JOIN private_buddy_watch.states s ON s.watch_id=w.id;
 RETURN rows;
END $$;
CREATE FUNCTION public.buddy_watch_apply(p_id uuid,p_revision uuid,p_state_revision uuid,p_facts jsonb,p_result jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.vessel_watchlist%ROWTYPE; s private_buddy_watch.states%ROWTYPE; q private_buddy_watch.quotas%ROWTYPE; next_state jsonb; event text; observed bigint; receipt uuid; words text;
BEGIN
 IF NOT private_buddy_watch.permitted() THEN RETURN false; END IF;
 SELECT * INTO w FROM public.vessel_watchlist WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR w.revision IS DISTINCT FROM p_revision OR NOT (w.configuration->>'enabled')::boolean OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=w.boat_id AND owner_id=w.owner_id) THEN RETURN false; END IF;
 SELECT * INTO s FROM private_buddy_watch.states WHERE watch_id=w.id FOR UPDATE;
 IF s.revision IS DISTINCT FROM p_state_revision OR private_buddy_watch.facts((w.configuration->>'mmsi')::bigint,w.configuration->'area') IS DISTINCT FROM p_facts THEN RETURN false; END IF;
 IF jsonb_typeof(p_result)<>'object' OR NOT p_result ?& ARRAY['state','event'] OR p_result-ARRAY['state','event']<>'{}' THEN RAISE EXCEPTION 'Fixed assessment required'; END IF;
 next_state:=p_result->'state';event:=p_result->>'event';
 IF jsonb_typeof(next_state)<>'object' OR NOT next_state ?& ARRAY['observedAt','mode','area','candidate','candidateSince','areaCandidate','areaSince','notSeen'] OR next_state-ARRAY['observedAt','mode','area','candidate','candidateSince','areaCandidate','areaSince','notSeen']<>'{}' OR
 (next_state->>'mode') NOT IN('unknown','stopped','moving','moored') OR (next_state->>'area') NOT IN('unknown','inside','outside') OR jsonb_typeof(next_state->'notSeen')<>'boolean' OR
 (event IS NOT NULL AND event NOT IN('moving','moored','underway','entered','left','not-seen')) THEN RAISE EXCEPTION 'Invalid assessment'; END IF;
 observed:=(next_state->>'observedAt')::bigint;
 IF observed>floor(extract(epoch FROM clock_timestamp())*1000) OR (s.state->>'observedAt')::bigint>observed THEN RETURN false; END IF;
 IF next_state IS NOT DISTINCT FROM s.state THEN RETURN false; END IF;
 INSERT INTO private_buddy_watch.states(watch_id,state) VALUES(w.id,next_state) ON CONFLICT(watch_id) DO UPDATE SET revision=gen_random_uuid(),state=excluded.state;
 IF event IS NULL OR NOT EXISTS(SELECT 1 FROM public.push_device_tokens WHERE user_id=w.owner_id) OR (s.last_notice_at IS NOT NULL AND s.last_notice_at>now()-interval '30 minutes') THEN RETURN true; END IF;
 IF event='not-seen' THEN
  IF observed IS NULL OR observed>floor(extract(epoch FROM now()-interval '15 minutes')*1000) THEN RETURN true; END IF;
 ELSIF p_facts IS NULL OR observed IS DISTINCT FROM (p_facts->>'at')::bigint OR observed<floor(extract(epoch FROM now()-interval '15 minutes')*1000) THEN RETURN true; END IF;
 INSERT INTO private_buddy_watch.quotas VALUES(w.owner_id,(now() AT TIME ZONE 'UTC')::date,0) ON CONFLICT DO NOTHING;
 SELECT * INTO q FROM private_buddy_watch.quotas WHERE owner_id=w.owner_id FOR UPDATE;
 IF q.day_start<>(now() AT TIME ZONE 'UTC')::date THEN q.day_start:=(now() AT TIME ZONE 'UTC')::date;q.used:=0; END IF;
 IF q.used>=12 THEN RETURN true; END IF;
 receipt:=gen_random_uuid();words:=CASE event WHEN 'moving' THEN 'AIS reports moving' WHEN 'moored' THEN 'AIS reports anchored or moored' WHEN 'underway' THEN 'AIS reports under way' WHEN 'entered' THEN 'Entered your chosen area in available AIS reports' WHEN 'left' THEN 'Left your chosen area in available AIS reports' ELSE 'Not seen in available AIS coverage; position unknown' END;
 INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,title,body,data) VALUES(w.owner_id,'buddy_notice','Buddy boat update',left(w.configuration->>'label',60)||': '||words||'. Last report '||to_char(to_timestamp(observed/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')||' UTC. Informational; coverage is incomplete.',jsonb_build_object('buddy_watch',1,'watch_id',w.id,'revision',w.revision,'receipt_id',receipt,'event',event,'observed_at',observed));
 UPDATE private_buddy_watch.states SET notice_id=receipt,notice_event=event,notice_observed_at=observed,last_notice_at=now() WHERE watch_id=w.id;
 UPDATE private_buddy_watch.quotas SET day_start=q.day_start,used=q.used+1 WHERE owner_id=w.owner_id;
 RETURN true;
END $$;
CREATE FUNCTION public.buddy_watch_finish(p_success boolean) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$UPDATE private_buddy_watch.control SET function_version=1,succeeded_at=CASE WHEN p_success THEN clock_timestamp() ELSE NULL END WHERE singleton$$;
CREATE FUNCTION public.buddy_notice_delivery(p_queue_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT private_buddy_watch.ready() AND EXISTS(SELECT 1 FROM public.push_notification_queue q JOIN public.vessel_watchlist w ON w.id=(q.data->>'watch_id')::uuid JOIN private_buddy_watch.states s ON s.watch_id=w.id JOIN public.boats b ON b.id=w.boat_id AND b.owner_id=w.owner_id WHERE q.id=p_queue_id AND q.notification_type='buddy_notice' AND q.recipient_user_id=w.owner_id AND q.created_at>now()-interval '30 minutes' AND (w.configuration->>'enabled')::boolean AND q.data->>'revision'=w.revision::text AND q.data->>'receipt_id'=s.notice_id::text AND q.data->>'event'=s.notice_event AND (q.data->>'observed_at')::bigint=s.notice_observed_at AND s.state->>'observedAt'=q.data->>'observed_at' AND CASE WHEN s.notice_event='not-seen' THEN (private_buddy_watch.facts((w.configuration->>'mmsi')::bigint,w.configuration->'area')->>'at')::bigint IS NULL OR (private_buddy_watch.facts((w.configuration->>'mmsi')::bigint,w.configuration->'area')->>'at')::bigint<floor(extract(epoch FROM now()-interval '15 minutes')*1000) ELSE s.notice_observed_at>floor(extract(epoch FROM now()-interval '15 minutes')*1000) END);
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_buddy_watch FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private_buddy_watch TO service_role;
REVOKE ALL ON FUNCTION public.buddy_watch_list(uuid),public.configure_buddy_watch(uuid,uuid,uuid,jsonb),public.buddy_watch_work(uuid,integer),public.buddy_watch_apply(uuid,uuid,uuid,jsonb,jsonb),public.buddy_watch_finish(boolean),public.buddy_notice_delivery(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.buddy_watch_list(uuid),public.configure_buddy_watch(uuid,uuid,uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buddy_watch_work(uuid,integer),public.buddy_watch_apply(uuid,uuid,uuid,jsonb,jsonb),public.buddy_watch_finish(boolean),public.buddy_notice_delivery(uuid) TO service_role;
COMMIT;
