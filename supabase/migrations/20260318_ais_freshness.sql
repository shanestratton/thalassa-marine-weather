-- ============================================================================
-- AIS Freshness — 2-hour vessel expiry
--
-- Adds a 2-hour freshness filter to vessels_nearby so stale AIS targets
-- disappear from the map. Also reduces the sweep default to 2 hours.
-- ============================================================================

-- Update vessels_nearby to filter out vessels older than 2 hours
CREATE OR REPLACE FUNCTION public.vessels_nearby(
    query_lat double precision,
    query_lon double precision,
    radius_m double precision DEFAULT 46300,
    max_results integer DEFAULT 500
)
RETURNS TABLE (
    mmsi bigint,
    name text,
    call_sign text,
    ship_type integer,
    destination text,
    lat double precision,
    lon double precision,
    cog float,
    sog float,
    heading integer,
    nav_status integer,
    updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        v.mmsi,
        v.name,
        v.call_sign,
        v.ship_type,
        v.destination,
        ST_Y(v.location::geometry) AS lat,
        ST_X(v.location::geometry) AS lon,
        v.cog,
        v.sog,
        v.heading,
        v.nav_status,
        v.updated_at
    FROM public.vessels v
    WHERE ST_DWithin(
        v.location,
        ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography,
        radius_m
    )
    AND v.updated_at > NOW() - INTERVAL '2 hours'
    ORDER BY v.updated_at DESC
    LIMIT max_results;
$$;

-- Update sweep default to 2 hours
CREATE OR REPLACE FUNCTION public.sweep_stale_vessels(max_age_hours integer DEFAULT 2)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM public.vessels
    WHERE updated_at < NOW() - (max_age_hours || ' hours')::interval;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;
