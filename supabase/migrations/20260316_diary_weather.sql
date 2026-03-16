-- ═══════════════════════════════════════════════════════════════
-- Diary Weather Data — Supabase Migration
-- Adds structured weather JSONB column for pin-drop weather capture
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.diary_entries
ADD COLUMN IF NOT EXISTS weather_data JSONB DEFAULT NULL;

-- weather_data stores structured weather at the pin-drop location:
-- {
--   "description": "Partly Cloudy",
--   "airTemp": 22.5,
--   "seaTemp": 19.0,
--   "windSpeed": 15,
--   "windDir": "NNE",
--   "humidity": 68,
--   "rain": 0.0
-- }

COMMENT ON COLUMN public.diary_entries.weather_data IS
    'Structured weather snapshot at pin-drop location (JSONB). Fields: description, airTemp, seaTemp, windSpeed, windDir, humidity, rain.';
