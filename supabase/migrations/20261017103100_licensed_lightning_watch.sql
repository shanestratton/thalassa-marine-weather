-- Prepared, held OFF. No cron, licence admission, provider read or push activation.
CREATE SCHEMA IF NOT EXISTS private_lightning142;
REVOKE ALL ON SCHEMA private_lightning142 FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private_lightning142 TO service_role;

CREATE TABLE public.lightning_watch_profiles (
    boat_id uuid PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    enabled boolean NOT NULL DEFAULT false,
    next_poll_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lightning_watch_due ON public.lightning_watch_profiles(next_poll_at,boat_id) WHERE enabled;
ALTER TABLE public.lightning_watch_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY lightning_watch_owner_read ON public.lightning_watch_profiles FOR SELECT TO authenticated
USING (owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.boats b WHERE b.id=boat_id AND b.owner_id=(SELECT auth.uid()) AND b.archived_at IS NULL AND b.released_at IS NULL));
REVOKE ALL ON public.lightning_watch_profiles FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.lightning_watch_profiles TO authenticated;
GRANT ALL ON public.lightning_watch_profiles TO service_role;
CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.lightning_watch_profiles
FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

CREATE TABLE private_lightning142.health (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    polling_enabled boolean NOT NULL DEFAULT false,
    function_version integer NOT NULL DEFAULT 0,
    delivery_version integer NOT NULL DEFAULT 0,
    entitlement_until timestamptz,
    succeeded_at timestamptz
);
INSERT INTO private_lightning142.health(singleton) VALUES(true);
CREATE TABLE private_lightning142.attempts (
    boat_id uuid PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    revision uuid NOT NULL,
    lease uuid NOT NULL UNIQUE,
    position_revision uuid NOT NULL,
    position_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    claimed boolean NOT NULL DEFAULT false
);
CREATE TABLE private_lightning142.deliveries (
    queue_id uuid PRIMARY KEY REFERENCES public.push_notification_queue(id) ON DELETE CASCADE,
    boat_id uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    revision uuid NOT NULL,
    position_revision uuid NOT NULL,
    position_at timestamptz NOT NULL,
    pulse_id text NOT NULL CHECK(pulse_id ~ '^[A-Za-z0-9_-]{1,80}$'),
    pulse_lat double precision NOT NULL CHECK(pulse_lat BETWEEN -90 AND 90),
    pulse_lon double precision NOT NULL CHECK(pulse_lon BETWEEN -180 AND 180),
    source_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(boat_id,pulse_id)
);
CREATE INDEX lightning_delivery_boat_quota ON private_lightning142.deliveries(boat_id,created_at DESC);
CREATE INDEX lightning_delivery_owner_quota ON private_lightning142.deliveries(owner_id,created_at DESC);
ALTER TABLE private_lightning142.health ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_lightning142.attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_lightning142.deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA private_lightning142 FROM PUBLIC,anon,authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA private_lightning142 TO service_role;
CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON private_lightning142.attempts
FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON private_lightning142.deliveries
FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

CREATE FUNCTION private_lightning142.ready(p_clock timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE scheduled boolean;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM private_lightning142.health WHERE polling_enabled AND function_version=1 AND delivery_version=1 AND entitlement_until>p_clock AND succeeded_at>p_clock-interval '3 minutes' AND succeeded_at<=p_clock) OR
       to_regclass('cron.job') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN RETURN false; END IF;
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job j JOIN cron.job_run_details r USING(jobid) WHERE j.jobname=''licensed-lightning-watch'' AND j.active AND j.schedule=''*/2 * * * *'' AND regexp_replace(btrim(j.command),''\s+'','' '',''g'')=$1 AND r.status=''succeeded'' AND r.end_time>$2-interval ''5 minutes'' AND r.end_time<=$2)'
    INTO scheduled USING 'SELECT public.invoke_edge_function(''licensed-lightning-watch'', 55000)',p_clock;
    RETURN coalesce(scheduled,false);
END $$;
CREATE FUNCTION private_lightning142.position(p_boat uuid,p_clock timestamptz DEFAULT clock_timestamp()) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT p FROM (SELECT private_weather_watch.weather_position_current(p_boat) p) s
    WHERE p IS NOT NULL AND (p->>'at')::numeric<=extract(epoch FROM p_clock)*1000
      AND (p->>'at')::numeric>extract(epoch FROM p_clock-interval '120 seconds')*1000
$$;
CREATE FUNCTION private_lightning142.within_radius(a double precision,b double precision,c double precision,d double precision) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
    SELECT coalesce(abs(a)<=90 AND abs(b)<=180 AND abs(c)<=90 AND abs(d)<=180 AND
        6371.0088*2*asin(least(1.0,sqrt(power(sin(radians(c-a)/2),2)+cos(radians(a))*cos(radians(c))*power(sin(radians(d-b)/2),2))))<=37.04,false)
$$;

CREATE FUNCTION public.lightning_watch_status(p_boat_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE profile jsonb;
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=p_boat_id AND owner_id=auth.uid() AND archived_at IS NULL AND released_at IS NULL) OR
       EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=auth.uid()) THEN RETURN NULL; END IF;
    SELECT jsonb_build_object('revision',revision,'enabled',enabled) INTO profile FROM public.lightning_watch_profiles WHERE boat_id=p_boat_id AND owner_id=auth.uid();
    RETURN jsonb_build_object('schema',1,'profile',profile,'ready',private_lightning142.ready(),'positionFresh',private_lightning142.position(p_boat_id) IS NOT NULL);
END $$;
CREATE FUNCTION public.configure_lightning_watch(p_boat_id uuid,p_expected uuid,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE caller uuid:=auth.uid(); old public.lightning_watch_profiles; result public.lightning_watch_profiles; at_clock timestamptz;
BEGIN
    IF caller IS NULL OR p_enabled IS NULL THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    -- Match real boat-retirement order: boat row before account authority.
    -- Never wait for an account lock while retaining a boat lock: deletion
    -- may already hold that account authority and be waiting on the boat.
    PERFORM 1 FROM public.boats WHERE id=p_boat_id AND owner_id=caller AND archived_at IS NULL AND released_at IS NULL FOR SHARE NOWAIT;
    IF NOT FOUND OR EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=caller) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended(caller::text,20260806)) THEN
        RAISE EXCEPTION 'Boat authority busy; reload and review' USING ERRCODE='40001'; END IF;
    SELECT * INTO old FROM public.lightning_watch_profiles WHERE boat_id=p_boat_id FOR UPDATE;
    at_clock:=clock_timestamp();
    IF old.owner_id IS DISTINCT FROM caller THEN old.revision:=NULL; END IF;
    IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Configuration changed; reload and review' USING ERRCODE='40001'; END IF;
    IF p_enabled AND (NOT private_lightning142.ready(at_clock) OR private_lightning142.position(p_boat_id,at_clock) IS NULL) THEN RAISE EXCEPTION 'Licensed watch or fresh boat position unavailable' USING ERRCODE='55000'; END IF;
    INSERT INTO public.lightning_watch_profiles(boat_id,owner_id,enabled,next_poll_at,updated_at) VALUES(p_boat_id,caller,p_enabled,at_clock,at_clock)
    ON CONFLICT(boat_id) DO UPDATE SET owner_id=caller,enabled=p_enabled,revision=gen_random_uuid(),next_poll_at=at_clock,updated_at=at_clock RETURNING * INTO result;
    DELETE FROM private_lightning142.attempts WHERE boat_id=p_boat_id;
    RETURN jsonb_build_object('revision',result.revision,'enabled',result.enabled);
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Boat authority busy; reload and review' USING ERRCODE='40001';
END $$;
REVOKE ALL ON FUNCTION public.lightning_watch_status(uuid),public.configure_lightning_watch(uuid,uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.lightning_watch_status(uuid),public.configure_lightning_watch(uuid,uuid,boolean) TO authenticated;

CREATE FUNCTION public.lightning_watch_work() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE candidate record; p public.lightning_watch_profiles; position jsonb; token uuid; result jsonb:='[]'; at_clock timestamptz;
BEGIN
    IF NOT private_weather_watch.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    -- An explicitly admitted scheduled worker may bootstrap its heartbeat;
    -- this remains separate from claiming any licensed event or sending it.
    IF NOT EXISTS(SELECT 1 FROM private_lightning142.health WHERE polling_enabled AND function_version=1 AND delivery_version=1 AND entitlement_until>clock_timestamp()) THEN RETURN result; END IF;
    FOR candidate IN SELECT w.boat_id,w.owner_id FROM public.lightning_watch_profiles w
        JOIN public.boats b ON b.id=w.boat_id AND b.owner_id=w.owner_id AND b.archived_at IS NULL AND b.released_at IS NULL
        WHERE w.enabled AND w.next_poll_at<=clock_timestamp() AND private_lightning142.position(w.boat_id) IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=w.owner_id)
        ORDER BY w.next_poll_at,w.boat_id LIMIT 32 LOOP
        EXIT WHEN jsonb_array_length(result)>=8;
        PERFORM 1 FROM public.boats WHERE id=candidate.boat_id AND owner_id=candidate.owner_id AND archived_at IS NULL AND released_at IS NULL FOR SHARE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;
        IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate.owner_id::text,20260806)) THEN CONTINUE; END IF;
        SELECT * INTO p FROM public.lightning_watch_profiles WHERE boat_id=candidate.boat_id AND owner_id=candidate.owner_id AND enabled AND next_poll_at<=clock_timestamp() FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;
        at_clock:=clock_timestamp();
        IF EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=p.owner_id) OR
           NOT EXISTS(SELECT 1 FROM private_lightning142.health WHERE polling_enabled AND function_version=1 AND delivery_version=1 AND entitlement_until>at_clock) THEN CONTINUE; END IF;
        position:=private_lightning142.position(p.boat_id,at_clock);
        IF position IS NULL THEN CONTINUE; END IF;
        token:=gen_random_uuid();
        UPDATE public.lightning_watch_profiles SET next_poll_at=at_clock+interval '2 minutes' WHERE boat_id=p.boat_id;
        INSERT INTO private_lightning142.attempts(boat_id,owner_id,revision,lease,position_revision,position_at,expires_at)
        VALUES(p.boat_id,p.owner_id,p.revision,token,(position->>'revision')::uuid,to_timestamp((position->>'at')::double precision/1000),at_clock+interval '60 seconds')
        ON CONFLICT(boat_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,revision=EXCLUDED.revision,lease=EXCLUDED.lease,position_revision=EXCLUDED.position_revision,position_at=EXCLUDED.position_at,expires_at=EXCLUDED.expires_at,claimed=false;
        result:=result||jsonb_build_array(jsonb_build_object('boat_id',p.boat_id,'revision',p.revision,'lease',token,'position_revision',position->>'revision','position_at',(position->>'at')::numeric,'latitude',(position->>'lat')::numeric,'longitude',(position->>'lon')::numeric));
    END LOOP;
    UPDATE private_lightning142.health SET succeeded_at=clock_timestamp() WHERE singleton;
    RETURN result;
END $$;
CREATE FUNCTION public.lightning_watch_attempt_current(p_boat_id uuid,p_revision uuid,p_lease uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT private_weather_watch.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    RETURN coalesce(private_lightning142.ready() AND EXISTS(
        SELECT 1 FROM private_lightning142.attempts a
        JOIN public.lightning_watch_profiles w ON w.boat_id=a.boat_id AND w.owner_id=a.owner_id AND w.revision=a.revision AND w.enabled
        JOIN public.boats b ON b.id=w.boat_id AND b.owner_id=w.owner_id AND b.archived_at IS NULL AND b.released_at IS NULL
        CROSS JOIN LATERAL (SELECT private_lightning142.position(a.boat_id) p) fix
        WHERE a.boat_id=p_boat_id AND a.revision=p_revision AND a.lease=p_lease AND NOT a.claimed AND a.expires_at>clock_timestamp()
          AND fix.p IS NOT NULL AND fix.p->>'revision'=a.position_revision::text
          AND to_timestamp((fix.p->>'at')::double precision/1000)>=a.position_at
          AND NOT EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=a.owner_id)),false);
END $$;

CREATE FUNCTION public.lightning_watch_claim(p_boat_id uuid,p_revision uuid,p_lease uuid,p_pulse_id text,p_lat double precision,p_lon double precision,p_source_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE attempt private_lightning142.attempts; profile public.lightning_watch_profiles; position jsonb; expires timestamptz; queue uuid; at_clock timestamptz; locked_owner uuid;
BEGIN
    IF NOT private_weather_watch.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    SELECT * INTO attempt FROM private_lightning142.attempts WHERE boat_id=p_boat_id AND lease=p_lease;
    IF NOT FOUND THEN RETURN false; END IF;
    locked_owner:=attempt.owner_id;
    PERFORM 1 FROM public.boats WHERE id=p_boat_id AND owner_id=locked_owner AND archived_at IS NULL AND released_at IS NULL FOR SHARE NOWAIT;
    IF NOT FOUND OR NOT pg_try_advisory_xact_lock(hashtextextended(locked_owner::text,20260806)) THEN RETURN false; END IF;
    SELECT * INTO profile FROM public.lightning_watch_profiles WHERE boat_id=p_boat_id FOR UPDATE;
    SELECT * INTO attempt FROM private_lightning142.attempts WHERE boat_id=p_boat_id AND lease=p_lease FOR UPDATE;
    at_clock:=clock_timestamp();
    IF NOT FOUND OR attempt.owner_id IS DISTINCT FROM locked_owner OR attempt.claimed OR attempt.expires_at<=at_clock OR attempt.revision<>p_revision OR
       profile.owner_id IS DISTINCT FROM attempt.owner_id OR profile.revision IS DISTINCT FROM p_revision OR NOT profile.enabled OR
       NOT private_lightning142.ready(at_clock) OR p_pulse_id IS NULL OR p_pulse_id !~ '^[A-Za-z0-9_-]{1,80}$' OR
       p_source_at IS NULL OR p_source_at<>date_trunc('milliseconds',p_source_at) OR p_source_at>at_clock OR p_source_at<=at_clock-interval '5 minutes' OR
       EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=attempt.owner_id) THEN RETURN false; END IF;
    position:=private_lightning142.position(p_boat_id,at_clock);
    IF position IS NULL OR position->>'revision'<>attempt.position_revision::text OR
       to_timestamp((position->>'at')::double precision/1000)<attempt.position_at OR
       NOT private_lightning142.within_radius((position->>'lat')::double precision,(position->>'lon')::double precision,p_lat,p_lon) THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM private_lightning142.deliveries WHERE boat_id=p_boat_id AND (pulse_id=p_pulse_id OR created_at>at_clock-interval '15 minutes')) OR
       (SELECT count(*) FROM private_lightning142.deliveries WHERE boat_id=p_boat_id AND created_at>at_clock-interval '24 hours')>=6 OR
       (SELECT count(*) FROM private_lightning142.deliveries WHERE owner_id=attempt.owner_id AND created_at>at_clock-interval '24 hours')>=8 THEN RETURN false; END IF;
    expires:=least(p_source_at+interval '5 minutes',at_clock+interval '60 seconds',attempt.expires_at);
    INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,title,body,data,created_at)
    VALUES(attempt.owner_id,'lightning_nearby','Lightning within 20 NM','Vaisala Xweather detected nearby lightning. Check current conditions.',
        jsonb_build_object('type','lightning_nearby','provider','xweather','source_at',extract(epoch FROM p_source_at)*1000,'expires_at',floor(extract(epoch FROM expires)*1000),'pulse_id',p_pulse_id),at_clock) RETURNING id INTO queue;
    INSERT INTO private_lightning142.deliveries(queue_id,boat_id,owner_id,revision,position_revision,position_at,pulse_id,pulse_lat,pulse_lon,source_at,expires_at,created_at)
    VALUES(queue,p_boat_id,attempt.owner_id,p_revision,attempt.position_revision,attempt.position_at,p_pulse_id,p_lat,p_lon,p_source_at,expires,at_clock);
    IF clock_timestamp()>=expires THEN RAISE EXCEPTION 'Lightning claim expired during queue admission' USING ERRCODE='55000'; END IF;
    UPDATE private_lightning142.attempts SET claimed=true WHERE boat_id=p_boat_id AND lease=p_lease;
    RETURN true;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;

CREATE FUNCTION public.lightning_watch_delivery_current(p_queue_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT private_weather_watch.weather_watch_service() THEN RAISE EXCEPTION 'Service required' USING ERRCODE='42501'; END IF;
    RETURN coalesce(private_lightning142.ready() AND EXISTS(
        SELECT 1 FROM private_lightning142.deliveries d
        JOIN public.lightning_watch_profiles w ON w.boat_id=d.boat_id AND w.owner_id=d.owner_id AND w.revision=d.revision AND w.enabled
        JOIN public.boats b ON b.id=w.boat_id AND b.owner_id=w.owner_id AND b.archived_at IS NULL AND b.released_at IS NULL
        CROSS JOIN LATERAL (SELECT private_lightning142.position(d.boat_id) p) fix
        WHERE d.queue_id=p_queue_id AND d.expires_at>clock_timestamp() AND d.source_at>clock_timestamp()-interval '5 minutes' AND d.source_at<=clock_timestamp() AND
          fix.p IS NOT NULL AND fix.p->>'revision'=d.position_revision::text AND to_timestamp((fix.p->>'at')::double precision/1000)>=d.position_at AND
          private_lightning142.within_radius((fix.p->>'lat')::double precision,(fix.p->>'lon')::double precision,d.pulse_lat,d.pulse_lon) AND
          NOT EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=d.owner_id)),false);
END $$;
-- Retire equality across archive/restore and owner A/B/A transitions. Run
-- before the existing account-deletion BEFORE fence and AFTER retirement
-- hooks. Every UPDATE must admit owner authority without waiting while
-- holding a boat row; only lifecycle changes retire the watch.
CREATE FUNCTION private_lightning142.boat_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE actor uuid; new_owner uuid; at_clock timestamptz;
BEGIN
    IF TG_OP='UPDATE' THEN
        new_owner:=NEW.owner_id;
    END IF;
    FOR actor IN SELECT DISTINCT x FROM unnest(ARRAY[OLD.owner_id,new_owner]) x WHERE x IS NOT NULL ORDER BY x LOOP
        IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text,20260806)) THEN
            RAISE EXCEPTION 'Boat authority busy; retry retirement' USING ERRCODE='40001'; END IF;
    END LOOP;
    IF TG_OP='UPDATE' AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
       AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
       AND NEW.released_at IS NOT DISTINCT FROM OLD.released_at THEN RETURN NEW; END IF;
    DELETE FROM private_lightning142.attempts WHERE boat_id=OLD.id;
    IF TG_OP='DELETE' OR EXISTS(SELECT 1 FROM public.account_deletion_jobs WHERE user_id=OLD.owner_id) THEN
        DELETE FROM public.lightning_watch_profiles WHERE boat_id=OLD.id;
    ELSE
        at_clock:=clock_timestamp();
        UPDATE public.lightning_watch_profiles SET enabled=false,revision=gen_random_uuid(),next_poll_at=at_clock,updated_at=at_clock WHERE boat_id=OLD.id;
    END IF;
    -- Delivery rows retain cooldown/deduplication history; their old revision
    -- can no longer join an enabled current profile. Source dates are untouched.
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER aa_lightning_watch_boat_retirement BEFORE UPDATE OR DELETE ON public.boats
FOR EACH ROW EXECUTE FUNCTION private_lightning142.boat_retired();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_lightning142 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.lightning_watch_work(),public.lightning_watch_attempt_current(uuid,uuid,uuid),public.lightning_watch_claim(uuid,uuid,uuid,text,double precision,double precision,timestamptz),public.lightning_watch_delivery_current(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lightning_watch_work(),public.lightning_watch_attempt_current(uuid,uuid,uuid),public.lightning_watch_claim(uuid,uuid,uuid,text,double precision,double precision,timestamptz),public.lightning_watch_delivery_current(uuid) TO service_role;
