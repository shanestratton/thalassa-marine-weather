-- ============================================================
-- Anchor Watch Push Notifications — Supabase Schema Migration
-- ============================================================
-- Run this SQL in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/pcisdplnodrphauixcau/sql
-- ============================================================

-- Store push tokens for shore devices in active Shore Watch sessions
CREATE TABLE IF NOT EXISTS anchor_alarm_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_code TEXT NOT NULL,
    device_token TEXT NOT NULL,
    platform TEXT DEFAULT 'ios',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(session_code, device_token)
);

-- Alarm events that trigger push notifications to shore devices
CREATE TABLE IF NOT EXISTS anchor_alarm_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_code TEXT NOT NULL,
    distance_m REAL NOT NULL,
    swing_radius_m REAL NOT NULL,
    vessel_lat REAL,
    vessel_lon REAL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast token lookups by session
CREATE INDEX IF NOT EXISTS idx_alarm_tokens_session ON anchor_alarm_tokens(session_code);

-- Index for recent alarm events
CREATE INDEX IF NOT EXISTS idx_alarm_events_session ON anchor_alarm_events(session_code);

-- Enable RLS
ALTER TABLE anchor_alarm_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_alarm_events ENABLE ROW LEVEL SECURITY;

-- Allow anonymous inserts/deletes (app uses anon key)
CREATE POLICY "Allow anon insert tokens" ON anchor_alarm_tokens FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon delete own tokens" ON anchor_alarm_tokens FOR DELETE USING (true);
CREATE POLICY "Allow anon select tokens" ON anchor_alarm_tokens FOR SELECT USING (true);

CREATE POLICY "Allow anon insert alarms" ON anchor_alarm_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon select alarms" ON anchor_alarm_events FOR SELECT USING (true);

-- Auto-cleanup: delete old tokens after 24 hours (optional cron job)
-- You can set this up via Supabase pg_cron:
-- SELECT cron.schedule('cleanup-old-tokens', '0 * * * *', $$
--     DELETE FROM anchor_alarm_tokens WHERE created_at < now() - interval '24 hours';
--     DELETE FROM anchor_alarm_events WHERE created_at < now() - interval '24 hours';
-- $$);
