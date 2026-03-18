-- ============================================================================
-- Guardian Watchdog RPCs — Distance checks for BOLO + Geofence
--
-- Used by the Railway Watchdog process to check if armed vessels
-- have moved beyond their thresholds.
-- ============================================================================

-- ── BOLO Distance Check ──
-- Returns distance in meters between a vessel's current AIS position
-- and its armed_location in guardian_profiles.
CREATE OR REPLACE FUNCTION public.check_bolo_distance(
    vessel_mmsi BIGINT
)
RETURNS DOUBLE PRECISION
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT ST_Distance(
        gp.armed_location,
        v.location
    )
    FROM public.guardian_profiles gp
    JOIN public.vessels v ON v.mmsi = gp.mmsi
    WHERE gp.mmsi = vessel_mmsi
      AND gp.armed = true
      AND gp.armed_location IS NOT NULL
      AND v.location IS NOT NULL
    LIMIT 1;
$$;

-- ── Geofence Distance Check ──
-- Returns distance in meters between a vessel's current AIS position
-- and its home_coordinate in guardian_profiles.
CREATE OR REPLACE FUNCTION public.check_geofence_distance(
    vessel_mmsi BIGINT
)
RETURNS DOUBLE PRECISION
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT ST_Distance(
        gp.home_coordinate,
        v.location
    )
    FROM public.guardian_profiles gp
    JOIN public.vessels v ON v.mmsi = gp.mmsi
    WHERE gp.mmsi = vessel_mmsi
      AND gp.home_coordinate IS NOT NULL
      AND v.location IS NOT NULL
    LIMIT 1;
$$;

-- ── Cleanup cron: Remove alerts older than 7 days ──
SELECT cron.schedule(
    'sweep-old-guardian-alerts',
    '0 3 * * *',  -- 3 AM daily
    $$DELETE FROM public.guardian_alerts WHERE created_at < NOW() - INTERVAL '7 days'$$
);
