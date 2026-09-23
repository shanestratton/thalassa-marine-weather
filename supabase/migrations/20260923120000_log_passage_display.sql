-- Passage display membership and historical GPS departure estimates.
-- Raw logs and public followed-route links are not changed.
BEGIN;
CREATE TABLE public.log_passage_memberships (
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id text NOT NULL,
    passage_group_id text NOT NULL CHECK (length(passage_group_id) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, voyage_id)
);
ALTER TABLE public.log_passage_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY log_passage_memberships_owner ON public.log_passage_memberships
    FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
REVOKE ALL ON public.log_passage_memberships FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.log_passage_memberships TO authenticated;
GRANT ALL ON public.log_passage_memberships TO service_role;

DROP FUNCTION IF EXISTS public.get_voyage_summaries(boolean);
CREATE FUNCTION public.get_voyage_summaries(p_include_archived BOOLEAN DEFAULT false)
RETURNS TABLE (
    voyage_id TEXT, entry_count BIGINT, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
    total_distance_nm DOUBLE PRECISION, avg_speed_kts DOUBLE PRECISION,
    has_manual BOOLEAN, is_planned_route BOOLEAN, is_imported BOOLEAN,
    first_lat DOUBLE PRECISION, first_lon DOUBLE PRECISION,
    last_lat DOUBLE PRECISION, last_lon DOUBLE PRECISION, first_is_on_water BOOLEAN,
    land_fraction DOUBLE PRECISION, min_lat DOUBLE PRECISION, max_lat DOUBLE PRECISION,
    min_lon DOUBLE PRECISION, max_lon DOUBLE PRECISION, departed_at TIMESTAMPTZ,
    passage_group_id TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
    WITH visible AS MATERIALIZED (
        SELECT logs.*, coalesce(nullif(logs.voyage_id, ''), 'default_voyage') AS vid
        FROM public.ship_logs logs
        WHERE logs.user_id = auth.uid()
          AND (p_include_archived OR logs.archived IS NULL OR logs.archived = false)
    ), unique_fixes AS (
        SELECT DISTINCT ON (vid, timestamp) *,
            coalesce(speed_kts BETWEEN 0.8 AND 80
                AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
                AND NOT (latitude = 0 AND longitude = 0), false) AS moving
        FROM visible ORDER BY vid, timestamp, id
    ), previous AS (
        SELECT *, lag(timestamp) OVER w AS prev_time, lag(moving) OVER w AS prev_moving
        FROM unique_fixes WINDOW w AS (PARTITION BY vid ORDER BY timestamp)
    ), groups AS (
        SELECT *, sum(CASE WHEN NOT moving OR NOT coalesce(prev_moving, false)
                          OR timestamp - prev_time > interval '20 minutes' THEN 1 ELSE 0 END)
                   OVER (PARTITION BY vid ORDER BY timestamp) AS run
        FROM previous
    ), runs AS (
        SELECT *, row_number() OVER w AS sample_n,
            first_value(timestamp) OVER w AS run_start,
            first_value(latitude) OVER w AS run_lat,
            first_value(longitude) OVER w AS run_lon,
            first_value(cumulative_distance_nm) OVER w AS run_distance
        FROM groups WHERE moving
        WINDOW w AS (PARTITION BY vid, run ORDER BY timestamp)
    ), departures AS (
        SELECT vid, min(run_start) AS departed_at FROM runs
        WHERE sample_n >= 3 AND timestamp - run_start >= interval '30 seconds'
          AND (run_distance IS NULL OR cumulative_distance_nm IS NULL OR cumulative_distance_nm > run_distance)
          AND 2 * 6371000 * asin(sqrt(least(1.0,
              power(sin(radians(latitude - run_lat) / 2), 2)
              + cos(radians(run_lat)) * cos(radians(latitude))
              * power(sin(radians(longitude - run_lon) / 2), 2)))) >= 30
        GROUP BY vid
    )
    , summaries AS (
    SELECT logs.vid, count(*) AS entry_count, min(logs.timestamp) AS started_at, max(logs.timestamp) AS ended_at,
        max(coalesce(logs.cumulative_distance_nm, 0)),
        avg(logs.speed_kts) FILTER (WHERE logs.speed_kts > 0),
        bool_or(logs.entry_type = 'manual'), bool_or(logs.source = 'planned_route'),
        bool_or(logs.source IS NOT NULL AND logs.source NOT IN ('device', 'planned_route')),
        (array_agg(logs.latitude ORDER BY logs.timestamp ASC))[1],
        (array_agg(logs.longitude ORDER BY logs.timestamp ASC))[1],
        (array_agg(logs.latitude ORDER BY logs.timestamp DESC))[1],
        (array_agg(logs.longitude ORDER BY logs.timestamp DESC))[1],
        (array_agg(logs.is_on_water ORDER BY logs.timestamp ASC))[1],
        (count(*) FILTER (WHERE logs.is_on_water = false))::double precision
            / NULLIF(count(*) FILTER (WHERE logs.is_on_water IS NOT NULL), 0),
        min(logs.latitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)),
        max(logs.latitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)),
        min(logs.longitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)),
        max(logs.longitude) FILTER (WHERE NOT (logs.latitude = 0 AND logs.longitude = 0)),
        CASE WHEN bool_or(logs.source IS NOT NULL AND logs.source <> 'device')
             THEN min(logs.timestamp)
             ELSE coalesce(min(departures.departed_at),
                 CASE WHEN min(logs.timestamp) < timestamptz '2026-09-23T00:00:00Z'
                      THEN min(logs.timestamp) END) END
    FROM visible logs LEFT JOIN departures ON departures.vid = logs.vid
    GROUP BY logs.vid
    ), route_refs AS (
        SELECT DISTINCT vid, saved_route_id AS route_ref FROM visible WHERE saved_route_id IS NOT NULL
        UNION
        SELECT links.voyage_id, links.plan_voyage_id FROM public.voyage_plan_links links
        JOIN summaries s ON s.vid = links.voyage_id WHERE links.user_id = auth.uid()
    ), linked_passages AS (
        SELECT refs.vid, min(routes.trip_id) AS passage_group_id FROM route_refs refs
        JOIN public.saved_routes routes ON routes.user_id = auth.uid()
            AND (routes.id = refs.route_ref OR routes.planned_route_id = refs.route_ref
                 OR routes.passage_voyage_id::text = refs.route_ref)
        WHERE routes.deleted = false AND routes.trip_id IS NOT NULL
        GROUP BY refs.vid HAVING count(DISTINCT routes.trip_id) = 1
    )
    SELECT s.*, coalesce(m.passage_group_id, linked.passage_group_id)
    FROM summaries s
    LEFT JOIN public.log_passage_memberships m ON m.user_id = auth.uid() AND m.voyage_id = s.vid
    LEFT JOIN linked_passages linked ON linked.vid = s.vid
    ORDER BY s.ended_at DESC;
$$;
REVOKE ALL ON FUNCTION public.get_voyage_summaries(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_voyage_summaries(boolean) TO authenticated;
COMMIT;
