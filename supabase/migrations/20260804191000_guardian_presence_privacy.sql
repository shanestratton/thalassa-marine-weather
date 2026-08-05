-- Guardian presence is opt-in and ephemeral for the public beta.
--
-- Privacy invariants enforced server-side (not merely in the client):
--   * disarmed profiles cannot heartbeat or remain discoverable;
--   * only armed, recently-seen vessels are returned;
--   * proximity uses the caller's own recent stored fix, never arbitrary
--     query coordinates (prevents sweeping an unrelated coastline);
--   * proximity/heartbeat RPCs have per-account quotas;
--   * discovery returns only the fields needed to render/hail a vessel.

-- Some production installs pre-date the canonical Guardian table and use
-- geography columns (`armed_position`, `last_known_position`) plus `bio`.
-- CREATE TABLE IF NOT EXISTS in the original migration could not reconcile
-- that shape. Add both sides of the compatibility pair before applying the
-- privacy invariants so a linked upgrade and a clean replay converge safely.
ALTER TABLE IF EXISTS public.guardian_profiles
    ADD COLUMN IF NOT EXISTS mmsi_verified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS vessel_bio TEXT,
    ADD COLUMN IF NOT EXISTS owner_name TEXT,
    ADD COLUMN IF NOT EXISTS armed_location GEOGRAPHY(POINT, 4326),
    ADD COLUMN IF NOT EXISTS last_known_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS last_known_lon DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS last_known_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS bio TEXT,
    ADD COLUMN IF NOT EXISTS armed_position GEOGRAPHY(POINT, 4326),
    ADD COLUMN IF NOT EXISTS last_known_position GEOGRAPHY(POINT, 4326),
    ADD COLUMN IF NOT EXISTS last_position_at TIMESTAMPTZ;

UPDATE public.guardian_profiles
SET vessel_bio = COALESCE(vessel_bio, bio),
    bio = COALESCE(vessel_bio, bio),
    armed_location = COALESCE(armed_location, armed_position),
    armed_position = COALESCE(armed_location, armed_position),
    last_known_lat = COALESCE(last_known_lat, ST_Y(last_known_position::geometry)),
    last_known_lon = COALESCE(last_known_lon, ST_X(last_known_position::geometry)),
    last_known_at = COALESCE(last_known_at, last_position_at),
    last_known_position = COALESCE(
        last_known_position,
        CASE
            WHEN last_known_lat IS NOT NULL AND last_known_lon IS NOT NULL
                THEN ST_SetSRID(ST_MakePoint(last_known_lon, last_known_lat), 4326)::geography
            ELSE NULL
        END
    ),
    last_position_at = COALESCE(last_position_at, last_known_at);

-- Remove legacy disarmed presence immediately.
UPDATE public.guardian_profiles
SET last_known_lat = NULL,
    last_known_lon = NULL,
    last_known_at = NULL,
    last_known_position = NULL,
    last_position_at = NULL,
    armed_location = NULL,
    armed_position = NULL,
    updated_at = now()
WHERE armed IS NOT TRUE
  AND (
      last_known_lat IS NOT NULL
      OR last_known_lon IS NOT NULL
      OR last_known_at IS NOT NULL
      OR last_known_position IS NOT NULL
      OR last_position_at IS NOT NULL
      OR armed_location IS NOT NULL
      OR armed_position IS NOT NULL
  );

-- Do not let raw REST writes bypass the arm/disarm/heartbeat invariants.
REVOKE INSERT, UPDATE ON public.guardian_profiles FROM authenticated;
GRANT INSERT (
    user_id, mmsi, vessel_name, vessel_bio, owner_name, dog_name,
    home_coordinate, home_radius_m, updated_at
) ON public.guardian_profiles TO authenticated;
GRANT UPDATE (
    user_id, mmsi, vessel_name, vessel_bio, owner_name, dog_name,
    home_coordinate, home_radius_m, updated_at
) ON public.guardian_profiles TO authenticated;

-- Keep the pre-canonical `bio` field coherent for older Watchdog/admin code
-- while the public client writes only `vessel_bio`.
CREATE OR REPLACE FUNCTION public.guardian_sync_profile_compatibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.vessel_bio := COALESCE(NEW.vessel_bio, NEW.bio);
        NEW.bio := NEW.vessel_bio;
    ELSIF NEW.vessel_bio IS DISTINCT FROM OLD.vessel_bio THEN
        NEW.bio := NEW.vessel_bio;
    ELSIF NEW.bio IS DISTINCT FROM OLD.bio THEN
        NEW.vessel_bio := NEW.bio;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guardian_sync_profile_compatibility_trigger ON public.guardian_profiles;
CREATE TRIGGER guardian_sync_profile_compatibility_trigger
BEFORE INSERT OR UPDATE ON public.guardian_profiles
FOR EACH ROW EXECUTE FUNCTION public.guardian_sync_profile_compatibility();

-- Changing a claimed MMSI always invalidates verification without granting
-- clients permission to write mmsi_verified=true themselves.
CREATE OR REPLACE FUNCTION public.guardian_reset_mmsi_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.mmsi_verified := false;
    ELSIF NEW.mmsi IS DISTINCT FROM OLD.mmsi THEN
        NEW.mmsi_verified := false;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guardian_reset_mmsi_verification_trigger ON public.guardian_profiles;
CREATE TRIGGER guardian_reset_mmsi_verification_trigger
BEFORE INSERT OR UPDATE ON public.guardian_profiles
FOR EACH ROW EXECUTE FUNCTION public.guardian_reset_mmsi_verification();

-- A crafted client must not bypass the armed-only presence rule by calling
-- the alert broadcaster directly with coordinates while disarmed.
CREATE OR REPLACE FUNCTION public.guardian_require_armed_user_broadcast()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.alert_type IN ('suspicious', 'weather_spike')
       AND NOT EXISTS (
           SELECT 1
           FROM public.guardian_profiles AS gp
           WHERE gp.user_id = NEW.source_user_id
             AND gp.armed IS TRUE
       ) THEN
        RAISE EXCEPTION 'Guardian must be armed before broadcasting a location-based alert';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guardian_require_armed_user_broadcast_trigger ON public.guardian_alerts;
CREATE TRIGGER guardian_require_armed_user_broadcast_trigger
BEFORE INSERT ON public.guardian_alerts
FOR EACH ROW EXECUTE FUNCTION public.guardian_require_armed_user_broadcast();

-- Legacy installs used the same argument signatures with a different return
-- type. PostgreSQL cannot change a function return type via OR REPLACE, so
-- explicitly retire those definitions before installing the canonical RPCs.
DROP FUNCTION IF EXISTS public.guardian_arm(DOUBLE PRECISION, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.guardian_disarm();
DROP FUNCTION IF EXISTS public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION public.guardian_arm(lat DOUBLE PRECISION, lon DOUBLE PRECISION)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.uid() IS NULL OR lat NOT BETWEEN -90 AND 90 OR lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'Authentication and valid coordinates required';
    END IF;
    IF NOT public.consume_edge_quota('guardian_arm', 30, 3600) THEN
        RAISE EXCEPTION 'Guardian arm rate limit exceeded';
    END IF;

    UPDATE public.guardian_profiles
    SET armed = true,
        armed_at = now(),
        armed_location = ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
        armed_position = ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
        last_known_lat = lat,
        last_known_lon = lon,
        last_known_at = now(),
        last_known_position = ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
        last_position_at = now(),
        updated_at = now()
    WHERE user_id = auth.uid();

    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.guardian_disarm()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    UPDATE public.guardian_profiles
    SET armed = false,
        armed_at = NULL,
        armed_location = NULL,
        armed_position = NULL,
        last_known_lat = NULL,
        last_known_lon = NULL,
        last_known_at = NULL,
        last_known_position = NULL,
        last_position_at = NULL,
        updated_at = now()
    WHERE user_id = auth.uid();

    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.guardian_heartbeat(lat DOUBLE PRECISION, lon DOUBLE PRECISION)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.uid() IS NULL OR lat NOT BETWEEN -90 AND 90 OR lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'Authentication and valid coordinates required';
    END IF;
    IF NOT public.consume_edge_quota('guardian_heartbeat', 180, 3600) THEN
        RAISE EXCEPTION 'Guardian heartbeat rate limit exceeded';
    END IF;

    UPDATE public.guardian_profiles
    SET last_known_lat = lat,
        last_known_lon = lon,
        last_known_at = now(),
        last_known_position = ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
        last_position_at = now(),
        updated_at = now()
    WHERE user_id = auth.uid()
      AND armed IS TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guardian must be armed before sharing location';
    END IF;
END;
$$;

-- Retire the coordinate-controlled discovery endpoint.
REVOKE ALL ON FUNCTION public.thalassa_users_nearby(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.thalassa_users_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);

DROP FUNCTION IF EXISTS public.nearby_guardians(DOUBLE PRECISION);
CREATE FUNCTION public.nearby_guardians(radius_nm DOUBLE PRECISION DEFAULT 5)
RETURNS TABLE (
    user_id UUID,
    vessel_name TEXT,
    distance_nm DOUBLE PRECISION,
    last_known_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_lat DOUBLE PRECISION;
    caller_lon DOUBLE PRECISION;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    IF NOT public.consume_edge_quota('guardian_nearby', 180, 3600) THEN
        RAISE EXCEPTION 'Guardian nearby rate limit exceeded';
    END IF;

    SELECT gp.last_known_lat, gp.last_known_lon
    INTO caller_lat, caller_lon
    FROM public.guardian_profiles AS gp
    WHERE gp.user_id = auth.uid()
      AND gp.armed IS TRUE
      AND gp.last_known_at > now() - interval '5 minutes';

    IF caller_lat IS NULL OR caller_lon IS NULL THEN
        RAISE EXCEPTION 'Arm Guardian with a recent position before checking nearby vessels';
    END IF;

    RETURN QUERY
    SELECT gp.user_id,
           gp.vessel_name,
           (round((ST_Distance(
               ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
               ST_SetSRID(ST_MakePoint(caller_lon, caller_lat), 4326)::geography
           ) / 1852.0)::numeric * 2) / 2.0)::double precision AS distance_nm,
           gp.last_known_at
    FROM public.guardian_profiles AS gp
    WHERE gp.user_id <> auth.uid()
      AND gp.armed IS TRUE
      AND gp.last_known_lat IS NOT NULL
      AND gp.last_known_lon IS NOT NULL
      AND gp.last_known_at > now() - interval '5 minutes'
      AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(caller_lon, caller_lat), 4326)::geography,
          LEAST(GREATEST(radius_nm, 0.1), 5) * 1852
      )
    ORDER BY 3 ASC
    LIMIT 50;
END;
$$;

-- Alerts use the same non-sweepable caller-position rule.
REVOKE ALL ON FUNCTION public.guardian_alerts_nearby(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER
) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.guardian_alerts_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER);

DROP FUNCTION IF EXISTS public.guardian_alerts_nearby(DOUBLE PRECISION, INTEGER);
CREATE FUNCTION public.guardian_alerts_nearby(
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
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_lat DOUBLE PRECISION;
    caller_lon DOUBLE PRECISION;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    IF NOT public.consume_edge_quota('guardian_alerts', 180, 3600) THEN
        RAISE EXCEPTION 'Guardian alert feed rate limit exceeded';
    END IF;

    SELECT gp.last_known_lat, gp.last_known_lon
    INTO caller_lat, caller_lon
    FROM public.guardian_profiles AS gp
    WHERE gp.user_id = auth.uid()
      AND gp.armed IS TRUE
      AND gp.last_known_at > now() - interval '5 minutes';

    IF caller_lat IS NULL OR caller_lon IS NULL THEN
        RAISE EXCEPTION 'Arm Guardian with a recent position before checking alerts';
    END IF;

    RETURN QUERY
    SELECT ga.id,
           ga.alert_type,
           ga.source_vessel_name,
           ga.title,
           ga.body,
           round(ST_Y(ga.location::geometry)::numeric, 3)::double precision,
           round(ST_X(ga.location::geometry)::numeric, 3)::double precision,
           ga.data - 'exact_location',
           ga.created_at
    FROM public.guardian_alerts AS ga
    WHERE ga.created_at > now() - make_interval(hours => LEAST(GREATEST(max_hours, 1), 24))
      AND (ga.source_user_id = auth.uid() OR ga.target_user_id = auth.uid())
      AND ga.location IS NOT NULL
      AND ST_DWithin(
          ga.location,
          ST_SetSRID(ST_MakePoint(caller_lon, caller_lat), 4326)::geography,
          LEAST(GREATEST(radius_nm, 0.1), 10) * 1852
      )
    ORDER BY ga.created_at DESC
    LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION public.guardian_arm(DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guardian_disarm() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guardian_reset_mmsi_verification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guardian_require_armed_user_broadcast() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guardian_sync_profile_compatibility() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nearby_guardians(DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guardian_alerts_nearby(DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.guardian_arm(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_disarm() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nearby_guardians(DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_alerts_nearby(DOUBLE PRECISION, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
