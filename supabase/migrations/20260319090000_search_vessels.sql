-- ============================================================================
-- Vessel Search — RPC function for name/MMSI search with lat/lon extraction
-- ============================================================================

CREATE OR REPLACE FUNCTION public.search_vessels(
    search_query text,
    max_results integer DEFAULT 10
)
RETURNS TABLE (
    mmsi bigint,
    name text,
    call_sign text,
    ship_type integer,
    sog float,
    lat double precision,
    lon double precision
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
        v.sog,
        ST_Y(v.location::geometry) AS lat,
        ST_X(v.location::geometry) AS lon
    FROM public.vessels v
    WHERE
        v.location IS NOT NULL
        AND (
            -- MMSI exact match (if the query is all digits)
            (search_query ~ '^\d{5,9}$' AND v.mmsi = search_query::bigint)
            OR
            -- Name match: start of name OR start of any word within name
            (v.name ILIKE search_query || '%')
            OR
            (v.name ILIKE '% ' || search_query || '%')
            OR
            (v.name ILIKE '%-' || search_query || '%')
            OR
            -- Call sign match (start-of-string only)
            (v.call_sign ILIKE search_query || '%')
        )
    ORDER BY v.updated_at DESC
    LIMIT max_results;
$$;
