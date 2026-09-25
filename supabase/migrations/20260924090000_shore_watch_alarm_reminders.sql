-- Prepared for review: no cron jobs, live watches or Pi assignments are changed.
-- Legacy phone registrations keep their existing one-shot delivery behaviour.
-- Repeating alerts are minute-spaced notification bursts, NOT continuous audio.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.anchor_alarm_tokens
    ADD COLUMN IF NOT EXISTS supports_reminders BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.anchor_alarm_events ADD COLUMN IF NOT EXISTS incident_id UUID;

-- A drag event is currently emitted again after ten minutes. Give all events
-- from the same unresolved condition one identity so these cannot bypass an
-- individual shore phone's acknowledgement.
WITH families AS (
    SELECT id, first_value(id) OVER (
        PARTITION BY session_code, user_id, pi_relay_id, alarm_kind
        ORDER BY created_at, id
    ) AS first_id
    FROM public.anchor_alarm_events
    WHERE incident_id IS NULL AND resolved_at IS NULL AND pi_relay_id IS NOT NULL
      AND alarm_kind IN ('drag', 'gps_lost', 'contact_lost')
)
UPDATE public.anchor_alarm_events e SET incident_id = f.first_id
FROM families f WHERE f.id = e.id;

CREATE INDEX IF NOT EXISTS anchor_alarm_incident_idx
    ON public.anchor_alarm_events(incident_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS public.anchor_alarm_device_deliveries (
    incident_id UUID NOT NULL REFERENCES public.anchor_alarm_events(id) ON DELETE CASCADE,
    token_id UUID NOT NULL REFERENCES public.anchor_alarm_tokens(id) ON DELETE CASCADE,
    acknowledged_at TIMESTAMPTZ,
    last_accepted_at TIMESTAMPTZ,
    next_due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claim_id UUID,
    processing_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (incident_id, token_id)
);
ALTER TABLE public.anchor_alarm_device_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.anchor_alarm_device_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.anchor_alarm_device_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.attach_anchor_alarm_incident()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE first_id UUID;
BEGIN
    -- Client-created vessel-phone events retain the existing short-lived
    -- one-shot path. Clients cannot nominate an incident or start reminders.
    NEW.incident_id := NULL;
    IF (auth.role() = 'service_role' OR (auth.role() IS NULL AND session_user IN ('postgres','supabase_admin')))
       AND NEW.pi_relay_id IS NOT NULL
       AND NEW.alarm_kind IN ('drag', 'gps_lost', 'contact_lost') THEN
        PERFORM 1 FROM public.pi_anchor_sessions p
        WHERE p.relay_id = NEW.pi_relay_id AND p.owner_id = NEW.user_id
          AND p.session_code = NEW.session_code AND p.expires_at > now()
        FOR UPDATE;
        IF FOUND THEN
            SELECT COALESCE(e.incident_id,e.id) INTO first_id
            FROM public.anchor_alarm_events e
            WHERE e.session_code = NEW.session_code AND e.user_id = NEW.user_id
              AND e.pi_relay_id = NEW.pi_relay_id AND e.alarm_kind = NEW.alarm_kind
              AND e.resolved_at IS NULL AND e.incident_id IS NOT NULL
            ORDER BY e.created_at,e.id LIMIT 1;
            NEW.incident_id := COALESCE(first_id,NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS attach_anchor_alarm_incident ON public.anchor_alarm_events;
CREATE TRIGGER attach_anchor_alarm_incident BEFORE INSERT ON public.anchor_alarm_events
FOR EACH ROW EXECUTE FUNCTION public.attach_anchor_alarm_incident();
REVOKE ALL ON FUNCTION public.attach_anchor_alarm_incident() FROM PUBLIC, anon, authenticated;

-- One shared definition is used by claims, acknowledgements and the sweeper.
-- This never renews a lease or resurrects a stopped/expired watch.
CREATE OR REPLACE FUNCTION public.anchor_alarm_incident_is_current(p_incident_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.anchor_alarm_events e
        JOIN public.pi_anchor_sessions p ON p.relay_id = e.pi_relay_id
          AND p.session_code = e.session_code AND p.owner_id = e.user_id
        JOIN public.anchor_watch_sessions s ON s.session_code = e.session_code AND s.owner_user_id = e.user_id
        JOIN public.pi_diary_relays r ON r.relay_id = p.relay_id AND r.owner_id = p.owner_id AND r.enabled
        WHERE e.id = p_incident_id AND e.incident_id = e.id AND e.resolved_at IS NULL
          AND p.expires_at > now() AND s.expires_at > now()
          AND CASE e.alarm_kind
            WHEN 'drag' THEN p.last_heartbeat_at >= now() - interval '35 seconds'
                AND p.gps_available AND p.is_dragging
            WHEN 'gps_lost' THEN p.last_heartbeat_at >= now() - interval '35 seconds' AND NOT p.gps_available
            WHEN 'contact_lost' THEN COALESCE(p.last_heartbeat_at,p.authorised_at) < now() - interval '60 seconds'
            ELSE false END
    );
$$;
REVOKE ALL ON FUNCTION public.anchor_alarm_incident_is_current(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anchor_alarm_incident_is_current(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_anchor_alarm_delivery(p_event_id UUID,p_token_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE incident UUID; claimed JSONB;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    SELECT e.incident_id INTO incident FROM public.anchor_alarm_events e
    JOIN public.anchor_alarm_tokens t ON t.id = p_token_id AND t.session_code = e.session_code
    JOIN public.anchor_watch_members m ON m.session_code = t.session_code AND m.user_id = t.user_id AND m.role = 'shore'
    WHERE e.id = p_event_id AND e.resolved_at IS NULL AND t.platform = 'ios' AND t.supports_reminders;
    IF incident IS NULL OR NOT public.anchor_alarm_incident_is_current(incident) THEN RETURN NULL; END IF;
    INSERT INTO public.anchor_alarm_device_deliveries(incident_id,token_id)
        VALUES(incident,p_token_id) ON CONFLICT DO NOTHING;
    -- This lock serialises initial delivery, retry, reminder and device ACK.
    WITH c AS (
        UPDATE public.anchor_alarm_device_deliveries d SET
            claim_id = gen_random_uuid(), processing_until = now() + interval '2 minutes', attempts = attempts + 1
        WHERE d.incident_id = incident AND d.token_id = p_token_id AND d.acknowledged_at IS NULL
          AND d.next_due_at <= now() AND (d.processing_until IS NULL OR d.processing_until <= now())
        RETURNING d.*
    ) SELECT to_jsonb(c) INTO claimed FROM c;
    IF claimed IS NOT NULL THEN
        claimed := claimed || jsonb_build_object('incident_started_at',(
            SELECT created_at FROM public.anchor_alarm_events WHERE id = incident
        ));
    END IF;
    RETURN claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_anchor_alarm_delivery(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_anchor_alarm_delivery(UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.anchor_alarm_delivery_is_current(p_incident_id UUID,p_token_id UUID,p_claim_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT public.anchor_alarm_incident_is_current(p_incident_id) AND EXISTS (
        SELECT 1 FROM public.anchor_alarm_device_deliveries d
        JOIN public.anchor_alarm_tokens t ON t.id = d.token_id AND t.supports_reminders AND t.platform = 'ios'
        JOIN public.anchor_watch_members m ON m.session_code = t.session_code AND m.user_id = t.user_id AND m.role = 'shore'
        JOIN public.anchor_alarm_events e ON e.id = d.incident_id AND e.session_code = t.session_code
        WHERE d.incident_id = p_incident_id AND d.token_id = p_token_id AND d.claim_id = p_claim_id
          AND d.acknowledged_at IS NULL AND d.processing_until > now()
    );
$$;
REVOKE ALL ON FUNCTION public.anchor_alarm_delivery_is_current(UUID,UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anchor_alarm_delivery_is_current(UUID,UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_anchor_alarm_delivery(p_incident_id UUID,p_token_id UUID,p_claim_id UUID,p_accepted BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    UPDATE public.anchor_alarm_device_deliveries SET
        last_accepted_at = CASE WHEN p_accepted THEN now() ELSE last_accepted_at END,
        next_due_at = now() + interval '60 seconds', processing_until = NULL, claim_id = NULL
    WHERE incident_id = p_incident_id AND token_id = p_token_id AND claim_id = p_claim_id;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_anchor_alarm_delivery(UUID,UUID,UUID,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_anchor_alarm_delivery(UUID,UUID,UUID,BOOLEAN) TO service_role;

-- The app captures p_started_before when the user presses Silence. A response
-- arriving later must not silently acknowledge an incident which began later.
CREATE OR REPLACE FUNCTION public.list_active_anchor_alarm_incidents(
    p_session_code TEXT,p_device_token TEXT,p_started_before TIMESTAMPTZ
) RETURNS TABLE(incident_id UUID,token_id UUID,alarm_kind TEXT,started_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT e.id,t.id,e.alarm_kind,e.created_at FROM public.anchor_alarm_events e
    JOIN public.anchor_alarm_tokens t ON t.session_code = e.session_code
    JOIN public.anchor_watch_members m ON m.session_code = t.session_code AND m.user_id = t.user_id AND m.role = 'shore'
    WHERE auth.uid() IS NOT NULL AND t.user_id = auth.uid() AND t.device_token = p_device_token
      AND t.supports_reminders AND t.session_code = p_session_code
      AND p_started_before IS NOT NULL AND p_started_before <= now()
      AND e.id = e.incident_id AND e.created_at <= p_started_before
      AND public.anchor_alarm_incident_is_current(e.id);
$$;
REVOKE ALL ON FUNCTION public.list_active_anchor_alarm_incidents(TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_active_anchor_alarm_incidents(TEXT,TEXT,TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.acknowledge_anchor_alarm(p_incident_id UUID,p_token_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.anchor_alarm_tokens t
        JOIN public.anchor_alarm_events e ON e.id = p_incident_id AND e.session_code = t.session_code
        JOIN public.anchor_watch_members m ON m.session_code = t.session_code AND m.user_id = t.user_id AND m.role = 'shore'
        JOIN public.anchor_watch_sessions s ON s.session_code = t.session_code AND s.expires_at > now()
        WHERE t.id = p_token_id AND t.user_id = auth.uid() AND t.supports_reminders
          AND e.id = e.incident_id
    ) THEN RETURN false; END IF;
    -- A recovered incident may still be acknowledged: this is idempotent and
    -- never acknowledges its replacement or changes the vessel's watch.
    INSERT INTO public.anchor_alarm_device_deliveries(incident_id,token_id,acknowledged_at)
        VALUES(p_incident_id,p_token_id,now())
    ON CONFLICT(incident_id,token_id) DO UPDATE SET acknowledged_at = COALESCE(
        anchor_alarm_device_deliveries.acknowledged_at,EXCLUDED.acknowledged_at);
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_anchor_alarm(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_anchor_alarm(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.queue_anchor_alarm_reminders()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,extensions AS $$
DECLARE supabase_url TEXT; service_key TEXT; alarm RECORD;
BEGIN
    SELECT decrypted_secret INTO supabase_url FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
    SELECT decrypted_secret INTO service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    IF supabase_url IS NULL THEN supabase_url := current_setting('app.settings.supabase_url',true); END IF;
    IF service_key IS NULL THEN service_key := current_setting('app.settings.service_role_key',true); END IF;
    IF supabase_url IS NULL OR service_key IS NULL THEN RETURN; END IF;
    FOR alarm IN
        SELECT e.id,MIN(COALESCE(d.next_due_at,e.created_at)) AS due_at
        FROM public.anchor_alarm_events e
        JOIN public.anchor_alarm_tokens t ON t.session_code = e.session_code AND t.platform = 'ios' AND t.supports_reminders
        JOIN public.anchor_watch_members m ON m.session_code = t.session_code AND m.user_id = t.user_id AND m.role = 'shore'
        LEFT JOIN public.anchor_alarm_device_deliveries d ON d.incident_id = e.id AND d.token_id = t.id
        WHERE e.id = e.incident_id AND public.anchor_alarm_incident_is_current(e.id)
          AND d.acknowledged_at IS NULL AND (d.next_due_at IS NULL OR d.next_due_at <= now())
          AND (d.processing_until IS NULL OR d.processing_until <= now())
        GROUP BY e.id ORDER BY due_at,e.id LIMIT 20
    LOOP
        PERFORM net.http_post(url := supabase_url || '/functions/v1/send-anchor-alarm',
            headers := jsonb_build_object('Authorization','Bearer ' || service_key,'Content-Type','application/json'),
            body := jsonb_build_object('record',jsonb_build_object('id',alarm.id),'reminder',true));
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.queue_anchor_alarm_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_anchor_alarm_reminders() TO service_role;

-- Deployment is a separate, explicit step. Add queue_anchor_alarm_reminders()
-- to the existing minute watchdog only after the migration, sender and app
-- have been verified together. Do not resume any unrelated holiday-paused job.
COMMIT;
