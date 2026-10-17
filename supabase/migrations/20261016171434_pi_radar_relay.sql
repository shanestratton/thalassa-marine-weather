-- HELD: build137 radar family. Requires source fixtures, actual PostgreSQL concurrency
-- proof and matching per-attempt sender before deployment. No contacts are invented.
BEGIN;

CREATE FUNCTION public.pi_radar_stamp(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(v)='number' THEN (v::text)::numeric BETWEEN 1 AND 9007199254740991
 AND (v::text)::numeric=trunc((v::text)::numeric) ELSE false END;
$$;
REVOKE ALL ON FUNCTION public.pi_radar_stamp(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_stamp(jsonb) TO service_role;

CREATE FUNCTION public.pi_radar_valid_context(p_owner uuid,p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_typeof(p)='object' AND p ?& ARRAY['binding','configurationRevision','instance','watchEpoch']
 AND p-ARRAY['binding','configurationRevision','instance','watchEpoch']='{}'::jsonb
 AND p->>'configurationRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->>'instance' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->>'watchEpoch' ~ '^[0-9a-f]{32}$'
 AND jsonb_typeof(p->'binding')='object'
 AND p->'binding' ?& ARRAY['ownerId','piDeviceId','pairingId','deviceId','enrollmentRevision','feedId']
 AND (p->'binding')-ARRAY['ownerId','piDeviceId','pairingId','deviceId','enrollmentRevision','feedId']='{}'::jsonb
 AND p->'binding'->>'ownerId'=p_owner::text
 AND p->'binding'->>'piDeviceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->'binding'->>'deviceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->'binding'->>'pairingId' ~ '^[0-9a-f]{64}$'
 AND p->'binding'->>'enrollmentRevision' ~ '^[0-9a-f]{64}$'
 AND p->'binding'->>'feedId' ~ ('^pi:'||(p->'binding'->>'piDeviceId')||':[0-9a-f]{24}$')
 AND pg_column_size(p)<=2048;
$$;
REVOKE ALL ON FUNCTION public.pi_radar_valid_context(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_valid_context(uuid,jsonb) TO service_role;

CREATE FUNCTION public.pi_radar_episode_key(p jsonb,a jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT (a->>'kind')||':'||left(encode(sha256(convert_to(replace(jsonb_build_array(1,jsonb_build_array(
 p->'binding'->>'ownerId',p->'binding'->>'piDeviceId',p->'binding'->>'pairingId',p->'binding'->>'deviceId',
 p->'binding'->>'enrollmentRevision',p->'binding'->>'feedId'),p->>'configurationRevision',p->>'instance',
 a->>'episodeId',a->>'contactKey',(a->>'raisedAt')::bigint,a->>'kind')::text,', ',','),'UTF8')),'hex'),12)||':'||(a->>'raisedAt');
$$;
REVOKE ALL ON FUNCTION public.pi_radar_episode_key(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_episode_key(jsonb,jsonb) TO service_role;

CREATE FUNCTION public.pi_radar_valid_identity(p jsonb,a jsonb,p_now bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(a)='object' AND a->>'key' ~ '^radar-(collision|close-quarters):[0-9a-f]{12}:[0-9]{10,13}$'
 AND a->>'contactKey' ~ '^radar:pi:[0-9a-f]{32}:[A-Z0-9]{2}:(0|[1-9][0-9]{0,2})$'
 AND a->>'episodeId' ~ ('^'||(p->>'watchEpoch')||':[1-9][0-9]{0,8}$')
 AND a->>'kind' IN ('radar-collision','radar-close-quarters') THEN
 split_part(a->>'key',':',1)=a->>'kind'
 AND split_part(a->>'key',':',3)::bigint BETWEEN p_now-30*86400000::bigint AND p_now+1000
 AND a->>'key'=public.pi_radar_episode_key(p,a||jsonb_build_object('raisedAt',split_part(a->>'key',':',3)::bigint)) ELSE false END;
$$;
REVOKE ALL ON FUNCTION public.pi_radar_valid_identity(jsonb,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_valid_identity(jsonb,jsonb,bigint) TO service_role;

CREATE TABLE public.pi_radar_contexts (
 relay_id text PRIMARY KEY REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 revision uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 profile jsonb NOT NULL CHECK(public.pi_radar_valid_context(owner_id,profile) IS TRUE),
 evaluated_at_ms bigint,
 retired boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pi_radar_contexts_owner_idx ON public.pi_radar_contexts(owner_id);
CREATE TABLE public.pi_radar_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 relay_id text NOT NULL REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
 context_revision uuid NOT NULL,
 alarm_key text NOT NULL CHECK(alarm_key ~ '^radar-(collision|close-quarters):[0-9a-f]{12}:[0-9]{10,13}$'),
 contact_key text NOT NULL CHECK(contact_key ~ '^radar:pi:[0-9a-f]{32}:[A-Z0-9]{2}:(0|[1-9][0-9]{0,2})$'),
 episode_id text NOT NULL CHECK(episode_id ~ '^[0-9a-f]{32}:[1-9][0-9]{0,8}$'),
 kind text NOT NULL CHECK(kind IN ('radar-collision','radar-close-quarters')),
 raised_at_ms bigint NOT NULL CHECK(raised_at_ms>0),
 source_at_ms bigint NOT NULL CHECK(source_at_ms>0),
 report_at_ms bigint NOT NULL CHECK(report_at_ms>=source_at_ms),
 cpa_nm double precision CHECK(cpa_nm BETWEEN 0 AND 1000),
 tcpa_min double precision CHECK(tcpa_min BETWEEN -60 AND 60),
 range_nm double precision CHECK(range_nm BETWEEN 0 AND 1000),
 bearing_deg double precision CHECK(bearing_deg>=0 AND bearing_deg<360),
 lost text CHECK(lost IN ('no-fix','own-motion-unknown','target-motion-unknown','report-too-old','gone')),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 last_pushed_at timestamptz,
 last_pushed_source_at_ms bigint,
 pushed_count integer NOT NULL DEFAULT 0 CHECK(pushed_count BETWEEN 0 AND 11),
 acked_at timestamptz,
 acked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 resolved_at timestamptz,
 resolved_reason text CHECK(resolved_reason IN ('passed','lost','retired','escalated')),
 UNIQUE(relay_id,alarm_key),
 CHECK(split_part(alarm_key,':',1)=kind AND split_part(alarm_key,':',3)::bigint=raised_at_ms),
 CHECK((cpa_nm IS NULL)=(tcpa_min IS NULL)),
 CHECK(lost IS NOT NULL OR (cpa_nm IS NOT NULL AND tcpa_min IS NOT NULL AND range_nm IS NOT NULL))
);
CREATE INDEX pi_radar_events_owner_raised_idx ON public.pi_radar_events(owner_id,raised_at_ms DESC);
CREATE INDEX pi_radar_events_open_idx ON public.pi_radar_events(relay_id,context_revision,contact_key) WHERE resolved_at IS NULL;
ALTER TABLE public.pi_radar_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pi_radar_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pi_radar_contexts,public.pi_radar_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pi_radar_contexts,public.pi_radar_events TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.pi_radar_contexts,public.pi_radar_events TO service_role;
CREATE POLICY radar_context_owner_read ON public.pi_radar_contexts FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));
CREATE POLICY radar_event_owner_read ON public.pi_radar_events FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));

-- The existing owner budget now serializes at the queue insertion for ALL four
-- families, including legacy callers. A new family's lock alone cannot fix a
-- race with an unchanged AIS/underway sender. The limits remain 30 new/20 resends.
CREATE INDEX push_queue_pi_alarm_shared_budget_idx ON public.push_notification_queue(recipient_user_id,created_at)
 WHERE notification_type IN ('collision_alarm','distress_alarm','underway_alarm','radar_alarm');
CREATE FUNCTION public.pi_alarm_enforce_queue_budget()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE used integer; resend boolean;
BEGIN
 IF NEW.notification_type NOT IN ('collision_alarm','distress_alarm','underway_alarm','radar_alarm') THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:pi-alarm-budget:'||NEW.recipient_user_id::text,0));
 resend:=coalesce(NEW.data->>'resend','false')='true';
 SELECT count(*) INTO used FROM public.push_notification_queue WHERE recipient_user_id=NEW.recipient_user_id
 AND notification_type IN ('collision_alarm','distress_alarm','underway_alarm','radar_alarm')
 AND created_at>=clock_timestamp()-interval '1 hour' AND (coalesce(data->>'resend','false')='true')=resend;
 IF used>=(CASE WHEN resend THEN 20 ELSE 30 END) THEN RAISE EXCEPTION 'Pi alarm hourly budget reached' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.pi_alarm_enforce_queue_budget() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_alarm_enforce_queue_budget() TO service_role;
CREATE TRIGGER pi_alarm_shared_queue_budget BEFORE INSERT ON public.push_notification_queue FOR EACH ROW EXECUTE FUNCTION public.pi_alarm_enforce_queue_budget();

CREATE FUNCTION public.pi_radar_text(p_kind text,p_cpa double precision,p_tcpa double precision,p_range double precision)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('title',CASE WHEN p_kind='radar-close-quarters' THEN 'Radar close quarters' ELSE 'Radar collision risk' END,
 'body','Radar contact. CPA '||round(p_cpa::numeric,2)::text||' NM in '||round(p_tcpa::numeric,1)::text||' min; range '||round(p_range::numeric,2)::text||' NM. Check the current radar picture.');
$$;
REVOKE ALL ON FUNCTION public.pi_radar_text(text,double precision,double precision,double precision) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_text(text,double precision,double precision,double precision) TO service_role;

CREATE FUNCTION public.pi_radar_apply(p_owner uuid,p_relay text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
#variable_conflict use_column
<<radar>>
DECLARE c public.pi_radar_contexts%ROWTYPE; e public.pi_radar_events%ROWTYPE;
 profile jsonb; a text; item jsonb; k text; now_ms bigint; evaluated_ms bigint; source_ms bigint; report_ms bigint;
 old_revision uuid; next_revision uuid; expected uuid; queue_id uuid; queued jsonb:='[]'; acked jsonb:='[]'; acknowledgements jsonb:='[]'; words jsonb;
 used integer; devices integer; resend boolean; seen text[]; listed text[]:=ARRAY[]::text[];
BEGIN
 IF p_owner IS NULL OR p_relay IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR p_request->>'family' IS DISTINCT FROM 'radar' OR pg_column_size(p_request)>16384 THEN RAISE EXCEPTION 'invalid radar request' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.pi_diary_relays WHERE relay_id=p_relay AND owner_id=p_owner AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'radar relay binding changed' USING ERRCODE='42501'; END IF;
 -- Same owner queue lock as legacy insertions. Held before context/event changes.
 PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:pi-alarm-budget:'||p_owner::text,0));
 SELECT * INTO c FROM public.pi_radar_contexts WHERE relay_id=p_relay FOR UPDATE;
 a:=p_request->>'action';now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF a='probe' THEN
  IF p_request-ARRAY['family','action']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid radar probe' USING ERRCODE='22023'; END IF;
  DELETE FROM public.pi_radar_events WHERE id IN(SELECT id FROM public.pi_radar_events WHERE relay_id=p_relay AND resolved_at<now()-interval '30 days' ORDER BY resolved_at LIMIT 200);
  SELECT count(*) INTO devices FROM public.push_device_tokens WHERE user_id=p_owner;
  RETURN jsonb_build_object('devices',devices,'contextRevision',CASE WHEN c.owner_id=p_owner THEN c.revision ELSE NULL END,
   'context',CASE WHEN c.owner_id=p_owner THEN c.profile ELSE NULL END,'retired',CASE WHEN c.owner_id=p_owner THEN c.retired ELSE false END);
 END IF;
 profile:=p_request->'context';
 IF public.pi_radar_valid_context(p_owner,profile) IS NOT TRUE OR
  profile->'binding'->>'pairingId'<>encode(sha256(convert_to(replace(jsonb_build_array(p_owner::text,profile->'binding'->>'piDeviceId',p_relay)::text,', ',','),'UTF8')),'hex') THEN RAISE EXCEPTION 'invalid radar context' USING ERRCODE='22023'; END IF;
 IF a='bind' THEN
  IF NOT(p_request ?& ARRAY['family','action','context','expectedContextRevision']) OR p_request-ARRAY['family','action','context','expectedContextRevision']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid radar bind' USING ERRCODE='22023'; END IF;
  expected:=(p_request->>'expectedContextRevision')::uuid;
  IF c.owner_id=p_owner AND c.profile=profile AND NOT c.retired THEN RETURN jsonb_build_object('contextRevision',c.revision,'bound',true); END IF;
  IF (CASE WHEN c.owner_id=p_owner THEN c.revision ELSE NULL END) IS DISTINCT FROM expected THEN RETURN jsonb_build_object('conflict',true); END IF;
  old_revision:=c.revision;next_revision:=gen_random_uuid();
  INSERT INTO public.pi_radar_contexts(relay_id,owner_id,revision,profile) VALUES(p_relay,p_owner,next_revision,profile)
  ON CONFLICT(relay_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,revision=EXCLUDED.revision,profile=EXCLUDED.profile,evaluated_at_ms=NULL,retired=false,updated_at=now();
  UPDATE public.pi_radar_events SET resolved_at=now(),resolved_reason='retired' WHERE relay_id=p_relay AND context_revision=old_revision AND resolved_at IS NULL;
  UPDATE public.push_notification_queue SET sent_at=now(),processing_at=NULL,last_error='radar context retired' WHERE notification_type='radar_alarm' AND data->>'context_revision'=old_revision::text AND sent_at IS NULL;
  RETURN jsonb_build_object('contextRevision',next_revision,'bound',true);
 END IF;
 IF a='retire' THEN
  IF NOT(p_request ?& ARRAY['family','action','context','contextRevision']) OR p_request-ARRAY['family','action','context','contextRevision']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid radar retire' USING ERRCODE='22023'; END IF;
  IF c.owner_id IS DISTINCT FROM p_owner OR c.revision IS DISTINCT FROM (p_request->>'contextRevision')::uuid OR c.profile IS DISTINCT FROM profile THEN RETURN jsonb_build_object('conflict',true); END IF;
  next_revision:=gen_random_uuid();
  UPDATE public.pi_radar_contexts SET revision=next_revision,retired=true,evaluated_at_ms=NULL,updated_at=now() WHERE relay_id=p_relay;
  UPDATE public.pi_radar_events SET resolved_at=now(),resolved_reason='retired' WHERE relay_id=p_relay AND context_revision=c.revision AND resolved_at IS NULL;
  UPDATE public.push_notification_queue SET sent_at=now(),processing_at=NULL,last_error='radar context retired' WHERE notification_type='radar_alarm' AND data->>'context_revision'=c.revision::text AND sent_at IS NULL;
  RETURN jsonb_build_object('contextRevision',next_revision,'retired',true,'queued',queued,'acked',acked,'acknowledgements',acknowledgements);
 END IF;
 IF a IS DISTINCT FROM 'sync' OR NOT(p_request ?& ARRAY['family','action','context','contextRevision','evaluatedAt','upserts','acks','resolved','more']) OR
  p_request-ARRAY['family','action','context','contextRevision','evaluatedAt','upserts','acks','resolved','more']<>'{}'::jsonb OR
  jsonb_typeof(p_request->'upserts') IS DISTINCT FROM 'array' OR jsonb_typeof(p_request->'acks') IS DISTINCT FROM 'array' OR jsonb_typeof(p_request->'resolved') IS DISTINCT FROM 'array' OR
  jsonb_typeof(p_request->'more') IS DISTINCT FROM 'boolean' OR public.pi_radar_stamp(p_request->'evaluatedAt') IS NOT TRUE THEN RAISE EXCEPTION 'invalid radar sync' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_request->'upserts')+jsonb_array_length(p_request->'acks')+jsonb_array_length(p_request->'resolved')>8 THEN RAISE EXCEPTION 'radar batch too large' USING ERRCODE='22023'; END IF;
 IF c.owner_id IS DISTINCT FROM p_owner OR c.retired OR c.revision IS DISTINCT FROM (p_request->>'contextRevision')::uuid OR c.profile IS DISTINCT FROM profile THEN RETURN jsonb_build_object('conflict',true); END IF;
 evaluated_ms:=(p_request->>'evaluatedAt')::bigint;
 IF evaluated_ms>now_ms+1000 OR now_ms-evaluated_ms>30000 THEN RAISE EXCEPTION 'stale radar evaluation' USING ERRCODE='22023'; END IF;
 IF c.evaluated_at_ms IS NOT NULL AND evaluated_ms<c.evaluated_at_ms THEN RETURN jsonb_build_object('conflict',true); END IF;
 seen:=ARRAY[]::text[];
 FOR item IN SELECT value FROM jsonb_array_elements(p_request->'upserts') LOOP
  k:=item->>'key';
  IF public.pi_radar_valid_identity(profile,item,now_ms) IS NOT TRUE OR NOT(item ?& ARRAY['key','contactKey','episodeId','kind','raisedAt','reportAt','sourceAt','cpaNm','tcpaMin','rangeNm','bearingDeg','lost']) OR
   item-ARRAY['key','contactKey','episodeId','kind','raisedAt','reportAt','sourceAt','cpaNm','tcpaMin','rangeNm','bearingDeg','lost']<>'{}'::jsonb OR k=ANY(seen) OR
   public.pi_radar_stamp(item->'raisedAt') IS NOT TRUE OR public.pi_radar_stamp(item->'reportAt') IS NOT TRUE OR public.pi_radar_stamp(item->'sourceAt') IS NOT TRUE THEN RAISE EXCEPTION 'invalid radar upsert' USING ERRCODE='22023'; END IF;
  seen:=array_append(seen,k);listed:=array_append(listed,k);source_ms:=(item->>'sourceAt')::bigint;report_ms:=(item->>'reportAt')::bigint;
  IF (item->>'raisedAt')::bigint<>split_part(k,':',3)::bigint OR (item->>'raisedAt')::bigint>evaluated_ms+1000 OR
   report_ms>evaluated_ms+1000 OR source_ms>report_ms OR source_ms<now_ms-30*86400000::bigint OR
   jsonb_typeof(item->'lost') NOT IN ('null','string') OR (item->>'lost' IS NOT NULL AND item->>'lost' NOT IN ('no-fix','own-motion-unknown','target-motion-unknown','report-too-old','gone')) OR
   jsonb_typeof(item->'cpaNm') NOT IN ('null','number') OR jsonb_typeof(item->'tcpaMin') NOT IN ('null','number') OR jsonb_typeof(item->'rangeNm') NOT IN ('null','number') OR jsonb_typeof(item->'bearingDeg') NOT IN ('null','number') OR
   ((item->>'cpaNm' IS NULL)<>(item->>'tcpaMin' IS NULL)) OR
   (item->>'lost' IS NULL AND (item->>'cpaNm' IS NULL OR item->>'tcpaMin' IS NULL OR item->>'rangeNm' IS NULL OR evaluated_ms-source_ms>15000)) THEN RAISE EXCEPTION 'invalid radar evidence' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM public.pi_radar_events WHERE relay_id=p_relay AND alarm_key=k FOR UPDATE;
  IF e.id IS NOT NULL AND (e.context_revision<>c.revision OR e.resolved_at IS NOT NULL OR report_ms<e.report_at_ms OR (item->>'lost' IS NULL AND source_ms<e.source_at_ms)) THEN CONTINUE; END IF;
  IF e.id IS NULL THEN
   SELECT count(*) INTO used FROM public.pi_radar_events WHERE relay_id=p_relay AND context_revision=c.revision AND resolved_at IS NULL;
   IF used>=800 THEN CONTINUE; END IF; -- Local danger remains latched; never evict a held contact to make room.
  END IF;
  IF item->>'kind'='radar-close-quarters' THEN
   UPDATE public.pi_radar_events SET resolved_at=now(),resolved_reason='escalated' WHERE relay_id=p_relay AND context_revision=c.revision AND contact_key=item->>'contactKey' AND episode_id=item->>'episodeId' AND kind='radar-collision' AND resolved_at IS NULL;
  ELSIF EXISTS(SELECT 1 FROM public.pi_radar_events WHERE relay_id=p_relay AND context_revision=c.revision AND contact_key=item->>'contactKey' AND episode_id=item->>'episodeId' AND kind='radar-close-quarters') THEN CONTINUE; END IF;
  INSERT INTO public.pi_radar_events(owner_id,relay_id,context_revision,alarm_key,contact_key,episode_id,kind,raised_at_ms,source_at_ms,report_at_ms,cpa_nm,tcpa_min,range_nm,bearing_deg,lost)
  VALUES(p_owner,p_relay,c.revision,k,item->>'contactKey',item->>'episodeId',item->>'kind',(item->>'raisedAt')::bigint,source_ms,report_ms,(item->>'cpaNm')::double precision,(item->>'tcpaMin')::double precision,(item->>'rangeNm')::double precision,(item->>'bearingDeg')::double precision,item->>'lost')
  ON CONFLICT(relay_id,alarm_key) DO UPDATE SET source_at_ms=EXCLUDED.source_at_ms,report_at_ms=EXCLUDED.report_at_ms,cpa_nm=EXCLUDED.cpa_nm,tcpa_min=EXCLUDED.tcpa_min,range_nm=EXCLUDED.range_nm,bearing_deg=EXCLUDED.bearing_deg,lost=EXCLUDED.lost,last_seen_at=now();
 END LOOP;
 -- Same ordinary 30-minute mute as the phone; close quarters lasts its episode.
 UPDATE public.pi_radar_events SET acked_at=NULL,acked_by=NULL WHERE relay_id=p_relay AND context_revision=c.revision
  AND alarm_key=ANY(listed) AND kind='radar-collision' AND resolved_at IS NULL AND lost IS NULL
  AND source_at_ms>=now_ms-15000 AND acked_at<=clock_timestamp()-interval '30 minutes';
 -- Acknowledgements precede queuing, including a simultaneous upsert+ACK.
 seen:=ARRAY[]::text[];
 FOR item IN SELECT value FROM jsonb_array_elements(p_request->'acks') LOOP
  k:=item->>'key';
  IF public.pi_radar_valid_identity(profile,item,now_ms) IS NOT TRUE OR NOT(item ?& ARRAY['key','contactKey','episodeId','kind','ackedAt']) OR item-ARRAY['key','contactKey','episodeId','kind','ackedAt']<>'{}'::jsonb OR k=ANY(seen) OR public.pi_radar_stamp(item->'ackedAt') IS NOT TRUE OR (item->>'ackedAt')::bigint<split_part(k,':',3)::bigint OR (item->>'ackedAt')::bigint>evaluated_ms+1000 THEN RAISE EXCEPTION 'invalid radar acknowledgement' USING ERRCODE='22023'; END IF;
  seen:=array_append(seen,k);listed:=array_append(listed,k);
  UPDATE public.pi_radar_events SET acked_at=coalesce(acked_at,to_timestamp((item->>'ackedAt')::double precision/1000)) WHERE relay_id=p_relay AND owner_id=p_owner AND context_revision=c.revision AND alarm_key=k AND contact_key=item->>'contactKey' AND episode_id=item->>'episodeId' AND kind=item->>'kind' AND resolved_at IS NULL
   AND (kind='radar-close-quarters' OR (item->>'ackedAt')::bigint>now_ms-1800000)
   AND (last_pushed_at IS NULL OR to_timestamp((item->>'ackedAt')::double precision/1000)>=last_pushed_at-interval '60 seconds');
 END LOOP;
 seen:=ARRAY[]::text[];
 FOR item IN SELECT value FROM jsonb_array_elements(p_request->'resolved') LOOP
  k:=item->>'key';
  IF public.pi_radar_valid_identity(profile,item,now_ms) IS NOT TRUE OR NOT(item ?& ARRAY['key','contactKey','episodeId','kind','how','endedAt']) OR item-ARRAY['key','contactKey','episodeId','kind','how','endedAt']<>'{}'::jsonb OR k=ANY(seen) OR public.pi_radar_stamp(item->'endedAt') IS NOT TRUE OR (item->>'endedAt')::bigint<split_part(k,':',3)::bigint OR (item->>'endedAt')::bigint>evaluated_ms+1000 OR coalesce(item->>'how','') NOT IN ('passed','lost') THEN RAISE EXCEPTION 'invalid radar resolution' USING ERRCODE='22023'; END IF;
  seen:=array_append(seen,k);
  UPDATE public.pi_radar_events SET resolved_at=coalesce(resolved_at,to_timestamp((item->>'endedAt')::double precision/1000)),resolved_reason=coalesce(resolved_reason,item->>'how') WHERE relay_id=p_relay AND owner_id=p_owner AND context_revision=c.revision AND alarm_key=k AND contact_key=item->>'contactKey' AND episode_id=item->>'episodeId' AND kind=item->>'kind';
 END LOOP;
 -- Only this explicit upsert cohort may enqueue. Empty/sparse batches never clear anything.
 FOR e IN SELECT * FROM public.pi_radar_events WHERE relay_id=p_relay AND owner_id=p_owner AND context_revision=c.revision AND alarm_key=ANY(listed) AND resolved_at IS NULL AND acked_at IS NULL AND lost IS NULL AND report_at_ms>=now_ms-15000 AND source_at_ms>=now_ms-15000 ORDER BY CASE WHEN kind='radar-close-quarters' THEN 0 ELSE 1 END,raised_at_ms LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'upserts') u WHERE u->>'key'=e.alarm_key) THEN CONTINUE; END IF;
  resend:=e.pushed_count>0;
  IF e.pushed_count>=11 OR (resend AND (e.last_pushed_at>clock_timestamp()-CASE WHEN e.kind='radar-close-quarters' THEN interval '60 seconds' ELSE interval '2 minutes' END OR e.source_at_ms<=e.last_pushed_source_at_ms)) THEN CONTINUE; END IF;
  SELECT count(*) INTO devices FROM public.push_device_tokens WHERE user_id=p_owner;
  IF devices=0 THEN CONTINUE; END IF;
  SELECT count(*) INTO used FROM public.push_notification_queue WHERE recipient_user_id=p_owner AND notification_type IN ('collision_alarm','distress_alarm','underway_alarm','radar_alarm') AND created_at>=clock_timestamp()-interval '1 hour' AND (coalesce(data->>'resend','false')='true')=resend;
  IF used>=(CASE WHEN resend THEN 20 ELSE 30 END) THEN CONTINUE; END IF;
  words:=public.pi_radar_text(e.kind,e.cpa_nm,e.tcpa_min,e.range_nm);
  INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,title,body,data) VALUES(p_owner,'radar_alarm',words->>'title',words->>'body',jsonb_build_object('kind',e.kind,'alarm_key',e.alarm_key,'contact_key',e.contact_key,'episode_id',e.episode_id,'context_revision',c.revision,'source_at',e.source_at_ms,'cpa_nm',e.cpa_nm,'tcpa_min',e.tcpa_min,'range_nm',e.range_nm,'resend',resend)) RETURNING id INTO queue_id;
  queued:=queued||jsonb_build_array(queue_id);
  UPDATE public.pi_radar_events SET last_pushed_at=clock_timestamp(),last_pushed_source_at_ms=e.source_at_ms,pushed_count=pushed_count+1 WHERE id=e.id;
 END LOOP;
 UPDATE public.pi_radar_contexts SET evaluated_at_ms=evaluated_ms,updated_at=now() WHERE relay_id=p_relay AND revision=c.revision;
 SELECT coalesce(jsonb_agg(alarm_key),'[]'::jsonb),coalesce(jsonb_agg(jsonb_build_object('key',alarm_key,'ackedAt',floor(extract(epoch FROM acked_at)*1000)::bigint)),'[]'::jsonb)
 INTO acked,acknowledgements FROM public.pi_radar_events WHERE relay_id=p_relay AND owner_id=p_owner AND context_revision=c.revision AND alarm_key=ANY(listed) AND resolved_at IS NULL AND acked_at IS NOT NULL AND (kind='radar-close-quarters' OR acked_at>clock_timestamp()-interval '30 minutes');
 RETURN jsonb_build_object('contextRevision',c.revision,'queued',queued,'acked',acked,'acknowledgements',acknowledgements);
END; $$;
REVOKE ALL ON FUNCTION public.pi_radar_apply(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_apply(uuid,text,jsonb) TO service_role;

CREATE SCHEMA thalassa_radar_private;
REVOKE ALL ON SCHEMA thalassa_radar_private FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA thalassa_radar_private TO authenticated;
CREATE FUNCTION thalassa_radar_private.acknowledge(p_key text,p_revision uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE caller uuid:=auth.uid();affected integer;
BEGIN
 IF caller IS NULL THEN RAISE EXCEPTION 'sign in to acknowledge' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^radar-(collision|close-quarters):[0-9a-f]{12}:[0-9]{10,13}$' OR p_revision IS NULL THEN RAISE EXCEPTION 'invalid radar acknowledgement' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:pi-alarm-budget:'||caller::text,0));
 UPDATE public.pi_radar_events e SET acked_at=clock_timestamp(),acked_by=caller
 FROM public.pi_radar_contexts c,public.pi_diary_relays r WHERE e.owner_id=caller AND e.alarm_key=p_key AND e.context_revision=p_revision AND e.resolved_at IS NULL
 AND c.relay_id=e.relay_id AND c.owner_id=caller AND c.revision=p_revision AND NOT c.retired AND r.relay_id=c.relay_id AND r.owner_id=caller AND r.enabled;
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected;
END; $$;
REVOKE ALL ON FUNCTION thalassa_radar_private.acknowledge(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION thalassa_radar_private.acknowledge(text,uuid) TO authenticated;
CREATE FUNCTION public.acknowledge_pi_radar_alarm(p_alarm_key text,p_context_revision uuid)
RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT thalassa_radar_private.acknowledge(p_alarm_key,p_context_revision);
$$;
REVOKE ALL ON FUNCTION public.acknowledge_pi_radar_alarm(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_pi_radar_alarm(text,uuid) TO authenticated;

CREATE FUNCTION public.pi_radar_delivery_current(p_queue_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.push_notification_queue q
 JOIN public.pi_radar_events e ON e.owner_id=q.recipient_user_id AND e.alarm_key=q.data->>'alarm_key'
 JOIN public.pi_radar_contexts c ON c.relay_id=e.relay_id AND c.owner_id=e.owner_id AND c.revision=e.context_revision
 JOIN public.pi_diary_relays r ON r.relay_id=c.relay_id AND r.owner_id=c.owner_id AND r.enabled
 WHERE q.id=p_queue_id AND q.notification_type='radar_alarm' AND q.sent_at IS NULL AND e.resolved_at IS NULL AND e.lost IS NULL
 AND (e.acked_at IS NULL OR (e.kind='radar-collision' AND e.acked_at<=now()-interval '30 minutes')) AND NOT c.retired
 AND q.data->>'context_revision'=c.revision::text AND q.data->>'episode_id'=e.episode_id AND q.data->>'contact_key'=e.contact_key AND q.data->>'kind'=e.kind
 AND (q.data->>'source_at')::bigint=e.last_pushed_source_at_ms
 AND c.evaluated_at_ms BETWEEN floor(extract(epoch FROM now()-interval '30 seconds')*1000)::bigint AND floor(extract(epoch FROM now()+interval '1 second')*1000)::bigint
 AND e.source_at_ms BETWEEN floor(extract(epoch FROM now()-interval '15 seconds')*1000)::bigint AND floor(extract(epoch FROM now()+interval '1 second')*1000)::bigint
 AND (q.data->>'source_at')::bigint BETWEEN floor(extract(epoch FROM now()-interval '15 seconds')*1000)::bigint AND floor(extract(epoch FROM now()+interval '1 second')*1000)::bigint
 AND q.created_at>=now()-interval '15 seconds'
 AND q.title=public.pi_radar_text(e.kind,(q.data->>'cpa_nm')::double precision,(q.data->>'tcpa_min')::double precision,(q.data->>'range_nm')::double precision)->>'title'
 AND q.body=public.pi_radar_text(e.kind,(q.data->>'cpa_nm')::double precision,(q.data->>'tcpa_min')::double precision,(q.data->>'range_nm')::double precision)->>'body');
$$;
REVOKE ALL ON FUNCTION public.pi_radar_delivery_current(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_radar_delivery_current(uuid) TO service_role;

-- A live latched radar encounter joins the same existing priority hierarchy.
-- These reads never change anchor, AIS, depth or wake rows and leases.
CREATE OR REPLACE FUNCTION public.pi_wake_priority_blocked(p_owner uuid,p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.pi_anchor_sessions WHERE owner_id=p_owner AND expires_at>now()
  AND last_heartbeat_at>=now()-interval '35 seconds' AND (is_dragging OR NOT gps_available))
 OR EXISTS(SELECT 1 FROM public.anchor_alarm_events e JOIN public.anchor_watch_sessions s USING(session_code)
  WHERE e.user_id=p_owner AND s.owner_user_id=p_owner AND s.expires_at>now() AND e.resolved_at IS NULL AND e.created_at>=now()-interval '2 minutes')
 OR EXISTS(SELECT 1 FROM public.pi_alarm_events WHERE owner_id=p_owner AND resolved_at IS NULL AND acked_at IS NULL
  AND kind IN ('collision','close-quarters','distress') AND last_seen_at>=now()-interval '45 seconds')
 OR EXISTS(SELECT 1 FROM public.pi_radar_events WHERE owner_id=p_owner AND resolved_at IS NULL
  AND (acked_at IS NULL OR (kind='radar-collision' AND acked_at<=now()-interval '30 minutes')) AND last_seen_at>=now()-interval '45 seconds')
 OR (p_kind<>'wake-depth' AND EXISTS(SELECT 1 FROM public.pi_wake_events WHERE owner_id=p_owner AND kind='wake-depth' AND resolved_at IS NULL AND acked_at IS NULL));
$$;
REVOKE ALL ON FUNCTION public.pi_wake_priority_blocked(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_priority_blocked(uuid,text) TO service_role;

CREATE FUNCTION public.pi_alarm_radar_capability()
RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN (SELECT count(*)=2 FROM pg_class WHERE oid IN('public.pi_radar_contexts'::regclass,'public.pi_radar_events'::regclass) AND relrowsecurity)
 AND NOT has_function_privilege('anon','public.pi_radar_apply(uuid,text,jsonb)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.pi_radar_apply(uuid,text,jsonb)','EXECUTE')
 AND NOT has_table_privilege('authenticated','public.pi_radar_events','INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('anon','public.pi_radar_events','SELECT')
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.push_notification_queue'::regclass AND tgname='pi_alarm_shared_queue_budget' AND tgenabled='O')
 THEN 1 ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION public.pi_alarm_radar_capability() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_alarm_radar_capability() TO service_role;

COMMIT;
