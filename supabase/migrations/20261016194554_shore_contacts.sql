-- HELD 137-05: no provider, cron, invitation or messaging capability activated.
BEGIN;
CREATE SCHEMA private_shore;
REVOKE ALL ON SCHEMA private_shore FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private_shore TO authenticated,service_role;
CREATE TABLE private_shore.control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false,email_version integer NOT NULL DEFAULT 0 CHECK(email_version BETWEEN 0 AND 1),telegram_version integer NOT NULL DEFAULT 0 CHECK(telegram_version BETWEEN 0 AND 1),entitlement_until timestamptz,worker_at timestamptz,bot_id text CHECK(bot_id~'^[1-9][0-9]{0,15}$'));
INSERT INTO private_shore.control(singleton) VALUES(true);
CREATE FUNCTION private_shore.permitted(channel text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT coalesce((SELECT enabled AND entitlement_until>now() AND CASE channel WHEN 'email' THEN email_version=1 WHEN 'telegram' THEN telegram_version=1 AND bot_id IS NOT NULL ELSE false END FROM private_shore.control WHERE singleton),false) $$;
CREATE FUNCTION private_shore.ready(channel text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE scheduled boolean:=false; BEGIN
 IF NOT private_shore.permitted(channel) OR NOT EXISTS(SELECT 1 FROM private_shore.control WHERE worker_at>now()-interval '15 minutes') OR to_regclass('cron.job') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job WHERE active AND jobname=$1 AND schedule=$2 AND command=$3)' INTO scheduled USING 'shore-anchor-messaging','* * * * *','SELECT public.invoke_edge_function(''anchor-alert-messaging'', 25000, ''{"action":"work"}''::jsonb)';
 RETURN scheduled;
END $$;
CREATE FUNCTION private_shore.valid_configuration(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND p ?& ARRAY['channel','label','address','sharePosition','enabled'] AND p-ARRAY['channel','label','address','sharePosition','enabled']='{}'::jsonb
 AND p->>'channel' IN ('email','telegram') AND jsonb_typeof(p->'label')='string' AND length(p->>'label') BETWEEN 1 AND 60 AND p->>'label'=btrim(p->>'label') AND (p->>'label')!~'[[:cntrl:]]'
 AND jsonb_typeof(p->'enabled')='boolean' AND jsonb_typeof(p->'sharePosition')='boolean'
 AND CASE WHEN p->>'channel'='telegram' THEN p->'address'='null'::jsonb ELSE p->'sharePosition'='false'::jsonb AND jsonb_typeof(p->'address')='string' AND length(p->>'address') BETWEEN 3 AND 254 AND (p->>'address')!~'[[:cntrl:][:space:]]' AND (p->>'address')~'^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' END,false)
$$;
CREATE TABLE private_shore.contacts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,boat_id uuid NOT NULL REFERENCES public.boats ON DELETE CASCADE,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),configuration jsonb NOT NULL CHECK(private_shore.valid_configuration(configuration)),
 consent text NOT NULL DEFAULT 'pending' CHECK(consent IN ('pending','confirmed','revoked')),consented_at timestamptz,
 chat_id text CHECK(chat_id~'^[1-9][0-9]{0,15}$'),user_id text CHECK(user_id~'^[1-9][0-9]{0,15}$'),bot_id text,position_revision uuid,
 invite_bot_id text,revoke_key uuid,invited_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shore_contacts_owner ON private_shore.contacts(owner_id,boat_id);
CREATE INDEX shore_contacts_chat ON private_shore.contacts(bot_id,chat_id,user_id) WHERE consent='confirmed';
CREATE TABLE private_shore.nonces(contact_id uuid REFERENCES private_shore.contacts ON DELETE CASCADE,revision uuid NOT NULL,kind text CHECK(kind IN ('confirm','revoke')),hash text NOT NULL UNIQUE CHECK(hash~'^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,used_at timestamptz,preview_chat text,preview_user text,preview_at timestamptz,PRIMARY KEY(contact_id,kind));
CREATE TABLE private_shore.quotas(owner_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,day date NOT NULL,invites integer NOT NULL DEFAULT 0 CHECK(invites BETWEEN 0 AND 10),deliveries integer NOT NULL DEFAULT 0 CHECK(deliveries BETWEEN 0 AND 30));
CREATE TABLE private_shore.global_quotas(day date PRIMARY KEY,invites integer NOT NULL DEFAULT 0 CHECK(invites BETWEEN 0 AND 500),deliveries integer NOT NULL DEFAULT 0 CHECK(deliveries BETWEEN 0 AND 5000));
CREATE TABLE private_shore.anchor_bindings(session_code text PRIMARY KEY REFERENCES public.anchor_watch_sessions ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,boat_id uuid NOT NULL REFERENCES public.boats ON DELETE CASCADE,revision uuid NOT NULL DEFAULT gen_random_uuid());
CREATE TABLE private_shore.deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_id uuid NOT NULL REFERENCES private_shore.contacts ON DELETE CASCADE,revision uuid NOT NULL,event_id uuid NOT NULL REFERENCES public.anchor_alarm_events ON DELETE CASCADE,incident_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,guarded_at timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),finished boolean NOT NULL DEFAULT false,UNIQUE(contact_id,incident_id));
CREATE INDEX shore_delivery_pending ON private_shore.deliveries(created_at) WHERE NOT finished;
CREATE TABLE private_shore.telegram_updates(bot_id text,chat_id text,user_id text,update_id bigint NOT NULL,accepted_at timestamptz NOT NULL DEFAULT now(),replied_at timestamptz,PRIMARY KEY(bot_id,chat_id,user_id));
-- All PII and bearer hashes remain private. There is no table read grant to recipients or owners.
DO $$ DECLARE n text; BEGIN FOR n IN SELECT tablename FROM pg_tables WHERE schemaname='private_shore' LOOP EXECUTE format('ALTER TABLE private_shore.%I ENABLE ROW LEVEL SECURITY',n); END LOOP; END $$;
GRANT ALL ON ALL TABLES IN SCHEMA private_shore TO service_role;
CREATE FUNCTION private_shore.position(boat uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE p jsonb; BEGIN
 IF to_regprocedure('private_weather_watch.weather_position_current(uuid)') IS NULL THEN RETURN NULL; END IF;
 EXECUTE 'SELECT private_weather_watch.weather_position_current($1)' INTO p USING boat; RETURN p;
END $$;
CREATE FUNCTION private_shore.list(boat uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE caller uuid:=auth.uid(); rows jsonb; BEGIN
 IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL) THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'configuration',configuration,'consent',consent,'consentedAt',floor(extract(epoch FROM consented_at)*1000)) ORDER BY created_at,id),'[]'::jsonb) INTO rows FROM private_shore.contacts WHERE owner_id=caller AND boat_id=boat;
 RETURN jsonb_build_object('schema',1,'ownerId',caller,'boatId',boat,'checkedAt',floor(extract(epoch FROM statement_timestamp())*1000),'emailReady',private_shore.ready('email'),'telegramReady',private_shore.ready('telegram'),'contacts',rows);
END $$;
CREATE FUNCTION private_shore.configure(boat uuid,contact uuid,expected uuid,cfg jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE caller uuid:=auth.uid(); old private_shore.contacts; next_revision uuid:=gen_random_uuid(); keep_consent boolean:=false; pos jsonb;
BEGIN
 IF caller IS NULL THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shore:'||caller::text,0));
 PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 DELETE FROM private_shore.contacts c WHERE c.owner_id=caller AND NOT EXISTS(SELECT 1 FROM public.boats b WHERE b.id=c.boat_id AND b.owner_id=caller AND b.archived_at IS NULL);
 IF contact IS NOT NULL THEN SELECT * INTO old FROM private_shore.contacts WHERE id=contact AND owner_id=caller AND boat_id=boat FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Owned contact required' USING ERRCODE='42501'; END IF; END IF;
 IF old.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Review contact revision' USING ERRCODE='40001'; END IF;
 IF cfg IS NULL THEN IF old.id IS NULL THEN RAISE EXCEPTION 'Existing contact required' USING ERRCODE='22023'; END IF; DELETE FROM private_shore.contacts WHERE id=old.id; RETURN next_revision; END IF;
 IF private_shore.valid_configuration(cfg) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid contact' USING ERRCODE='22023'; END IF;
 keep_consent:=old.consent='confirmed' AND old.configuration-'enabled'=cfg-'enabled' AND (old.configuration->>'channel'<>'telegram' OR old.bot_id IS NOT DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton));
 IF (cfg->>'enabled')::boolean AND (keep_consent IS NOT TRUE OR NOT private_shore.ready(cfg->>'channel')) THEN RAISE EXCEPTION 'Recipient consent and delivery capability required' USING ERRCODE='55000'; END IF;
 IF (cfg->>'sharePosition')::boolean THEN pos:=private_shore.position(boat); IF pos IS NULL THEN RAISE EXCEPTION 'Fresh registered vessel position required' USING ERRCODE='55000'; END IF; END IF;
 IF keep_consent AND old.position_revision IS DISTINCT FROM (pos->>'revision')::uuid THEN keep_consent:=false; IF (cfg->>'enabled')::boolean THEN RAISE EXCEPTION 'Position source changed; obtain recipient consent again' USING ERRCODE='55000'; END IF; END IF;
 IF old.id IS NULL THEN
  IF (SELECT count(*) FROM private_shore.contacts WHERE owner_id=caller)>=10 THEN RAISE EXCEPTION 'At most ten shore contacts' USING ERRCODE='54000'; END IF;
  INSERT INTO private_shore.contacts(owner_id,boat_id,revision,configuration,position_revision) VALUES(caller,boat,next_revision,cfg,(pos->>'revision')::uuid);
 ELSE
  UPDATE private_shore.contacts SET revision=next_revision,configuration=cfg,consent=CASE WHEN keep_consent THEN 'confirmed' ELSE 'pending' END,consented_at=CASE WHEN keep_consent THEN old.consented_at END,chat_id=CASE WHEN keep_consent THEN old.chat_id END,user_id=CASE WHEN keep_consent THEN old.user_id END,bot_id=CASE WHEN keep_consent THEN old.bot_id END,position_revision=(pos->>'revision')::uuid WHERE id=old.id;
  IF keep_consent THEN UPDATE private_shore.nonces SET revision=next_revision WHERE contact_id=old.id; ELSE DELETE FROM private_shore.nonces WHERE contact_id=old.id; END IF; UPDATE private_shore.deliveries SET finished=true WHERE contact_id=old.id;
 END IF; RETURN next_revision;
END $$;
-- A phone session has no boat column: deliberately bind a current vessel role,
-- never whichever boat happens to be active in the owner's settings.
CREATE FUNCTION private_shore.bind_anchor(boat uuid,session text,expected uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE caller uuid:=auth.uid(); old private_shore.anchor_bindings; result uuid:=gen_random_uuid(); BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('shore-session:'||session,0));
 PERFORM 1 FROM public.boats WHERE id=boat AND owner_id=caller AND archived_at IS NULL FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'Owned vessel required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.anchor_watch_sessions s JOIN public.anchor_watch_members m ON m.session_code=s.session_code AND m.user_id=caller AND m.role='vessel' WHERE s.session_code=session AND s.owner_user_id=caller AND s.expires_at>now() AND s.vessel_state='watching' FOR SHARE OF s;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current owned vessel watch required' USING ERRCODE='42501'; END IF;
 SELECT * INTO old FROM private_shore.anchor_bindings WHERE session_code=session FOR UPDATE;
 IF old.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Review session binding' USING ERRCODE='40001'; END IF;
 IF old.boat_id IS NOT NULL AND old.boat_id<>boat THEN RAISE EXCEPTION 'Start a new session for a different vessel' USING ERRCODE='55000'; END IF;
 INSERT INTO private_shore.anchor_bindings(session_code,owner_id,boat_id,revision) VALUES(session,caller,boat,result) ON CONFLICT(session_code) DO UPDATE SET revision=EXCLUDED.revision;
 RETURN result;
END $$;
CREATE FUNCTION public.shore_contacts_list(p_boat_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private_shore.list(p_boat_id) $$;
CREATE FUNCTION public.configure_shore_contact(p_boat_id uuid,p_contact_id uuid,p_expected uuid,p_configuration jsonb) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private_shore.configure(p_boat_id,p_contact_id,p_expected,p_configuration) $$;
CREATE FUNCTION public.bind_shore_anchor(p_boat_id uuid,p_session_code text,p_expected uuid) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private_shore.bind_anchor(p_boat_id,p_session_code,p_expected) $$;
-- Service-only calls below accept fixed data after Edge authentication. Owner
-- identity is supplied by validated Auth /user, never a JSON ownerId.
CREATE FUNCTION public.shore_invite(p_owner uuid,p_contact uuid,p_revision uuid,p_confirm_hash text,p_revoke_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE c private_shore.contacts; q private_shore.quotas; BEGIN
 IF p_confirm_hash!~'^[a-f0-9]{64}$' OR p_revoke_hash!~'^[a-f0-9]{64}$' OR p_confirm_hash=p_revoke_hash THEN RAISE EXCEPTION 'Invalid nonce hashes'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shore:'||p_owner::text,0));
 SELECT * INTO c FROM private_shore.contacts WHERE id=p_contact AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND OR c.revision IS DISTINCT FROM p_revision OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=c.boat_id AND owner_id=p_owner AND archived_at IS NULL) THEN RAISE EXCEPTION 'Contact changed' USING ERRCODE='40001'; END IF;
 IF NOT private_shore.permitted(c.configuration->>'channel') THEN RAISE EXCEPTION 'Delivery capability held' USING ERRCODE='55000'; END IF;
 IF c.invited_at>now()-interval '10 minutes' THEN RAISE EXCEPTION 'Invitation cooldown' USING ERRCODE='54000'; END IF;
 INSERT INTO private_shore.quotas(owner_id,day) VALUES(p_owner,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT(owner_id) DO NOTHING;
 SELECT * INTO q FROM private_shore.quotas WHERE owner_id=p_owner FOR UPDATE;
 IF q.day<>(now() AT TIME ZONE 'UTC')::date THEN q.invites:=0;q.deliveries:=0; END IF;
 IF q.invites>=10 THEN RAISE EXCEPTION 'Daily invitation quota' USING ERRCODE='54000'; END IF;
 INSERT INTO private_shore.global_quotas(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(day) DO NOTHING;
 UPDATE private_shore.global_quotas SET invites=invites+1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND invites<500; IF NOT FOUND THEN RAISE EXCEPTION 'Global invitation quota' USING ERRCODE='54000'; END IF;
 UPDATE private_shore.quotas SET day=(now() AT TIME ZONE 'UTC')::date,invites=q.invites+1,deliveries=q.deliveries WHERE owner_id=p_owner;
 UPDATE private_shore.contacts SET consent='pending',consented_at=NULL,chat_id=NULL,user_id=NULL,bot_id=NULL,invite_bot_id=(SELECT bot_id FROM private_shore.control WHERE singleton),revoke_key=c.revision,invited_at=now(),configuration=jsonb_set(configuration,'{enabled}','false') WHERE id=c.id;
 UPDATE private_shore.deliveries SET finished=true WHERE contact_id=c.id;
 DELETE FROM private_shore.nonces WHERE contact_id=c.id;
 INSERT INTO private_shore.nonces(contact_id,revision,kind,hash,expires_at,used_at) VALUES(c.id,c.revision,'confirm',p_confirm_hash,now()+interval '24 hours',NULL),(c.id,c.revision,'revoke',p_revoke_hash,now()+interval '1 year',NULL);
 RETURN jsonb_build_object('invitationId',gen_random_uuid(),'channel',c.configuration->>'channel','address',c.configuration->>'address','sharePosition',(c.configuration->>'sharePosition')::boolean,'botId',(SELECT bot_id FROM private_shore.control WHERE singleton));
END $$;
CREATE FUNCTION public.shore_consent(p_hash text,p_action text,p_chat text DEFAULT NULL,p_user text DEFAULT NULL,p_bot text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE n private_shore.nonces;c private_shore.contacts; BEGIN
 IF p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_action NOT IN ('confirm','revoke') THEN RETURN false; END IF;
 SELECT * INTO n FROM private_shore.nonces WHERE hash=p_hash AND kind=p_action;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO c FROM private_shore.contacts WHERE id=n.contact_id FOR UPDATE;
 SELECT * INTO n FROM private_shore.nonces WHERE hash=p_hash AND kind=p_action FOR UPDATE;
 IF NOT FOUND OR n.used_at IS NOT NULL OR n.expires_at<=now() OR n.revision<>c.revision OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=c.boat_id AND owner_id=c.owner_id AND archived_at IS NULL) THEN RETURN false; END IF;
 IF p_action='confirm' THEN
  IF NOT private_shore.permitted(c.configuration->>'channel') THEN RETURN false; END IF;
  IF c.configuration->>'channel'='telegram' AND (p_chat IS NULL OR p_user IS NULL OR p_chat!~'^[1-9][0-9]{0,15}$' OR p_chat<>p_user OR p_bot IS DISTINCT FROM c.invite_bot_id OR p_bot IS DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton) OR n.preview_chat IS DISTINCT FROM p_chat OR n.preview_user IS DISTINCT FROM p_user OR n.preview_at IS NULL OR n.preview_at<=now()-interval '5 minutes' OR n.preview_at>now()) THEN RETURN false; END IF;
  IF c.configuration->>'channel'='email' AND (p_chat IS NOT NULL OR p_user IS NOT NULL OR p_bot IS NOT NULL) THEN RETURN false; END IF;
  UPDATE private_shore.contacts SET consent='confirmed',consented_at=now(),chat_id=p_chat,user_id=p_user,bot_id=p_bot WHERE id=c.id;
 ELSE UPDATE private_shore.contacts SET consent='revoked',consented_at=NULL,configuration=jsonb_set(configuration,'{enabled}','false') WHERE id=c.id; UPDATE private_shore.deliveries SET finished=true WHERE contact_id=c.id; END IF;
 UPDATE private_shore.nonces SET used_at=now() WHERE contact_id=c.id AND kind=p_action; RETURN true;
END $$;
-- Bounded per-chat high-water mark (one row per known recipient). /stop remains
-- effective even while transport readiness is held. Old/replayed updates do not reply.
CREATE FUNCTION public.shore_telegram_command(p_bot text,p_chat text,p_user text,p_update bigint,p_at bigint,p_command text,p_hash text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE prior private_shore.telegram_updates; c private_shore.contacts; n private_shore.nonces; pos jsonb; matches integer; result jsonb; BEGIN
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
  IF NOT FOUND OR n.used_at IS NOT NULL OR n.expires_at<=now() OR n.revision<>c.revision OR c.configuration->>'channel'<>'telegram' OR c.invite_bot_id IS DISTINCT FROM p_bot OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=c.boat_id AND owner_id=c.owner_id AND archived_at IS NULL) OR (n.preview_chat IS NOT NULL AND (n.preview_chat IS DISTINCT FROM p_chat OR n.preview_user IS DISTINCT FROM p_user)) THEN RETURN NULL; END IF;
  UPDATE private_shore.nonces SET preview_chat=p_chat,preview_user=p_user,preview_at=now() WHERE contact_id=c.id AND kind='confirm';
 ELSIF p_command='confirm' THEN
  IF public.shore_consent(p_hash,'confirm',p_chat,p_user,p_bot) IS NOT TRUE THEN RETURN NULL; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM private_shore.contacts WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user AND consent='confirmed') THEN RETURN NULL; END IF;
 INSERT INTO private_shore.telegram_updates VALUES(p_bot,p_chat,p_user,p_update,now(),prior.replied_at) ON CONFLICT(bot_id,chat_id,user_id) DO UPDATE SET update_id=EXCLUDED.update_id,accepted_at=now();
 IF p_command='stop' THEN
  UPDATE private_shore.contacts SET consent='revoked',consented_at=NULL,configuration=jsonb_set(configuration,'{enabled}','false') WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user;
  UPDATE private_shore.deliveries d SET finished=true FROM private_shore.contacts x WHERE d.contact_id=x.id AND x.bot_id=p_bot AND x.chat_id=p_chat AND x.user_id=p_user;
  RETURN jsonb_build_object('text','Shore-contact messages stopped. A new invitation and confirmation are required to restart.');
 END IF;
 IF p_command<>'confirm' AND prior.replied_at>now()-interval '1 minute' THEN RETURN NULL; END IF;
 UPDATE private_shore.telegram_updates SET replied_at=now() WHERE bot_id=p_bot AND chat_id=p_chat AND user_id=p_user;
 IF p_command='preview' THEN RETURN jsonb_build_object('invitation',jsonb_build_object('sharePosition',(c.configuration->>'sharePosition')::boolean)); END IF;
 IF p_command='confirm' THEN RETURN jsonb_build_object('text','Consent recorded. The owner must separately enable this vessel contact. Use /stop to revoke.'); END IF;
 IF NOT private_shore.permitted('telegram') THEN RETURN NULL; END IF;
 SELECT count(*) INTO matches FROM private_shore.contacts x JOIN public.boats b ON b.id=x.boat_id AND b.owner_id=x.owner_id AND b.archived_at IS NULL WHERE x.bot_id=p_bot AND x.chat_id=p_chat AND x.user_id=p_user AND x.consent='confirmed' AND (x.configuration->>'enabled')::boolean AND (x.configuration->>'sharePosition')::boolean;
 IF matches<>1 THEN RETURN jsonb_build_object('text','Position unavailable: no single explicitly shared vessel is selected.'); END IF;
 SELECT x.* INTO c FROM private_shore.contacts x JOIN public.boats b ON b.id=x.boat_id AND b.owner_id=x.owner_id AND b.archived_at IS NULL WHERE x.bot_id=p_bot AND x.chat_id=p_chat AND x.user_id=p_user AND x.consent='confirmed' AND (x.configuration->>'enabled')::boolean AND (x.configuration->>'sharePosition')::boolean;
 pos:=private_shore.position(c.boat_id);
 IF pos IS NULL OR (pos->>'revision')::uuid IS DISTINCT FROM c.position_revision THEN RETURN jsonb_build_object('text','Position unavailable: no fresh receipt from the explicitly agreed vessel source.'); END IF;
 result:=jsonb_build_object('position',jsonb_build_object('lat',pos->'lat','lon',pos->'lon','at',pos->'at')); RETURN result;
END $$;
-- Fixed current-alarm admission, independently rerun immediately before every
-- provider attempt. An event row alone is never evidence of a current incident.
CREATE FUNCTION private_shore.contact_current(c private_shore.contacts) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.consent='confirmed' AND (c.configuration->>'enabled')::boolean AND private_shore.permitted(c.configuration->>'channel') AND (c.configuration->>'channel'<>'telegram' OR c.bot_id IS NOT DISTINCT FROM (SELECT bot_id FROM private_shore.control WHERE singleton)) AND (NOT(c.configuration->>'sharePosition')::boolean OR (c.position_revision IS NOT NULL AND c.position_revision IS NOT DISTINCT FROM (private_shore.position(c.boat_id)->>'revision')::uuid)),false)
$$;
CREATE FUNCTION private_shore.anchor_event(event uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$ DECLARE e public.anchor_alarm_events;s public.anchor_watch_sessions;p public.pi_anchor_sessions;boat uuid; BEGIN
 SELECT * INTO e FROM public.anchor_alarm_events WHERE id=event AND resolved_at IS NULL AND created_at<=now() AND created_at>now()-interval '10 minutes'; IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.anchor_watch_sessions WHERE session_code=e.session_code AND owner_user_id=e.user_id AND expires_at>now(); IF NOT FOUND THEN RETURN NULL; END IF;
 IF e.pi_relay_id IS NOT NULL THEN
  SELECT a.* INTO p FROM public.pi_anchor_sessions a JOIN public.pi_diary_relays d ON d.relay_id=a.relay_id AND d.owner_id=a.owner_id AND d.enabled WHERE a.relay_id=e.pi_relay_id AND a.session_code=e.session_code AND a.owner_id=e.user_id AND a.expires_at>now(); IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT boat_id INTO boat FROM public.pi_diary_relays WHERE relay_id=e.pi_relay_id AND owner_id=e.user_id AND enabled;
  IF e.alarm_kind='contact_lost' THEN IF coalesce(p.last_heartbeat_at,p.authorised_at)>now()-interval '60 seconds' THEN RETURN NULL; END IF;
  ELSIF e.alarm_kind='session_expiring' THEN IF s.expires_at>now()+interval '12 hours' THEN RETURN NULL; END IF;
  ELSIF p.last_heartbeat_at IS NULL OR p.last_heartbeat_at>now() OR p.last_heartbeat_at<now()-interval '35 seconds' OR (e.alarm_kind='drag' AND NOT(p.gps_available AND p.is_dragging)) OR (e.alarm_kind='gps_lost' AND p.gps_available) THEN RETURN NULL; END IF;
 ELSE
  SELECT b.boat_id INTO boat FROM private_shore.anchor_bindings b JOIN public.anchor_watch_members m ON m.session_code=b.session_code AND m.user_id=b.owner_id AND m.role='vessel' WHERE b.session_code=e.session_code AND b.owner_id=e.user_id;
  IF s.vessel_state IS DISTINCT FROM 'watching' THEN RETURN NULL; END IF;
  IF e.alarm_kind='contact_lost' THEN IF s.vessel_heartbeat_at>now()-interval '5 minutes' THEN RETURN NULL; END IF;
  ELSIF e.alarm_kind<>'drag' OR e.created_at<now()-interval '120 seconds' THEN RETURN NULL; END IF;
 END IF;
 IF boat IS NULL OR NOT EXISTS(SELECT 1 FROM public.boats WHERE id=boat AND owner_id=e.user_id AND archived_at IS NULL) OR e.alarm_kind NOT IN ('drag','contact_lost','gps_lost','session_expiring') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('boatId',boat,'ownerId',e.user_id,'kind',e.alarm_kind,'at',floor(extract(epoch FROM e.created_at)*1000));
END $$;
CREATE FUNCTION public.shore_anchor_enqueue(p_after uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE e record;c record;fact jsonb;counted integer:=0;last_id uuid;BEGIN
 DELETE FROM private_shore.deliveries WHERE created_at<now()-interval '7 days';
 DELETE FROM private_shore.global_quotas WHERE day<(now() AT TIME ZONE 'UTC')::date-7;
 DELETE FROM private_shore.anchor_bindings b USING public.anchor_watch_sessions s WHERE s.session_code=b.session_code AND s.expires_at<=now();
 FOR e IN SELECT id,coalesce(incident_id,id) AS incident FROM public.anchor_alarm_events WHERE (p_after IS NULL OR id>p_after) AND resolved_at IS NULL AND created_at>now()-interval '10 minutes' ORDER BY id LIMIT 20 LOOP
  last_id:=e.id;fact:=private_shore.anchor_event(e.id); IF fact IS NULL THEN CONTINUE; END IF;
  FOR c IN SELECT id,revision FROM private_shore.contacts WHERE owner_id=(fact->>'ownerId')::uuid AND boat_id=(fact->>'boatId')::uuid AND private_shore.contact_current(contacts) LOOP
   INSERT INTO private_shore.deliveries(contact_id,revision,event_id,incident_id) VALUES(c.id,c.revision,e.id,e.incident) ON CONFLICT(contact_id,incident_id) DO NOTHING; counted:=counted+1;
  END LOOP;
 END LOOP; RETURN jsonb_build_object('after',last_id,'queued',counted);
END $$;
CREATE FUNCTION public.shore_delivery_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ DECLARE d private_shore.deliveries; c private_shore.contacts;fact jsonb;q private_shore.quotas; BEGIN
 FOR d IN SELECT * FROM private_shore.deliveries WHERE NOT finished AND created_at>now()-interval '10 minutes' AND attempts<3 AND (claimed_at IS NULL OR claimed_at<now()-interval '2 minutes') ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  SELECT * INTO c FROM private_shore.contacts WHERE id=d.contact_id;
  fact:=private_shore.anchor_event(d.event_id);
  IF fact IS NULL OR c.revision<>d.revision OR NOT private_shore.contact_current(c) OR c.owner_id::text<>fact->>'ownerId' OR c.boat_id::text<>fact->>'boatId' THEN UPDATE private_shore.deliveries SET finished=true WHERE id=d.id; CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shore:'||c.owner_id::text,0));
  INSERT INTO private_shore.quotas(owner_id,day) VALUES(c.owner_id,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT(owner_id) DO NOTHING;
  SELECT * INTO q FROM private_shore.quotas WHERE owner_id=c.owner_id FOR UPDATE;
  IF q.day<>(now() AT TIME ZONE 'UTC')::date THEN q.invites:=0;q.deliveries:=0; END IF;
  IF q.deliveries>=30 THEN RETURN NULL; END IF;
  INSERT INTO private_shore.global_quotas(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(day) DO NOTHING;
  UPDATE private_shore.global_quotas SET deliveries=deliveries+1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND deliveries<5000; IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE private_shore.quotas SET day=(now() AT TIME ZONE 'UTC')::date,invites=q.invites,deliveries=q.deliveries+1 WHERE owner_id=c.owner_id;
  UPDATE private_shore.deliveries SET claimed_at=now(),guarded_at=NULL,attempts=attempts+1 WHERE id=d.id;
  RETURN jsonb_build_object('id',d.id,'revision',d.revision,'contactId',c.id,'revokeKey',c.revoke_key,'revokeHash',(SELECT hash FROM private_shore.nonces WHERE contact_id=c.id AND kind='revoke' AND revision=c.revision AND used_at IS NULL AND expires_at>now()),'channel',c.configuration->>'channel','address',c.configuration->>'address','chatId',c.chat_id,'botId',c.bot_id,'kind',fact->>'kind','at',fact->'at');
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION public.shore_delivery_guard(p_id uuid,p_revision uuid) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d private_shore.deliveries;c private_shore.contacts;fact jsonb;
BEGIN
 SELECT * INTO d FROM private_shore.deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR d.revision IS DISTINCT FROM p_revision OR d.finished OR d.guarded_at IS NOT NULL OR d.claimed_at IS NULL OR d.claimed_at<now()-interval '30 seconds' OR d.created_at<now()-interval '10 minutes' THEN RETURN false; END IF;
 SELECT * INTO c FROM private_shore.contacts WHERE id=d.contact_id;
 fact:=private_shore.anchor_event(d.event_id);
 IF c.revision IS DISTINCT FROM p_revision OR NOT private_shore.contact_current(c) OR fact IS NULL OR (fact->>'boatId')::uuid<>c.boat_id OR (fact->>'ownerId')::uuid<>c.owner_id THEN RETURN false; END IF;
 -- Telegram has no idempotent-send API. Reserve its sole attempt before HTTP,
 -- accepting possible non-delivery instead of retrying an unknown outcome.
 UPDATE private_shore.deliveries SET guarded_at=now(),finished=(c.configuration->>'channel'='telegram') WHERE id=d.id;
 RETURN true;
END $$;
CREATE FUNCTION public.shore_worker_finish(p_success boolean) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ UPDATE private_shore.control SET worker_at=CASE WHEN p_success THEN now() END WHERE singleton $$;
CREATE FUNCTION public.shore_delivery_finish(p_id uuid,p_revision uuid,p_success boolean) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ UPDATE private_shore.deliveries SET finished=finished OR p_success OR attempts>=3 WHERE id=p_id AND revision=p_revision $$;
-- Explicit exhaustive function ACLs: owner wrappers only, service procedures
-- only. No generic dynamic SQL/table surface and no anonymous nonce RPC.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_shore FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private_shore.list(uuid),private_shore.configure(uuid,uuid,uuid,jsonb),private_shore.bind_anchor(uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private_shore TO service_role;
REVOKE ALL ON FUNCTION public.shore_contacts_list(uuid),public.configure_shore_contact(uuid,uuid,uuid,jsonb),public.bind_shore_anchor(uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.shore_contacts_list(uuid),public.configure_shore_contact(uuid,uuid,uuid,jsonb),public.bind_shore_anchor(uuid,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.shore_invite(uuid,uuid,uuid,text,text),public.shore_consent(text,text,text,text,text),public.shore_telegram_command(text,text,text,bigint,bigint,text,text),public.shore_anchor_enqueue(uuid),public.shore_delivery_claim(),public.shore_delivery_guard(uuid,uuid),public.shore_delivery_finish(uuid,uuid,boolean),public.shore_worker_finish(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shore_invite(uuid,uuid,uuid,text,text),public.shore_consent(text,text,text,text,text),public.shore_telegram_command(text,text,text,bigint,bigint,text,text),public.shore_anchor_enqueue(uuid),public.shore_delivery_claim(),public.shore_delivery_guard(uuid,uuid),public.shore_delivery_finish(uuid,uuid,boolean),public.shore_worker_finish(boolean) TO service_role;
COMMIT;
