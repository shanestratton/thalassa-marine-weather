-- HELD / PREPARED ONLY, build137-01. Apply this exact file only after review; no blanket push.
-- No live alarms or test notifications are inserted by this migration.
-- Wake owns separate context/event/ack state. AIS/underway tables and budgets are untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.pi_wake_valid_quiet(q jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(q)='null' THEN true
 WHEN jsonb_typeof(q)='object' AND q ?& ARRAY['startMinute','endMinute','utcOffsetMinutes']
 AND q-ARRAY['startMinute','endMinute','utcOffsetMinutes']='{}'::jsonb
 AND jsonb_typeof(q->'startMinute')='number' AND jsonb_typeof(q->'endMinute')='number'
 AND jsonb_typeof(q->'utcOffsetMinutes')='number' THEN
 (q->>'startMinute')::numeric BETWEEN 0 AND 1439 AND (q->>'endMinute')::numeric BETWEEN 0 AND 1439
 AND (q->>'utcOffsetMinutes')::numeric BETWEEN -840 AND 840
 AND (q->>'startMinute')::numeric=trunc((q->>'startMinute')::numeric)
 AND (q->>'endMinute')::numeric=trunc((q->>'endMinute')::numeric)
 AND (q->>'utcOffsetMinutes')::numeric=trunc((q->>'utcOffsetMinutes')::numeric)
 AND (q->>'startMinute')::numeric<>(q->>'endMinute')::numeric ELSE false END;
$$;
REVOKE ALL ON FUNCTION public.pi_wake_valid_quiet(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_valid_quiet(jsonb) TO service_role;

-- Explicit fixed offset from the saved configuration, never the server time zone.
CREATE FUNCTION public.pi_wake_quiet(q jsonb,p_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(q)='null' THEN false
 WHEN public.pi_wake_valid_quiet(q) IS TRUE THEN
 CASE WHEN (q->>'startMinute')::int<(q->>'endMinute')::int THEN
 mod(mod(floor(extract(epoch FROM p_at)/60)+(q->>'utcOffsetMinutes')::int,1440)+1440,1440)>=(q->>'startMinute')::int
 AND mod(mod(floor(extract(epoch FROM p_at)/60)+(q->>'utcOffsetMinutes')::int,1440)+1440,1440)<(q->>'endMinute')::int
 ELSE mod(mod(floor(extract(epoch FROM p_at)/60)+(q->>'utcOffsetMinutes')::int,1440)+1440,1440)>=(q->>'startMinute')::int
 OR mod(mod(floor(extract(epoch FROM p_at)/60)+(q->>'utcOffsetMinutes')::int,1440)+1440,1440)<(q->>'endMinute')::int END
 ELSE true END;
$$;
REVOKE ALL ON FUNCTION public.pi_wake_quiet(jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_quiet(jsonb,timestamptz) TO service_role;

CREATE FUNCTION public.pi_wake_valid_rule(r jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_typeof(r)='object' AND r ?& ARRAY['kind','enabled','sourceKey','threshold','quietHours']
 AND r-ARRAY['kind','enabled','sourceKey','threshold','quietHours']='{}'::jsonb AND jsonb_typeof(r->'enabled')='boolean'
 AND public.pi_wake_valid_quiet(r->'quietHours') IS TRUE
 AND (jsonb_typeof(r->'sourceKey')='null' OR (jsonb_typeof(r->'sourceKey')='string' AND r->>'sourceKey' ~ '^[0-9a-f]{64}$'))
 AND (r->>'enabled'='false' OR (jsonb_typeof(r->'sourceKey')='string' AND jsonb_typeof(r->'threshold')='number'))
 AND CASE WHEN jsonb_typeof(r->'threshold')='null' THEN r->>'enabled'='false' ELSE jsonb_typeof(r->'threshold')='number' AND
 CASE r->>'kind' WHEN 'wake-depth' THEN (r->>'threshold')::double precision BETWEEN 0 AND 100
 WHEN 'wake-wind' THEN (r->>'threshold')::double precision BETWEEN 1 AND 150
 WHEN 'wake-speed' THEN (r->>'threshold')::double precision BETWEEN 0.1 AND 50
 WHEN 'wake-pressure' THEN (r->>'threshold')::double precision BETWEEN 0.1 AND 30
 WHEN 'wake-coolant' THEN (r->>'threshold')::double precision BETWEEN 0 AND 180
 WHEN 'wake-oil' THEN (r->>'threshold')::double precision BETWEEN 1 AND 2000
 WHEN 'wake-rpm' THEN (r->>'threshold')::double precision BETWEEN 100 AND 20000
 WHEN 'wake-battery' THEN (r->>'threshold')::double precision BETWEEN 1 AND 1000 ELSE false END END
 AND r->>'kind' IN ('wake-depth','wake-wind','wake-speed','wake-pressure','wake-coolant','wake-oil','wake-rpm','wake-battery');
$$;
REVOKE ALL ON FUNCTION public.pi_wake_valid_rule(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_valid_rule(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.pi_wake_valid_profile(p_owner uuid, p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_typeof(p)='object' AND p ?& ARRAY['binding','rulesDigest','configurationRevision','instance','rules']
 AND p - ARRAY['binding','rulesDigest','configurationRevision','instance','rules']='{}'::jsonb
 AND p->>'rulesDigest' ~ '^[0-9a-f]{64}$'
 AND p->>'configurationRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->>'instance' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND jsonb_typeof(p->'binding')='object'
 AND p->'binding' ?& ARRAY['ownerId','piDeviceId','pairingId','deviceId','enrollmentRevision','feedId']
 AND (p->'binding') - ARRAY['ownerId','piDeviceId','pairingId','deviceId','enrollmentRevision','feedId']='{}'::jsonb
 AND p->'binding'->>'ownerId'=p_owner::text
 AND p->'binding'->>'piDeviceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->'binding'->>'deviceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND p->'binding'->>'pairingId' ~ '^[0-9a-f]{64}$'
 AND p->'binding'->>'enrollmentRevision' ~ '^[0-9a-f]{64}$'
 AND p->'binding'->>'feedId' ~ ('^pi:'||(p->'binding'->>'piDeviceId')||':[0-9a-f]{24}$')
 AND CASE WHEN jsonb_typeof(p->'rules')='array' THEN jsonb_array_length(p->'rules')=8
 AND (SELECT count(*)=8 AND count(DISTINCT value->>'kind')=8 AND bool_and(public.pi_wake_valid_rule(value) IS TRUE) FROM jsonb_array_elements(p->'rules')) ELSE false END
 AND pg_column_size(p)<=4096;
$$;
REVOKE ALL ON FUNCTION public.pi_wake_valid_profile(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_valid_profile(uuid,jsonb) TO service_role;

CREATE FUNCTION public.pi_wake_episode_key(p jsonb,p_kind text,p_source text,p_raised bigint)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_kind||':'||left(encode(sha256(convert_to(replace(jsonb_build_array(1,jsonb_build_array(
 p->'binding'->>'ownerId',p->'binding'->>'piDeviceId',p->'binding'->>'pairingId',p->'binding'->>'deviceId',
 p->'binding'->>'enrollmentRevision',p->'binding'->>'feedId'),p->>'rulesDigest',p->>'configurationRevision',
 p->>'instance',p_kind,p_source,p_raised)::text,', ',','),'UTF8')),'hex'),12)||':'||p_raised::text;
$$;
REVOKE ALL ON FUNCTION public.pi_wake_episode_key(jsonb,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_episode_key(jsonb,text,text,bigint) TO service_role;

CREATE TABLE public.pi_wake_contexts (
 relay_id text PRIMARY KEY REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 revision uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 profile jsonb NOT NULL CHECK(public.pi_wake_valid_profile(owner_id,profile) IS TRUE),
 updated_at timestamptz NOT NULL DEFAULT now(),
 evaluated_at_ms bigint,
 higher_priority boolean NOT NULL DEFAULT false,
 retired boolean NOT NULL DEFAULT false
);
CREATE INDEX pi_wake_contexts_owner_idx ON public.pi_wake_contexts(owner_id);
CREATE TABLE public.pi_wake_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 relay_id text NOT NULL REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
 context_revision uuid NOT NULL,
 rules_digest text NOT NULL CHECK(rules_digest ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('wake-depth','wake-wind','wake-speed','wake-pressure','wake-coolant','wake-oil','wake-rpm','wake-battery')),
 alarm_key text NOT NULL CHECK(alarm_key ~ '^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$'),
 source_key text NOT NULL CHECK(source_key ~ '^[0-9a-f]{64}$'),
 raised_at_ms bigint NOT NULL CHECK(raised_at_ms>0),
 source_at_ms bigint NOT NULL CHECK(source_at_ms>=raised_at_ms),
 measured_value double precision NOT NULL,
 threshold double precision NOT NULL,
 depth_basis text CHECK(depth_basis IN ('below-keel','transducer-offset','conservative-full-draft')),
 quiet boolean NOT NULL DEFAULT false,
 source_qualified boolean NOT NULL DEFAULT true,
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 last_pushed_at timestamptz,
 last_pushed_source_at_ms bigint,
 pushed_count integer NOT NULL DEFAULT 0 CHECK(pushed_count BETWEEN 0 AND 3),
 acked_at timestamptz,
 acked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 resolved_at timestamptz,
 resolved_reason text CHECK(resolved_reason IN ('clear','retired')),
 UNIQUE(relay_id,alarm_key),
 CHECK(split_part(alarm_key,':',1)=kind AND split_part(alarm_key,':',3)::bigint=raised_at_ms),
 CHECK(CASE kind WHEN 'wake-depth' THEN measured_value BETWEEN -100 AND 12000 AND threshold BETWEEN 0 AND 100 AND depth_basis IS NOT NULL
 WHEN 'wake-wind' THEN measured_value BETWEEN 0 AND 200 AND threshold BETWEEN 1 AND 150 AND depth_basis IS NULL
 WHEN 'wake-speed' THEN measured_value BETWEEN 0 AND 100 AND threshold BETWEEN 0.1 AND 50 AND depth_basis IS NULL
 WHEN 'wake-pressure' THEN measured_value BETWEEN -100 AND 100 AND threshold BETWEEN 0.1 AND 30 AND depth_basis IS NULL
 WHEN 'wake-coolant' THEN measured_value BETWEEN -60 AND 200 AND threshold BETWEEN 0 AND 180 AND depth_basis IS NULL
 WHEN 'wake-oil' THEN measured_value BETWEEN 0 AND 5000 AND threshold BETWEEN 1 AND 2000 AND depth_basis IS NULL
 WHEN 'wake-rpm' THEN measured_value BETWEEN 0 AND 20000 AND threshold BETWEEN 100 AND 20000 AND depth_basis IS NULL
 WHEN 'wake-battery' THEN measured_value BETWEEN 0 AND 1000 AND threshold BETWEEN 1 AND 1000 AND depth_basis IS NULL ELSE false END)
);
CREATE INDEX pi_wake_events_owner_raised_idx ON public.pi_wake_events(owner_id,raised_at_ms DESC);
CREATE INDEX pi_wake_events_open_idx ON public.pi_wake_events(relay_id,context_revision,kind) WHERE resolved_at IS NULL;
CREATE INDEX push_queue_wake_budget_idx ON public.push_notification_queue(recipient_user_id,created_at) WHERE notification_type='wake_alarm';
ALTER TABLE public.pi_wake_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pi_wake_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pi_wake_contexts,public.pi_wake_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pi_wake_contexts,public.pi_wake_events TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.pi_wake_contexts,public.pi_wake_events TO service_role;
CREATE POLICY wake_context_owner_read ON public.pi_wake_contexts FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));
CREATE POLICY wake_event_owner_read ON public.pi_wake_events FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));

-- These words have one server implementation. Neither a Pi nor a queue caller supplies wake prose.
CREATE OR REPLACE FUNCTION public.pi_wake_text(p_kind text,p_value double precision,p_threshold double precision,p_basis text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
DECLARE label text; unit text; basis text:='';
BEGIN
 CASE p_kind WHEN 'wake-depth' THEN label:='Depth under keel';unit:='m';
   basis:=CASE p_basis WHEN 'conservative-full-draft' THEN ' Conservative full-draft allowance.' WHEN 'transducer-offset' THEN ' Measured transducer offset.' ELSE '' END;
 WHEN 'wake-wind' THEN label:='True wind';unit:='kn';
 WHEN 'wake-speed' THEN label:='Speed over ground';unit:='kn';
 WHEN 'wake-pressure' THEN label:='Measured pressure fall';unit:='hPa/3h';
 WHEN 'wake-coolant' THEN label:='Engine coolant';unit:='C';
 WHEN 'wake-oil' THEN label:='Engine oil pressure';unit:='kPa';
 WHEN 'wake-rpm' THEN label:='Engine speed';unit:='rpm';
 WHEN 'wake-battery' THEN label:='Battery voltage';unit:='V';
 ELSE RAISE EXCEPTION 'invalid wake preset' USING ERRCODE='22023'; END CASE;
 RETURN jsonb_build_object('title','Wake rule: '||label,'body',label||' '||round(p_value::numeric,2)::text||' '||unit||
 '; setting '||round(p_threshold::numeric,2)::text||' '||unit||'. Alarm remains active.'||basis||' Check aboard.');
END; $$;
REVOKE ALL ON FUNCTION public.pi_wake_text(text,double precision,double precision,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_text(text,double precision,double precision,text) TO service_role;

-- Existing, independently observed higher alarms win. The Pi may additionally suppress,
-- never lower, this priority. Wake reads do not alter their rows/leases/budgets.
CREATE OR REPLACE FUNCTION public.pi_wake_priority_blocked(p_owner uuid,p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.pi_anchor_sessions WHERE owner_id=p_owner AND expires_at>now()
   AND last_heartbeat_at>=now()-interval '35 seconds' AND (is_dragging OR NOT gps_available))
 OR EXISTS(SELECT 1 FROM public.anchor_alarm_events e JOIN public.anchor_watch_sessions s USING(session_code)
   WHERE e.user_id=p_owner AND s.owner_user_id=p_owner AND s.expires_at>now() AND e.resolved_at IS NULL
     AND e.created_at>=now()-interval '2 minutes')
 OR EXISTS(SELECT 1 FROM public.pi_alarm_events WHERE owner_id=p_owner AND resolved_at IS NULL AND acked_at IS NULL
   AND kind IN ('collision','close-quarters','distress') AND last_seen_at>=now()-interval '45 seconds')
 OR (p_kind<>'wake-depth' AND EXISTS(SELECT 1 FROM public.pi_wake_events WHERE owner_id=p_owner
   AND kind='wake-depth' AND resolved_at IS NULL AND acked_at IS NULL));
$$;
REVOKE ALL ON FUNCTION public.pi_wake_priority_blocked(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_priority_blocked(uuid,text) TO service_role;

-- One owner-scoped wake lock makes both budgets atomic across multiple paired Pis.
-- No network work occurs inside the transaction. At most eight states are examined.
CREATE OR REPLACE FUNCTION public.pi_wake_apply(p_owner uuid,p_relay text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
#variable_conflict use_column
<<wake>>
DECLARE c public.pi_wake_contexts%ROWTYPE; e public.pi_wake_events%ROWTYPE;
 profile jsonb; state jsonb; alarm jsonb; selected jsonb; kind text; status text; k text; a text; source_ms bigint; raised_ms bigint;
 now_ms bigint; evaluated_ms bigint; source_age bigint; old_revision uuid; context_revision uuid;
 expected uuid; queue_id uuid; queued jsonb:='[]'; acked jsonb:='[]'; text_body jsonb;
 count_pushes integer; resend boolean; tier text; device_count integer; fresh boolean; seen text[]:=ARRAY[]::text[];
BEGIN
 IF p_owner IS NULL OR p_relay IS NULL OR jsonb_typeof(p_request)<>'object' OR p_request->>'family'<>'wake' THEN
  RAISE EXCEPTION 'invalid wake request' USING ERRCODE='22023'; END IF;
 -- Recheck authoritative relay owner/enabled under a short shared row lock.
 PERFORM 1 FROM public.pi_diary_relays WHERE relay_id=p_relay AND owner_id=p_owner AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'wake relay binding changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:wake:'||p_owner::text,0));
 SELECT * INTO c FROM public.pi_wake_contexts WHERE relay_id=p_relay FOR UPDATE;
 a:=p_request->>'action';
 IF a='probe' THEN
  DELETE FROM public.pi_wake_events WHERE id IN(SELECT id FROM public.pi_wake_events WHERE relay_id=p_relay AND resolved_at<now()-interval '30 days' LIMIT 200);
  SELECT count(*) INTO device_count FROM public.push_device_tokens WHERE user_id=p_owner;
  -- A re-paired owner learns nothing about a previous owner's context.
  RETURN jsonb_build_object('contextRevision',CASE WHEN c.owner_id=p_owner THEN c.revision ELSE NULL END,
    'context',CASE WHEN c.owner_id=p_owner THEN c.profile ELSE NULL END,'retired',CASE WHEN c.owner_id=p_owner THEN c.retired ELSE false END,'devices',device_count);
 END IF;
 profile:=p_request->'context';
 IF public.pi_wake_valid_profile(p_owner,profile) IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid wake profile' USING ERRCODE='22023'; END IF;
 IF profile->'binding'->>'pairingId'<>encode(sha256(convert_to(replace(jsonb_build_array(p_owner::text,profile->'binding'->>'piDeviceId',p_relay)::text,', ',','),'UTF8')),'hex') THEN RAISE EXCEPTION 'wake pairing changed' USING ERRCODE='42501'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF a='bind' THEN
  IF NOT(p_request ?& ARRAY['family','action','context','expectedContextRevision']) OR
     p_request-ARRAY['family','action','context','expectedContextRevision']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid wake bind' USING ERRCODE='22023'; END IF;
  expected:=(p_request->>'expectedContextRevision')::uuid;
  IF c.owner_id=p_owner AND c.profile=profile AND NOT c.retired THEN RETURN jsonb_build_object('contextRevision',c.revision,'bound',true); END IF;
  IF (CASE WHEN c.owner_id=p_owner THEN c.revision ELSE NULL END) IS DISTINCT FROM expected THEN RETURN jsonb_build_object('conflict',true); END IF;
  old_revision:=c.revision;context_revision:=gen_random_uuid();
  INSERT INTO public.pi_wake_contexts(relay_id,owner_id,revision,profile) VALUES(p_relay,p_owner,context_revision,profile)
  ON CONFLICT(relay_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,revision=EXCLUDED.revision,profile=EXCLUDED.profile,updated_at=now(),evaluated_at_ms=NULL,higher_priority=false,retired=false;
  UPDATE public.pi_wake_events SET resolved_at=now(),resolved_reason='retired'
   WHERE relay_id=p_relay AND context_revision=old_revision AND resolved_at IS NULL;
  UPDATE public.push_notification_queue SET sent_at=now(),processing_at=NULL,last_error='wake profile retired'
   WHERE notification_type='wake_alarm' AND data->>'context_revision'=old_revision::text AND sent_at IS NULL;
  RETURN jsonb_build_object('contextRevision',context_revision,'bound',true);
 END IF;
 IF a='retire' THEN
  IF NOT(p_request ?& ARRAY['family','action','context','contextRevision']) OR p_request-ARRAY['family','action','context','contextRevision']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid wake retirement' USING ERRCODE='22023'; END IF;
  IF c.owner_id IS DISTINCT FROM p_owner OR c.revision IS DISTINCT FROM (p_request->>'contextRevision')::uuid OR c.profile IS DISTINCT FROM profile THEN RETURN jsonb_build_object('conflict',true); END IF;
  context_revision:=gen_random_uuid();
  UPDATE public.pi_wake_contexts SET revision=wake.context_revision,retired=true,evaluated_at_ms=NULL,updated_at=now() WHERE relay_id=p_relay;
  UPDATE public.pi_wake_events SET resolved_at=now(),resolved_reason='retired' WHERE relay_id=p_relay AND context_revision=c.revision AND resolved_at IS NULL;
  UPDATE public.push_notification_queue SET sent_at=now(),processing_at=NULL,last_error='wake profile retired' WHERE notification_type='wake_alarm' AND data->>'context_revision'=c.revision::text AND sent_at IS NULL;
  RETURN jsonb_build_object('contextRevision',context_revision,'retired',true,'acked','[]'::jsonb,'queued','[]'::jsonb);
 END IF;
 IF a<>'sync' OR NOT(p_request ?& ARRAY['family','action','context','contextRevision','evaluatedAt','higherPriority','states']) OR
    p_request-ARRAY['family','action','context','contextRevision','evaluatedAt','higherPriority','states']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid wake sync' USING ERRCODE='22023'; END IF;
 IF c.owner_id IS DISTINCT FROM p_owner OR c.retired OR c.revision IS DISTINCT FROM (p_request->>'contextRevision')::uuid OR c.profile IS DISTINCT FROM profile THEN RETURN jsonb_build_object('conflict',true); END IF;
 IF jsonb_typeof(p_request->'states')<>'array' THEN RAISE EXCEPTION 'invalid wake states' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_request->'states')<>8 OR jsonb_typeof(p_request->'evaluatedAt')<>'number' OR
    jsonb_typeof(p_request->'higherPriority')<>'string' OR p_request->>'higherPriority' NOT IN ('none','anchor','collision','distress') THEN RAISE EXCEPTION 'invalid wake evaluation' USING ERRCODE='22023'; END IF;
 evaluated_ms:=(p_request->>'evaluatedAt')::bigint;
 IF evaluated_ms>now_ms+1000 OR now_ms-evaluated_ms>30000 THEN RAISE EXCEPTION 'stale wake evaluation' USING ERRCODE='22023'; END IF;
 IF c.evaluated_at_ms IS NOT NULL AND evaluated_ms<c.evaluated_at_ms THEN RETURN jsonb_build_object('conflict',true); END IF;
 -- Process depth first so rest cannot consume its priority even in the same batch.
 FOR state IN SELECT value FROM jsonb_array_elements(p_request->'states') ORDER BY CASE WHEN value->>'kind'='wake-depth' THEN 0 ELSE 1 END LOOP
  kind:=state->>'kind';status:=state->>'status';alarm:=state->'alarm';
  IF jsonb_typeof(state)<>'object' OR NOT(state ?& ARRAY['kind','status','quiet','alarm']) OR state-ARRAY['kind','status','quiet','alarm']<>'{}'::jsonb
    OR jsonb_typeof(state->'kind')<>'string' OR kind NOT IN ('wake-depth','wake-wind','wake-speed','wake-pressure','wake-coolant','wake-oil','wake-rpm','wake-battery') OR kind=ANY(seen)
    OR jsonb_typeof(state->'status')<>'string' OR status NOT IN ('disabled','unconfigured','unknown','watching','pending','active') OR jsonb_typeof(state->'quiet')<>'boolean' THEN RAISE EXCEPTION 'invalid wake state' USING ERRCODE='22023'; END IF;
  seen:=array_append(seen,kind);
  SELECT value INTO selected FROM jsonb_array_elements(profile->'rules') WHERE value->>'kind'=wake.kind;
  IF ((selected->>'enabled')::boolean AND status='disabled') OR (NOT (selected->>'enabled')::boolean AND status<>'disabled') THEN RAISE EXCEPTION 'wake preset configuration changed' USING ERRCODE='22023'; END IF;
  IF status IN ('unknown','unconfigured') THEN
   UPDATE public.pi_wake_events SET source_qualified=false,quiet=(state->>'quiet')::boolean WHERE relay_id=p_relay AND context_revision=c.revision AND kind=wake.kind AND resolved_at IS NULL;
   CONTINUE; END IF; -- Never clear/fire/deliver on unknown.
  IF status<>'active' THEN
   IF alarm<>'null'::jsonb THEN RAISE EXCEPTION 'unexpected wake alarm' USING ERRCODE='22023'; END IF;
   UPDATE public.pi_wake_events SET resolved_at=now(),resolved_reason=CASE WHEN status='disabled' THEN 'retired' ELSE 'clear' END
    WHERE relay_id=p_relay AND context_revision=c.revision AND kind=wake.kind AND resolved_at IS NULL;
   CONTINUE;
  END IF;
  IF jsonb_typeof(alarm)<>'object' OR NOT(alarm ?& ARRAY['key','sourceKey','sourceAt','raisedAt','value','threshold','depthBasis','ackedAt']) OR
    alarm-ARRAY['key','sourceKey','sourceAt','raisedAt','value','threshold','depthBasis','ackedAt']<>'{}'::jsonb OR
    jsonb_typeof(alarm->'sourceAt')<>'number' OR jsonb_typeof(alarm->'raisedAt')<>'number' OR jsonb_typeof(alarm->'value')<>'number' OR jsonb_typeof(alarm->'threshold')<>'number' THEN RAISE EXCEPTION 'invalid wake alarm' USING ERRCODE='22023'; END IF;
  source_ms:=(alarm->>'sourceAt')::bigint;raised_ms:=(alarm->>'raisedAt')::bigint;k:=alarm->>'key';source_age:=CASE WHEN kind='wake-pressure' THEN 120000 ELSE CASE WHEN kind='wake-battery' THEN 180000 ELSE 13000 END END;
  IF source_ms>evaluated_ms+1000 OR evaluated_ms-source_ms>source_age OR raised_ms>source_ms OR raised_ms<now_ms-30*24*3600000::bigint OR raised_ms<=0 OR
    k!~'^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$' OR split_part(k,':',1)<>kind OR split_part(k,':',3)::bigint<>raised_ms OR
    alarm->>'sourceKey'!~'^[0-9a-f]{64}$' OR alarm->>'sourceKey' IS DISTINCT FROM selected->>'sourceKey' OR (alarm->>'threshold')::double precision IS DISTINCT FROM (selected->>'threshold')::double precision OR
    k<>public.pi_wake_episode_key(profile,kind,alarm->>'sourceKey',raised_ms) OR
    jsonb_typeof(alarm->'ackedAt') NOT IN ('null','number') OR (alarm->>'ackedAt' IS NOT NULL AND ((alarm->>'ackedAt')::bigint>evaluated_ms+1000 OR (alarm->>'ackedAt')::bigint<now_ms-30*24*3600000::bigint))
    THEN RAISE EXCEPTION 'invalid wake clocks/source' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM public.pi_wake_events WHERE relay_id=p_relay AND alarm_key=k FOR UPDATE;
  IF FOUND AND (e.context_revision<>c.revision OR e.rules_digest<>profile->>'rulesDigest' OR e.source_key<>alarm->>'sourceKey' OR e.resolved_at IS NOT NULL) THEN
   CONTINUE; -- A resolved episode never reopens; a new fire owns a new key.
  END IF;
  IF e.id IS NOT NULL AND source_ms<e.source_at_ms THEN CONTINUE; END IF;
  UPDATE public.pi_wake_events SET resolved_at=now(),resolved_reason='retired' WHERE relay_id=p_relay AND context_revision=c.revision
   AND kind=wake.kind AND alarm_key<>k AND resolved_at IS NULL;
  INSERT INTO public.pi_wake_events(owner_id,relay_id,context_revision,rules_digest,kind,alarm_key,source_key,raised_at_ms,source_at_ms,measured_value,threshold,depth_basis,quiet,acked_at)
  VALUES(p_owner,p_relay,c.revision,profile->>'rulesDigest',kind,k,alarm->>'sourceKey',raised_ms,source_ms,(alarm->>'value')::double precision,
   (alarm->>'threshold')::double precision,alarm->>'depthBasis',(state->>'quiet')::boolean,
   CASE WHEN alarm->>'ackedAt' IS NOT NULL THEN to_timestamp((alarm->>'ackedAt')::double precision/1000) ELSE NULL END)
  ON CONFLICT(relay_id,alarm_key) DO UPDATE SET source_at_ms=EXCLUDED.source_at_ms,measured_value=EXCLUDED.measured_value,
   threshold=EXCLUDED.threshold,depth_basis=EXCLUDED.depth_basis,quiet=EXCLUDED.quiet,source_qualified=true,last_seen_at=now(),acked_at=coalesce(pi_wake_events.acked_at,EXCLUDED.acked_at)
  RETURNING * INTO e;
  IF e.acked_at IS NOT NULL OR e.quiet OR public.pi_wake_quiet(selected->'quietHours',clock_timestamp()) OR p_request->>'higherPriority'<>'none' OR public.pi_wake_priority_blocked(p_owner,kind) THEN CONTINUE; END IF;
  resend:=e.pushed_count>0;
  IF e.pushed_count>=3 OR (resend AND (e.last_pushed_at>now()-interval '10 minutes' OR source_ms<=e.last_pushed_source_at_ms)) THEN CONTINUE; END IF;
  tier:=CASE WHEN kind='wake-depth' THEN 'depth' ELSE 'rest' END;
  SELECT count(*) INTO count_pushes FROM public.push_notification_queue WHERE recipient_user_id=p_owner AND notification_type='wake_alarm'
   AND created_at>=now()-interval '1 hour' AND data->>'priority'=tier AND data->>'resend'=resend::text;
  IF count_pushes>=(CASE WHEN resend THEN 2 ELSE 4 END) THEN CONTINUE; END IF;
  SELECT count(*) INTO device_count FROM public.push_device_tokens WHERE user_id=p_owner;
  IF device_count=0 THEN CONTINUE; END IF;
  text_body:=public.pi_wake_text(kind,e.measured_value,e.threshold,e.depth_basis);
  INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,title,body,data)
  VALUES(p_owner,'wake_alarm',text_body->>'title',text_body->>'body',jsonb_build_object('kind',kind,'alarm_key',k,'rules_digest',e.rules_digest,
   'context_revision',c.revision,'source_key',e.source_key,'source_at',source_ms,'value',e.measured_value,'threshold',e.threshold,'depth_basis',e.depth_basis,
   'priority',tier,'resend',resend)) RETURNING id INTO queue_id;
  queued:=queued||jsonb_build_array(queue_id);
  UPDATE public.pi_wake_events SET last_pushed_at=now(),last_pushed_source_at_ms=source_ms,pushed_count=pushed_count+1 WHERE id=e.id;
 END LOOP;
 IF cardinality(seen)<>8 THEN RAISE EXCEPTION 'incomplete wake evaluation' USING ERRCODE='22023'; END IF;
 UPDATE public.pi_wake_contexts SET evaluated_at_ms=evaluated_ms,updated_at=now(),higher_priority=p_request->>'higherPriority'<>'none' WHERE relay_id=p_relay AND revision=c.revision;
 SELECT coalesce(jsonb_agg(alarm_key),'[]'::jsonb) INTO acked FROM public.pi_wake_events WHERE relay_id=p_relay AND context_revision=c.revision AND resolved_at IS NULL AND acked_at IS NOT NULL;
 RETURN jsonb_build_object('contextRevision',c.revision,'acked',acked,'queued',queued);
END; $$;
REVOKE ALL ON FUNCTION public.pi_wake_apply(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_apply(uuid,text,jsonb) TO service_role;

CREATE SCHEMA thalassa_wake_private;
REVOKE ALL ON SCHEMA thalassa_wake_private FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA thalassa_wake_private TO authenticated;
CREATE FUNCTION thalassa_wake_private.acknowledge(p_key text,p_digest text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE caller uuid:=auth.uid(); affected integer;
BEGIN
 IF caller IS NULL THEN RAISE EXCEPTION 'sign in to acknowledge' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$' OR p_digest IS NULL OR p_digest!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid wake acknowledgement' USING ERRCODE='22023'; END IF;
 UPDATE public.pi_wake_events SET acked_at=coalesce(acked_at,now()),acked_by=coalesce(acked_by,caller)
  WHERE owner_id=caller AND alarm_key=p_key AND rules_digest=p_digest AND resolved_at IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected;
END; $$;
REVOKE ALL ON FUNCTION thalassa_wake_private.acknowledge(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION thalassa_wake_private.acknowledge(text,text) TO authenticated;
CREATE FUNCTION public.acknowledge_pi_wake_alarm(p_alarm_key text,p_rules_digest text)
RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT thalassa_wake_private.acknowledge(p_alarm_key,p_rules_digest);
$$;
REVOKE ALL ON FUNCTION public.acknowledge_pi_wake_alarm(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_pi_wake_alarm(text,text) TO authenticated;

-- Rechecked before every actual APNs attempt. A stale, acked, cleared, replaced,
-- quiet or higher-priority-blocked wake cannot escape through the retry drain.
CREATE FUNCTION public.pi_wake_delivery_current(p_queue_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.push_notification_queue q JOIN public.pi_wake_events e
 ON e.owner_id=q.recipient_user_id AND e.alarm_key=q.data->>'alarm_key' AND e.rules_digest=q.data->>'rules_digest'
 JOIN public.pi_wake_contexts c ON c.relay_id=e.relay_id AND c.owner_id=e.owner_id AND c.revision=e.context_revision
 JOIN public.pi_diary_relays r ON r.relay_id=c.relay_id AND r.owner_id=c.owner_id AND r.enabled
 WHERE q.id=p_queue_id AND q.notification_type='wake_alarm' AND q.sent_at IS NULL AND e.resolved_at IS NULL AND e.acked_at IS NULL AND NOT e.quiet AND e.source_qualified AND NOT c.higher_priority AND NOT c.retired
 AND q.data->>'context_revision'=c.revision::text AND q.data->>'source_key'=e.source_key
 AND NOT public.pi_wake_quiet((SELECT value->'quietHours' FROM jsonb_array_elements(c.profile->'rules') WHERE value->>'kind'=e.kind),now())
 AND (q.data->>'source_at')::bigint=e.last_pushed_source_at_ms
 AND c.profile->>'rulesDigest'=e.rules_digest AND c.evaluated_at_ms<=floor(extract(epoch FROM now())*1000)::bigint
 AND c.evaluated_at_ms>=floor(extract(epoch FROM now()-interval '30 seconds')*1000)::bigint
 AND (q.data->>'source_at')::bigint<=floor(extract(epoch FROM now()+interval '1 second')*1000)::bigint
 AND (q.data->>'source_at')::bigint>=floor(extract(epoch FROM now())*1000)::bigint-
   CASE e.kind WHEN 'wake-pressure' THEN 120000 WHEN 'wake-battery' THEN 180000 ELSE 13000 END
 AND q.created_at>=now()-interval '30 seconds' AND NOT public.pi_wake_priority_blocked(e.owner_id,e.kind)
 AND q.title=public.pi_wake_text(e.kind,(q.data->>'value')::double precision,(q.data->>'threshold')::double precision,q.data->>'depth_basis')->>'title'
 AND q.body=public.pi_wake_text(e.kind,(q.data->>'value')::double precision,(q.data->>'threshold')::double precision,q.data->>'depth_basis')->>'body');
$$;
REVOKE ALL ON FUNCTION public.pi_wake_delivery_current(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_wake_delivery_current(uuid) TO service_role;

CREATE FUNCTION public.pi_alarm_wake_capability()
RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN (SELECT count(*)=2 FROM pg_class WHERE oid IN('public.pi_wake_contexts'::regclass,'public.pi_wake_events'::regclass) AND relrowsecurity)
 AND NOT has_function_privilege('anon','public.pi_wake_apply(uuid,text,jsonb)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.pi_wake_apply(uuid,text,jsonb)','EXECUTE')
 AND NOT has_table_privilege('authenticated','public.pi_wake_events','INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('anon','public.pi_wake_events','SELECT')
 THEN 1 ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION public.pi_alarm_wake_capability() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pi_alarm_wake_capability() TO service_role;
COMMIT;
