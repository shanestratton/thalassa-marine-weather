-- ═══════════════════════════════════════════════════════════════
-- Voyage Log telemetry — richer ship_log columns
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Adds the wind / heading / depth / temperature columns the public
-- Voyage Log telemetry panel needs, fed by the Bosun Pi ping from
-- SignalK. Every statement is ADD COLUMN IF NOT EXISTS — idempotent,
-- and it also re-asserts the base columns the voyage-log pipeline
-- depends on, so a partially-applied ship_log migration can't leave
-- the pipeline silently broken (see the audio_url incident).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.ship_log
    -- Base columns the voyage-log pipeline reads/writes (re-asserted defensively)
    ADD COLUMN IF NOT EXISTS speed_kts            DECIMAL(5, 1),
    ADD COLUMN IF NOT EXISTS course_deg           INTEGER,
    ADD COLUMN IF NOT EXISTS pressure             INTEGER,
    ADD COLUMN IF NOT EXISTS wind_speed           DECIMAL(5, 1),
    ADD COLUMN IF NOT EXISTS wind_direction       VARCHAR(3),
    ADD COLUMN IF NOT EXISTS wave_height          DECIMAL(4, 1),
    ADD COLUMN IF NOT EXISTS air_temp             INTEGER,
    ADD COLUMN IF NOT EXISTS water_temp           INTEGER,
    ADD COLUMN IF NOT EXISTS entry_type           VARCHAR(10) NOT NULL DEFAULT 'auto',

    -- New telemetry columns — sourced from SignalK by the Pi ping
    ADD COLUMN IF NOT EXISTS heading_deg          INTEGER,        -- vessel heading (true), distinct from COG
    ADD COLUMN IF NOT EXISTS wind_speed_apparent  DECIMAL(5, 1),  -- AWS, knots
    ADD COLUMN IF NOT EXISTS wind_angle_apparent  INTEGER,        -- AWA, degrees relative to bow (-180..180)
    ADD COLUMN IF NOT EXISTS wind_speed_true      DECIMAL(5, 1),  -- TWS, knots
    ADD COLUMN IF NOT EXISTS wind_direction_true  INTEGER,        -- TWD, degrees true (0..359)
    ADD COLUMN IF NOT EXISTS depth_m              DECIMAL(6, 1);  -- depth below transducer, metres

COMMENT ON COLUMN public.ship_log.wind_angle_apparent IS
    'Apparent wind angle in degrees relative to the bow: negative = port, positive = starboard.';
COMMENT ON COLUMN public.ship_log.wind_direction_true IS
    'True wind direction in degrees (0–359, the compass direction the wind blows FROM).';
