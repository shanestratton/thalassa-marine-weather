-- Prepared only: deployment and watchdog activation are separate operations.
-- No existing (including holiday-paused) cron job is altered by this migration.
ALTER TABLE public.pi_anchor_sessions
    ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gps_available BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_dragging BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS contact_alarm_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gps_alarm_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expiry_alarm_at TIMESTAMPTZ;

ALTER TABLE public.anchor_alarm_events
    ADD COLUMN IF NOT EXISTS pi_relay_id TEXT,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notified_device_tokens TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS alarm_kind TEXT NOT NULL DEFAULT 'drag'
        CHECK (alarm_kind IN ('drag', 'contact_lost', 'gps_lost', 'session_expiring'));

-- Re-registering the same device uses upsert. It may only update its own
-- registration, and only while membership is still live.
DROP POLICY IF EXISTS anchor_token_owner_update ON public.anchor_alarm_tokens;
CREATE POLICY anchor_token_owner_update ON public.anchor_alarm_tokens FOR UPDATE TO authenticated
USING (user_id = auth.uid() AND public.is_anchor_watch_member(session_code, auth.uid()))
WITH CHECK (user_id = auth.uid() AND public.is_anchor_watch_member(session_code, auth.uid()));

-- Called only AFTER the edge function verifies the scoped Pi credential.
-- Lock the binding so stop/revoke and heartbeat renewal cannot resurrect it.
CREATE OR REPLACE FUNCTION public.record_pi_anchor_heartbeat(
    p_relay_id TEXT, p_session_code TEXT, p_owner_id UUID,
    p_gps_available BOOLEAN, p_drag BOOLEAN,
    p_distance_m REAL, p_swing_radius_m REAL, p_lat REAL, p_lon REAL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.pi_anchor_sessions%ROWTYPE; hard_expiry TIMESTAMPTZ; lease_expiry TIMESTAMPTZ;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    SELECT * INTO b FROM public.pi_anchor_sessions WHERE relay_id = p_relay_id FOR UPDATE;
    IF NOT FOUND OR b.owner_id <> p_owner_id OR b.session_code <> p_session_code OR b.expires_at <= now() THEN
        RETURN NULL;
    END IF;
    SELECT s.expires_at INTO hard_expiry FROM public.anchor_watch_sessions s
    JOIN public.pi_diary_relays r ON r.relay_id = p_relay_id AND r.enabled AND r.owner_id = p_owner_id
    WHERE s.session_code = p_session_code AND s.owner_user_id = p_owner_id AND s.expires_at > now();
    IF hard_expiry IS NULL THEN RETURN NULL; END IF;

    -- The phone is not needed for six-hour lease renewal. The hard session
    -- expiry is NEVER renewed by the Pi, nor is an expired binding revived.
    lease_expiry := LEAST(now() + interval '6 hours', hard_expiry, b.authorised_at + interval '48 hours');
    UPDATE public.pi_anchor_sessions SET
        expires_at = lease_expiry, last_heartbeat_at = now(), gps_available = p_gps_available,
        is_dragging = p_gps_available AND p_drag,
        contact_alarm_at = NULL,
        gps_alarm_at = CASE WHEN p_gps_available THEN NULL ELSE COALESCE(gps_alarm_at, now()) END
    WHERE relay_id = p_relay_id;

    UPDATE public.anchor_alarm_events SET resolved_at = now()
    WHERE session_code = p_session_code AND user_id = p_owner_id AND resolved_at IS NULL
        AND (alarm_kind = 'contact_lost' OR (p_gps_available AND alarm_kind = 'gps_lost')
            OR (p_gps_available AND NOT p_drag AND alarm_kind = 'drag'));

    IF NOT p_gps_available AND b.gps_alarm_at IS NULL THEN
        INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m)
        VALUES(p_session_code,p_owner_id,p_relay_id,'gps_lost',0,0);
    END IF;
    IF p_gps_available AND p_drag AND NOT EXISTS (
        SELECT 1 FROM public.anchor_alarm_events WHERE session_code = p_session_code
        AND alarm_kind = 'drag' AND created_at > now() - interval '10 minutes'
        AND resolved_at IS NULL
    ) THEN
        INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m,vessel_lat,vessel_lon)
        VALUES(p_session_code,p_owner_id,p_relay_id,'drag',GREATEST(0,p_distance_m),GREATEST(0,p_swing_radius_m),p_lat,p_lon);
    END IF;
    RETURN jsonb_build_object('expires_at',lease_expiry,'session_expires_at',hard_expiry);
END;
$$;
REVOKE ALL ON FUNCTION public.record_pi_anchor_heartbeat(TEXT,TEXT,UUID,BOOLEAN,BOOLEAN,REAL,REAL,REAL,REAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pi_anchor_heartbeat(TEXT,TEXT,UUID,BOOLEAN,BOOLEAN,REAL,REAL,REAL,REAL) TO service_role;

-- A server watchdog is necessary: neither a closed phone nor a disconnected
-- Pi can report its own loss of contact. One alert per outage, reset on contact.
CREATE OR REPLACE FUNCTION public.check_pi_anchor_watch_health()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b RECORD;
BEGIN
    FOR b IN
        SELECT p.*,s.expires_at AS session_expires_at FROM public.pi_anchor_sessions p
        JOIN public.anchor_watch_sessions s ON s.session_code = p.session_code AND s.owner_user_id = p.owner_id
        JOIN public.pi_diary_relays r ON r.relay_id = p.relay_id AND r.owner_id = p.owner_id AND r.enabled
        WHERE s.expires_at > now() AND p.expires_at > now()
        FOR UPDATE OF p SKIP LOCKED
    LOOP
        IF COALESCE(b.last_heartbeat_at,b.authorised_at) < now() - interval '60 seconds'
            AND b.contact_alarm_at IS NULL THEN
            UPDATE public.pi_anchor_sessions SET contact_alarm_at = now() WHERE relay_id = b.relay_id;
            INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m)
            VALUES(b.session_code,b.owner_id,b.relay_id,'contact_lost',0,0);
        END IF;
        IF b.session_expires_at <= now() + interval '15 minutes' AND b.expiry_alarm_at IS NULL THEN
            UPDATE public.pi_anchor_sessions SET expiry_alarm_at = now() WHERE relay_id = b.relay_id;
            INSERT INTO public.anchor_alarm_events(session_code,user_id,pi_relay_id,alarm_kind,distance_m,swing_radius_m)
            VALUES(b.session_code,b.owner_id,b.relay_id,'session_expiring',0,0);
        END IF;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.check_pi_anchor_watch_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pi_anchor_watch_health() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_anchor_alarm_event(p_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed JSONB;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    WITH claimed_row AS (
        UPDATE public.anchor_alarm_events
        SET processing_at = now(), delivery_attempts = delivery_attempts + 1, last_error = NULL
        WHERE id = p_id AND notified_at IS NULL AND resolved_at IS NULL
            AND created_at > now() - interval '1 hour'
            AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        RETURNING *
    ) SELECT to_jsonb(claimed_row) INTO claimed FROM claimed_row;
    RETURN claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_anchor_alarm_event(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_anchor_alarm_event(UUID) TO service_role;

-- Keep missing-token / failed deliveries retryable for their one-hour life.
-- Five attempts used to exhaust in five minutes, before a device re-registered.
CREATE OR REPLACE FUNCTION public.retry_pending_anchor_alarms()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE supabase_url TEXT; service_key TEXT; alarm RECORD;
BEGIN
    SELECT decrypted_secret INTO supabase_url FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
    SELECT decrypted_secret INTO service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    IF supabase_url IS NULL THEN supabase_url := current_setting('app.settings.supabase_url', true); END IF;
    IF service_key IS NULL THEN service_key := current_setting('app.settings.service_role_key', true); END IF;
    IF supabase_url IS NULL OR service_key IS NULL THEN RETURN; END IF;
    FOR alarm IN SELECT id FROM public.anchor_alarm_events
        WHERE notified_at IS NULL AND resolved_at IS NULL AND created_at > now() - interval '1 hour' AND delivery_attempts < 60
        AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        ORDER BY created_at LIMIT 20
    LOOP
        PERFORM net.http_post(url := supabase_url || '/functions/v1/send-anchor-alarm',
            headers := jsonb_build_object('Authorization','Bearer ' || service_key,'Content-Type','application/json'),
            body := jsonb_build_object('record',jsonb_build_object('id',alarm.id)));
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_pending_anchor_alarms() FROM PUBLIC, anon, authenticated;

-- DEPLOYMENT STEP (deliberately NOT executed here):
-- SELECT cron.schedule('shore-watch-health', '* * * * *', 'SELECT public.check_pi_anchor_watch_health()');
-- Check that retry-pending-anchor-alarm is intentionally active too. Do not
-- resume unrelated jobs or a user's holiday-paused jobs as part of migration.
