-- ============================================================================
-- Guardian Alerts — BOLO, Suspicious, Drag Warning, Weather, Geofence
--
-- Alert history and broadcast RPC for the Maritime Neighborhood Watch.
-- Uses push_notification_queue for delivery to nearby users.
-- ============================================================================

-- ── Alert Log ──
CREATE TABLE IF NOT EXISTS public.guardian_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type TEXT NOT NULL CHECK (alert_type IN (
        'bolo',              -- Armed vessel moved >50m
        'suspicious',        -- User-reported suspicious activity
        'drag_warning',      -- Neighbor vessel dragging anchor
        'weather_spike',     -- Local weather danger broadcast
        'geofence_breach',   -- Vessel left home geofence
        'hail'               -- Social hail ("Ahoy!")
    )),
    source_user_id UUID REFERENCES auth.users(id),
    source_mmsi BIGINT,
    source_vessel_name TEXT,
    target_user_id UUID REFERENCES auth.users(id),   -- NULL = broadcast
    target_mmsi BIGINT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    radius_nm REAL DEFAULT 5,
    data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS guardian_alerts_type_idx
    ON public.guardian_alerts (alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS guardian_alerts_location_idx
    ON public.guardian_alerts USING GIST (location);
CREATE INDEX IF NOT EXISTS guardian_alerts_target_idx
    ON public.guardian_alerts (target_user_id, created_at DESC)
    WHERE target_user_id IS NOT NULL;

-- ── RLS ──
ALTER TABLE public.guardian_alerts ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read alerts
CREATE POLICY "Authenticated can view alerts"
    ON public.guardian_alerts FOR SELECT
    TO authenticated
    USING (true);

-- Authenticated users can insert alerts (for suspicious reports, weather, hails)
CREATE POLICY "Authenticated can insert alerts"
    ON public.guardian_alerts FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Service role has full access (Railway Watchdog inserts BOLO/geofence)
CREATE POLICY "Service role full access on alerts"
    ON public.guardian_alerts FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ── RPC: Broadcast a Guardian alert to all nearby users ──
-- Inserts the alert AND queues push notifications for all recipients within radius.
-- Returns the number of users notified.
CREATE OR REPLACE FUNCTION public.broadcast_guardian_alert(
    sender_user_id UUID,
    p_alert_type TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 5,
    p_title TEXT DEFAULT '',
    p_body TEXT DEFAULT '',
    alert_data JSONB DEFAULT '{}'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    alert_id UUID;
    recipient RECORD;
    notify_count INTEGER := 0;
    notification_type TEXT;
BEGIN
    -- 1. Insert the alert record
    INSERT INTO public.guardian_alerts (
        alert_type, source_user_id, title, body,
        location, radius_nm, data
    ) VALUES (
        p_alert_type, sender_user_id, p_title, p_body,
        ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
        radius_nm, alert_data
    ) RETURNING id INTO alert_id;

    -- Map alert_type to push notification_type
    notification_type := CASE p_alert_type
        WHEN 'bolo' THEN 'bolo_alert'
        WHEN 'suspicious' THEN 'suspicious_alert'
        WHEN 'drag_warning' THEN 'drag_warning'
        WHEN 'weather_spike' THEN 'weather_alert'
        WHEN 'geofence_breach' THEN 'geofence_alert'
        WHEN 'hail' THEN 'hail'
        ELSE 'guardian_alert'
    END;

    -- 2. Find all Thalassa users within radius and queue push notifications
    FOR recipient IN
        SELECT gp.user_id
        FROM public.guardian_profiles gp
        WHERE gp.last_known_lat IS NOT NULL
          AND gp.last_known_lon IS NOT NULL
          AND gp.last_known_at > NOW() - INTERVAL '24 hours'
          AND gp.user_id != sender_user_id  -- Don't notify sender
          AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
              radius_nm * 1852
          )
    LOOP
        -- Insert into push queue (triggers pg_net → send-push Edge Function)
        INSERT INTO public.push_notification_queue (
            recipient_user_id, notification_type, title, body, data
        ) VALUES (
            recipient.user_id,
            notification_type,
            p_title,
            p_body,
            jsonb_build_object(
                'alert_id', alert_id,
                'alert_type', p_alert_type,
                'lat', lat,
                'lon', lon
            ) || alert_data
        );
        notify_count := notify_count + 1;
    END LOOP;

    RETURN notify_count;
END;
$$;

-- ── RPC: Get recent alerts near a location ──
CREATE OR REPLACE FUNCTION public.guardian_alerts_nearby(
    query_lat DOUBLE PRECISION,
    query_lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 10,
    max_hours INTEGER DEFAULT 24
)
RETURNS TABLE (
    id UUID,
    alert_type TEXT,
    source_vessel_name TEXT,
    title TEXT,
    body TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    data JSONB,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        ga.id,
        ga.alert_type,
        ga.source_vessel_name,
        ga.title,
        ga.body,
        ST_Y(ga.location::geometry) AS lat,
        ST_X(ga.location::geometry) AS lon,
        ga.data,
        ga.created_at
    FROM public.guardian_alerts ga
    WHERE ga.created_at > NOW() - (max_hours || ' hours')::interval
      AND ga.location IS NOT NULL
      AND ST_DWithin(
          ga.location,
          ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography,
          radius_nm * 1852
      )
    ORDER BY ga.created_at DESC
    LIMIT 50;
$$;

-- Enable Realtime for live alert feed
ALTER PUBLICATION supabase_realtime ADD TABLE guardian_alerts;
