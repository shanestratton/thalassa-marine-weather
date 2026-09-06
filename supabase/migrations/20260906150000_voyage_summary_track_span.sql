-- Voyage summaries carry the track's footprint (2026-09-06).
--
-- The Log page's empty-track prune keyed on distance alone:
-- max(cumulative_distance_nm) < 0.05 NM. A boat on the hard at Scarborough
-- accrued 0.1 NM of confirmed GPS jitter over an afternoon (a boatyard's
-- multipath pairs up even under the two-fix rule) and so was never swept,
-- while every fix sat inside a box a few tens of metres across. The client
-- now also prunes a voyage whose bounding-box diagonal is under 150 m
-- (services/shiplog/VoyageSummary.ts EMPTY_TRACK_SPAN_M); this revision hands
-- it the box. Placeholder 0,0 fixes (captureImmediate before the first real
-- fix) are excluded from it.
--
-- Body otherwise verbatim from 20260724093000_voyage_summary_default_bucket.sql.

DROP FUNCTION IF EXISTS public.get_voyage_summaries(boolean);

CREATE OR REPLACE FUNCTION public.get_voyage_summaries(
    p_include_archived BOOLEAN DEFAULT false
)
RETURNS TABLE (
    voyage_id TEXT,
    entry_count BIGINT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    total_distance_nm DOUBLE PRECISION,
    avg_speed_kts DOUBLE PRECISION,
    has_manual BOOLEAN,
    is_planned_route BOOLEAN,
    is_imported BOOLEAN,
    first_lat DOUBLE PRECISION,
    first_lon DOUBLE PRECISION,
    last_lat DOUBLE PRECISION,
    last_lon DOUBLE PRECISION,
    first_is_on_water BOOLEAN,
    land_fraction DOUBLE PRECISION,
    min_lat DOUBLE PRECISION,
    max_lat DOUBLE PRECISION,
    min_lon DOUBLE PRECISION,
    max_lon DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        coalesce(nullif(logs.voyage_id, ''), 'default_voyage') AS voyage_id,
        count(*) AS entry_count,
        min(logs.timestamp) AS started_at,
        max(logs.timestamp) AS ended_at,
        max(coalesce(logs.cumulative_distance_nm, 0)) AS total_distance_nm,
        avg(logs.speed_kts) FILTER (WHERE logs.speed_kts > 0) AS avg_speed_kts,
        bool_or(logs.entry_type = 'manual') AS has_manual,
        bool_or(logs.source = 'planned_route') AS is_planned_route,
        bool_or(
            logs.source IS NOT NULL
            AND logs.source NOT IN ('device', 'planned_route')
        ) AS is_imported,
        (array_agg(logs.latitude ORDER BY logs.timestamp ASC))[1] AS first_lat,
        (array_agg(logs.longitude ORDER BY logs.timestamp ASC))[1] AS first_lon,
        (array_agg(logs.latitude ORDER BY logs.timestamp DESC))[1] AS last_lat,
        (array_agg(logs.longitude ORDER BY logs.timestamp DESC))[1] AS last_lon,
        (array_agg(logs.is_on_water ORDER BY logs.timestamp ASC))[1] AS first_is_on_water,
        (count(*) FILTER (WHERE logs.is_on_water = false))::double precision
            / NULLIF(
                count(*) FILTER (WHERE logs.is_on_water IS NOT NULL),
                0
            ) AS land_fraction,
        min(logs.latitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)) AS min_lat,
        max(logs.latitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)) AS max_lat,
        min(logs.longitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)) AS min_lon,
        max(logs.longitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)) AS max_lon
    FROM public.ship_logs AS logs
    WHERE logs.user_id = auth.uid()
      AND (
          p_include_archived
          OR logs.archived IS NULL
          OR logs.archived = false
      )
    GROUP BY coalesce(nullif(logs.voyage_id, ''), 'default_voyage')
    ORDER BY max(logs.timestamp) DESC;
$$;

REVOKE ALL ON FUNCTION public.get_voyage_summaries(boolean)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_voyage_summaries(boolean)
    TO authenticated;
