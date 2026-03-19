-- ============================================================
-- Weather Alert Cron — Dedup log + pg_cron schedule
-- ============================================================

-- 1. Dedup table — prevents spamming same alert within cooldown window
CREATE TABLE IF NOT EXISTS weather_alerts_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,       -- 'wind', 'gusts', 'waves', etc.
    alert_key TEXT NOT NULL,        -- 'wind-45kts-2026-03-19' (unique per day)
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_weather_alerts_log_user
    ON weather_alerts_log(user_id);

CREATE INDEX IF NOT EXISTS idx_weather_alerts_log_created
    ON weather_alerts_log(created_at);

-- Enable RLS
ALTER TABLE weather_alerts_log ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (cron runs as service role)
CREATE POLICY "Service role full access" ON weather_alerts_log
    FOR ALL USING (true) WITH CHECK (true);

-- 2. Cleanup old dedup entries (older than 24 hours)
SELECT cron.schedule(
    'cleanup-weather-alerts-log',
    '0 */6 * * *',  -- every 6 hours
    $$DELETE FROM weather_alerts_log WHERE created_at < now() - interval '24 hours'$$
);

-- 3. Schedule the weather check cron (every 30 minutes)
-- The edge function is invoked via pg_net HTTP extension
SELECT cron.schedule(
    'check-weather-alerts',
    '*/30 * * * *',
    $$
    SELECT net.http_post(
        url := current_setting('app.settings.supabase_url') || '/functions/v1/check-weather-alerts',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
        ),
        body := '{}'::jsonb
    );
    $$
);
