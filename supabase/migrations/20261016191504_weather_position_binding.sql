-- HELD, after weather_watch_optins. No jobs/capabilities/entitlements enabled.
-- New position sharing requires explicit owner CAS consent. The legacy
-- account-selected vessel_telemetry row is deliberately never consulted.
CREATE TABLE IF NOT EXISTS private_weather_watch.weather_position_registrations (
    boat_id uuid PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    relay_id text NOT NULL REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
    revision uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    self_key text NOT NULL CHECK (self_key ~ '^[a-f0-9]{64}$'),
    source_key text NOT NULL CHECK (source_key ~ '^[a-f0-9]{64}$'),
    enabled boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private_weather_watch.weather_position_receipts (
    boat_id uuid PRIMARY KEY REFERENCES private_weather_watch.weather_position_registrations(boat_id) ON DELETE CASCADE,
    revision uuid NOT NULL,
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    measured_at timestamptz NOT NULL,
    zone text NOT NULL CHECK (length(zone) BETWEEN 1 AND 80)
);
ALTER TABLE private_weather_watch.weather_watch_deliveries ADD COLUMN IF NOT EXISTS position_revision uuid;
ALTER TABLE private_weather_watch.weather_watch_deliveries ADD COLUMN IF NOT EXISTS position_at timestamptz;
REVOKE ALL ON private_weather_watch.weather_position_registrations,private_weather_watch.weather_position_receipts FROM PUBLIC,anon,authenticated;
ALTER TABLE private_weather_watch.weather_position_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_weather_watch.weather_position_receipts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON private_weather_watch.weather_position_registrations,private_weather_watch.weather_position_receipts TO service_role;

CREATE OR REPLACE FUNCTION private_weather_watch.weather_position_current(p_boat_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('revision',r.revision,'lat',p.lat,'lon',p.lon,'at',extract(epoch FROM p.measured_at)*1000,'zone',p.zone)
    FROM private_weather_watch.weather_position_registrations r JOIN private_weather_watch.weather_position_receipts p ON p.boat_id=r.boat_id AND p.revision=r.revision
    JOIN public.pi_diary_relays d ON d.relay_id=r.relay_id AND d.boat_id=r.boat_id AND d.owner_id=r.owner_id AND d.enabled
    JOIN public.boats b ON b.id=r.boat_id AND b.owner_id=r.owner_id AND b.archived_at IS NULL
    WHERE r.boat_id=p_boat_id AND r.enabled AND p.measured_at<=now() AND p.measured_at>now()-interval '15 minutes'
$$;
REVOKE ALL ON FUNCTION private_weather_watch.weather_position_current(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private_weather_watch.configure_weather_position(p_boat_id uuid,p_expected uuid,p_relay_id text,p_self_key text,p_source_key text,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old private_weather_watch.weather_position_registrations; result private_weather_watch.weather_position_registrations; caller uuid:=auth.uid();
BEGIN
    IF caller IS NULL THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    IF p_enabled IS NULL OR p_relay_id IS NULL OR p_relay_id !~ '^[A-Za-z0-9_-]{16,128}$' OR p_self_key IS NULL OR p_source_key IS NULL OR p_self_key !~ '^[a-f0-9]{64}$' OR p_source_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid position source' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('weather-watch:'||p_boat_id::text,0));
    PERFORM 1 FROM public.boats WHERE id=p_boat_id AND owner_id=caller AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    SELECT * INTO old FROM private_weather_watch.weather_position_registrations WHERE boat_id=p_boat_id FOR UPDATE;
    IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Position source changed; review it' USING ERRCODE='40001'; END IF;
    IF p_enabled THEN
        PERFORM 1 FROM public.pi_diary_relays WHERE relay_id=p_relay_id AND boat_id=p_boat_id AND owner_id=caller AND enabled FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'This relay is not paired to this owned vessel' USING ERRCODE='42501'; END IF;
    ELSIF old.revision IS NULL OR old.owner_id<>caller OR old.relay_id<>p_relay_id OR old.self_key<>p_self_key OR old.source_key<>p_source_key THEN
        RAISE EXCEPTION 'Review current source before stopping sharing' USING ERRCODE='40001';
    END IF;
    INSERT INTO private_weather_watch.weather_position_registrations(boat_id,owner_id,relay_id,self_key,source_key,enabled)
    VALUES(p_boat_id,caller,p_relay_id,p_self_key,p_source_key,p_enabled)
    ON CONFLICT(boat_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,relay_id=EXCLUDED.relay_id,self_key=EXCLUDED.self_key,source_key=EXCLUDED.source_key,enabled=EXCLUDED.enabled,revision=gen_random_uuid(),updated_at=now() RETURNING * INTO result;
    DELETE FROM private_weather_watch.weather_position_receipts WHERE boat_id=p_boat_id;
    RETURN jsonb_build_object('revision',result.revision);
END $$;
REVOKE ALL ON FUNCTION private_weather_watch.configure_weather_position(uuid,uuid,text,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private_weather_watch.configure_weather_position(uuid,uuid,text,text,text,boolean) TO authenticated;
CREATE OR REPLACE FUNCTION public.configure_weather_position(p_boat_id uuid,p_expected uuid,p_relay_id text,p_self_key text,p_source_key text,p_enabled boolean) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private_weather_watch.configure_weather_position(p_boat_id,p_expected,p_relay_id,p_self_key,p_source_key,p_enabled) $$;
REVOKE ALL ON FUNCTION public.configure_weather_position(uuid,uuid,text,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.configure_weather_position(uuid,uuid,text,text,text,boolean) TO authenticated;

-- Called only after existing relay credential authentication. Optional proof is
-- independently sourced from the registered Signal K leaf, never a supplement.
CREATE OR REPLACE FUNCTION public.weather_position_telemetry(p_owner_id uuid,p_relay_id text,p_proof jsonb,p_zone text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r private_weather_watch.weather_position_registrations; prior private_weather_watch.weather_position_receipts; boat uuid; at_ms numeric; stamp timestamptz; valid boolean:=false; old_revision boolean:=false;
BEGIN
    IF NOT private_weather_watch.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    SELECT boat_id INTO boat FROM public.pi_diary_relays WHERE relay_id=p_relay_id AND owner_id=p_owner_id AND enabled;
    IF boat IS NULL THEN RETURN NULL; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('weather-watch:'||boat::text,0));
    PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=p_owner_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM 1 FROM public.pi_diary_relays WHERE relay_id=p_relay_id AND boat_id=boat AND owner_id=p_owner_id AND enabled FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO r FROM private_weather_watch.weather_position_registrations WHERE boat_id=boat AND owner_id=p_owner_id AND relay_id=p_relay_id AND enabled FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    old_revision:=coalesce(jsonb_typeof(p_proof)='object' AND p_proof->>'revision' IS NOT NULL AND p_proof->>'revision'<>r.revision::text,false);
    IF jsonb_typeof(p_proof)='object' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_proof) key)=ARRAY['at','lat','lon','revision','schema','selfKey','sourceKey'] AND
        p_proof->'schema'='1'::jsonb AND p_proof->>'revision'=r.revision::text AND p_proof->>'selfKey'=r.self_key AND p_proof->>'sourceKey'=r.source_key AND
        jsonb_typeof(p_proof->'at')='number' AND jsonb_typeof(p_proof->'lat')='number' AND jsonb_typeof(p_proof->'lon')='number' THEN
        at_ms:=(p_proof->>'at')::numeric;
        IF at_ms=trunc(at_ms) AND at_ms>0 AND at_ms<=extract(epoch FROM now())*1000 AND at_ms>extract(epoch FROM now()-interval '13 seconds')*1000 AND
            (p_proof->>'lat')::numeric BETWEEN -90 AND 90 AND (p_proof->>'lon')::numeric BETWEEN -180 AND 180 AND
            EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=p_zone) AND length(p_zone)<=80 THEN
            stamp:=to_timestamp(at_ms/1000);
            SELECT * INTO prior FROM private_weather_watch.weather_position_receipts WHERE boat_id=boat;
            IF prior.measured_at IS NOT NULL AND stamp<prior.measured_at THEN
                valid:=true; -- delayed same-binding packets cannot overwrite a newer measurement
            ELSIF prior.measured_at IS NULL OR stamp>prior.measured_at OR (stamp=prior.measured_at AND prior.lat=(p_proof->>'lat')::double precision AND prior.lon=(p_proof->>'lon')::double precision) THEN
                INSERT INTO private_weather_watch.weather_position_receipts(boat_id,revision,lat,lon,measured_at,zone) VALUES(boat,r.revision,(p_proof->>'lat')::double precision,(p_proof->>'lon')::double precision,stamp,p_zone)
                ON CONFLICT(boat_id) DO UPDATE SET revision=EXCLUDED.revision,lat=EXCLUDED.lat,lon=EXCLUDED.lon,measured_at=EXCLUDED.measured_at,zone=EXCLUDED.zone;
                valid:=true;
            END IF;
        END IF;
    END IF;
    -- An unqualified source retires readiness immediately, rather than dating an
    -- old location as a new telemetry receipt. An older same-source clock cannot
    -- replace a newer one; an obsolete registration cannot erase its replacement.
    IF NOT valid AND NOT old_revision THEN DELETE FROM private_weather_watch.weather_position_receipts WHERE boat_id=boat; END IF;
    RETURN jsonb_build_object('schema',1,'revision',r.revision,'selfKey',r.self_key,'sourceKey',r.source_key,'expiresAt',floor(extract(epoch FROM now()+interval '10 minutes')*1000));
END $$;
REVOKE ALL ON FUNCTION public.weather_position_telemetry(uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.weather_position_telemetry(uuid,text,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION private_weather_watch.weather_watch_status(p_boat_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; profile jsonb; registration jsonb;
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=p_boat_id AND owner_id=auth.uid() AND archived_at IS NULL) THEN RETURN NULL; END IF;
    SELECT jsonb_build_object('revision',revision,'preferences',preferences) INTO profile FROM public.weather_watch_profiles WHERE boat_id=p_boat_id AND owner_id=auth.uid();
    SELECT jsonb_object_agg(feature,jsonb_build_object('functionVersion',function_version,'deliveryVersion',delivery_version,
        'scheduled',private_weather_watch.weather_watch_scheduled(job_name),'entitlementUntil',extract(epoch FROM entitlement_until)*1000,
        'succeededAt',extract(epoch FROM succeeded_at)*1000)) INTO result FROM private_weather_watch.weather_watch_health;
    SELECT jsonb_build_object('revision',revision,'relayId',relay_id,'selfKey',self_key,'sourceKey',source_key,'enabled',enabled) INTO registration
    FROM private_weather_watch.weather_position_registrations WHERE boat_id=p_boat_id AND owner_id=auth.uid();
    RETURN jsonb_build_object('schema',1,'profile',profile,'capabilities',result,'position',jsonb_build_object('registration',registration,'position',private_weather_watch.weather_position_current(p_boat_id)));
END $$;
