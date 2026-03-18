-- ============================================================================
-- AIS Vessels — Real-time vessel tracking via AISStream.io
--
-- PostGIS-enabled table for spatial queries on vessel positions.
-- Worker upserts from AISStream WebSocket, app queries via Edge Function.
-- ============================================================================

-- Enable PostGIS (idempotent)
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Vessels table ──
CREATE TABLE IF NOT EXISTS public.vessels (
    mmsi bigint PRIMARY KEY,
    name text,
    call_sign text,
    ship_type integer DEFAULT 0,
    destination text,
    imo_number integer,
    location geography(POINT, 4326),
    cog float DEFAULT 0,
    sog float DEFAULT 0,
    heading integer DEFAULT 511,  -- 511 = not available per AIS spec
    nav_status integer DEFAULT 15, -- 15 = not defined
    dimension_a integer, -- bow to antenna
    dimension_b integer, -- antenna to stern
    dimension_c integer, -- port to antenna
    dimension_d integer, -- antenna to starboard
    updated_at timestamptz DEFAULT now()
);

-- Spatial index for fast map bounding-box queries
CREATE INDEX IF NOT EXISTS vessels_location_idx
    ON public.vessels USING GIST (location);

-- Index for stale vessel cleanup
CREATE INDEX IF NOT EXISTS vessels_updated_idx
    ON public.vessels (updated_at);

-- ── RLS ──
ALTER TABLE public.vessels ENABLE ROW LEVEL SECURITY;

-- Anon users can read vessel positions (public AIS data)
CREATE POLICY "Vessels are publicly readable"
    ON public.vessels FOR SELECT
    USING (true);

-- Only service_role can insert/update/delete (worker uses service key)
CREATE POLICY "Only service role can modify vessels"
    ON public.vessels FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ── Stale vessel cleanup function ──
-- Called by sweep-stale-vessels Edge Function on a cron schedule
CREATE OR REPLACE FUNCTION public.sweep_stale_vessels(max_age_hours integer DEFAULT 24)
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

-- ── Spatial query function (called by Edge Function) ──
CREATE OR REPLACE FUNCTION public.vessels_nearby(
    query_lat double precision,
    query_lon double precision,
    radius_m double precision DEFAULT 46300, -- ~25 NM
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
    ORDER BY v.updated_at DESC
    LIMIT max_results;
$$;
