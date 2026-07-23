-- Anonymous Edge-function callers use the project's public anon credential,
-- which is intentionally shipped in the app. Bound expensive public fallbacks
-- by an HMAC of the reverse-proxy address; raw addresses never enter Postgres.

CREATE TABLE IF NOT EXISTS public.edge_public_rate_limits (
    client_hash TEXT NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
    bucket TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
    PRIMARY KEY (client_hash, bucket, window_start)
);
ALTER TABLE public.edge_public_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS edge_public_rate_limits_window_idx
    ON public.edge_public_rate_limits(window_start);

CREATE OR REPLACE FUNCTION public.consume_public_edge_quota(
    p_bucket TEXT,
    p_client_hash TEXT,
    p_limit INTEGER,
    p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    bucket_start TIMESTAMPTZ;
    consumed INTEGER;
BEGIN
    IF auth.role() <> 'service_role'
       OR p_bucket !~ '^[a-z0-9_-]{1,40}$'
       OR p_client_hash !~ '^[0-9a-f]{64}$'
       OR p_limit NOT BETWEEN 1 AND 10000
       OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN
        RETURN false;
    END IF;

    bucket_start := to_timestamp(
        floor(extract(epoch FROM statement_timestamp()) / p_window_seconds) * p_window_seconds
    );

    INSERT INTO public.edge_public_rate_limits(client_hash, bucket, window_start, request_count)
    VALUES (p_client_hash, p_bucket, bucket_start, 1)
    ON CONFLICT (client_hash, bucket, window_start) DO UPDATE
        SET request_count = public.edge_public_rate_limits.request_count + 1
        WHERE public.edge_public_rate_limits.request_count < p_limit
    RETURNING request_count INTO consumed;

    -- Opportunistic bounded retention. This is not part of authorization and
    -- must never turn one public request into an unbounded maintenance sweep.
    WITH stale AS MATERIALIZED (
        SELECT client_hash, bucket, window_start
        FROM public.edge_public_rate_limits
        WHERE window_start < statement_timestamp() - interval '2 days'
        ORDER BY window_start
        LIMIT 500
    )
    DELETE FROM public.edge_public_rate_limits AS quota
    USING stale
    WHERE quota.client_hash = stale.client_hash
      AND quota.bucket = stale.bucket
      AND quota.window_start = stale.window_start;

    RETURN consumed IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_public_edge_quota(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_public_edge_quota(TEXT, TEXT, INTEGER, INTEGER) TO service_role;

-- The original SECURITY DEFINER AIS functions inherited PUBLIC execute.
-- Restrict the destructive sweep to the service role and force spatial
-- callers through bounded, authenticated arguments even if they bypass Edge.
REVOKE ALL ON FUNCTION public.sweep_stale_vessels(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_vessels(INTEGER) TO service_role;
ALTER FUNCTION public.sweep_stale_vessels(INTEGER) SET search_path = pg_catalog, public;

-- Guardian watchdog helpers expose private armed/home positions and inherited
-- PUBLIC execute from SECURITY DEFINER. Retire the old distance-only helpers:
-- the combined owner-scoped helper below returns one internally consistent
-- position/distance snapshot and is the only supported watchdog read path.
DROP FUNCTION IF EXISTS public.check_bolo_distance(BIGINT);
DROP FUNCTION IF EXISTS public.check_bolo_distance(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.check_geofence_distance(BIGINT);
DROP FUNCTION IF EXISTS public.check_geofence_distance(UUID, BIGINT);

CREATE OR REPLACE FUNCTION public.guardian_watchdog_position(
    p_user_id UUID,
    p_vessel_mmsi BIGINT,
    p_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    result JSONB;
BEGIN
    IF auth.role() <> 'service_role'
       OR p_user_id IS NULL
       OR p_vessel_mmsi IS NULL
       OR p_kind NOT IN ('bolo', 'geofence_breach') THEN
        RAISE EXCEPTION 'Service role, exact owner/vessel, and alert kind required';
    END IF;

    SELECT jsonb_build_object(
        'distance_m',
        CASE p_kind
            WHEN 'bolo' THEN ST_Distance(gp.armed_location, v.location)
            ELSE ST_Distance(gp.home_coordinate, v.location)
        END,
        'lat', ST_Y(v.location::geometry),
        'lon', ST_X(v.location::geometry),
        'updated_at', v.updated_at
    )
    INTO result
    FROM public.guardian_profiles AS gp
    JOIN public.vessels AS v ON v.mmsi = gp.mmsi
    WHERE gp.user_id = p_user_id
      AND gp.mmsi = p_vessel_mmsi
      AND v.location IS NOT NULL
      AND v.updated_at > statement_timestamp() - interval '15 minutes'
      AND v.updated_at <= statement_timestamp() + interval '2 minutes'
      AND (
          (p_kind = 'bolo' AND gp.armed = true AND gp.armed_location IS NOT NULL)
          OR (p_kind = 'geofence_breach' AND gp.home_coordinate IS NOT NULL)
      );
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.guardian_watchdog_position(UUID, BIGINT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_watchdog_position(UUID, BIGINT, TEXT) TO service_role;

-- Restart-safe Guardian alert episodes. One transaction claims the episode,
-- writes its durable audit row, and queues owner/nearby pushes. A worker crash
-- cannot leave an in-memory latch as the only record of a critical alert.
CREATE TABLE IF NOT EXISTS public.guardian_watchdog_episodes (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    alert_kind TEXT NOT NULL CHECK (alert_kind IN ('bolo', 'geofence_breach')),
    episode_key TEXT NOT NULL CHECK (char_length(episode_key) BETWEEN 1 AND 160),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    resolved_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, alert_kind, episode_key)
);
ALTER TABLE public.guardian_watchdog_episodes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS guardian_watchdog_resolved_at_idx
    ON public.guardian_watchdog_episodes(resolved_at)
    WHERE resolved_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.queue_guardian_watchdog_alert(
    p_user_id UUID,
    p_alert_kind TEXT,
    p_episode_key TEXT,
    p_lat DOUBLE PRECISION,
    p_lon DOUBLE PRECISION,
    p_radius_nm DOUBLE PRECISION,
    p_title TEXT,
    p_body TEXT,
    p_owner_title TEXT,
    p_owner_body TEXT,
    p_data JSONB DEFAULT '{}'::jsonb
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    claimed_user UUID;
    alert_id UUID;
    recipient RECORD;
    notify_count INTEGER := 0;
    bounded_radius DOUBLE PRECISION;
    notification_type TEXT;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    IF p_alert_kind NOT IN ('bolo', 'geofence_breach')
       OR p_user_id IS NULL
       OR p_episode_key IS NULL
       OR char_length(p_episode_key) NOT BETWEEN 1 AND 160
       OR p_lat IS NULL
       OR p_lat NOT BETWEEN -90 AND 90
       OR p_lon IS NULL
       OR p_lon NOT BETWEEN -180 AND 180
       OR p_radius_nm IS NULL
       OR p_radius_nm NOT BETWEEN 0.1 AND 5
       OR p_title IS NULL
       OR char_length(p_title) NOT BETWEEN 1 AND 120
       OR p_body IS NULL
       OR char_length(p_body) NOT BETWEEN 1 AND 500
       OR p_owner_title IS NULL
       OR char_length(p_owner_title) NOT BETWEEN 1 AND 120
       OR p_owner_body IS NULL
       OR char_length(p_owner_body) NOT BETWEEN 1 AND 500
       OR jsonb_typeof(COALESCE(p_data, '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'Invalid Guardian watchdog alert';
    END IF;
    bounded_radius := p_radius_nm;

    INSERT INTO public.guardian_watchdog_episodes(user_id, alert_kind, episode_key)
    VALUES (p_user_id, p_alert_kind, p_episode_key)
    ON CONFLICT (user_id, alert_kind, episode_key) DO UPDATE
        SET created_at = statement_timestamp(), resolved_at = NULL
        WHERE public.guardian_watchdog_episodes.resolved_at IS NOT NULL
    RETURNING user_id INTO claimed_user;
    IF claimed_user IS NULL THEN RETURN 0; END IF;

    INSERT INTO public.guardian_alerts(
        alert_type, source_user_id, source_vessel_name, target_user_id,
        title, body, location, radius_nm, data
    )
    SELECT
        p_alert_kind, p_user_id, gp.vessel_name,
        CASE WHEN p_alert_kind = 'geofence_breach' THEN p_user_id ELSE NULL END,
        left(p_title, 120), left(p_body, 500),
        ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
        bounded_radius, COALESCE(p_data, '{}'::jsonb) || jsonb_build_object('episode_key', p_episode_key)
    FROM public.guardian_profiles AS gp
    WHERE gp.user_id = p_user_id
    RETURNING id INTO alert_id;
    IF alert_id IS NULL THEN RAISE EXCEPTION 'Guardian profile required'; END IF;

    notification_type := CASE WHEN p_alert_kind = 'bolo' THEN 'bolo_alert' ELSE 'geofence_alert' END;
    INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
    VALUES (
        p_user_id, notification_type, left(p_owner_title, 120), left(p_owner_body, 500),
        jsonb_build_object('alert_id', alert_id, 'alert_type', p_alert_kind, 'episode_key', p_episode_key)
    );
    notify_count := 1;

    IF p_alert_kind = 'bolo' THEN
        FOR recipient IN
            SELECT gp.user_id
            FROM public.guardian_profiles AS gp
            WHERE gp.user_id <> p_user_id
              AND gp.last_known_at > statement_timestamp() - interval '2 hours'
              AND gp.last_known_lat IS NOT NULL
              AND gp.last_known_lon IS NOT NULL
              AND ST_DWithin(
                  ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
                  ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
                  bounded_radius * 1852
              )
            ORDER BY gp.user_id
            LIMIT 50
        LOOP
            INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
            VALUES (
                recipient.user_id, notification_type, left(p_title, 120), left(p_body, 500),
                jsonb_build_object('alert_id', alert_id, 'alert_type', p_alert_kind, 'episode_key', p_episode_key)
            );
            notify_count := notify_count + 1;
        END LOOP;
    END IF;

    RETURN notify_count;
END;
$$;
REVOKE ALL ON FUNCTION public.queue_guardian_watchdog_alert(
    UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_guardian_watchdog_alert(
    UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_guardian_watchdog_episode(
    p_user_id UUID,
    p_alert_kind TEXT,
    p_episode_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    resolved BOOLEAN;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    IF p_user_id IS NULL
       OR p_alert_kind NOT IN ('bolo', 'geofence_breach')
       OR p_episode_key IS NULL
       OR char_length(p_episode_key) NOT BETWEEN 1 AND 160 THEN
        RAISE EXCEPTION 'Exact Guardian episode required';
    END IF;

    UPDATE public.guardian_watchdog_episodes
    SET resolved_at = statement_timestamp()
    WHERE user_id = p_user_id
      AND alert_kind = p_alert_kind
      AND episode_key = p_episode_key
      AND resolved_at IS NULL;
    resolved := FOUND;

    -- Keep this maintenance bounded so an alert-resolution request can never
    -- turn into an unbounded table sweep. The final predicate prevents a row
    -- reopened by a concurrent alert from being deleted.
    WITH stale AS MATERIALIZED (
        SELECT user_id, alert_kind, episode_key, resolved_at
        FROM public.guardian_watchdog_episodes
        WHERE resolved_at < statement_timestamp() - interval '30 days'
        ORDER BY resolved_at
        LIMIT 100
    )
    DELETE FROM public.guardian_watchdog_episodes AS episode
    USING stale
    WHERE episode.user_id = stale.user_id
      AND episode.alert_kind = stale.alert_kind
      AND episode.episode_key = stale.episode_key
      AND episode.resolved_at = stale.resolved_at;

    RETURN resolved;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_guardian_watchdog_episode(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_guardian_watchdog_episode(UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.guardian_arm(DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guardian_arm(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
ALTER FUNCTION public.guardian_arm(DOUBLE PRECISION, DOUBLE PRECISION) SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.guardian_disarm() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guardian_disarm() TO authenticated;
ALTER FUNCTION public.guardian_disarm() SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
ALTER FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION public.vessels_nearby(
    query_lat DOUBLE PRECISION,
    query_lon DOUBLE PRECISION,
    radius_m DOUBLE PRECISION DEFAULT 46300,
    max_results INTEGER DEFAULT 250
)
RETURNS TABLE (
    mmsi BIGINT,
    name TEXT,
    call_sign TEXT,
    ship_type INTEGER,
    destination TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    cog FLOAT,
    sog FLOAT,
    heading INTEGER,
    nav_status INTEGER,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF query_lat IS NULL OR query_lat NOT BETWEEN -90 AND 90
       OR query_lon IS NULL OR query_lon NOT BETWEEN -180 AND 180
       OR radius_m IS NULL OR radius_m NOT BETWEEN 926 AND 185200
       OR max_results IS NULL OR max_results NOT BETWEEN 1 AND 250 THEN
        RAISE EXCEPTION 'Invalid vessels_nearby bounds' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        v.mmsi,
        v.name,
        v.call_sign,
        v.ship_type,
        v.destination,
        ST_Y(v.location::geometry),
        ST_X(v.location::geometry),
        v.cog,
        v.sog,
        v.heading,
        v.nav_status,
        v.updated_at
    FROM public.vessels AS v
    WHERE ST_DWithin(
        v.location,
        ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography,
        radius_m
    )
      AND v.updated_at > statement_timestamp() - interval '2 hours'
      AND v.updated_at <= statement_timestamp() + interval '2 minutes'
    ORDER BY v.updated_at DESC
    LIMIT max_results;
END;
$$;
REVOKE ALL ON FUNCTION public.vessels_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vessels_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
    TO authenticated, service_role;

-- Escrow state must reserve the hand-off claim before Stripe capture starts,
-- otherwise the expiry sweep can race a valid PIN and cancel the same intent.
ALTER TABLE public.marketplace_escrow
    DROP CONSTRAINT IF EXISTS marketplace_escrow_escrow_status_check;
ALTER TABLE public.marketplace_escrow
    ADD CONSTRAINT marketplace_escrow_escrow_status_check
    CHECK (escrow_status IN (
        'awaiting_handoff', 'capture_pending', 'released', 'expired', 'canceled'
    ));
ALTER TABLE public.marketplace_escrow
    ADD COLUMN IF NOT EXISTS capture_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stripe_cancel_attempted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stripe_canceled_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.verify_escrow_pin(
    p_escrow_id UUID,
    p_pin TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
    escrow public.marketplace_escrow%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL OR p_pin !~ '^[0-9]{6}$' THEN
        RETURN json_build_object('success', false, 'error', 'Invalid PIN');
    END IF;
    IF NOT public.consume_edge_quota('escrow_pin', 30, 3600) THEN
        RETURN json_build_object('success', false, 'error', 'Too many attempts; try again later');
    END IF;

    SELECT * INTO escrow
    FROM public.marketplace_escrow
    WHERE id = p_escrow_id
    FOR UPDATE;
    IF NOT FOUND OR escrow.seller_id <> auth.uid() THEN
        RETURN json_build_object('success', false, 'error', 'Escrow not found');
    END IF;
    IF escrow.escrow_status <> 'awaiting_handoff' THEN
        RETURN json_build_object('success', false, 'error', 'Escrow is no longer active');
    END IF;
    IF escrow.escrow_expires_at < statement_timestamp() THEN
        UPDATE public.marketplace_escrow
        SET escrow_status = 'expired'
        WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Escrow has expired');
    END IF;
    IF escrow.pin_locked_until IS NOT NULL
       AND escrow.pin_locked_until > statement_timestamp() THEN
        RETURN json_build_object('success', false, 'error', 'Too many attempts; try again later');
    END IF;
    IF crypt(p_pin, escrow.escrow_pin) <> escrow.escrow_pin THEN
        UPDATE public.marketplace_escrow
        SET pin_attempt_count = pin_attempt_count + 1,
            pin_locked_until = CASE
                WHEN pin_attempt_count + 1 >= 5
                    THEN statement_timestamp() + interval '15 minutes'
                ELSE NULL
            END
        WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Invalid PIN');
    END IF;

    UPDATE public.marketplace_escrow
    SET pin_attempt_count = 0,
        pin_locked_until = NULL,
        escrow_status = 'capture_pending',
        capture_claimed_at = statement_timestamp()
    WHERE id = p_escrow_id;

    RETURN json_build_object(
        'success', true,
        'payment_intent_id', escrow.stripe_payment_intent_id,
        'amount_cents', escrow.amount_cents,
        'platform_fee_cents', escrow.platform_fee_cents,
        'seller_payout_cents', escrow.seller_payout_cents,
        'escrow_id', escrow.id
    );
END;
$$;
REVOKE ALL ON FUNCTION public.verify_escrow_pin(UUID, TEXT)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_escrow_pin(UUID, TEXT)
    TO authenticated;

CREATE OR REPLACE FUNCTION public.release_marketplace_escrow_capture(
    p_escrow_id UUID,
    p_payment_intent_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required';
    END IF;
    UPDATE public.marketplace_escrow
    SET escrow_status = CASE
            WHEN escrow_expires_at <= statement_timestamp() THEN 'expired'
            ELSE 'awaiting_handoff'
        END,
        capture_claimed_at = NULL
    WHERE id = p_escrow_id
      AND stripe_payment_intent_id = p_payment_intent_id
      AND escrow_status = 'capture_pending';
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.release_marketplace_escrow_capture(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_marketplace_escrow_capture(UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.claim_marketplace_escrow_reconciliation(
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    escrow_id UUID,
    payment_intent_id TEXT,
    listing_id UUID,
    escrow_status TEXT,
    escrow_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required';
    END IF;
    RETURN QUERY
    WITH candidates AS MATERIALIZED (
        SELECT e.id
        FROM public.marketplace_escrow AS e
        WHERE e.stripe_payment_intent_id IS NOT NULL
          AND e.stripe_canceled_at IS NULL
          AND (
              (e.escrow_status = 'awaiting_handoff'
                  AND e.escrow_expires_at <= statement_timestamp())
              OR e.escrow_status = 'expired'
              OR (
                  e.escrow_status = 'capture_pending'
                  AND e.capture_claimed_at <
                      statement_timestamp() - interval '10 minutes'
              )
          )
          AND (
              e.stripe_cancel_attempted_at IS NULL
              OR e.stripe_cancel_attempted_at <
                  statement_timestamp() - interval '15 minutes'
          )
        ORDER BY e.escrow_expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT least(greatest(coalesce(p_limit, 10), 1), 25)
    ),
    claimed AS (
        UPDATE public.marketplace_escrow AS e
        SET escrow_status = CASE
                WHEN e.escrow_status = 'awaiting_handoff' THEN 'expired'
                ELSE e.escrow_status
            END,
            stripe_cancel_attempted_at = statement_timestamp()
        FROM candidates AS c
        WHERE e.id = c.id
        RETURNING e.id, e.stripe_payment_intent_id, e.listing_id,
                  e.escrow_status, e.escrow_expires_at
    )
    SELECT c.id, c.stripe_payment_intent_id, c.listing_id,
           c.escrow_status, c.escrow_expires_at
    FROM claimed AS c;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_marketplace_escrow_reconciliation(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_marketplace_escrow_reconciliation(INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.complete_marketplace_escrow_cancellation(
    p_escrow_id UUID,
    p_payment_intent_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_listing_id UUID;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required';
    END IF;
    UPDATE public.marketplace_escrow
    SET escrow_status = 'expired',
        capture_claimed_at = NULL,
        stripe_canceled_at = statement_timestamp()
    WHERE id = p_escrow_id
      AND stripe_payment_intent_id = p_payment_intent_id
      AND escrow_status IN ('awaiting_handoff', 'capture_pending', 'expired', 'canceled')
    RETURNING listing_id INTO target_listing_id;
    IF target_listing_id IS NULL THEN RETURN false; END IF;

    UPDATE public.marketplace_listings
    SET status = 'available',
        updated_at = statement_timestamp()
    WHERE id = target_listing_id
      AND status = 'pending';
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_marketplace_escrow_cancellation(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_marketplace_escrow_cancellation(UUID, TEXT)
    TO service_role;

-- Stripe is an external side effect, but the local escrow and listing state
-- must still advance atomically. The capture endpoint can safely call this
-- again after a lost response or temporary database failure.
CREATE OR REPLACE FUNCTION public.finalize_marketplace_escrow_release(
    p_escrow_id UUID,
    p_payment_intent_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    escrow public.marketplace_escrow%ROWTYPE;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required';
    END IF;
    IF p_escrow_id IS NULL
       OR p_payment_intent_id IS NULL
       OR char_length(p_payment_intent_id) > 255
       OR p_payment_intent_id !~ '^pi_[[:alnum:]]{8,}$' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid payment reference');
    END IF;

    SELECT * INTO escrow
    FROM public.marketplace_escrow
    WHERE id = p_escrow_id
    FOR UPDATE;
    IF NOT FOUND
       OR escrow.stripe_payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'Escrow not found');
    END IF;
    IF escrow.escrow_status NOT IN ('awaiting_handoff', 'capture_pending', 'released') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Escrow is not releasable');
    END IF;

    UPDATE public.marketplace_escrow
    SET escrow_status = 'released',
        capture_claimed_at = NULL,
        updated_at = statement_timestamp()
    WHERE id = escrow.id
      AND escrow_status <> 'released';

    UPDATE public.marketplace_listings
    SET status = 'sold',
        sold_at = coalesce(sold_at, statement_timestamp()),
        updated_at = statement_timestamp()
    WHERE id = escrow.listing_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_marketplace_escrow_release(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_marketplace_escrow_release(UUID, TEXT)
    TO service_role;

DO $$
BEGIN
    PERFORM cron.unschedule('sweep-expired-marketplace-escrows');
EXCEPTION
    WHEN OTHERS THEN NULL;
END;
$$;
SELECT cron.schedule(
    'sweep-expired-marketplace-escrows',
    '*/5 * * * *',
    $$
    SELECT net.http_post(
        url := current_setting('app.settings.supabase_url')
            || '/functions/v1/sweep-expired-escrows',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer '
                || current_setting('app.settings.service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
    );
    $$
);

DO $$
BEGIN
    PERFORM cron.unschedule('sweep-stale-ais-vessels');
EXCEPTION
    WHEN OTHERS THEN NULL;
END;
$$;
SELECT cron.schedule(
    'sweep-stale-ais-vessels',
    '17 */6 * * *',
    $$
    SELECT net.http_post(
        url := current_setting('app.settings.supabase_url')
            || '/functions/v1/sweep-stale-vessels',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer '
                || current_setting('app.settings.service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
    );
    $$
);
