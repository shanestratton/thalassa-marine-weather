-- 140-04: explicitly consented app positions, separate from AIS and safety data.
-- All positions are 0.05-degree cell centres, even for crew/friends. One
-- pending first fix + one published fix; no precise position/history table.
BEGIN;
DO $$ BEGIN
    IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
       OR to_regprocedure('extensions.digest(text,text)') IS NULL THEN
        RAISE EXCEPTION 'Presence requires pgcrypto in the existing extensions schema';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_publication p
        LEFT JOIN pg_publication_namespace pn ON pn.pnpubid=p.oid
        LEFT JOIN pg_namespace ns ON ns.oid=pn.pnnspid
        WHERE p.puballtables OR ns.nspname='private_presence'
    ) THEN RAISE EXCEPTION 'Presence must not join a schema-wide Realtime publication'; END IF;
END $$;
CREATE SCHEMA private_presence;
REVOKE ALL ON SCHEMA private_presence FROM PUBLIC,anon,authenticated;

CREATE TABLE private_presence.boat_presence (
    owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Intentionally no boats FK: boat retirement already holds that row lock.
    -- Live ownership joins + retirement triggers avoid a reverse key-share /
    -- config lock cycle. These UUIDs never confer authority by themselves.
    boat_id uuid,
    tier text NOT NULL DEFAULT 'off' CHECK(tier IN ('off','crew','friends','nearby')),
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    sequence bigint NOT NULL DEFAULT 1 CHECK(sequence>0),
    reader_revision uuid NOT NULL DEFAULT gen_random_uuid(), reader_nonce uuid, reader_until timestamptz,
    publisher_revision uuid NOT NULL DEFAULT gen_random_uuid(), publisher_nonce uuid, publisher_until timestamptz,
    quota_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    controls integer NOT NULL DEFAULT 0 CHECK(controls BETWEEN 0 AND 30),
    fixes integer NOT NULL DEFAULT 0 CHECK(fixes BETWEEN 0 AND 6),
    reads integer NOT NULL DEFAULT 0 CHECK(reads BETWEEN 0 AND 6),
    CHECK(tier='off' OR boat_id IS NOT NULL),
    CHECK((reader_nonce IS NULL)=(reader_until IS NULL)),
    CHECK((publisher_nonce IS NULL)=(publisher_until IS NULL))
);
CREATE TABLE private_presence.samples (
    owner_id uuid PRIMARY KEY REFERENCES private_presence.boat_presence(owner_id) ON DELETE CASCADE,
    fix_lat double precision, fix_lon double precision, fix_at timestamptz,
    pending_lat double precision, pending_lon double precision, pending_at timestamptz, pending_bucket bigint,
    published_lat double precision, published_lon double precision, published_at timestamptz, published_bucket bigint,
    touched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(fix_lat BETWEEN -90 AND 90 AND fix_lon BETWEEN -180 AND 180),
    CHECK(pending_lat BETWEEN -90 AND 90 AND pending_lon BETWEEN -180 AND 180),
    CHECK(published_lat BETWEEN -90 AND 90 AND published_lon BETWEEN -180 AND 180),
    CHECK((fix_lat IS NULL)=(fix_lon IS NULL) AND (fix_lat IS NULL)=(fix_at IS NULL)),
    CHECK((pending_lat IS NULL)=(pending_lon IS NULL) AND (pending_lat IS NULL)=(pending_at IS NULL)
        AND (pending_lat IS NULL)=(pending_bucket IS NULL)),
    CHECK((published_lat IS NULL)=(published_lon IS NULL) AND (published_lat IS NULL)=(published_at IS NULL)
        AND (published_lat IS NULL)=(published_bucket IS NULL))
);
CREATE INDEX presence_samples_expiry ON private_presence.samples(touched_at,owner_id);
CREATE INDEX presence_published_area ON private_presence.samples(published_lat,published_lon)
    WHERE published_at IS NOT NULL;
CREATE TABLE private_presence.friend_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES private_presence.boat_presence(owner_id) ON DELETE CASCADE,
    boat_id uuid NOT NULL,
    revision uuid NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
    label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX presence_invite_owner ON private_presence.friend_invites(owner_id,expires_at);
CREATE TABLE private_presence.friends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES private_presence.boat_presence(owner_id) ON DELETE CASCADE,
    boat_id uuid NOT NULL,
    grantee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(owner_id<>grantee_id), UNIQUE(owner_id,boat_id,grantee_id)
);
CREATE INDEX presence_friend_viewer ON private_presence.friends(grantee_id,owner_id,boat_id);
ALTER TABLE private_presence.boat_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_presence.samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_presence.friend_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_presence.friends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA private_presence FROM PUBLIC,anon,authenticated;
CREATE TRIGGER presence_config_tombstone BEFORE INSERT OR UPDATE ON private_presence.boat_presence
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER presence_sample_tombstone BEFORE INSERT OR UPDATE ON private_presence.samples
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER presence_invite_tombstone BEFORE INSERT OR UPDATE ON private_presence.friend_invites
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER presence_friend_tombstone BEFORE INSERT OR UPDATE ON private_presence.friends
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id','grantee_id');

CREATE FUNCTION private_presence.uuid_input(p_input jsonb,p_key text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ BEGIN
    IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string'
       OR (p_input->>p_key) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN RAISE EXCEPTION 'Invalid presence input' USING ERRCODE='22023'; END IF;
    RETURN (p_input->>p_key)::uuid;
END $$;
CREATE FUNCTION private_presence.lock_only(p_accounts uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='500ms' AS $$
DECLARE v_id uuid;
BEGIN
    FOR v_id IN SELECT DISTINCT x FROM unnest(p_accounts) x WHERE x IS NOT NULL ORDER BY x LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(v_id::text,20260806));
    END LOOP;
END $$;
CREATE FUNCTION private_presence.lock_accounts(p_accounts uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='500ms' AS $$
DECLARE v_id uuid;
BEGIN
    PERFORM private_presence.lock_only(p_accounts);
    FOR v_id IN SELECT DISTINCT x FROM unnest(p_accounts) x WHERE x IS NOT NULL ORDER BY x LOOP
        IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=v_id)
           OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=v_id)
        THEN RAISE EXCEPTION 'Presence account is unavailable' USING ERRCODE='55000'; END IF;
    END LOOP;
END $$;
CREATE FUNCTION private_presence.retire_owner(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
    PERFORM private_presence.lock_only(ARRAY[p_owner]);
    -- Account-deletion cascades must never be blocked by a tombstoned UPDATE.
    IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=p_owner) THEN
        DELETE FROM private_presence.boat_presence p WHERE p.owner_id=p_owner;
        RETURN;
    END IF;
    UPDATE private_presence.boat_presence p SET tier='off',boat_id=NULL,revision=gen_random_uuid(),sequence=p.sequence+1,
        reader_revision=gen_random_uuid(),reader_nonce=NULL,reader_until=NULL,
        publisher_revision=gen_random_uuid(),publisher_nonce=NULL,publisher_until=NULL WHERE p.owner_id=p_owner;
    DELETE FROM private_presence.samples s WHERE s.owner_id=p_owner;
    DELETE FROM private_presence.friend_invites i WHERE i.owner_id=p_owner;
END $$;
CREATE FUNCTION private_presence.active_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
    IF TG_OP='DELETE' THEN PERFORM private_presence.retire_owner(OLD.user_id);RETURN OLD; END IF;
    IF TG_OP='INSERT' OR NEW.boat_id IS DISTINCT FROM OLD.boat_id THEN
        PERFORM private_presence.retire_owner(NEW.user_id);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER presence_active_vessel_retirement AFTER INSERT OR UPDATE OF boat_id OR DELETE ON public.user_active_vessels
    FOR EACH ROW EXECUTE FUNCTION private_presence.active_changed();
CREATE FUNCTION private_presence.boat_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
    IF TG_OP='DELETE' THEN PERFORM private_presence.retire_owner(OLD.owner_id);RETURN OLD; END IF;
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
       OR NEW.released_at IS DISTINCT FROM OLD.released_at THEN
        PERFORM private_presence.lock_only(ARRAY[OLD.owner_id,NEW.owner_id]);
        FOR v_id IN SELECT DISTINCT x FROM unnest(ARRAY[OLD.owner_id,NEW.owner_id]) x ORDER BY x LOOP
            PERFORM private_presence.retire_owner(v_id);
        END LOOP;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER presence_boat_retirement AFTER UPDATE OF owner_id,archived_at,released_at OR DELETE ON public.boats
    FOR EACH ROW EXECUTE FUNCTION private_presence.boat_changed();
CREATE FUNCTION private_presence.account_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
    PERFORM private_presence.lock_only(ARRAY[NEW.user_id]);
    DELETE FROM private_presence.boat_presence WHERE owner_id=NEW.user_id;
    DELETE FROM private_presence.friends WHERE grantee_id=NEW.user_id;
    RETURN NEW;
END $$;
CREATE TRIGGER presence_account_retirement AFTER INSERT ON public.account_deletion_jobs
    FOR EACH ROW EXECUTE FUNCTION private_presence.account_retired();
CREATE FUNCTION private_presence.expire_batch() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
    WITH expired AS (
        SELECT s.owner_id FROM private_presence.samples s WHERE s.touched_at<clock_timestamp()-interval '15 minutes'
        ORDER BY s.touched_at,s.owner_id FOR UPDATE SKIP LOCKED LIMIT 64
    ) DELETE FROM private_presence.samples s USING expired e WHERE s.owner_id=e.owner_id;
    GET DIAGNOSTICS v_count=ROW_COUNT;RETURN v_count;
END $$;
CREATE FUNCTION private_presence.state_json(p private_presence.boat_presence) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path='' AS $$
    SELECT jsonb_build_object('vesselId',p.boat_id,'vesselName',(SELECT left(b.name,120) FROM public.boats b WHERE b.id=p.boat_id),
        'tier',p.tier,'revision',p.revision,'sequence',p.sequence,
        'readerRevision',p.reader_revision,'publisherRevision',p.publisher_revision,
        'publisherActive',coalesce(p.publisher_until>clock_timestamp(),false),'serverTime',clock_timestamp());
$$;

-- The implementation lives in a non-exposed schema. The public entry point
-- added below is SECURITY INVOKER and exposes only the authenticated whitelist.
CREATE FUNCTION private_presence.call(p_action text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s' SET lock_timeout='500ms' AS $$
DECLARE
    actor uuid:=auth.uid(); other_id uuid; active_boat uuid; requested uuid;
    cfg private_presence.boat_presence%ROWTYPE; src private_presence.boat_presence%ROWTYPE;
    sample private_presence.samples%ROWTYPE; invitation private_presence.friend_invites%ROWTYPE;
    grant_row private_presence.friends%ROWTYPE;
    at_time timestamptz:=clock_timestamp(); observed timestamptz; lat float8; lon float8;
    bucket bigint; nonce uuid; expected uuid; token text; label text; kind text;
    allowed text[]; answer jsonb; rows_json jsonb;
BEGIN
    IF actor IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>2048
    THEN RAISE EXCEPTION 'Presence requires an authenticated bounded request' USING ERRCODE='22023'; END IF;
    allowed:=CASE p_action
        WHEN 'state' THEN ARRAY[]::text[] WHEN 'friends' THEN ARRAY[]::text[]
        WHEN 'configure' THEN ARRAY['revision','tier']
        WHEN 'begin' THEN ARRAY['revision','sessionRevision','kind','nonce']
        WHEN 'end' THEN ARRAY['revision','sessionRevision','kind','nonce']
        WHEN 'fix' THEN ARRAY['revision','readerNonce','publisherNonce','latitude','longitude','observedAt']
        WHEN 'nearby' THEN ARRAY['revision','readerNonce']
        WHEN 'invite' THEN ARRAY['revision','label']
        WHEN 'preview' THEN ARRAY['token'] WHEN 'accept' THEN ARRAY['token']
        WHEN 'revoke' THEN ARRAY['grantId'] ELSE NULL END;
    IF allowed IS NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT(k=ANY(allowed)))
    THEN RAISE EXCEPTION 'Unknown presence action or field' USING ERRCODE='22023'; END IF;
    -- Resolve the immutable counterpart, then lock both accounts in one order.
    -- Row locks and revalidation happen only AFTER these advisory locks.
    IF p_action IN ('preview','accept') THEN
        token:=p_input->>'token';
        IF token IS NULL OR token !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='22023'; END IF;
        SELECT i.owner_id INTO other_id FROM private_presence.friend_invites i
            WHERE i.token_hash=encode(extensions.digest(token,'sha256'),'hex');
    ELSIF p_action='revoke' THEN
        requested:=private_presence.uuid_input(p_input,'grantId');
        SELECT CASE WHEN f.owner_id=actor THEN f.grantee_id WHEN f.grantee_id=actor THEN f.owner_id END
            INTO other_id FROM private_presence.friends f WHERE f.id=requested;
    END IF;
    PERFORM private_presence.lock_accounts(ARRAY[actor,other_id]);
    SELECT b.id INTO active_boat FROM public.user_active_vessels a JOIN public.boats b ON b.id=a.boat_id
        WHERE a.user_id=actor AND b.owner_id=actor AND b.archived_at IS NULL AND b.released_at IS NULL;
    INSERT INTO private_presence.boat_presence(owner_id,boat_id) VALUES(actor,active_boat) ON CONFLICT DO NOTHING;
    SELECT p.* INTO cfg FROM private_presence.boat_presence p WHERE p.owner_id=actor FOR UPDATE;
    IF cfg.boat_id IS DISTINCT FROM active_boat THEN
        PERFORM private_presence.retire_owner(actor);
        UPDATE private_presence.boat_presence SET boat_id=active_boat WHERE owner_id=actor RETURNING * INTO cfg;
    END IF;
    IF at_time-cfg.quota_at>=interval '1 minute' THEN
        UPDATE private_presence.boat_presence SET quota_at=at_time,controls=0,fixes=0,reads=0
            WHERE owner_id=actor RETURNING * INTO cfg;
    END IF;
    IF p_action='fix' THEN
        IF cfg.fixes>=6 THEN RAISE EXCEPTION 'Presence fix rate exceeded' USING ERRCODE='54000'; END IF;
        UPDATE private_presence.boat_presence SET fixes=fixes+1 WHERE owner_id=actor;
    ELSIF p_action='nearby' THEN
        IF cfg.reads>=6 THEN RAISE EXCEPTION 'Presence read rate exceeded' USING ERRCODE='54000'; END IF;
        UPDATE private_presence.boat_presence SET reads=reads+1 WHERE owner_id=actor;
    ELSE
        IF cfg.controls>=30 THEN RAISE EXCEPTION 'Presence control rate exceeded' USING ERRCODE='54000'; END IF;
        UPDATE private_presence.boat_presence SET controls=controls+1 WHERE owner_id=actor;
    END IF;
    IF p_action IN ('configure','begin','end','fix','nearby','invite')
       AND private_presence.uuid_input(p_input,'revision')<>cfg.revision
    THEN RAISE EXCEPTION 'Presence context changed; reload controls' USING ERRCODE='40001'; END IF;

    IF p_action='configure' THEN
        kind:=p_input->>'tier';
        IF kind IS NULL OR kind NOT IN ('off','crew','friends','nearby') OR (kind<>'off' AND active_boat IS NULL)
        THEN RAISE EXCEPTION 'Select an active owned vessel and a sharing tier' USING ERRCODE='22023'; END IF;
        UPDATE private_presence.boat_presence p SET tier=kind,revision=gen_random_uuid(),sequence=p.sequence+1,
            reader_revision=gen_random_uuid(),reader_nonce=NULL,reader_until=NULL,
            publisher_revision=gen_random_uuid(),publisher_nonce=NULL,publisher_until=NULL
            WHERE p.owner_id=actor RETURNING * INTO cfg;
        DELETE FROM private_presence.samples WHERE owner_id=actor;
        DELETE FROM private_presence.friend_invites WHERE owner_id=actor;
    ELSIF p_action IN ('begin','end') THEN
        kind:=p_input->>'kind'; nonce:=private_presence.uuid_input(p_input,'nonce');
        expected:=private_presence.uuid_input(p_input,'sessionRevision');
        IF kind IS NULL OR kind NOT IN ('reader','publisher') THEN RAISE EXCEPTION 'Invalid presence session' USING ERRCODE='22023'; END IF;
        IF p_action='begin' THEN
            IF active_boat IS NULL OR (kind='publisher' AND cfg.tier='off') THEN
                RAISE EXCEPTION 'Presence sharing is off or vessel unavailable' USING ERRCODE='55000'; END IF;
            IF (kind='reader' AND expected<>cfg.reader_revision) OR (kind='publisher' AND expected<>cfg.publisher_revision)
            THEN RAISE EXCEPTION 'Presence session changed' USING ERRCODE='40001'; END IF;
            IF kind='reader' THEN
                UPDATE private_presence.boat_presence SET reader_revision=gen_random_uuid(),reader_nonce=nonce,
                    reader_until=at_time+interval '45 seconds' WHERE owner_id=actor RETURNING * INTO cfg;
            ELSE
                UPDATE private_presence.boat_presence SET publisher_revision=gen_random_uuid(),publisher_nonce=nonce,
                    publisher_until=at_time+interval '45 seconds' WHERE owner_id=actor RETURNING * INTO cfg;
                UPDATE private_presence.samples SET pending_lat=NULL,pending_lon=NULL,pending_at=NULL,pending_bucket=NULL,
                    published_lat=NULL,published_lon=NULL,published_at=NULL,published_bucket=NULL WHERE owner_id=actor;
            END IF;
        ELSE
            -- A stop may overtake its begin. The known nonce retires it in
            -- either order, but cannot cancel a subsequent different session.
            IF kind='reader' AND (cfg.reader_revision=expected OR cfg.reader_nonce=nonce) THEN
                UPDATE private_presence.boat_presence SET reader_revision=gen_random_uuid(),reader_nonce=NULL,reader_until=NULL
                    WHERE owner_id=actor RETURNING * INTO cfg;
                UPDATE private_presence.samples SET fix_lat=NULL,fix_lon=NULL,fix_at=NULL WHERE owner_id=actor;
            ELSIF kind='publisher' AND (cfg.publisher_revision=expected OR cfg.publisher_nonce=nonce) THEN
                UPDATE private_presence.boat_presence SET publisher_revision=gen_random_uuid(),publisher_nonce=NULL,publisher_until=NULL
                    WHERE owner_id=actor RETURNING * INTO cfg;
                UPDATE private_presence.samples SET pending_lat=NULL,pending_lon=NULL,pending_at=NULL,pending_bucket=NULL,
                    published_lat=NULL,published_lon=NULL,published_at=NULL,published_bucket=NULL WHERE owner_id=actor;
            END IF;
        END IF;
    ELSIF p_action='fix' THEN
        IF active_boat IS NULL THEN RAISE EXCEPTION 'Owned vessel unavailable' USING ERRCODE='55000'; END IF;
        IF p_input ? 'readerNonce' THEN
            nonce:=private_presence.uuid_input(p_input,'readerNonce');
            IF nonce IS DISTINCT FROM cfg.reader_nonce OR cfg.reader_until<=at_time THEN
                RAISE EXCEPTION 'Reader session expired' USING ERRCODE='40001'; END IF;
        END IF;
        IF p_input ? 'publisherNonce' THEN
            nonce:=private_presence.uuid_input(p_input,'publisherNonce');
            IF nonce IS DISTINCT FROM cfg.publisher_nonce OR cfg.publisher_until<=at_time OR cfg.tier='off' THEN
                RAISE EXCEPTION 'Publisher session expired' USING ERRCODE='40001'; END IF;
        END IF;
        IF NOT(p_input ? 'readerNonce' OR p_input ? 'publisherNonce')
            OR jsonb_typeof(p_input->'latitude') IS DISTINCT FROM 'number'
            OR jsonb_typeof(p_input->'longitude') IS DISTINCT FROM 'number'
            OR jsonb_typeof(p_input->'observedAt') IS DISTINCT FROM 'string'
        THEN RAISE EXCEPTION 'A live session and original GPS fix are required' USING ERRCODE='22023'; END IF;
        lat:=(p_input->>'latitude')::float8;lon:=(p_input->>'longitude')::float8;observed:=(p_input->>'observedAt')::timestamptz;
        IF NOT(lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180)
            OR observed<at_time-interval '30 seconds' OR observed>at_time+interval '5 seconds'
        THEN RAISE EXCEPTION 'Fresh self-reported GPS fix required' USING ERRCODE='22023'; END IF;
        SELECT s.* INTO sample FROM private_presence.samples s WHERE s.owner_id=actor;
        IF sample.fix_at IS NOT NULL AND observed<=sample.fix_at THEN
            RAISE EXCEPTION 'GPS fix did not advance' USING ERRCODE='22023'; END IF;
        lat:=least(89.975::numeric,greatest(-89.975::numeric,floor((lat::numeric+90)*20)/20-90+0.025));
        lon:=least(179.975::numeric,greatest(-179.975::numeric,floor((lon::numeric+180)*20)/20-180+0.025));
        INSERT INTO private_presence.samples(owner_id,fix_lat,fix_lon,fix_at,touched_at) VALUES(actor,lat,lon,observed,at_time)
            ON CONFLICT(owner_id) DO UPDATE SET fix_lat=lat,fix_lon=lon,fix_at=observed,touched_at=at_time;
        IF p_input ? 'readerNonce' THEN
            UPDATE private_presence.boat_presence SET reader_until=at_time+interval '45 seconds' WHERE owner_id=actor;
        END IF;
        IF p_input ? 'publisherNonce' THEN
            UPDATE private_presence.boat_presence SET publisher_until=at_time+interval '45 seconds' WHERE owner_id=actor;
            UPDATE private_presence.samples SET
                published_lat=pending_lat,published_lon=pending_lon,published_at=pending_at,published_bucket=pending_bucket,
                pending_lat=NULL,pending_lon=NULL,pending_at=NULL,pending_bucket=NULL
                WHERE owner_id=actor AND pending_at<=at_time-interval '5 minutes';
            bucket:=floor(extract(epoch FROM at_time)/300)::bigint;
            UPDATE private_presence.samples SET pending_lat=lat,pending_lon=lon,pending_at=at_time,pending_bucket=bucket
                WHERE owner_id=actor AND pending_at IS NULL;
        END IF;
    ELSIF p_action='nearby' THEN
        nonce:=private_presence.uuid_input(p_input,'readerNonce');
        IF active_boat IS NULL OR nonce IS DISTINCT FROM cfg.reader_nonce OR cfg.reader_until<=at_time THEN
            RAISE EXCEPTION 'Foreground reader session expired' USING ERRCODE='40001'; END IF;
        SELECT s.* INTO sample FROM private_presence.samples s WHERE s.owner_id=actor AND s.fix_at>=at_time-interval '30 seconds';
        IF sample.fix_at IS NULL THEN RAISE EXCEPTION 'Fresh reader GPS context required' USING ERRCODE='55000'; END IF;
        SELECT coalesce(jsonb_agg(point ORDER BY metres),'[]'::jsonb) INTO rows_json FROM (SELECT point,metres FROM (
            SELECT jsonb_build_object(
                'id',encode(extensions.digest(actor::text||':'||p.revision::text,'sha256'),'hex'),
                'label',CASE WHEN p.tier='nearby' THEN 'Thalassa boat' ELSE left(b.name,120) END,
                'tier',p.tier,'latitude',s.published_lat,'longitude',s.published_lon,
                'bucketAt',to_timestamp(s.published_bucket*300),
                'validUntil',least(at_time+interval '30 seconds',p.publisher_until,s.published_at+interval '15 minutes')) point,
                6371000*2*asin(sqrt(least(1.0,
                    power(sin(radians(s.published_lat-sample.fix_lat)/2),2)+
                    cos(radians(sample.fix_lat))*cos(radians(s.published_lat))*power(sin(radians(s.published_lon-sample.fix_lon)/2),2)))) metres
            FROM private_presence.samples s JOIN private_presence.boat_presence p ON p.owner_id=s.owner_id
            JOIN public.boats b ON b.id=p.boat_id AND b.owner_id=p.owner_id AND b.archived_at IS NULL AND b.released_at IS NULL
            JOIN public.user_active_vessels a ON a.user_id=p.owner_id AND a.boat_id=p.boat_id
            WHERE p.owner_id<>actor AND p.tier<>'off' AND p.publisher_until>at_time
                AND s.published_at BETWEEN at_time-interval '15 minutes' AND at_time-interval '5 minutes'
                AND s.published_lat BETWEEN sample.fix_lat-0.421 AND sample.fix_lat+0.421
                AND abs(mod((s.published_lon-sample.fix_lon+540)::numeric,360)-180)
                    <=least(180,0.421/greatest(0.001,abs(cos(radians(sample.fix_lat)))))
                AND NOT EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=p.owner_id)
                AND (p.tier='nearby'
                    OR (p.tier='friends' AND EXISTS(SELECT 1 FROM private_presence.friends f
                        WHERE f.owner_id=p.owner_id AND f.boat_id=p.boat_id AND f.grantee_id=actor))
                    OR (p.tier='crew' AND EXISTS(SELECT 1 FROM public.boat_members m
                        WHERE m.boat_id=p.boat_id AND m.user_id=actor)
                        AND EXISTS(SELECT 1 FROM public.vessel_crew c WHERE c.owner_id=p.owner_id
                            AND c.crew_user_id=actor AND c.status='accepted')))
        ) candidates WHERE metres<=25*1852 ORDER BY metres LIMIT 100) bounded;
        answer:=jsonb_build_object('points',rows_json,'serverTime',at_time,'validUntil',at_time+interval '30 seconds');
    ELSIF p_action='invite' THEN
        label:=btrim(p_input->>'label');
        IF cfg.tier<>'friends' OR active_boat IS NULL OR jsonb_typeof(p_input->'label') IS DISTINCT FROM 'string'
            OR label IS NULL OR char_length(label) NOT BETWEEN 1 AND 80
        THEN RAISE EXCEPTION 'Friends tier and a short invitation label required' USING ERRCODE='22023'; END IF;
        DELETE FROM private_presence.friend_invites WHERE owner_id=actor AND expires_at<=at_time;
        IF (SELECT count(*) FROM private_presence.friend_invites WHERE owner_id=actor)>=10 THEN
            RAISE EXCEPTION 'Too many invitations' USING ERRCODE='54000'; END IF;
        token:=encode(extensions.gen_random_bytes(32),'hex');
        INSERT INTO private_presence.friend_invites(owner_id,boat_id,revision,token_hash,label,expires_at)
            VALUES(actor,active_boat,cfg.revision,encode(extensions.digest(token,'sha256'),'hex'),label,at_time+interval '1 hour');
        answer:=jsonb_build_object('token',token,'expiresAt',at_time+interval '1 hour');
    ELSIF p_action IN ('preview','accept') THEN
        SELECT i.* INTO invitation FROM private_presence.friend_invites i
            WHERE i.token_hash=encode(extensions.digest(token,'sha256'),'hex') FOR UPDATE;
        IF invitation.owner_id IS NULL OR invitation.owner_id=actor OR invitation.owner_id IS DISTINCT FROM other_id
            OR invitation.expires_at<=at_time THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='55000'; END IF;
        SELECT p.* INTO src FROM private_presence.boat_presence p JOIN public.boats b ON b.id=p.boat_id
            JOIN public.user_active_vessels a ON a.user_id=p.owner_id AND a.boat_id=p.boat_id
            WHERE p.owner_id=invitation.owner_id AND p.boat_id=invitation.boat_id AND p.revision=invitation.revision
                AND p.tier='friends' AND b.owner_id=p.owner_id AND b.archived_at IS NULL AND b.released_at IS NULL;
        IF src.owner_id IS NULL THEN RAISE EXCEPTION 'Invitation context changed' USING ERRCODE='55000'; END IF;
        answer:=jsonb_build_object('vesselName',(SELECT left(b.name,120) FROM public.boats b WHERE b.id=src.boat_id),
            'expiresAt',invitation.expires_at);
        IF p_action='accept' THEN
            IF (SELECT count(*) FROM private_presence.friends WHERE owner_id=src.owner_id)>=100
                OR (SELECT count(*) FROM private_presence.friends WHERE grantee_id=actor)>=100 THEN
                RAISE EXCEPTION 'Friend limit reached' USING ERRCODE='54000'; END IF;
            INSERT INTO private_presence.friends(owner_id,boat_id,grantee_id,label)
                VALUES(src.owner_id,src.boat_id,actor,invitation.label) ON CONFLICT(owner_id,boat_id,grantee_id) DO NOTHING;
            DELETE FROM private_presence.friend_invites WHERE id=invitation.id;
            answer:=answer||jsonb_build_object('accepted',true);
        END IF;
    ELSIF p_action='revoke' THEN
        DELETE FROM private_presence.friends f WHERE f.id=requested AND (f.owner_id=actor OR f.grantee_id=actor)
            RETURNING * INTO grant_row;
        IF grant_row.id IS NULL THEN RAISE EXCEPTION 'Friend grant unavailable' USING ERRCODE='55000'; END IF;
        answer:=jsonb_build_object('revoked',true);
    ELSIF p_action='friends' THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'label',CASE WHEN f.owner_id=actor THEN f.label ELSE left(b.name,120) END,
            'direction',CASE WHEN f.owner_id=actor THEN 'sharing' ELSE 'following' END,'acceptedAt',f.accepted_at) ORDER BY f.accepted_at),'[]'::jsonb)
            INTO rows_json FROM private_presence.friends f JOIN public.boats b ON b.id=f.boat_id
            WHERE (f.owner_id=actor OR f.grantee_id=actor) AND b.owner_id=f.owner_id
                AND b.archived_at IS NULL AND b.released_at IS NULL;
        answer:=jsonb_build_object('friends',rows_json);
    END IF;
    PERFORM private_presence.expire_batch();
    IF answer IS NOT NULL THEN RETURN answer; END IF;
    SELECT p.* INTO cfg FROM private_presence.boat_presence p WHERE p.owner_id=actor;
    RETURN private_presence.state_json(cfg);
END $$;
CREATE FUNCTION public.boat_presence_control(p_action text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private_presence.call(p_action,p_input); $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_presence FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private_presence TO authenticated;
GRANT EXECUTE ON FUNCTION private_presence.call(text,jsonb) TO authenticated;
-- Maintenance only: the eventual deployment must schedule bounded expiry.
-- This migration installs no timer/job and exposes no public maintenance RPC.
GRANT USAGE ON SCHEMA private_presence TO service_role;
GRANT EXECUTE ON FUNCTION private_presence.expire_batch() TO service_role;
REVOKE ALL ON FUNCTION public.boat_presence_control(text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.boat_presence_control(text,jsonb) TO authenticated;
COMMENT ON FUNCTION public.boat_presence_control(text,jsonb) IS
    '140-04 explicit foreground, self-reported app positions. 0.05 degree cells; >=5min delayed, never AIS or collision data. No durable client queue.';
COMMIT;
