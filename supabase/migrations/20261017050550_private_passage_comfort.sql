-- 141-06: owner-private subjective comfort. Never a shared ship-log field,
-- sensor observation, forecast skill score, safety limit or Realtime stream.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication p LEFT JOIN pg_publication_namespace pn ON pn.pnpubid=p.oid
 LEFT JOIN pg_namespace n ON n.oid=pn.pnnspid WHERE p.puballtables OR n.nspname='private_comfort')
 THEN RAISE EXCEPTION 'Private comfort cannot join a schema-wide publication'; END IF;
END $$;
CREATE SCHEMA private_comfort;
REVOKE ALL ON SCHEMA private_comfort FROM PUBLIC,anon,authenticated;
CREATE TABLE private_comfort.contexts(
 owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 quota_at timestamptz NOT NULL DEFAULT clock_timestamp(), calls integer NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 30)
);
CREATE TABLE private_comfort.cohorts(
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 -- No boat FK: its key-share would reverse the existing retirement lock
 -- order (boat row -> account advisory). Live joins and the trigger below
 -- provide retirement/cascade without adding that deadlock edge.
 boat_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
 PRIMARY KEY(owner_id,boat_id)
);
CREATE INDEX comfort_cohort_boat ON private_comfort.cohorts(boat_id);
CREATE TABLE private_comfort.reports(
 owner_id uuid NOT NULL,boat_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation ~ '^[A-Za-z0-9_-]{1,128}$'),
 log_id uuid NOT NULL REFERENCES public.ship_logs(id) ON DELETE CASCADE,
 capture_fingerprint text NOT NULL CHECK(capture_fingerprint ~ '^[0-9a-f]{32}$'),
 epoch uuid NOT NULL,profile_revision bigint NOT NULL,
 -- The actual parent's voyage and capture clocks, never an independent trail.
 voyage_id text NOT NULL,captured_at timestamptz NOT NULL,reported_at timestamptz NOT NULL,
 level smallint NOT NULL CHECK(level BETWEEN 0 AND 3),
 parts jsonb NOT NULL CHECK(jsonb_typeof(parts)='object' AND octet_length(parts::text)<=1200),
 fetched_at timestamptz NOT NULL,valid_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,boat_id,operation),
 FOREIGN KEY(owner_id,boat_id) REFERENCES private_comfort.cohorts(owner_id,boat_id) ON DELETE CASCADE
);
CREATE INDEX comfort_report_parent ON private_comfort.reports(log_id);
CREATE INDEX comfort_report_cohort ON private_comfort.reports(owner_id,boat_id,epoch,captured_at DESC);
CREATE TABLE private_comfort.deleted_operations(
 owner_id uuid NOT NULL,boat_id uuid NOT NULL,operation text NOT NULL CHECK(operation ~ '^[A-Za-z0-9_-]{1,128}$'),
 PRIMARY KEY(owner_id,boat_id,operation),
 FOREIGN KEY(owner_id,boat_id) REFERENCES private_comfort.cohorts(owner_id,boat_id) ON DELETE CASCADE
);
ALTER TABLE private_comfort.contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_comfort.cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_comfort.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_comfort.deleted_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA private_comfort FROM PUBLIC,anon,authenticated;
CREATE TRIGGER comfort_context_tombstone BEFORE INSERT OR UPDATE ON private_comfort.contexts
 FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER comfort_cohort_tombstone BEFORE INSERT OR UPDATE ON private_comfort.cohorts
 FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER comfort_report_tombstone BEFORE INSERT OR UPDATE ON private_comfort.reports
 FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
CREATE TRIGGER comfort_delete_tombstone BEFORE INSERT OR UPDATE ON private_comfort.deleted_operations
 FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

CREATE FUNCTION private_comfort.retire() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid;
BEGIN
 actor:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 IF TG_OP='UPDATE' AND NEW.boat_id IS NOT DISTINCT FROM OLD.boat_id THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text,20260806));
 -- Keep successful-request quota across switches. Cascading account deletion
 -- must delete rather than run a tombstoned UPDATE.
 IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=actor)
 OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=actor)
 THEN DELETE FROM private_comfort.contexts WHERE owner_id=actor;
 ELSE UPDATE private_comfort.contexts SET revision=gen_random_uuid() WHERE owner_id=actor; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER comfort_active_context AFTER INSERT OR UPDATE OF boat_id OR DELETE ON public.user_active_vessels
 FOR EACH ROW EXECUTE FUNCTION private_comfort.retire();
CREATE FUNCTION private_comfort.boat_retired() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid;new_owner uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
  AND NEW.released_at IS NOT DISTINCT FROM OLD.released_at THEN RETURN NEW; END IF;
  new_owner:=NEW.owner_id;
 END IF;
 FOR actor IN SELECT DISTINCT x FROM unnest(ARRAY[OLD.owner_id,new_owner]) x WHERE x IS NOT NULL ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text,20260806));
  IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=actor)
  OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=actor)
  THEN DELETE FROM private_comfort.contexts WHERE owner_id=actor;
  ELSE UPDATE private_comfort.contexts SET revision=gen_random_uuid() WHERE owner_id=actor; END IF;
 END LOOP;
 DELETE FROM private_comfort.cohorts WHERE boat_id=OLD.id;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER comfort_boat_retirement AFTER UPDATE OF owner_id,archived_at,released_at OR DELETE ON public.boats
 FOR EACH ROW EXECUTE FUNCTION private_comfort.boat_retired();

CREATE FUNCTION private_comfort.parts_ok(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE k text;part jsonb;v float8;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>1200
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN('total','windSea','swell','secondarySwell'))
 OR NOT(p ?& ARRAY['total','windSea','swell','secondarySwell']) THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['total','windSea','swell','secondarySwell'] LOOP
  part:=p->k;IF part='null'::jsonb THEN CONTINUE; END IF;
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR NOT(part ?& ARRAY['hM','periodS','fromDeg'])
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(part) x WHERE x NOT IN('hM','periodS','fromDeg'))
  OR jsonb_typeof(part->'hM') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  v:=(part->>'hM')::float8;IF NOT(v>=0 AND v<=50) THEN RETURN false; END IF;
  IF part->'periodS'<>'null'::jsonb THEN
   IF jsonb_typeof(part->'periodS') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   v:=(part->>'periodS')::float8;IF NOT(v>0 AND v<=60) THEN RETURN false; END IF;
  END IF;
  IF part->'fromDeg'<>'null'::jsonb THEN
   IF jsonb_typeof(part->'fromDeg') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   v:=(part->>'fromDeg')::float8;IF NOT(v>=0 AND v<=360) THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN p->'total'<>'null'::jsonb AND p->'total'->'periodS'<>'null'::jsonb;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN false;
END $$;

-- Change detector only; ownership still comes from live joins, never this hash.
CREATE FUNCTION private_comfort.capture_key(p public.ship_logs) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT md5(jsonb_build_array(p.user_id,p.boat_id,p.client_operation_id,p.voyage_id,
 extract(epoch FROM p.timestamp),p.latitude,p.longitude,p.source,p.entry_type)::text)
$$;
CREATE FUNCTION private_comfort.call(p_action text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s' SET lock_timeout='500ms' AS $$
DECLARE actor uuid:=auth.uid();at_time timestamptz:=clock_timestamp();active uuid;cfg private_comfort.contexts;
 cohort private_comfort.cohorts;prof public.boat_profiles;parent public.ship_logs;
 sid uuid;allowed text[];op text;reported timestamptz;observed timestamptz;fetched timestamptz;valid timestamptz;
 lat float8;lon float8;distance_m float8;parts jsonb;subject_level integer;answer jsonb;
BEGIN
 IF actor IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096
 THEN RAISE EXCEPTION 'Authenticated bounded comfort request required' USING ERRCODE='22023'; END IF;
 allowed:=CASE p_action WHEN 'state' THEN ARRAY[]::text[]
 WHEN 'save' THEN ARRAY['context','epoch','revision','operation','reportedAt','fixAt','latitude','longitude','level','parts','fetchedAt','validAt']
 WHEN 'delete' THEN ARRAY['context','epoch','revision','operation'] WHEN 'reset' THEN ARRAY['context','epoch','revision'] ELSE NULL END;
 IF allowed IS NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT(k=ANY(allowed)))
 THEN RAISE EXCEPTION 'Unknown comfort action or field' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text,20260806));
 IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=actor)
 OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=actor)
 THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='55000'; END IF;
 BEGIN sid:=(auth.jwt()->>'session_id')::uuid;EXCEPTION WHEN invalid_text_representation THEN sid:=NULL;END;
 IF sid IS NULL OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=actor
 AND (s.not_after IS NULL OR s.not_after>at_time))
 THEN RAISE EXCEPTION 'Live session required' USING ERRCODE='42501'; END IF;
 SELECT b.id INTO active FROM public.user_active_vessels a JOIN public.boats b ON b.id=a.boat_id
 WHERE a.user_id=actor AND b.owner_id=actor AND b.archived_at IS NULL AND b.released_at IS NULL;
 SELECT p.* INTO prof FROM public.boat_profiles p WHERE p.boat_id=active;
 IF active IS NULL OR prof.boat_id IS NULL OR coalesce(prof.profile->>'type','') NOT IN('sail','power')
 OR jsonb_typeof(prof.profile->'length') IS DISTINCT FROM 'number'
 OR NOT((prof.profile->>'length')::float8>0 AND (prof.profile->>'length')::float8<=1000)
 THEN RAISE EXCEPTION 'Current owned vessel profile required' USING ERRCODE='42501'; END IF;
 INSERT INTO private_comfort.contexts(owner_id) VALUES(actor) ON CONFLICT DO NOTHING;
 SELECT * INTO cfg FROM private_comfort.contexts WHERE owner_id=actor FOR UPDATE;
 IF cfg.quota_at<at_time-interval '1 minute' THEN cfg.calls:=0;cfg.quota_at:=at_time; END IF;
 IF cfg.calls>=30 THEN RAISE EXCEPTION 'Comfort request limit' USING ERRCODE='54000'; END IF;
 UPDATE private_comfort.contexts SET calls=cfg.calls+1,quota_at=cfg.quota_at WHERE owner_id=actor;
 INSERT INTO private_comfort.cohorts(owner_id,boat_id,revision,profile) VALUES(actor,active,prof.revision,
 jsonb_build_object('type',prof.profile->>'type','length',(prof.profile->>'length')::float8)) ON CONFLICT DO NOTHING;
 SELECT * INTO cohort FROM private_comfort.cohorts WHERE owner_id=actor AND boat_id=active;
 IF cohort.revision<>prof.revision THEN
  DELETE FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active;
  DELETE FROM private_comfort.deleted_operations WHERE owner_id=actor AND boat_id=active;
  UPDATE private_comfort.cohorts SET revision=prof.revision,epoch=gen_random_uuid(),
  profile=jsonb_build_object('type',prof.profile->>'type','length',(prof.profile->>'length')::float8)
  WHERE owner_id=actor AND boat_id=active RETURNING * INTO cohort;
 END IF;
 IF p_action<>'state' AND (p_input->>'context' IS DISTINCT FROM cfg.revision::text
 OR p_input->>'epoch' IS DISTINCT FROM cohort.epoch::text OR p_input->>'revision' IS DISTINCT FROM cohort.revision::text)
 THEN RAISE EXCEPTION 'Comfort context retired' USING ERRCODE='40001'; END IF;
 IF p_action IN('save','delete') THEN
  op:=p_input->>'operation';IF op IS NULL OR op !~ '^[A-Za-z0-9_-]{1,128}$'
  THEN RAISE EXCEPTION 'Capture operation required' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_action='reset' THEN
  DELETE FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active;
  DELETE FROM private_comfort.deleted_operations WHERE owner_id=actor AND boat_id=active;
  UPDATE private_comfort.cohorts SET epoch=gen_random_uuid() WHERE owner_id=actor AND boat_id=active RETURNING * INTO cohort;
 ELSIF p_action='delete' THEN
  -- Tombstone even when an in-flight save has not arrived yet. Each operation
  -- consumes one of the same120 cohort slots; deleting cannot grow a second ledger.
  IF NOT EXISTS(SELECT 1 FROM private_comfort.deleted_operations WHERE owner_id=actor AND boat_id=active AND operation=op)
  AND NOT EXISTS(SELECT 1 FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active AND operation=op)
  AND (SELECT count(*) FROM (SELECT operation FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active
      UNION SELECT operation FROM private_comfort.deleted_operations WHERE owner_id=actor AND boat_id=active) operations)>=120
  THEN RAISE EXCEPTION 'Comfort cohort full; reset explicitly to start again' USING ERRCODE='54000'; END IF;
  INSERT INTO private_comfort.deleted_operations VALUES(actor,active,op) ON CONFLICT DO NOTHING;
  DELETE FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active AND operation=op;
 ELSIF p_action='save' THEN
  SELECT l.* INTO parent FROM public.ship_logs l WHERE l.user_id=actor AND l.boat_id=active
  AND l.client_operation_id=op AND l.source='device' AND l.entry_type IN('auto','manual','waypoint') LIMIT 1;
  IF parent.id IS NULL THEN RAISE EXCEPTION 'Own device capture not uploaded' USING ERRCODE='23503'; END IF;
  reported:=(p_input->>'reportedAt')::timestamptz;observed:=(p_input->>'fixAt')::timestamptz;
  fetched:=(p_input->>'fetchedAt')::timestamptz;valid:=(p_input->>'validAt')::timestamptz;
  IF reported IS NULL OR observed IS NULL OR fetched IS NULL OR valid IS NULL
  OR reported>at_time+interval '5 seconds' OR reported<at_time-interval '30 days'
  OR observed>reported+interval '5 seconds' OR observed<reported-interval '45 seconds'
  OR parent.timestamp<reported-interval '5 minutes' OR parent.timestamp>reported+interval '5 seconds'
  OR fetched<reported-interval '30 minutes' OR fetched>reported+interval '5 minutes'
  OR valid<reported-interval '30 minutes' OR valid>reported+interval '5 minutes'
  THEN RAISE EXCEPTION 'Original comfort clocks unavailable' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_input->'latitude') IS DISTINCT FROM 'number' OR jsonb_typeof(p_input->'longitude') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_input->'level') IS DISTINCT FROM 'number' OR (p_input->>'level') !~ '^[0-3]$'
  THEN RAISE EXCEPTION 'Invalid comfort fix or level' USING ERRCODE='22023'; END IF;
  lat:=(p_input->>'latitude')::float8;lon:=(p_input->>'longitude')::float8;subject_level:=(p_input->>'level')::integer;
  IF NOT(lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180)
  THEN RAISE EXCEPTION 'Invalid comfort coordinates' USING ERRCODE='22023'; END IF;
  distance_m:=6371000*2*asin(sqrt(least(1.0,power(sin(radians(lat-parent.latitude)/2),2)
    +cos(radians(lat))*cos(radians(parent.latitude))*power(sin(radians(lon-parent.longitude)/2),2))));
  parts:=p_input->'parts';
  IF distance_m IS NULL OR distance_m>500 OR NOT private_comfort.parts_ok(parts)
  THEN RAISE EXCEPTION 'Capture or sea is not qualified' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active AND operation=op)
  AND NOT EXISTS(SELECT 1 FROM private_comfort.deleted_operations WHERE owner_id=actor AND boat_id=active AND operation=op) THEN
   IF (SELECT count(*) FROM (SELECT operation FROM private_comfort.reports WHERE owner_id=actor AND boat_id=active
       UNION SELECT operation FROM private_comfort.deleted_operations WHERE owner_id=actor AND boat_id=active) operations)>=120
   THEN RAISE EXCEPTION 'Comfort cohort full; reset explicitly to start again' USING ERRCODE='54000'; END IF;
   INSERT INTO private_comfort.reports(owner_id,boat_id,operation,log_id,capture_fingerprint,epoch,profile_revision,voyage_id,captured_at,
   reported_at,level,parts,fetched_at,valid_at) VALUES(actor,active,op,parent.id,private_comfort.capture_key(parent),cohort.epoch,cohort.revision,
   parent.voyage_id,parent.timestamp,reported,subject_level,parts,fetched,valid);
  END IF;
 END IF;
 -- Recheck the exact profile after qualification/reset work. Do not acquire
 -- a profile row lock after the account lock: existing fleet projections
 -- hold that row before their account-deletion fence. A later profile edit
 -- receives a new revision and cannot qualify this cohort on its next read.
 IF NOT EXISTS(SELECT 1 FROM public.boat_profiles p JOIN public.boats b ON b.id=p.boat_id
 JOIN public.user_active_vessels a ON a.boat_id=b.id AND a.user_id=actor
 WHERE p.boat_id=active AND p.revision=prof.revision AND p.profile=prof.profile
 AND b.owner_id=actor AND b.archived_at IS NULL AND b.released_at IS NULL)
 THEN RAISE EXCEPTION 'Comfort profile retired during qualification' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=actor AND (s.not_after IS NULL OR s.not_after>clock_timestamp()))
 THEN RAISE EXCEPTION 'Session retired during qualification' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('operation',r.operation,'voyageId',r.voyage_id,'capturedAt',r.captured_at,
 'level',r.level,'parts',r.parts,'fetchedAt',r.fetched_at,'validAt',r.valid_at,
 'qualified',coalesce(l.id IS NOT NULL AND private_comfort.capture_key(l)=r.capture_fingerprint,false)) ORDER BY r.captured_at DESC),'[]'::jsonb)
 INTO answer FROM private_comfort.reports r LEFT JOIN public.ship_logs l ON l.id=r.log_id AND l.user_id=actor AND l.boat_id=active
 WHERE r.owner_id=actor AND r.boat_id=active
 AND r.epoch=cohort.epoch AND r.profile_revision=prof.revision;
 RETURN jsonb_build_object('boatId',active,'context',cfg.revision,'epoch',cohort.epoch,'revision',cohort.revision,
 'profile',cohort.profile,'reports',answer,'serverTime',at_time);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_comfort FROM PUBLIC,anon,authenticated;
-- Narrow function execution is needed by this invoker wrapper; no raw table grants.
GRANT USAGE ON SCHEMA private_comfort TO authenticated;
GRANT EXECUTE ON FUNCTION private_comfort.call(text,jsonb) TO authenticated;
CREATE FUNCTION public.private_passage_comfort(p_action text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private_comfort.call(p_action,p_input) $$;
REVOKE ALL ON FUNCTION public.private_passage_comfort(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.private_passage_comfort(text,jsonb) TO authenticated;
COMMENT ON FUNCTION public.private_passage_comfort(text,jsonb) IS 'Owner-private subjective preference; self-reported GPS and model sea, never measured forecast skill or safety authority.';
COMMIT;
