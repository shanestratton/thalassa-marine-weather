--140-05 SOURCE ONLY. Requires the complete135 AIS schema/writer; never deploy a subset.
-- No scheduler, transport, provider right or phone/Pi consent is activated here.
CREATE SCHEMA IF NOT EXISTS private_ais_receiver;
REVOKE ALL ON SCHEMA private_ais_receiver FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private_ais_receiver TO service_role;

CREATE TABLE private_ais_receiver.control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 forwarding_enabled boolean NOT NULL DEFAULT false,
 coverage_enabled boolean NOT NULL DEFAULT false,
 transport_rights_reference text CHECK(length(transport_rights_reference) BETWEEN 1 AND 200),
 display_rights_reference text CHECK(length(display_rights_reference) BETWEEN 1 AND 200)
);
INSERT INTO private_ais_receiver.control(singleton) VALUES(true);
CREATE TABLE private_ais_receiver.consents (
 boat_id uuid PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 pi_device_id uuid NOT NULL UNIQUE,
 relay_id text NOT NULL UNIQUE REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND pg_column_size(binding)<2048),
 public_key_spki text NOT NULL CHECK(length(public_key_spki) BETWEEN 80 AND 258 AND public_key_spki ~ '^[A-Za-z0-9+/]+={0,2}$'),
 revision uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 enabled boolean NOT NULL DEFAULT false,
 consent_version text NOT NULL CHECK(consent_version='2026-10-17-pi-v1'),
 issued_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '30 days')
);
-- ONE current coarse cell, overwritten on movement. No receiver coordinate/history table.
CREATE TABLE private_ais_receiver.observations (
 boat_id uuid PRIMARY KEY REFERENCES private_ais_receiver.consents(boat_id) ON DELETE CASCADE,
 consent_revision uuid NOT NULL,
 cell_id text NOT NULL CHECK(cell_id ~ '^v1:([0-9]|[1-8][0-9]):([0-9]|[1-9][0-9]|1[0-7][0-9])$'),
 first_heard_at timestamptz NOT NULL,
 last_heard_at timestamptz NOT NULL,
 CHECK(last_heard_at>=first_heard_at-interval '30 seconds')
);
CREATE TABLE private_ais_receiver.replays (
 consent_revision uuid NOT NULL REFERENCES private_ais_receiver.consents(revision) ON DELETE CASCADE ON UPDATE CASCADE,
 boot_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 2147483647),
 PRIMARY KEY(consent_revision,boot_id)
);
ALTER TABLE private_ais_receiver.control ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_ais_receiver.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_ais_receiver.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_ais_receiver.replays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA private_ais_receiver FROM PUBLIC,anon,authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA private_ais_receiver TO service_role;

CREATE FUNCTION private_ais_receiver.require_service() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' THEN
  RAISE EXCEPTION 'Service required' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION private_ais_receiver.require_service() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private_ais_receiver.require_service() TO service_role;

CREATE FUNCTION public.set_ais_receiver_consent(p_owner uuid,p_binding jsonb,p_expected uuid,p_enabled boolean,p_spki text,p_expires_at timestamptz)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE old private_ais_receiver.consents; result private_ais_receiver.consents; boat uuid; pi uuid; relay text;
BEGIN
 PERFORM private_ais_receiver.require_service();
 IF p_owner IS NULL OR jsonb_typeof(p_binding)<>'object' OR
  NOT(p_binding ?& ARRAY['ownerId','boatId','piDeviceId','relayId','pairingId','controllerId','enrollmentRevision','sourceKey']) OR
  p_binding-ARRAY['ownerId','boatId','piDeviceId','relayId','pairingId','controllerId','enrollmentRevision','sourceKey']<>'{}'::jsonb OR
  p_binding->>'ownerId' IS DISTINCT FROM p_owner::text OR p_enabled IS NULL OR
  NOT coalesce(p_binding->>'pairingId' ~ '^[a-f0-9]{64}$',false) OR NOT coalesce(p_binding->>'enrollmentRevision' ~ '^[a-f0-9]{64}$',false) OR
  NOT coalesce(p_binding->>'sourceKey' ~ '^[a-f0-9]{64}$',false) OR NOT coalesce(p_binding->>'controllerId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false) THEN
  RAISE EXCEPTION 'Invalid consent binding' USING ERRCODE='22023';
 END IF;
 boat:=(p_binding->>'boatId')::uuid; pi:=(p_binding->>'piDeviceId')::uuid; relay:=p_binding->>'relayId';
 IF boat IS NULL OR pi IS NULL OR relay IS NULL OR relay !~ '^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION 'Invalid consent binding'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ais-receiver:'||boat::text,0));
 PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=p_owner AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned active vessel required' USING ERRCODE='42501'; END IF;
 SELECT * INTO old FROM private_ais_receiver.consents WHERE boat_id=boat FOR UPDATE;
 IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Consent changed; review it' USING ERRCODE='40001'; END IF;
 IF NOT p_enabled THEN
  IF old.revision IS NULL OR old.owner_id<>p_owner OR old.binding IS DISTINCT FROM p_binding THEN
   RAISE EXCEPTION 'Review the current binding before withdrawal' USING ERRCODE='40001';
  END IF;
  DELETE FROM private_ais_receiver.observations WHERE boat_id=boat;
  DELETE FROM private_ais_receiver.replays WHERE consent_revision=old.revision;
  UPDATE private_ais_receiver.consents SET enabled=false,revision=gen_random_uuid(),updated_at=clock_timestamp()
   WHERE boat_id=boat RETURNING * INTO result;
 ELSE
  -- Worker verified a fresh paired-Pi signature and JWT owner before this service-only call.
  PERFORM 1 FROM private_ais_receiver.control c JOIN public.ais_fleet_control f ON f.singleton=c.singleton
   WHERE c.singleton AND c.forwarding_enabled AND c.transport_rights_reference IS NOT NULL
    AND f.enabled AND f.licence_reference IS NOT NULL FOR UPDATE OF f FOR SHARE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Full fleet/transport prerequisites are held' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM public.pi_diary_relays WHERE relay_id=relay AND owner_id=p_owner AND boat_id=boat AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Relay is not paired to this owned vessel' USING ERRCODE='42501'; END IF;
  IF p_spki IS NULL OR length(p_spki) NOT BETWEEN 80 AND 258 OR p_spki !~ '^[A-Za-z0-9+/]+={0,2}$' OR p_expires_at<=clock_timestamp() OR
   p_expires_at>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'Invalid consent expiry/key'; END IF;
  IF old.revision IS NULL AND (SELECT count(*) FROM private_ais_receiver.consents)>=4096 THEN
   RAISE EXCEPTION 'Receiver consent capacity unavailable' USING ERRCODE='54000';
  END IF;
  IF old.revision IS NOT NULL THEN
   DELETE FROM private_ais_receiver.observations WHERE boat_id=boat;
   DELETE FROM private_ais_receiver.replays WHERE consent_revision=old.revision;
  END IF;
  INSERT INTO private_ais_receiver.consents(boat_id,owner_id,pi_device_id,relay_id,binding,public_key_spki,enabled,consent_version,issued_at,expires_at)
   VALUES(boat,p_owner,pi,relay,p_binding,p_spki,true,'2026-10-17-pi-v1',clock_timestamp(),p_expires_at)
  ON CONFLICT(boat_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,pi_device_id=EXCLUDED.pi_device_id,relay_id=EXCLUDED.relay_id,
   binding=EXCLUDED.binding,public_key_spki=EXCLUDED.public_key_spki,enabled=true,revision=gen_random_uuid(),
   issued_at=EXCLUDED.issued_at,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp() RETURNING * INTO result;
 END IF;
 RETURN jsonb_build_object('schema',1,'binding',result.binding,'revision',result.revision,'enabled',result.enabled,
  'consentVersion',result.consent_version,'issuedAt',floor(extract(epoch FROM result.issued_at)*1000),
  'expiresAt',floor(extract(epoch FROM result.expires_at)*1000));
END $$;
REVOKE ALL ON FUNCTION public.set_ais_receiver_consent(uuid,jsonb,uuid,boolean,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_ais_receiver_consent(uuid,jsonb,uuid,boolean,text,timestamptz) TO service_role;

-- A key lookup is not admission. The worker verifies the signed exact batch,
-- then atomically rechecks all identities, consent and replay below.
CREATE FUNCTION public.read_ais_receiver_consent(p_owner uuid,p_boat uuid,p_relay text) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT CASE WHEN coalesce(current_setting('request.jwt.claim.role',true),'')='service_role' THEN
  (SELECT jsonb_build_object('binding',r.binding,'revision',r.revision,'spki',r.public_key_spki,'enabled',r.enabled,
   'expiresAt',floor(extract(epoch FROM r.expires_at)*1000)) FROM private_ais_receiver.consents r
   JOIN public.boats b ON b.id=r.boat_id AND b.owner_id=r.owner_id AND b.archived_at IS NULL
   JOIN public.pi_diary_relays d ON d.relay_id=r.relay_id AND d.owner_id=r.owner_id AND d.boat_id=r.boat_id AND d.enabled
   WHERE r.owner_id=p_owner AND r.boat_id=p_boat AND r.relay_id=p_relay) ELSE NULL END
$$;
REVOKE ALL ON FUNCTION public.read_ais_receiver_consent(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_ais_receiver_consent(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.admit_ais_receiver_batch(p_binding jsonb,p_revision uuid,p_token_hash text,p_spki text,p_boot uuid,p_sequence bigint,
 p_sent_at timestamptz,p_cell text,p_fix_at timestamptz,p_last_heard timestamptz,p_received_ais boolean) RETURNS boolean
 LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r private_ais_receiver.consents; f public.ais_fleet_control; prior bigint; boat uuid; cost integer:=4;
BEGIN
 PERFORM private_ais_receiver.require_service();
 boat:=(p_binding->>'boatId')::uuid;
 IF boat IS NULL OR p_boot IS NULL OR p_sequence IS NULL OR p_sequence NOT BETWEEN 1 AND 2147483647 OR p_sent_at IS NULL OR
  p_sent_at>clock_timestamp() OR p_sent_at<clock_timestamp()-interval '10 seconds' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ais-receiver:'||boat::text,0));
 SELECT * INTO f FROM public.ais_fleet_control WHERE singleton FOR UPDATE;
 IF NOT FOUND OR NOT f.enabled OR f.licence_reference IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM private_ais_receiver.control WHERE singleton AND forwarding_enabled AND transport_rights_reference IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 -- Boat first: release/archive cannot deadlock a cascading consent delete
 -- against an admission holding the child row while waiting for the hull.
 PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=(p_binding->>'ownerId')::uuid AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO r FROM private_ais_receiver.consents WHERE boat_id=boat FOR UPDATE;
 IF NOT FOUND OR NOT r.enabled OR r.expires_at<=clock_timestamp() OR r.revision IS DISTINCT FROM p_revision OR
  r.binding IS DISTINCT FROM p_binding OR r.public_key_spki IS DISTINCT FROM p_spki THEN RETURN false; END IF;
 PERFORM 1 FROM public.pi_diary_relays WHERE relay_id=r.relay_id AND owner_id=r.owner_id AND boat_id=r.boat_id AND enabled
  AND token_hash=p_token_hash FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT sequence INTO prior FROM private_ais_receiver.replays WHERE consent_revision=r.revision AND boot_id=p_boot;
 IF prior IS NOT NULL AND prior>=p_sequence THEN RETURN false; END IF;
 -- Never evict an old boot and let A/B/A replay re-enter. A fresh consent is needed after16 boots.
 IF prior IS NULL AND (SELECT count(*) FROM private_ais_receiver.replays WHERE consent_revision=r.revision)>=16 THEN RETURN false; END IF;
 IF f.day_start<>current_date THEN f.day_start:=current_date;f.day_writes:=0; END IF;
 IF f.hour_start<>date_trunc('hour',now()) THEN f.hour_start:=date_trunc('hour',now());f.hour_writes:=0; END IF;
 IF f.day_writes+cost>f.day_write_limit OR f.hour_writes+cost>f.hour_write_limit THEN RETURN false; END IF;
 INSERT INTO private_ais_receiver.replays VALUES(r.revision,p_boot,p_sequence)
  ON CONFLICT(consent_revision,boot_id) DO UPDATE SET sequence=EXCLUDED.sequence;
 UPDATE public.ais_fleet_control SET day_start=f.day_start,day_writes=f.day_writes+cost,
  hour_start=f.hour_start,hour_writes=f.hour_writes+cost WHERE singleton;
 IF p_received_ais AND p_cell ~ '^v1:([0-9]|[1-8][0-9]):([0-9]|[1-9][0-9]|1[0-7][0-9])$' AND
  p_fix_at<=p_sent_at AND p_fix_at>=clock_timestamp()-interval '13 seconds' AND
  p_last_heard<=p_sent_at AND p_last_heard>=clock_timestamp()-interval '30 seconds' THEN
  INSERT INTO private_ais_receiver.observations VALUES(r.boat_id,r.revision,p_cell,clock_timestamp(),p_last_heard)
  ON CONFLICT(boat_id) DO UPDATE SET consent_revision=EXCLUDED.consent_revision,cell_id=EXCLUDED.cell_id,
   first_heard_at=CASE WHEN private_ais_receiver.observations.cell_id=EXCLUDED.cell_id
    AND private_ais_receiver.observations.consent_revision=EXCLUDED.consent_revision
    AND private_ais_receiver.observations.last_heard_at>=clock_timestamp()-interval '10 minutes'
    THEN private_ais_receiver.observations.first_heard_at ELSE EXCLUDED.first_heard_at END,
   last_heard_at=CASE WHEN private_ais_receiver.observations.cell_id=EXCLUDED.cell_id
    THEN greatest(private_ais_receiver.observations.last_heard_at,EXCLUDED.last_heard_at) ELSE EXCLUDED.last_heard_at END;
 END IF;
 DELETE FROM private_ais_receiver.observations WHERE boat_id IN(
  SELECT boat_id FROM private_ais_receiver.observations WHERE last_heard_at<clock_timestamp()-interval '10 minutes' LIMIT 1);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admit_ais_receiver_batch(jsonb,uuid,text,text,uuid,bigint,timestamptz,text,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admit_ais_receiver_batch(jsonb,uuid,text,text,uuid,bigint,timestamptz,text,timestamptz,timestamptz,boolean) TO service_role;

CREATE FUNCTION private_ais_receiver.coverage(p_west double precision,p_south double precision,p_east double precision,p_north double precision)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; count_cells integer;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid()) THEN
  RAISE EXCEPTION 'Signed-in reader required' USING ERRCODE='42501';
 END IF;
 IF p_west IS NULL OR p_east IS NULL OR p_south IS NULL OR p_north IS NULL OR
  p_west NOT BETWEEN -180 AND 180 OR p_east NOT BETWEEN -180 AND 180 OR
  p_south NOT BETWEEN -90 AND 90 OR p_north NOT BETWEEN -90 AND 90 OR p_south>=p_north THEN
  RAISE EXCEPTION 'Invalid coverage window' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM private_ais_receiver.control c JOIN public.ais_fleet_control f ON f.singleton=c.singleton
  WHERE c.singleton AND c.coverage_enabled AND c.display_rights_reference IS NOT NULL AND f.enabled AND f.licence_reference IS NOT NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('schema',1,'state','held','cells','[]'::jsonb,'partial',false); END IF;
 WITH qualified AS (
  SELECT o.cell_id FROM private_ais_receiver.observations o
  JOIN private_ais_receiver.consents r ON r.boat_id=o.boat_id AND r.revision=o.consent_revision AND r.enabled AND r.expires_at>now()
  JOIN public.boats b ON b.id=r.boat_id AND b.owner_id=r.owner_id AND b.archived_at IS NULL
  JOIN public.pi_diary_relays d ON d.relay_id=r.relay_id AND d.owner_id=r.owner_id AND d.boat_id=r.boat_id AND d.enabled
  WHERE o.first_heard_at<=now()-interval '5 minutes' AND o.last_heard_at>=now()-interval '10 minutes' AND o.last_heard_at<=now()
  GROUP BY o.cell_id HAVING count(DISTINCT r.owner_id)>=3 AND count(DISTINCT r.pi_device_id)>=3
 ), cells AS (
  SELECT cell_id,split_part(cell_id,':',2)::integer*2-90 AS south,split_part(cell_id,':',3)::integer*2-180 AS west FROM qualified
 ), in_window AS (
  SELECT cell_id FROM cells WHERE
   extensions.ST_Intersects(extensions.ST_MakeEnvelope(west,south,west+2,south+2,4326),
    CASE WHEN p_west<=p_east THEN extensions.ST_MakeEnvelope(p_west,p_south,p_east,p_north,4326)
    ELSE extensions.ST_Collect(extensions.ST_MakeEnvelope(p_west,p_south,180,p_north,4326),extensions.ST_MakeEnvelope(-180,p_south,p_east,p_north,4326)) END)
  ORDER BY cell_id LIMIT 257
 ) SELECT coalesce(jsonb_agg(cell_id ORDER BY cell_id),'[]'::jsonb),count(*) INTO result,count_cells FROM in_window;
 RETURN jsonb_build_object('schema',1,'state','available','cells',CASE WHEN count_cells>256 THEN result-256 ELSE result END,
  'partial',count_cells>256,'asOf',floor(extract(epoch FROM now()-interval '5 minutes')/300)*300000,
  'expiresAt',floor(extract(epoch FROM now()+interval '1 minute')*1000));
END $$;
REVOKE ALL ON FUNCTION private_ais_receiver.coverage(double precision,double precision,double precision,double precision) FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA private_ais_receiver TO authenticated;
GRANT EXECUTE ON FUNCTION private_ais_receiver.coverage(double precision,double precision,double precision,double precision) TO authenticated;
CREATE FUNCTION public.ais_receiver_coverage(p_west double precision,p_south double precision,p_east double precision,p_north double precision)
 RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT private_ais_receiver.coverage(p_west,p_south,p_east,p_north)
$$;
REVOKE ALL ON FUNCTION public.ais_receiver_coverage(double precision,double precision,double precision,double precision) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ais_receiver_coverage(double precision,double precision,double precision,double precision) TO authenticated;
