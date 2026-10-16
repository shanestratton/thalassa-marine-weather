-- HELD 137-06. Requires reviewed 137-05; no cron/provider/capability activated.
BEGIN;
-- Missing allowOverdue remains anchor-only; changing purpose retires prior consent via existing CAS.
CREATE OR REPLACE FUNCTION private_shore.valid_configuration(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND p ?& ARRAY['channel','label','address','sharePosition','enabled'] AND p-ARRAY['channel','label','address','sharePosition','enabled','allowOverdue']='{}'::jsonb
 AND (NOT(p ? 'allowOverdue') OR jsonb_typeof(p->'allowOverdue')='boolean') AND p->>'channel' IN ('email','telegram') AND jsonb_typeof(p->'label')='string' AND length(p->>'label') BETWEEN 1 AND 60 AND p->>'label'=btrim(p->>'label') AND (p->>'label')!~'[[:cntrl:]]'
 AND jsonb_typeof(p->'enabled')='boolean' AND jsonb_typeof(p->'sharePosition')='boolean'
 AND CASE WHEN p->>'channel'='telegram' THEN p->'address'='null'::jsonb ELSE (p->'sharePosition'='false'::jsonb OR p->'allowOverdue'='true'::jsonb) AND jsonb_typeof(p->'address')='string' AND length(p->>'address') BETWEEN 3 AND 254 AND (p->>'address')!~'[[:cntrl:][:space:]]' AND (p->>'address')~'^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' END,false)
$$;
ALTER TABLE private_shore.contacts ADD COLUMN invite_policy_version integer NOT NULL DEFAULT 1 CHECK(invite_policy_version IN (1,2));
-- Replace old signatures, retaining defaults for legacy anchor-only callers.
DROP FUNCTION public.shore_telegram_command(text,text,text,bigint,bigint,text,text);
DROP FUNCTION public.shore_consent(text,text,text,text,text);
DROP FUNCTION public.shore_invite(uuid,uuid,uuid,text,text);
CREATE FUNCTION public.shore_invite(p_owner uuid,p_contact uuid,p_revision uuid,p_confirm_hash text,p_revoke_hash text,p_policy_version integer DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE c private_shore.contacts; q private_shore.quotas; BEGIN
 IF p_confirm_hash!~'^[a-f0-9]{64}$' OR p_revoke_hash!~'^[a-f0-9]{64}$' OR p_confirm_hash=p_revoke_hash THEN RAISE EXCEPTION 'Invalid nonce hashes'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shore:'||p_owner::text,0));
 SELECT * INTO c FROM private_shore.contacts WHERE id=p_contact AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND OR c.revision IS DISTINCT FROM p_revision OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=c.boat_id AND owner_id=p_owner AND archived_at IS NULL) THEN RAISE EXCEPTION 'Contact changed' USING ERRCODE='40001'; END IF;
 IF (p_policy_version IS NULL OR p_policy_version NOT IN (1,2)) OR (c.configuration->'allowOverdue'='true'::jsonb AND p_policy_version IS DISTINCT FROM 2) THEN RAISE EXCEPTION 'Review exact overdue purpose in current invitation' USING ERRCODE='55000'; END IF;
 IF NOT private_shore.permitted(c.configuration->>'channel') THEN RAISE EXCEPTION 'Delivery capability held' USING ERRCODE='55000'; END IF;
 IF c.invited_at>now()-interval '10 minutes' THEN RAISE EXCEPTION 'Invitation cooldown' USING ERRCODE='54000'; END IF;
 INSERT INTO private_shore.quotas(owner_id,day) VALUES(p_owner,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT(owner_id) DO NOTHING;
 SELECT * INTO q FROM private_shore.quotas WHERE owner_id=p_owner FOR UPDATE;
 IF q.day<>(now() AT TIME ZONE 'UTC')::date THEN q.invites:=0;q.deliveries:=0; END IF;
 IF q.invites>=10 THEN RAISE EXCEPTION 'Daily invitation quota' USING ERRCODE='54000'; END IF;
 INSERT INTO private_shore.global_quotas(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(day) DO NOTHING;
 UPDATE private_shore.global_quotas SET invites=invites+1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND invites<500; IF NOT FOUND THEN RAISE EXCEPTION 'Global invitation quota' USING ERRCODE='54000'; END IF;
 UPDATE private_shore.quotas SET day=(now() AT TIME ZONE 'UTC')::date,invites=q.invites+1,deliveries=q.deliveries WHERE owner_id=p_owner;
 UPDATE private_shore.contacts SET consent='pending',consented_at=NULL,chat_id=NULL,user_id=NULL,bot_id=NULL,invite_policy_version=p_policy_version,invite_bot_id=(SELECT bot_id FROM private_shore.control WHERE singleton),revoke_key=c.revision,invited_at=now(),configuration=jsonb_set(configuration,'{enabled}','false') WHERE id=c.id;
 UPDATE private_shore.deliveries SET finished=true WHERE contact_id=c.id;
 DELETE FROM private_shore.nonces WHERE contact_id=c.id;
 INSERT INTO private_shore.nonces(contact_id,revision,kind,hash,expires_at,used_at) VALUES(c.id,c.revision,'confirm',p_confirm_hash,now()+interval '24 hours',NULL),(c.id,c.revision,'revoke',p_revoke_hash,now()+interval '1 year',NULL);
 RETURN jsonb_build_object('invitationId',gen_random_uuid(),'channel',c.configuration->>'channel','address',c.configuration->>'address','allowOverdue',coalesce((c.configuration->>'allowOverdue')::boolean,false),'sharePosition',(c.configuration->>'sharePosition')::boolean,'botId',(SELECT bot_id FROM private_shore.control WHERE singleton));
END $$;
CREATE FUNCTION public.shore_consent(p_hash text,p_action text,p_chat text DEFAULT NULL,p_user text DEFAULT NULL,p_bot text DEFAULT NULL,p_policy_version integer DEFAULT 1) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE n private_shore.nonces;c private_shore.contacts; BEGIN
 IF p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_action NOT IN ('confirm','revoke') THEN RETURN false; END IF;
 SELECT * INTO n FROM private_shore.nonces WHERE hash=p_hash AND kind=p_action;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO c FROM private_shore.contacts WHERE id=n.contact_id FOR UPDATE;
 SELECT * INTO n FROM private_shore.nonces WHERE hash=p_hash AND kind=p_action FOR UPDATE;
 IF NOT FOUND OR n.used_at IS NOT NULL OR n.expires_at<=now() OR n.revision<>c.revision OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=c.boat_id AND owner_id=c.owner_id AND archived_at IS NULL) THEN RETURN false; END IF;
 IF p_action='confirm' THEN
  IF c.configuration->'allowOverdue'='true'::jsonb AND (p_policy_version IS DISTINCT FROM 2 OR c.invite_policy_version<>2) THEN RETURN false; END IF;
  IF NOT private_shore.permitted(c.configuration->>'channel') THEN RETURN false; END IF;
  IF c.configuration->>'channel'='telegram' AND (p_chat IS NULL OR p_user IS NULL OR p_chat!~'^[1-9][0-9]{0,15}$' OR p_chat<>p_user OR p_bot IS DISTINCT FROM c.invite_bot_id OR p_bot IS DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton) OR n.preview_chat IS DISTINCT FROM p_chat OR n.preview_user IS DISTINCT FROM p_user OR n.preview_at IS NULL OR n.preview_at<=now()-interval '5 minutes' OR n.preview_at>now()) THEN RETURN false; END IF;
  IF c.configuration->>'channel'='email' AND (p_chat IS NOT NULL OR p_user IS NOT NULL OR p_bot IS NOT NULL) THEN RETURN false; END IF;
  UPDATE private_shore.contacts SET consent='confirmed',consented_at=now(),chat_id=p_chat,user_id=p_user,bot_id=p_bot WHERE id=c.id;
 ELSE UPDATE private_shore.contacts SET consent='revoked',consented_at=NULL,configuration=jsonb_set(configuration,'{enabled}','false') WHERE id=c.id; UPDATE private_shore.deliveries SET finished=true WHERE contact_id=c.id; END IF;
 UPDATE private_shore.nonces SET used_at=now() WHERE contact_id=c.id AND kind=p_action; RETURN true;
END $$;
CREATE FUNCTION public.shore_telegram_command(p_bot text,p_chat text,p_user text,p_update bigint,p_at bigint,p_command text,p_hash text DEFAULT NULL,p_policy_version integer DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE prior private_shore.telegram_updates; c private_shore.contacts; n private_shore.nonces; pos jsonb; matches integer; result jsonb; BEGIN
 IF p_bot IS DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton) OR p_chat IS NULL OR p_user IS NULL OR p_chat<>p_user OR p_chat!~'^[1-9][0-9]{0,15}$' OR p_update IS NULL OR p_update<0 OR p_at IS NULL OR p_at<=0 OR p_at>extract(epoch FROM now())*1000 OR (p_command<>'stop' AND p_at<extract(epoch FROM now()-interval '5 minutes')*1000) OR p_command IS NULL OR p_command NOT IN ('preview','confirm','stop','where') THEN RETURN NULL; END IF;
 DELETE FROM private_shore.telegram_updates WHERE accepted_at<now()-interval '1 day';
 PERFORM pg_advisory_xact_lock(hashtextextended('shore-chat:'||p_bot||':'||p_chat,0));
 SELECT * INTO prior FROM private_shore.telegram_updates WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user FOR UPDATE;
 IF prior.update_id IS NOT NULL AND p_update<=prior.update_id THEN RETURN NULL; END IF;
 IF p_command='preview' THEN
  IF p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR NOT private_shore.permitted('telegram') THEN RETURN NULL; END IF;
  SELECT * INTO n FROM private_shore.nonces WHERE hash=p_hash AND kind='confirm';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO c FROM private_shore.contacts WHERE id=n.contact_id FOR UPDATE;
  SELECT * INTO n FROM private_shore.nonces WHERE hash=p_hash AND kind='confirm' FOR UPDATE;
  IF NOT FOUND OR n.used_at IS NOT NULL OR n.expires_at<=now() OR n.revision<>c.revision OR (c.configuration->'allowOverdue'='true'::jsonb AND (p_policy_version IS DISTINCT FROM 2 OR c.invite_policy_version<>2)) OR c.configuration->>'channel'<>'telegram' OR c.invite_bot_id IS DISTINCT FROM p_bot OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=c.boat_id AND owner_id=c.owner_id AND archived_at IS NULL) OR (n.preview_chat IS NOT NULL AND (n.preview_chat IS DISTINCT FROM p_chat OR n.preview_user IS DISTINCT FROM p_user)) THEN RETURN NULL; END IF;
  UPDATE private_shore.nonces SET preview_chat=p_chat,preview_user=p_user,preview_at=now() WHERE contact_id=c.id AND kind='confirm';
 ELSIF p_command='confirm' THEN
  IF public.shore_consent(p_hash,'confirm',p_chat,p_user,p_bot,p_policy_version) IS NOT TRUE THEN RETURN NULL; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM private_shore.contacts WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user AND consent='confirmed') THEN RETURN NULL; END IF;
 INSERT INTO private_shore.telegram_updates VALUES(p_bot,p_chat,p_user,p_update,now(),prior.replied_at) ON CONFLICT(bot_id,chat_id,user_id) DO UPDATE SET update_id=EXCLUDED.update_id,accepted_at=now();
 IF p_command='stop' THEN
  UPDATE private_shore.contacts SET consent='revoked',consented_at=NULL,configuration=jsonb_set(configuration,'{enabled}','false') WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user;
  UPDATE private_shore.deliveries d SET finished=true FROM private_shore.contacts x WHERE d.contact_id=x.id AND x.bot_id=p_bot AND x.chat_id=p_chat AND x.user_id=p_user;
  RETURN jsonb_build_object('text','Shore-contact messages stopped. A new invitation and confirmation are required to restart.');
 END IF;
 IF p_command<>'confirm' AND prior.replied_at>now()-interval '1 minute' THEN RETURN NULL; END IF;
 UPDATE private_shore.telegram_updates SET replied_at=now() WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user;
 IF p_command='preview' THEN RETURN jsonb_build_object('invitation',jsonb_build_object('allowOverdue',coalesce((c.configuration->>'allowOverdue')::boolean,false),'sharePosition',(c.configuration->>'sharePosition')::boolean)); END IF;
 IF p_command='confirm' THEN RETURN jsonb_build_object('text','Consent recorded. The owner must separately enable this vessel contact. Use /stop to revoke.'); END IF;
 IF NOT private_shore.permitted('telegram') THEN RETURN NULL; END IF;
 SELECT count(*) INTO matches FROM private_shore.contacts x JOIN public.boats b ON b.id=x.boat_id AND b.owner_id=x.owner_id AND b.archived_at IS NULL WHERE x.bot_id=p_bot AND x.chat_id=p_chat AND x.user_id=p_user AND x.consent='confirmed' AND (x.configuration->>'enabled')::boolean AND (x.configuration->>'sharePosition')::boolean;
 IF matches<>1 THEN RETURN jsonb_build_object('text','Position unavailable: no single explicitly shared vessel is selected.'); END IF;
 SELECT x.* INTO c FROM private_shore.contacts x JOIN public.boats b ON b.id=x.boat_id AND b.owner_id=x.owner_id AND b.archived_at IS NULL WHERE x.bot_id=p_bot AND x.chat_id=p_chat AND x.user_id=p_user AND x.consent='confirmed' AND (x.configuration->>'enabled')::boolean AND (x.configuration->>'sharePosition')::boolean;
 pos:=private_shore.position(c.boat_id);
 IF pos IS NULL OR (pos->>'revision')::uuid IS DISTINCT FROM c.position_revision THEN RETURN jsonb_build_object('text','Position unavailable: no fresh receipt from the explicitly agreed vessel source.'); END IF;
 result:=jsonb_build_object('position',jsonb_build_object('lat',pos->'lat','lon',pos->'lon','at',pos->'at')); RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.shore_invite(uuid,uuid,uuid,text,text,integer),public.shore_consent(text,text,text,text,text,integer),public.shore_telegram_command(text,text,text,bigint,bigint,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shore_invite(uuid,uuid,uuid,text,text,integer),public.shore_consent(text,text,text,text,text,integer),public.shore_telegram_command(text,text,text,bigint,bigint,text,text,integer) TO service_role;
CREATE SCHEMA private_overdue;
REVOKE ALL ON SCHEMA private_overdue FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private_overdue TO authenticated,service_role;
CREATE TABLE private_overdue.control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false,function_version integer NOT NULL DEFAULT 0 CHECK(function_version BETWEEN 0 AND 1),delivery_version integer NOT NULL DEFAULT 0 CHECK(delivery_version BETWEEN 0 AND 1),entitlement_until timestamptz,worker_at timestamptz,cursor uuid);
INSERT INTO private_overdue.control(singleton) VALUES(true);
CREATE FUNCTION private_overdue.permitted() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT enabled AND function_version=1 AND delivery_version=1 AND entitlement_until>now() FROM private_overdue.control WHERE singleton),false)
$$;
CREATE FUNCTION private_overdue.ready() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE scheduled boolean:=false; BEGIN
 IF NOT private_overdue.permitted() OR NOT EXISTS(SELECT 1 FROM private_overdue.control WHERE worker_at>now()-interval '5 minutes') OR to_regclass('cron.job') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job WHERE active AND jobname=$1 AND schedule=$2 AND command=$3)' INTO scheduled USING 'overdue-watch','* * * * *','SELECT public.invoke_edge_function(''overdue-watch'', 25000, ''{"action":"work"}''::jsonb)';
 RETURN scheduled;
END $$;
-- A fixed table lookup of the explicit registration. A stale/missing fix does not become a new position.
CREATE FUNCTION private_overdue.position_revision(boat uuid,owner uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE result uuid; BEGIN
 IF to_regclass('private_weather_watch.weather_position_registrations') IS NULL THEN RETURN NULL; END IF;
 EXECUTE 'SELECT r.revision FROM private_weather_watch.weather_position_registrations r JOIN public.pi_diary_relays d ON d.relay_id=r.relay_id AND d.boat_id=r.boat_id AND d.owner_id=r.owner_id AND d.enabled WHERE r.boat_id=$1 AND r.owner_id=$2 AND r.enabled' INTO result USING boat,owner;
 RETURN result;
END $$;
CREATE FUNCTION private_overdue.last_position(boat uuid,owner uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 IF revision IS NULL OR revision IS DISTINCT FROM private_overdue.position_revision(boat,owner) OR to_regclass('private_weather_watch.weather_position_receipts') IS NULL THEN RETURN NULL; END IF;
 EXECUTE 'SELECT jsonb_build_object(''lat'',p.lat,''lon'',p.lon,''at'',floor(extract(epoch FROM p.measured_at)*1000)) FROM private_weather_watch.weather_position_receipts p WHERE p.boat_id=$1 AND p.revision=$2 AND p.measured_at<=now() AND p.measured_at>now()-interval ''24 hours''' INTO result USING boat,revision;
 RETURN result;
END $$;
CREATE FUNCTION private_overdue.valid_configuration(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ DECLARE plan jsonb;r jsonb;departure numeric;due numeric;eta numeric; BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>6144 OR NOT(p ?& ARRAY['enabled','plan','contacts','sharePosition','rescueRegion']) OR p-ARRAY['enabled','plan','contacts','sharePosition','rescueRegion']<>'{}'::jsonb OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'sharePosition') IS DISTINCT FROM 'boolean' OR NOT(p->'rescueRegion'='null'::jsonb OR p->>'rescueRegion' IN ('au','nz','us','uk','fr')) THEN RETURN false; END IF;
 plan:=p->'plan';
 IF jsonb_typeof(plan) IS DISTINCT FROM 'object' OR NOT(plan ?& ARRAY['vesselLabel','from','to','departureAt','etaAt','overdueAt','persons']) OR plan-ARRAY['vesselLabel','from','to','departureAt','etaAt','overdueAt','persons']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH r IN ARRAY ARRAY[plan->'vesselLabel',plan->'from',plan->'to'] LOOP IF jsonb_typeof(r) IS DISTINCT FROM 'string' OR length(r#>>'{}') NOT BETWEEN 1 AND 80 OR (r#>>'{}')<>btrim(r#>>'{}') OR (r#>>'{}')~'[[:cntrl:]]' THEN RETURN false; END IF; END LOOP;
 IF jsonb_typeof(plan->'departureAt') IS DISTINCT FROM 'number' OR jsonb_typeof(plan->'overdueAt') IS DISTINCT FROM 'number' OR jsonb_typeof(plan->'persons') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 departure:=(plan->>'departureAt')::numeric;due:=(plan->>'overdueAt')::numeric;
 IF departure<>trunc(departure) OR due<>trunc(due) OR departure<=0 OR due<=departure OR due>8640000000000000 OR due-departure>15552000000 OR (plan->>'persons')::numeric NOT BETWEEN 1 AND 100 OR (plan->>'persons')::numeric<>trunc((plan->>'persons')::numeric) THEN RETURN false; END IF;
 IF plan->'etaAt'<>'null'::jsonb THEN IF jsonb_typeof(plan->'etaAt') IS DISTINCT FROM 'number' THEN RETURN false; END IF;eta:=(plan->>'etaAt')::numeric;IF eta<>trunc(eta) OR eta NOT BETWEEN departure AND due THEN RETURN false; END IF; END IF;
 IF jsonb_typeof(p->'contacts') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'contacts') NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(p->'contacts') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r ?& ARRAY['id','revision']) OR r-ARRAY['id','revision']<>'{}'::jsonb OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'revision') IS DISTINCT FROM 'string' OR (r->>'id')!~*'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR (r->>'revision')!~*'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT x->>'id')=count(*) FROM jsonb_array_elements(p->'contacts') x);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE TABLE public.overdue_watches(boat_id uuid PRIMARY KEY REFERENCES public.boats ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,revision uuid NOT NULL DEFAULT gen_random_uuid(),configuration jsonb NOT NULL CHECK(private_overdue.valid_configuration(configuration)),position_revision uuid,owner_queued_at timestamptz,owner_attempted_at timestamptz,contacts_queued_at timestamptz,ended_at timestamptz,end_reason text CHECK(end_reason IN ('arrived','cancelled')),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX overdue_watches_owner ON public.overdue_watches(owner_id) WHERE configuration->'enabled'='true'::jsonb AND ended_at IS NULL;
ALTER TABLE public.overdue_watches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.overdue_watches FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.overdue_watches TO authenticated;
GRANT ALL ON public.overdue_watches TO service_role;
CREATE POLICY overdue_owner_read ON public.overdue_watches FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.boats b WHERE b.id=boat_id AND b.owner_id=(SELECT auth.uid()) AND b.archived_at IS NULL));
CREATE TABLE private_overdue.owner_deliveries(queue_id uuid PRIMARY KEY REFERENCES public.push_notification_queue ON DELETE CASCADE,boat_id uuid NOT NULL REFERENCES public.overdue_watches ON DELETE CASCADE,revision uuid NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE private_overdue.contact_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),boat_id uuid NOT NULL REFERENCES public.overdue_watches ON DELETE CASCADE,watch_revision uuid NOT NULL,contact_id uuid NOT NULL REFERENCES private_shore.contacts ON DELETE CASCADE,contact_revision uuid NOT NULL,position jsonb,created_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,guarded_at timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),finished boolean NOT NULL DEFAULT false,UNIQUE(boat_id,watch_revision,contact_id));
CREATE INDEX overdue_contact_pending ON private_overdue.contact_deliveries(created_at) WHERE NOT finished;
CREATE TABLE private_overdue.quotas(owner_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,day date NOT NULL,owner_notices integer NOT NULL DEFAULT 0 CHECK(owner_notices BETWEEN 0 AND 10));
CREATE TABLE private_overdue.global_quotas(day date PRIMARY KEY,owner_notices integer NOT NULL DEFAULT 0 CHECK(owner_notices BETWEEN 0 AND 1000));
DO $$ DECLARE n text; BEGIN FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='private_overdue' LOOP EXECUTE format('ALTER TABLE private_overdue.%I ENABLE ROW LEVEL SECURITY',n); END LOOP; END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA private_overdue FROM PUBLIC,anon,authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA private_overdue TO service_role;
CREATE FUNCTION private_overdue.current(w public.overdue_watches) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(private_overdue.permitted() AND w.configuration->'enabled'='true'::jsonb AND w.ended_at IS NULL AND EXISTS(SELECT 1 FROM public.boats b WHERE b.id=w.boat_id AND b.owner_id=w.owner_id AND b.archived_at IS NULL) AND (NOT(w.configuration->>'sharePosition')::boolean OR w.position_revision IS NOT DISTINCT FROM private_overdue.position_revision(w.boat_id,w.owner_id)) AND (NOT(w.configuration->>'sharePosition')::boolean OR w.position_revision IS NOT NULL) AND (w.configuration->'plan'->>'overdueAt')::numeric BETWEEN extract(epoch FROM now()-interval '24 hours')*1000 AND extract(epoch FROM now())*1000,false)
$$;
CREATE FUNCTION private_overdue.contact_current(w public.overdue_watches,c private_shore.contacts) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(private_overdue.current(w) AND c.owner_id=w.owner_id AND c.boat_id=w.boat_id AND c.consent='confirmed' AND c.invite_policy_version=2 AND c.configuration->'enabled'='true'::jsonb AND c.configuration->'allowOverdue'='true'::jsonb AND private_shore.permitted(c.configuration->>'channel') AND (c.configuration->>'channel'<>'telegram' OR c.bot_id IS NOT DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton)) AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.configuration->'contacts') r WHERE r->>'id'=c.id::text AND r->>'revision'=c.revision::text) AND (NOT(w.configuration->>'sharePosition')::boolean OR (c.configuration->'sharePosition'='true'::jsonb AND c.position_revision IS NOT DISTINCT FROM w.position_revision)),false)
$$;
CREATE FUNCTION private_overdue.contacts_valid(w public.overdue_watches) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.configuration->'contacts') r WHERE NOT EXISTS(SELECT 1 FROM private_shore.contacts c WHERE c.id::text=r->>'id' AND c.revision::text=r->>'revision' AND c.owner_id=w.owner_id AND c.boat_id=w.boat_id AND c.consent='confirmed' AND c.invite_policy_version=2 AND c.configuration->'enabled'='true'::jsonb AND c.configuration->'allowOverdue'='true'::jsonb AND private_shore.permitted(c.configuration->>'channel') AND (c.configuration->>'channel'<>'telegram' OR c.bot_id IS NOT DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton)) AND (w.configuration->'sharePosition'='false'::jsonb OR (c.configuration->'sharePosition'='true'::jsonb AND c.position_revision IS NOT DISTINCT FROM w.position_revision))))
$$;
CREATE FUNCTION private_overdue.list(boat uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE caller uuid:=auth.uid();w public.overdue_watches;row jsonb;BEGIN
 IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL) THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 SELECT * INTO w FROM public.overdue_watches WHERE boat_id=boat AND owner_id=caller;
 IF FOUND THEN row:=jsonb_build_object('revision',w.revision,'configuration',w.configuration,'state',jsonb_build_object('ownerQueuedAt',floor(extract(epoch FROM w.owner_queued_at)*1000),'ownerAttemptedAt',floor(extract(epoch FROM w.owner_attempted_at)*1000),'contactsQueuedAt',floor(extract(epoch FROM w.contacts_queued_at)*1000),'endedAt',floor(extract(epoch FROM w.ended_at)*1000)),'endReason',w.end_reason,'reviewRequired',NOT private_overdue.contacts_valid(w) OR (w.configuration->'sharePosition'='true'::jsonb AND (w.position_revision IS NULL OR w.position_revision IS DISTINCT FROM private_overdue.position_revision(w.boat_id,w.owner_id)))); END IF;
 RETURN jsonb_build_object('schema',1,'ownerId',caller,'boatId',boat,'checkedAt',floor(extract(epoch FROM statement_timestamp())*1000),'ready',private_overdue.ready(),'watch',row);
END $$;
CREATE FUNCTION private_overdue.configure(boat uuid,expected uuid,cfg jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE caller uuid:=auth.uid();old public.overdue_watches;next_revision uuid:=gen_random_uuid();r jsonb;c private_shore.contacts;pos uuid;due numeric;BEGIN
 IF caller IS NULL THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('overdue:'||caller::text,0));
 PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 SELECT * INTO old FROM public.overdue_watches WHERE boat_id=boat FOR UPDATE;
 IF old.boat_id IS NOT NULL AND old.owner_id<>caller THEN DELETE FROM public.overdue_watches WHERE boat_id=boat AND owner_id=old.owner_id AND revision=old.revision;old:=NULL;END IF;
 IF old.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Review current overdue watch' USING ERRCODE='40001'; END IF;
 IF private_overdue.valid_configuration(cfg) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid compact plan' USING ERRCODE='22023'; END IF;
 IF cfg->'enabled'='true'::jsonb THEN
  due:=(cfg->'plan'->>'overdueAt')::numeric;
  IF NOT private_overdue.ready() OR due<extract(epoch FROM now()+interval '5 minutes')*1000 OR due>extract(epoch FROM now()+interval '180 days')*1000 OR (cfg->'plan'->>'departureAt')::numeric<extract(epoch FROM now()-interval '180 days')*1000 THEN RAISE EXCEPTION 'Review future deadline and real delivery capability' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.push_device_tokens WHERE user_id=caller AND platform='ios') THEN RAISE EXCEPTION 'Owner push device required' USING ERRCODE='55000'; END IF;
  IF NOT coalesce(old.configuration->'enabled'='true'::jsonb AND old.ended_at IS NULL,false) AND (SELECT count(*) FROM public.overdue_watches x JOIN public.boats b ON b.id=x.boat_id AND b.owner_id=x.owner_id AND b.archived_at IS NULL WHERE x.owner_id=caller AND x.configuration->'enabled'='true'::jsonb AND x.ended_at IS NULL)>=5 THEN RAISE EXCEPTION 'At most five active vessel watches' USING ERRCODE='54000'; END IF;
  IF cfg->'sharePosition'='true'::jsonb THEN pos:=private_overdue.position_revision(boat,caller);IF pos IS NULL THEN RAISE EXCEPTION 'Explicit vessel position registration required' USING ERRCODE='55000'; END IF;END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(cfg->'contacts') LOOP
   SELECT * INTO c FROM private_shore.contacts WHERE id=(r->>'id')::uuid AND revision=(r->>'revision')::uuid AND owner_id=caller AND boat_id=boat;
   IF NOT FOUND OR c.consent<>'confirmed' OR c.invite_policy_version<>2 OR c.configuration->'allowOverdue' IS DISTINCT FROM 'true'::jsonb OR c.configuration->'enabled' IS DISTINCT FROM 'true'::jsonb OR NOT private_shore.ready(c.configuration->>'channel') OR (cfg->'sharePosition'='true'::jsonb AND (c.configuration->'sharePosition' IS DISTINCT FROM 'true'::jsonb OR c.position_revision IS DISTINCT FROM pos)) THEN RAISE EXCEPTION 'Fresh explicit overdue/position consent required' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;
 IF old.boat_id IS NULL THEN INSERT INTO public.overdue_watches(boat_id,owner_id,revision,configuration,position_revision) VALUES(boat,caller,next_revision,cfg,pos);
 ELSE UPDATE public.overdue_watches SET revision=next_revision,configuration=cfg,position_revision=pos,owner_queued_at=NULL,owner_attempted_at=NULL,contacts_queued_at=NULL,ended_at=NULL,end_reason=NULL,updated_at=now() WHERE boat_id=boat;END IF;
 UPDATE private_overdue.contact_deliveries SET finished=true WHERE boat_id=boat;RETURN next_revision;
END $$;
CREATE FUNCTION private_overdue.end_watch(boat uuid,expected uuid,reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE caller uuid:=auth.uid();result uuid:=gen_random_uuid();BEGIN
 IF caller IS NULL OR reason NOT IN ('arrived','cancelled') OR reason IS NULL THEN RAISE EXCEPTION 'Explicit owner action required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('overdue:'||caller::text,0));
 PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 UPDATE public.overdue_watches SET revision=result,configuration=jsonb_set(configuration,'{enabled}','false'),ended_at=now(),end_reason=reason,updated_at=now() WHERE boat_id=boat AND owner_id=caller AND revision=expected;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review current overdue watch' USING ERRCODE='40001'; END IF;
 UPDATE private_overdue.contact_deliveries SET finished=true WHERE boat_id=boat;RETURN result;
END $$;
CREATE FUNCTION public.overdue_watch_status(p_boat_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$SELECT private_overdue.list(p_boat_id)$$;
CREATE FUNCTION public.configure_overdue_watch(p_boat_id uuid,p_expected uuid,p_configuration jsonb) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$SELECT private_overdue.configure(p_boat_id,p_expected,p_configuration)$$;
CREATE FUNCTION public.end_overdue_watch(p_boat_id uuid,p_expected uuid,p_reason text) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$SELECT private_overdue.end_watch(p_boat_id,p_expected,p_reason)$$;
-- Service work only: finite owner-first admission; contact notices need an actual initiated owner attempt.
CREATE FUNCTION public.overdue_watch_work(p_after uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE w public.overdue_watches;c private_shore.contacts;last uuid;queue uuid;expires timestamptz;q private_overdue.quotas;position jsonb;BEGIN
 IF NOT private_overdue.permitted() OR NOT pg_try_advisory_xact_lock(hashtextextended('overdue-work',0)) THEN RETURN NULL; END IF;
 IF p_after IS NULL THEN
  SELECT cursor INTO p_after FROM private_overdue.control WHERE singleton;
  IF p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.overdue_watches x WHERE x.boat_id>p_after AND private_overdue.current(x) AND (x.owner_queued_at IS NULL OR (x.owner_attempted_at IS NOT NULL AND x.owner_attempted_at<=now()-interval '10 minutes' AND x.contacts_queued_at IS NULL))) THEN p_after:=NULL;END IF;
 END IF;
 DELETE FROM private_overdue.owner_deliveries WHERE expires_at<now()-interval '7 days';
 DELETE FROM private_overdue.contact_deliveries WHERE created_at<now()-interval '7 days';DELETE FROM private_overdue.global_quotas WHERE day<(now() AT TIME ZONE 'UTC')::date-7;
 FOR w IN SELECT x.* FROM public.overdue_watches x WHERE (p_after IS NULL OR x.boat_id>p_after) AND private_overdue.current(x) AND (x.owner_queued_at IS NULL OR (x.owner_attempted_at IS NOT NULL AND x.owner_attempted_at<=now()-interval '10 minutes' AND x.contacts_queued_at IS NULL)) ORDER BY x.boat_id LIMIT 16 LOOP
  last:=w.boat_id;PERFORM pg_advisory_xact_lock(hashtextextended('overdue:'||w.owner_id::text,0));
  SELECT * INTO w FROM public.overdue_watches WHERE boat_id=last FOR UPDATE;
  IF NOT private_overdue.current(w) THEN CONTINUE; END IF;
  IF w.owner_queued_at IS NULL THEN
   INSERT INTO private_overdue.quotas(owner_id,day) VALUES(w.owner_id,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT(owner_id) DO NOTHING;
   SELECT * INTO q FROM private_overdue.quotas WHERE owner_id=w.owner_id FOR UPDATE;
   IF q.day<>(now() AT TIME ZONE 'UTC')::date THEN q.owner_notices:=0;END IF;
   IF q.owner_notices>=10 THEN CONTINUE;END IF;
   INSERT INTO private_overdue.global_quotas(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(day) DO NOTHING;
   UPDATE private_overdue.global_quotas SET owner_notices=owner_notices+1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND owner_notices<1000;IF NOT FOUND THEN CONTINUE;END IF;
   UPDATE private_overdue.quotas SET day=(now() AT TIME ZONE 'UTC')::date,owner_notices=q.owner_notices+1 WHERE owner_id=w.owner_id;
   expires:=least(now()+interval '10 minutes',to_timestamp((w.configuration->'plan'->>'overdueAt')::numeric/1000)+interval '24 hours');
   INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,title,body,data) VALUES(w.owner_id,'overdue_notice','Float plan overdue','Arrival has not been confirmed. Review your saved plan; mark arrived, cancel or extend it. Delivery is not guaranteed.',jsonb_build_object('overdue_watch',1,'boatId',w.boat_id,'revision',w.revision,'overdueAt',w.configuration->'plan'->'overdueAt','expiresAt',floor(extract(epoch FROM expires)*1000))) RETURNING id INTO queue;
   INSERT INTO private_overdue.owner_deliveries VALUES(queue,w.boat_id,w.revision,expires);
   UPDATE public.overdue_watches SET owner_queued_at=now() WHERE boat_id=w.boat_id;
  ELSIF w.owner_attempted_at IS NOT NULL AND w.owner_attempted_at<=now()-interval '10 minutes' AND w.contacts_queued_at IS NULL THEN
   position:=CASE WHEN w.configuration->'sharePosition'='true'::jsonb THEN private_overdue.last_position(w.boat_id,w.owner_id,w.position_revision) END;
   FOR c IN SELECT * FROM private_shore.contacts WHERE boat_id=w.boat_id AND owner_id=w.owner_id ORDER BY id LOOP
    IF private_overdue.contact_current(w,c) THEN INSERT INTO private_overdue.contact_deliveries(boat_id,watch_revision,contact_id,contact_revision,position) VALUES(w.boat_id,w.revision,c.id,c.revision,position) ON CONFLICT DO NOTHING;END IF;
   END LOOP;
   UPDATE public.overdue_watches SET contacts_queued_at=now() WHERE boat_id=w.boat_id;
  END IF;
 END LOOP;UPDATE private_overdue.control SET cursor=last WHERE singleton;RETURN jsonb_build_object('after',last);
END $$;
CREATE FUNCTION public.overdue_owner_current(p_queue_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM private_overdue.owner_deliveries d JOIN public.overdue_watches w ON w.boat_id=d.boat_id AND w.revision=d.revision JOIN public.push_notification_queue q ON q.id=d.queue_id AND q.recipient_user_id=w.owner_id AND q.notification_type='overdue_notice' WHERE d.queue_id=p_queue_id AND d.expires_at>now() AND private_overdue.current(w))
$$;
-- Invoke ONLY after an actual token/JWT/payload is prepared, immediately before provider HTTP.
-- This is an initiated-attempt receipt, never evidence of delivery or a read acknowledgement.
CREATE FUNCTION public.overdue_owner_attempt(p_queue_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE d private_overdue.owner_deliveries;BEGIN
 SELECT * INTO d FROM private_overdue.owner_deliveries WHERE queue_id=p_queue_id;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM public.overdue_watches WHERE boat_id=d.boat_id FOR UPDATE;
 IF public.overdue_owner_current(p_queue_id) IS NOT TRUE THEN RETURN false;END IF;
 UPDATE public.overdue_watches SET owner_attempted_at=coalesce(owner_attempted_at,now()) WHERE boat_id=d.boat_id AND revision=d.revision;RETURN FOUND;
END $$;
CREATE FUNCTION public.overdue_contact_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE candidate private_overdue.contact_deliveries;d private_overdue.contact_deliveries;w public.overdue_watches;c private_shore.contacts;q private_shore.quotas;pending boolean:=false;BEGIN
 IF NOT private_overdue.permitted() THEN RETURN NULL;END IF;
 FOR candidate IN SELECT * FROM private_overdue.contact_deliveries WHERE NOT finished AND created_at>now()-interval '10 minutes' AND attempts<3 AND (claimed_at IS NULL OR claimed_at<now()-interval '1 minute') ORDER BY created_at,id LIMIT 10 LOOP
  SELECT * INTO w FROM public.overdue_watches WHERE boat_id=candidate.boat_id FOR SHARE;
  SELECT * INTO d FROM private_overdue.contact_deliveries WHERE id=candidate.id AND NOT finished AND attempts<3 AND (claimed_at IS NULL OR claimed_at<now()-interval '1 minute') FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN pending:=true;CONTINUE;END IF;
  SELECT * INTO c FROM private_shore.contacts WHERE id=d.contact_id;
  IF w.revision IS DISTINCT FROM d.watch_revision OR c.revision IS DISTINCT FROM d.contact_revision OR NOT private_overdue.contact_current(w,c) THEN UPDATE private_overdue.contact_deliveries SET finished=true WHERE id=d.id;CONTINUE;END IF;
  INSERT INTO private_shore.quotas(owner_id,day) VALUES(w.owner_id,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT(owner_id) DO NOTHING;
  SELECT * INTO q FROM private_shore.quotas WHERE owner_id=w.owner_id FOR UPDATE;
  IF q.day<>(now() AT TIME ZONE 'UTC')::date THEN q.deliveries:=0;q.invites:=0;END IF;
  IF q.deliveries>=30 THEN pending:=true;CONTINUE;END IF;
  INSERT INTO private_shore.global_quotas(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(day) DO NOTHING;
  UPDATE private_shore.global_quotas SET deliveries=deliveries+1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND deliveries<5000;IF NOT FOUND THEN pending:=true;CONTINUE;END IF;
  UPDATE private_shore.quotas SET day=(now() AT TIME ZONE 'UTC')::date,invites=q.invites,deliveries=q.deliveries+1 WHERE owner_id=w.owner_id;
  UPDATE private_overdue.contact_deliveries SET attempts=attempts+1,claimed_at=now(),guarded_at=NULL WHERE id=d.id;
  RETURN jsonb_build_object('id',d.id,'revision',d.watch_revision,'contactRevision',d.contact_revision,'contactId',c.id,'channel',c.configuration->>'channel','address',c.configuration->>'address','chatId',c.chat_id,'botId',c.bot_id,'revokeKey',c.revoke_key,'revokeHash',(SELECT hash FROM private_shore.nonces WHERE contact_id=c.id AND revision=c.revision AND kind='revoke' AND used_at IS NULL AND expires_at>now()),'preparedAt',floor(extract(epoch FROM d.created_at)*1000),'plan',w.configuration->'plan','rescueRegion',w.configuration->'rescueRegion','position',d.position,'ownerAttemptedAt',floor(extract(epoch FROM w.owner_attempted_at)*1000));
 END LOOP;IF pending OR EXISTS(SELECT 1 FROM private_overdue.contact_deliveries WHERE NOT finished AND attempts<3 AND created_at>now()-interval '10 minutes' AND (claimed_at IS NULL OR claimed_at<now()-interval '1 minute')) THEN RETURN jsonb_build_object('more',true);END IF;RETURN NULL;
END $$;
CREATE FUNCTION public.overdue_contact_guard(p_id uuid,p_revision uuid,p_contact_revision uuid) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE d private_overdue.contact_deliveries;w public.overdue_watches;c private_shore.contacts;BEGIN
 SELECT * INTO d FROM private_overdue.contact_deliveries WHERE id=p_id;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO w FROM public.overdue_watches WHERE boat_id=d.boat_id FOR SHARE;
 SELECT * INTO d FROM private_overdue.contact_deliveries WHERE id=p_id FOR UPDATE;
 SELECT * INTO c FROM private_shore.contacts WHERE id=d.contact_id;
 IF d.finished OR d.watch_revision IS DISTINCT FROM p_revision OR d.contact_revision IS DISTINCT FROM p_contact_revision OR w.revision IS DISTINCT FROM p_revision OR c.revision IS DISTINCT FROM p_contact_revision OR d.guarded_at IS NOT NULL OR d.claimed_at IS NULL OR d.claimed_at<now()-interval '30 seconds' OR d.created_at<now()-interval '10 minutes' OR NOT private_overdue.contact_current(w,c) OR w.owner_attempted_at IS NULL OR w.owner_attempted_at>now()-interval '10 minutes' THEN RETURN false;END IF;
 UPDATE private_overdue.contact_deliveries SET guarded_at=now(),finished=c.configuration->>'channel'='telegram' WHERE id=p_id;RETURN true;
END $$;
CREATE FUNCTION public.overdue_contact_finish(p_id uuid,p_revision uuid,p_success boolean) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$UPDATE private_overdue.contact_deliveries SET finished=finished OR p_success OR attempts>=3 WHERE id=p_id AND watch_revision=p_revision$$;
CREATE FUNCTION public.overdue_worker_finish(p_success boolean) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$UPDATE private_overdue.control SET worker_at=CASE WHEN p_success THEN now() END WHERE singleton$$;
CREATE OR REPLACE FUNCTION private_shore.list(boat uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE caller uuid:=auth.uid();rows jsonb;BEGIN
 IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL) THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'configuration',configuration,'consent',consent,'consentedAt',floor(extract(epoch FROM consented_at)*1000)) ORDER BY created_at,id),'[]'::jsonb) INTO rows FROM private_shore.contacts WHERE owner_id=caller AND boat_id=boat;
 RETURN jsonb_build_object('schema',1,'ownerId',caller,'boatId',boat,'checkedAt',floor(extract(epoch FROM statement_timestamp())*1000),'emailReady',private_shore.ready('email'),'telegramReady',private_shore.ready('telegram'),'overdueReady',private_overdue.ready(),'contacts',rows);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_overdue FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private_overdue.list(uuid),private_overdue.configure(uuid,uuid,jsonb),private_overdue.end_watch(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private_overdue TO service_role;
REVOKE ALL ON FUNCTION public.overdue_watch_status(uuid),public.configure_overdue_watch(uuid,uuid,jsonb),public.end_overdue_watch(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.overdue_watch_status(uuid),public.configure_overdue_watch(uuid,uuid,jsonb),public.end_overdue_watch(uuid,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.overdue_watch_work(uuid),public.overdue_owner_current(uuid),public.overdue_owner_attempt(uuid),public.overdue_contact_claim(),public.overdue_contact_guard(uuid,uuid,uuid),public.overdue_contact_finish(uuid,uuid,boolean),public.overdue_worker_finish(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.overdue_watch_work(uuid),public.overdue_owner_current(uuid),public.overdue_owner_attempt(uuid),public.overdue_contact_claim(),public.overdue_contact_guard(uuid,uuid,uuid),public.overdue_contact_finish(uuid,uuid,boolean),public.overdue_worker_finish(boolean) TO service_role;
COMMIT;
