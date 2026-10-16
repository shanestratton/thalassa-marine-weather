-- HELD: no cron is activated here. Review source, ACL/concurrency proof, provider
-- permission, sender guard and real scheduled heartbeat before releasing this file.
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS public.weather_watch_profiles (
    boat_id uuid PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    preferences jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(preferences) = 'object' AND octet_length(preferences::text) <= 16384)
);
ALTER TABLE public.weather_watch_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS weather_watch_owner_read ON public.weather_watch_profiles;
CREATE POLICY weather_watch_owner_read ON public.weather_watch_profiles FOR SELECT TO authenticated
USING (owner_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.boats b WHERE b.id=boat_id AND b.owner_id=(SELECT auth.uid()) AND b.archived_at IS NULL));
REVOKE ALL ON public.weather_watch_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.weather_watch_profiles TO authenticated;
GRANT ALL ON public.weather_watch_profiles TO service_role;

CREATE TABLE IF NOT EXISTS private.weather_watch_health (
    feature text PRIMARY KEY CHECK (feature IN ('morning','rain','storm','gust')),
    job_name text NOT NULL,
    function_version integer NOT NULL DEFAULT 0,
    delivery_version integer NOT NULL DEFAULT 0,
    -- Set ONLY after real permission/entitlement review, never from key presence.
    entitlement_until timestamptz,
    succeeded_at timestamptz
);
INSERT INTO private.weather_watch_health(feature,job_name) VALUES
('morning','morning-briefing'),('rain','nowcast-watch'),('storm','convective-watch'),('gust','convective-watch') ON CONFLICT DO NOTHING;
REVOKE ALL ON private.weather_watch_health FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.weather_watch_health TO service_role;

CREATE TABLE IF NOT EXISTS private.weather_watch_deliveries (
    queue_id uuid PRIMARY KEY REFERENCES public.push_notification_queue(id) ON DELETE CASCADE,
    boat_id uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    revision uuid NOT NULL,
    feature text NOT NULL CHECK (feature IN ('morning','rain','storm','gust')),
    event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
    sample_key text NOT NULL,
    source_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(boat_id,feature,event_key)
);
CREATE INDEX IF NOT EXISTS weather_watch_daily_quota ON private.weather_watch_deliveries(boat_id,feature,created_at DESC);
CREATE INDEX IF NOT EXISTS weather_watch_owner_quota ON private.weather_watch_deliveries(owner_id,feature,created_at DESC);
REVOKE ALL ON private.weather_watch_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.weather_watch_deliveries TO service_role;

CREATE OR REPLACE FUNCTION private.weather_watch_service() RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')='service_role'
$$;
REVOKE ALL ON FUNCTION private.weather_watch_service() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.weather_watch_preferences_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE s jsonb; n numeric; k text; max_age numeric; stamp numeric := extract(epoch FROM now())*1000;
BEGIN
    IF jsonb_typeof(p)<>'object' OR octet_length(p::text)>16384 OR
       (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p) key) <> ARRAY['gust','gustKts','hour','morning','rain','samples','storm','zone'] THEN RETURN false; END IF;
    FOREACH k IN ARRAY ARRAY['morning','rain','storm','gust'] LOOP
        IF jsonb_typeof(p->k) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(p->'hour') IS DISTINCT FROM 'number' OR (p->>'hour')::numeric NOT BETWEEN 0 AND 23 OR
       (p->>'hour')::numeric <> trunc((p->>'hour')::numeric) OR jsonb_typeof(p->'zone') IS DISTINCT FROM 'string' OR
       NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=p->>'zone') OR
       (p->>'zone'<>'UTC' AND position('/' in p->>'zone')=0) OR
       jsonb_typeof(p->'samples') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'samples')>16 THEN RETURN false; END IF;
    IF p->'gustKts' <> 'null'::jsonb AND (jsonb_typeof(p->'gustKts')<>'number' OR (p->>'gustKts')::numeric NOT BETWEEN 1 AND 200) THEN RETURN false; END IF;
    IF (p->>'gust')::boolean AND p->'gustKts'='null'::jsonb THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p->'samples') x WHERE x->>'kind'='boat')>1 OR
       (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(p->'samples') x)<>jsonb_array_length(p->'samples') THEN RETURN false; END IF;
    FOR s IN SELECT * FROM jsonb_array_elements(p->'samples') LOOP
        IF jsonb_typeof(s)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(s) key)<>ARRAY['expiresAt','key','kind','label','lat','lon','sourceAt'] OR
           jsonb_typeof(s->'key') IS DISTINCT FROM 'string' OR s->>'key' !~ '^[a-zA-Z0-9:_-]{1,64}$' OR
           jsonb_typeof(s->'label') IS DISTINCT FROM 'string' OR length(s->>'label') NOT BETWEEN 1 AND 64 OR s->>'label' ~ '[[:cntrl:]]' OR
           jsonb_typeof(s->'kind') IS DISTINCT FROM 'string' OR s->>'kind' NOT IN ('boat','spot','route') THEN RETURN false; END IF;
        FOREACH k IN ARRAY ARRAY['lat','lon','sourceAt','expiresAt'] LOOP
            IF jsonb_typeof(s->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        END LOOP;
        IF abs((s->>'lat')::numeric)>90 OR abs((s->>'lon')::numeric)>180 THEN RETURN false; END IF;
        max_age := CASE s->>'kind' WHEN 'boat' THEN 900000 WHEN 'route' THEN 172800000 ELSE 2592000000 END;
        IF (s->>'sourceAt')::numeric > stamp OR (s->>'sourceAt')::numeric<=0 OR
           (s->>'sourceAt')::numeric<>trunc((s->>'sourceAt')::numeric) OR (s->>'expiresAt')::numeric<>trunc((s->>'expiresAt')::numeric) OR
           (s->>'expiresAt')::numeric<=(s->>'sourceAt')::numeric OR (s->>'expiresAt')::numeric-(s->>'sourceAt')::numeric>max_age THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION private.weather_watch_preferences_valid(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.weather_watch_configure(p_boat_id uuid,p_expected uuid,p_preferences jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old public.weather_watch_profiles; result public.weather_watch_profiles; caller uuid := auth.uid();
BEGIN
    -- Boat-scoped transaction lock also serializes first insertion, quota claims and retirement.
    PERFORM pg_advisory_xact_lock(hashtextextended('weather-watch:'||p_boat_id::text,0));
    PERFORM 1 FROM public.boats b WHERE b.id=p_boat_id AND b.owner_id=caller AND b.archived_at IS NULL FOR SHARE;
    IF caller IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    SELECT * INTO old FROM public.weather_watch_profiles WHERE boat_id=p_boat_id FOR UPDATE;
    IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Configuration changed; review it again' USING ERRCODE='40001'; END IF;
    IF NOT private.weather_watch_preferences_valid(p_preferences) THEN RAISE EXCEPTION 'Invalid weather watch preferences' USING ERRCODE='22023'; END IF;
    INSERT INTO public.weather_watch_profiles(boat_id,owner_id,preferences) VALUES(p_boat_id,caller,p_preferences)
    ON CONFLICT(boat_id) DO UPDATE SET owner_id=caller,preferences=p_preferences,revision=gen_random_uuid(),updated_at=now() RETURNING * INTO result;
    RETURN jsonb_build_object('revision',result.revision,'preferences',result.preferences);
END $$;
REVOKE ALL ON FUNCTION private.weather_watch_configure(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA private TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.weather_watch_configure(uuid,uuid,jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.configure_weather_watch(p_boat_id uuid,p_expected uuid,p_preferences jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private.weather_watch_configure(p_boat_id,p_expected,p_preferences) $$;
REVOKE ALL ON FUNCTION public.configure_weather_watch(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.configure_weather_watch(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION private.weather_watch_scheduled(p_name text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result boolean;
BEGIN
    IF to_regclass('cron.job') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN RETURN false; END IF;
    IF p_name NOT IN ('morning-briefing','nowcast-watch','convective-watch') THEN RETURN false; END IF;
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job j JOIN cron.job_run_details r USING(jobid) WHERE j.jobname=$1 AND j.active AND j.schedule=$2 AND regexp_replace(btrim(j.command),''\s+'','' '',''g'')=$3 AND r.status=''succeeded'' AND r.end_time>now()-interval ''2 hours'')'
    INTO result USING p_name,CASE p_name WHEN 'morning-briefing' THEN '*/15 * * * *' WHEN 'nowcast-watch' THEN '*/5 * * * *' ELSE '*/30 * * * *' END,
        format('SELECT public.invoke_edge_function(%L, 55000)',p_name);
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION private.weather_watch_scheduled(text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.weather_watch_status(p_boat_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; profile jsonb;
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=p_boat_id AND owner_id=auth.uid() AND archived_at IS NULL) THEN RETURN NULL; END IF;
    SELECT jsonb_build_object('revision',revision,'preferences',preferences) INTO profile FROM public.weather_watch_profiles WHERE boat_id=p_boat_id AND owner_id=auth.uid();
    SELECT jsonb_object_agg(feature,jsonb_build_object('functionVersion',function_version,'deliveryVersion',delivery_version,
        'scheduled',private.weather_watch_scheduled(job_name),'entitlementUntil',extract(epoch FROM entitlement_until)*1000,
        'succeededAt',extract(epoch FROM succeeded_at)*1000)) INTO result FROM private.weather_watch_health;
    RETURN jsonb_build_object('schema',1,'profile',profile,'capabilities',result);
END $$;
REVOKE ALL ON FUNCTION private.weather_watch_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.weather_watch_status(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.weather_watch_status(p_boat_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT private.weather_watch_status(p_boat_id) $$;
REVOKE ALL ON FUNCTION public.weather_watch_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.weather_watch_status(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.weather_watch_claim(p_boat_id uuid,p_revision uuid,p_feature text,p_sample text,p_event text,p_source_at timestamptz,p_expires timestamptz,p_title text,p_body text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.weather_watch_profiles; q uuid; sent integer; ttl interval; s jsonb;
BEGIN
    IF NOT private.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    IF p_feature NOT IN ('morning','rain','storm','gust') OR p_expires<=now() OR p_expires>now()+interval '1 hour' OR
       p_source_at>now() OR p_source_at<now()-interval '24 hours' OR length(p_event) NOT BETWEEN 1 AND 200 OR
       length(p_title) NOT BETWEEN 1 AND 100 OR length(p_body) NOT BETWEEN 1 AND 500 THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('weather-watch:'||p_boat_id::text,0));
    SELECT * INTO p FROM public.weather_watch_profiles WHERE boat_id=p_boat_id FOR UPDATE;
    IF p.revision IS DISTINCT FROM p_revision OR p.preferences->p_feature<>'true'::jsonb THEN RETURN false; END IF;
    PERFORM 1 FROM public.boats WHERE id=p_boat_id AND owner_id=p.owner_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('weather-watch-owner:'||p.owner_id::text,0));
    SELECT value INTO s FROM jsonb_array_elements(p.preferences->'samples') WHERE value->>'key'=p_sample AND (value->>'expiresAt')::numeric>extract(epoch FROM now())*1000;
    IF s IS NULL OR (p_feature IN ('morning','rain') AND s->>'kind'<>'boat') THEN RETURN false; END IF;
    IF NOT EXISTS(SELECT 1 FROM private.weather_watch_health h WHERE h.feature=p_feature AND h.function_version=1 AND h.delivery_version=1 AND h.entitlement_until>now() AND h.succeeded_at>now()-(CASE WHEN p_feature='rain' THEN interval '15 minutes' ELSE interval '2 hours' END) AND private.weather_watch_scheduled(h.job_name)) THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM private.weather_watch_deliveries WHERE boat_id=p_boat_id AND feature=p_feature AND event_key=p_event) THEN RETURN false; END IF;
    IF p_feature='morning' AND (p_event<>to_char(now() AT TIME ZONE (p.preferences->>'zone'),'YYYY-MM-DD') OR extract(hour FROM now() AT TIME ZONE (p.preferences->>'zone'))<>(p.preferences->>'hour')::integer) THEN RETURN false; END IF;
    ttl := CASE WHEN p_feature='morning' THEN interval '0' WHEN p_feature='rain' THEN interval '2 hours' ELSE interval '3 hours' END;
    IF EXISTS(SELECT 1 FROM private.weather_watch_deliveries WHERE boat_id=p_boat_id AND feature=p_feature AND created_at>now()-ttl) THEN RETURN false; END IF;
    SELECT count(*) INTO sent FROM private.weather_watch_deliveries WHERE boat_id=p_boat_id AND feature=p_feature AND created_at>now()-interval '24 hours';
    IF p_feature<>'morning' AND sent >= (CASE WHEN p_feature='rain' THEN 6 ELSE 4 END) THEN RETURN false; END IF;
    SELECT count(*) INTO sent FROM private.weather_watch_deliveries WHERE owner_id=p.owner_id AND feature=p_feature AND created_at>now()-interval '24 hours';
    IF sent >= (CASE WHEN p_feature='morning' THEN 10 WHEN p_feature='rain' THEN 12 ELSE 8 END) THEN RETURN false; END IF;
    INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,title,body,data) VALUES(p.owner_id,'weather_alert',p_title,p_body,
        jsonb_build_object('weather_watch',1,'boat_id',p_boat_id,'revision',p_revision,'feature',p_feature,'sample_key',p_sample,'expires',p_expires)) RETURNING id INTO q;
    INSERT INTO private.weather_watch_deliveries(queue_id,boat_id,owner_id,revision,feature,event_key,sample_key,source_at,expires_at)
    VALUES(q,p_boat_id,p.owner_id,p_revision,p_feature,p_event,p_sample,p_source_at,p_expires);
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.weather_watch_claim(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.weather_watch_claim(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.weather_watch_delivery_current(p_queue_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT private.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    RETURN EXISTS(SELECT 1 FROM private.weather_watch_deliveries d
        JOIN public.weather_watch_profiles p ON p.boat_id=d.boat_id AND p.revision=d.revision AND p.owner_id=d.owner_id
        JOIN public.boats b ON b.id=p.boat_id AND b.owner_id=p.owner_id AND b.archived_at IS NULL
        JOIN private.weather_watch_health h ON h.feature=d.feature
        WHERE d.queue_id=p_queue_id AND d.expires_at>now() AND p.preferences->d.feature='true'::jsonb AND
        EXISTS(SELECT 1 FROM jsonb_array_elements(p.preferences->'samples') s WHERE s->>'key'=d.sample_key AND (s->>'expiresAt')::numeric>extract(epoch FROM now())*1000) AND
        h.delivery_version=1 AND h.entitlement_until>now());
END $$;
REVOKE ALL ON FUNCTION public.weather_watch_delivery_current(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.weather_watch_delivery_current(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.weather_watch_work(p_feature text,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 16) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
    IF NOT private.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    IF p_feature NOT IN ('morning','rain','storm','gust') OR p_limit NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'Invalid work bounds'; END IF;
    -- Provider work is impossible without reviewed entitlement and sender support.
    IF NOT EXISTS(SELECT 1 FROM private.weather_watch_health WHERE feature=p_feature AND delivery_version=1 AND entitlement_until>now()) THEN RETURN '[]'::jsonb; END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) INTO result FROM (
        SELECT p.boat_id,p.owner_id,p.revision,p.preferences FROM public.weather_watch_profiles p
        JOIN public.boats b ON b.id=p.boat_id AND b.owner_id=p.owner_id AND b.archived_at IS NULL
        WHERE p.preferences->p_feature='true'::jsonb AND (p_after IS NULL OR p.boat_id>p_after)
        ORDER BY p.boat_id LIMIT p_limit
    ) rows;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.weather_watch_work(text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.weather_watch_work(text,uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.weather_watch_tick(p_feature text,p_success boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT private.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    UPDATE private.weather_watch_health SET function_version=1,succeeded_at=CASE WHEN p_success THEN now() ELSE NULL END WHERE feature=p_feature;
    DELETE FROM private.weather_watch_deliveries WHERE created_at<now()-interval '32 days';
END $$;
REVOKE ALL ON FUNCTION public.weather_watch_tick(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.weather_watch_tick(text,boolean) TO service_role;
