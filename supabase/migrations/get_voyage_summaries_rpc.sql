-- ───────────────────────────────────────────────────────────────────────────
-- get_voyage_summaries() — server-side Ship's Log voyage roll-up
-- ───────────────────────────────────────────────────────────────────────────
--
-- WHY: the Log page used to pull every individual track point (at 1–10 Hz
-- precision capture that is hundreds of thousands of rows) just to render a
-- list of voyage cards. This function does the aggregation in Postgres and
-- returns ONE row per voyage, so the list never downloads individual points.
-- Full per-point detail is lazy-loaded only when the user opens a voyage.
--
-- SECURITY: SECURITY INVOKER + a hard user_id = auth.uid() filter means the
-- function can only ever see the caller's own rows (same guarantee as the
-- table's RLS). No GRANTs beyond authenticated.
--
-- first/last coordinates use the array_agg(... ORDER BY timestamp)[1] trick:
-- aggregate the column ordered ascending → element 1 is the earliest;
-- ordered descending → element 1 is the latest. One pass, no self-join.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_voyage_summaries(p_include_archived boolean DEFAULT false)
RETURNS TABLE (
    voyage_id          text,
    entry_count        bigint,
    started_at         timestamptz,
    ended_at           timestamptz,
    total_distance_nm  double precision,
    avg_speed_kts      double precision,
    has_manual         boolean,
    is_planned_route   boolean,
    is_imported        boolean,
    first_lat          double precision,
    first_lon          double precision,
    last_lat           double precision,
    last_lon           double precision,
    first_is_on_water  boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        voyage_id,
        count(*)                                                            AS entry_count,
        min(timestamp)                                                      AS started_at,
        max(timestamp)                                                      AS ended_at,
        max(coalesce(cumulative_distance_nm, 0))                            AS total_distance_nm,
        avg(speed_kts) FILTER (WHERE speed_kts > 0)                         AS avg_speed_kts,
        bool_or(entry_type = 'manual')                                      AS has_manual,
        bool_or(source = 'planned_route')                                   AS is_planned_route,
        bool_or(source IS NOT NULL
                AND source NOT IN ('device', 'planned_route'))              AS is_imported,
        (array_agg(latitude  ORDER BY timestamp ASC))[1]                    AS first_lat,
        (array_agg(longitude ORDER BY timestamp ASC))[1]                    AS first_lon,
        (array_agg(latitude  ORDER BY timestamp DESC))[1]                   AS last_lat,
        (array_agg(longitude ORDER BY timestamp DESC))[1]                   AS last_lon,
        (array_agg(is_on_water ORDER BY timestamp ASC))[1]                  AS first_is_on_water
    FROM public.ship_logs
    WHERE user_id = auth.uid()
      AND voyage_id IS NOT NULL
      AND (p_include_archived OR archived IS NULL OR archived = false)
    GROUP BY voyage_id
    ORDER BY max(timestamp) DESC;
$$;

-- Callable by signed-in users only.
REVOKE ALL ON FUNCTION public.get_voyage_summaries(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.get_voyage_summaries(boolean) TO authenticated;
