-- Public Voyage Log trip catalogue (2026-07-27).
--
-- The public voyage-log Edge Function needs a compact list of historical,
-- recorded voyages to drive its picker.  Keep that aggregation in Postgres so
-- it never has to download every GPS point merely to discover the trips.
--
-- This is intentionally a service-role-only helper.  Public callers still
-- enter through the Edge Function, which resolves the public handle to its
-- exact owner and applies the configured retention window before calling it.

CREATE INDEX IF NOT EXISTS ship_logs_public_voyage_catalog_owner_timestamp_idx
    ON public.ship_logs (user_id, timestamp DESC, voyage_id)
    INCLUDE (cumulative_distance_nm, is_on_water, source, entry_type)
    WHERE (archived IS NULL OR archived = false)
      AND voyage_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.public_voyage_log_trip_catalog(
    p_owner_id UUID,
    p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
    voyage_id TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    point_count BIGINT,
    distance_nm DOUBLE PRECISION,
    land_fraction DOUBLE PRECISION,
    plan_voyage_id TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Grants below are the primary boundary.  Keep the check in the function
    -- as defence in depth in case a later migration accidentally broadens
    -- EXECUTE permissions on this SECURITY DEFINER helper.
    IF auth.role() IS DISTINCT FROM 'service_role' OR p_owner_id IS NULL THEN
        RAISE EXCEPTION 'Service role and an exact owner are required';
    END IF;

    RETURN QUERY
    WITH eligible_logs AS (
        SELECT
            btrim(logs.voyage_id) AS normalized_voyage_id,
            logs.timestamp,
            logs.cumulative_distance_nm,
            logs.is_on_water
        FROM public.ship_logs AS logs
        WHERE logs.user_id = p_owner_id
          -- Archived/binned tracks are private everywhere, including the
          -- public voyage picker.
          AND (logs.archived IS NULL OR logs.archived = false)
          -- A catalogue entry must be a real started voyage, not legacy
          -- ungrouped data, a sentinel bucket, or a saved/planned route.
          AND logs.voyage_id IS NOT NULL
          AND btrim(logs.voyage_id) <> ''
          AND lower(btrim(logs.voyage_id)) NOT IN ('default', 'default_voyage')
          AND btrim(logs.voyage_id) !~* '^planned_'
          AND coalesce(logs.source, '') <> 'planned_route'
          -- Match the public map: manually logged positions are diary-style
          -- annotations, not GPS track geometry.
          AND logs.entry_type IS DISTINCT FROM 'manual'
          AND logs.latitude BETWEEN -90 AND 90
          AND logs.longitude BETWEEN -180 AND 180
          AND NOT (
              abs(logs.latitude) < 0.001
              AND abs(logs.longitude) < 0.001
          )
          AND coalesce(logs.waypoint_name, '') NOT LIKE 'COG %'
          AND coalesce(logs.notes, '') NOT LIKE 'Auto: COG%'
          -- The caller normally supplies voyage_log_configs.track_days.  A
          -- NULL value is deliberate and means the Edge Function has chosen
          -- to request the full retained history.
          AND (p_since IS NULL OR logs.timestamp >= p_since)
    )
    SELECT
        eligible.normalized_voyage_id AS voyage_id,
        min(eligible.timestamp) AS started_at,
        max(eligible.timestamp) AS ended_at,
        count(*) AS point_count,
        max(coalesce(eligible.cumulative_distance_nm, 0))::DOUBLE PRECISION AS distance_nm,
        (count(*) FILTER (WHERE eligible.is_on_water = false))::DOUBLE PRECISION
            / nullif(
                (count(*) FILTER (WHERE eligible.is_on_water IS NOT NULL))::DOUBLE PRECISION,
                0
            ) AS land_fraction,
        links.plan_voyage_id
    FROM eligible_logs AS eligible
    LEFT JOIN public.voyage_plan_links AS links
        ON links.user_id = p_owner_id
       AND links.voyage_id = eligible.normalized_voyage_id
    GROUP BY eligible.normalized_voyage_id, links.plan_voyage_id
    ORDER BY max(eligible.timestamp) DESC, eligible.normalized_voyage_id ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ)
    TO service_role;

COMMENT ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ) IS
    'Service-role-only compact catalogue of a public voyage-log owner''s recorded trips. p_since preserves the configured public history window.';
