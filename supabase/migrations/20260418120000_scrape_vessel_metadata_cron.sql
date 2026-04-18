-- ============================================================
-- Scrape vessel metadata — pg_cron schedule
-- ============================================================
-- Replaces the Railway-hosted vessel-scraper worker. Invokes the
-- scrape-vessel-metadata edge function every 15 minutes via pg_net.
--
-- Prereqs (already present for the weather-alert cron):
--   - extensions: pg_cron, pg_net
--   - GUCs: app.settings.supabase_url, app.settings.service_role_key
-- ============================================================

SELECT cron.schedule(
    'scrape-vessel-metadata',
    '*/15 * * * *',
    $$
    SELECT net.http_post(
        url := current_setting('app.settings.supabase_url') || '/functions/v1/scrape-vessel-metadata',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
    );
    $$
);
