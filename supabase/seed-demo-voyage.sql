-- ═══════════════════════════════════════════════════════════════
-- DEMO VOYAGE — Newport → Nouméa (final approach, ~30 nm out)
--
-- Seeds the Voyage Log with a believable hourly track + live telemetry
-- so the public page has something to show off before the real Pi ping
-- is feeding it. Run in the Supabase SQL Editor.
--
-- End-point chosen to put the boat inside Nouméa's AIS coverage so the
-- map shows nearby shipping. Mid-Coral-Sea was too sparse (3 vessels
-- within 200 nm vs hundreds nearer the harbour approaches).
--
-- Self-contained: re-asserts the ship_log telemetry columns up top, so
-- it works whether or not the telemetry migration has been run.
--
-- To remove the demo later:
--   DELETE FROM public.ship_log WHERE entry_type = 'demo';
-- ═══════════════════════════════════════════════════════════════

-- ── 0. Ensure the telemetry columns exist (idempotent) ─────────
ALTER TABLE public.ship_log
    ADD COLUMN IF NOT EXISTS speed_kts            DECIMAL(5, 1),
    ADD COLUMN IF NOT EXISTS course_deg           INTEGER,
    ADD COLUMN IF NOT EXISTS pressure             INTEGER,
    ADD COLUMN IF NOT EXISTS wave_height          DECIMAL(4, 1),
    ADD COLUMN IF NOT EXISTS air_temp             INTEGER,
    ADD COLUMN IF NOT EXISTS water_temp           INTEGER,
    ADD COLUMN IF NOT EXISTS entry_type           VARCHAR(10) NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS heading_deg          INTEGER,
    ADD COLUMN IF NOT EXISTS wind_speed_apparent  DECIMAL(5, 1),
    ADD COLUMN IF NOT EXISTS wind_angle_apparent  INTEGER,
    ADD COLUMN IF NOT EXISTS wind_speed_true      DECIMAL(5, 1),
    ADD COLUMN IF NOT EXISTS wind_direction_true  INTEGER,
    ADD COLUMN IF NOT EXISTS depth_m              DECIMAL(6, 1);

-- ── 1. Clear any previous demo run ─────────────────────────────
DELETE FROM public.ship_log WHERE entry_type = 'demo';

-- ── 2. The track — 80 hourly fixes, Newport → Nouméa approach ─
-- Linear run from Newport, QLD (-27.16, 153.10) toward the Nouméa
-- approach (~-22.75, 166.45), with a little sine wander for realism.
-- Trade-wind passage: SE'ly breeze, broad reach on starboard, warm water.
INSERT INTO public.ship_log (
    user_id, latitude, longitude, timestamp, entry_type,
    speed_kts, course_deg, heading_deg, pressure,
    wind_speed_apparent, wind_angle_apparent, wind_speed_true, wind_direction_true,
    air_temp, water_temp, wave_height
)
SELECT
    (SELECT owner_id FROM public.voyage_log_configs WHERE handle = 'serene-summer'),
    -27.16 + 4.41 * (g / 80.0) + sin(g / 4.0) * 0.05,                       -- latitude  (Newport → -22.75)
    153.10 + 13.35 * (g / 80.0) + cos(g / 5.0) * 0.06,                      -- longitude (Newport → 166.45)
    now() - ((80 - g) || ' hours')::interval,                              -- hourly, ending now
    'demo',
    round((6.4 + sin(g / 3.0) * 1.0 + random() * 0.6)::numeric, 1),        -- SOG  ~5.5–8 kt
    ((52 + sin(g / 6.0) * 12 + random() * 6)::int) % 360,                  -- COG  ~40–70°
    ((54 + sin(g / 6.0) * 12 + random() * 9)::int) % 360,                  -- HDG  near COG
    round(1016 + sin(g / 12.0) * 7)::int,                                  -- baro 1009–1023, trending
    round((18 + sin(g / 4.0) * 4 + random() * 3)::numeric, 1),             -- AWS  ~13–25 kt
    (108 + sin(g / 5.0) * 22)::int,                                        -- AWA  ~86–130° (stbd)
    round((15 + sin(g / 7.0) * 3 + random() * 2)::numeric, 1),             -- TWS  ~12–20 kt
    ((134 + sin(g / 9.0) * 18)::int) % 360,                                -- TWD  ~116–152° (SE)
    round(24 + sin(g / 8.0) * 2)::int,                                     -- air  ~22–26 °C
    round(26 + sin(g / 10.0) * 1.5)::int,                                  -- sea  ~24–28 °C
    round((1.4 + sin(g / 4.0) * 0.7 + random() * 0.3)::numeric, 1)         -- seas ~0.6–2.5 m
FROM generate_series(1, 80) AS g;

-- ── 3. Drop the diary entries along the route ──────────────────
-- Spreads whatever published entries exist evenly across the passage so
-- their photo/mood markers sit on the track.
WITH ranked AS (
    SELECT
        id,
        row_number() OVER (ORDER BY created_at) AS rn,
        count(*) OVER ()                        AS total
    FROM public.diary_entries
    WHERE user_id = (SELECT owner_id FROM public.voyage_log_configs WHERE handle = 'serene-summer')
)
UPDATE public.diary_entries d
SET latitude      = -27.16 + 4.41 * ((ranked.rn - 0.5) / ranked.total) + 0.07,
    longitude     = 153.10 + 13.35 * ((ranked.rn - 0.5) / ranked.total),
    location_name = CASE
        WHEN ranked.rn = 1            THEN 'Departing Newport, QLD'
        WHEN ranked.rn = ranked.total THEN 'Approaching Nouméa'
        ELSE 'Coral Sea passage'
    END
FROM ranked
WHERE d.id = ranked.id;
