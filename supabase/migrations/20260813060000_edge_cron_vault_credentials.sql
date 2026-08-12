-- ═══════════════════════════════════════════════════════════════════════
-- Scheduled edge-function calls: one credential path, and LOUD failure
-- ═══════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-13 while chasing why 416,718 stale AIS vessels were never
-- swept. cron.job_run_details told the real story:
--
--     sweep-stale-ais-vessels | failed | ERROR: schema "net" does not exist
--
-- Two independent faults, both invisible from the app:
--
--   1. pg_net was never enabled, so EVERY scheduled job that calls an edge
--      function has been failing since the day it was scheduled — the AIS
--      sweep, weather alerts, vessel-metadata scraping and the marketplace
--      escrow sweep.
--
--   2. Neither credential source existed. `current_setting(
--      'app.settings.supabase_url')` is NULL and vault.decrypted_secrets
--      holds no 'supabase_url'/'service_role_key' rows. So even with pg_net
--      installed, all four jobs would still fail on the next line.
--
-- The push paths (push_queue_trigger, retry_pending_push_notifications,
-- retry_pending_anchor_alarms) already read Vault first and fall back to
-- current_setting. These four cron bodies never got that treatment — they
-- inlined current_setting directly. This migration gives all of them one
-- credential path via a single helper, so there is one place to fix the day
-- a key rotates.
--
-- DELIBERATELY LOUD. The push functions `RETURN` silently when credentials
-- are missing, which is how this hid for months: the job reports success
-- while doing nothing. The helper below RAISES instead, so a missing secret
-- shows up as 'failed' in cron.job_run_details with a message that names the
-- fix. A scheduled job that cannot do its work must not report success.
--
-- REQUIRES, before any of this does anything (see the accompanying notes):
--   select vault.create_secret('https://<project>.supabase.co', 'supabase_url');
--   select vault.create_secret('<service role key>',            'service_role_key');

-- ── 1. pg_net ──────────────────────────────────────────────────────────
-- Guarded: on a role without permission to create extensions this leaves a
-- warning rather than failing the whole migration. The Dashboard toggle
-- (Database → Extensions → pg_net) is the supported path and is idempotent
-- with this.
DO $$
BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_net';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'pg_net could not be created here — enable it from Database → Extensions';
END;
$$;

-- ── 2. One credential path for every scheduled edge-function call ──────
CREATE OR REPLACE FUNCTION public.invoke_edge_function(
    function_name TEXT,
    timeout_ms INTEGER DEFAULT 30000,
    payload JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
    supabase_url TEXT;
    service_key TEXT;
BEGIN
    IF function_name IS NULL OR function_name !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
        RAISE EXCEPTION 'invoke_edge_function: refusing to build a URL from %', function_name;
    END IF;

    SELECT decrypted_secret INTO supabase_url
    FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

    IF supabase_url IS NULL OR supabase_url = '' THEN
        supabase_url := current_setting('app.settings.supabase_url', true);
    END IF;
    IF service_key IS NULL OR service_key = '' THEN
        service_key := current_setting('app.settings.service_role_key', true);
    END IF;

    IF supabase_url IS NULL OR supabase_url = '' OR service_key IS NULL OR service_key = '' THEN
        RAISE EXCEPTION
            'invoke_edge_function(%): no supabase_url/service_role_key in vault.decrypted_secrets or app.settings — create them with vault.create_secret()',
            function_name;
    END IF;

    PERFORM net.http_post(
        url := rtrim(supabase_url, '/') || '/functions/v1/' || function_name,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
        body := COALESCE(payload, '{}'::JSONB),
        timeout_milliseconds := timeout_ms
    );
END;
$$;

-- It mints service-role-authenticated calls: nobody but the scheduler.
REVOKE ALL ON FUNCTION public.invoke_edge_function(TEXT, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;

-- ── 3. Repoint the jobs at the helper ──────────────────────────────────
-- The job name is NOT the function name for two of these — 'sweep-stale-
-- ais-vessels' posts to 'sweep-stale-vessels'. Carried as separate columns
-- so nobody re-derives one from the other and quietly 404s a sweep.
--
-- Schedules preserved exactly. Timeouts preserved where declared;
-- check-weather-alerts never declared one, so it inherited pg_net's short
-- default — it now gets the same 150 s ceiling the other edge calls use.
--
-- DELIBERATELY NOT INCLUDED: 'sweep-expired-marketplace-escrows'
-- (*/5 * * * *), which posts to 'sweep-expired-escrows'. No such function
-- exists under supabase/functions/, so it has been POSTing into a 404 every
-- five minutes. Left exactly as it is rather than re-blessed here: whether
-- the function needs deploying or the job needs unscheduling is a
-- marketplace decision, not a credentials one — and net.http_post does not
-- raise on a 404, so wiring it to the loud helper would not surface it.

DO $$
DECLARE
    job RECORD;
BEGIN
    FOR job IN
        SELECT * FROM (VALUES
            ('check-weather-alerts',    'check-weather-alerts',   '*/30 * * * *', 150000),
            ('scrape-vessel-metadata',  'scrape-vessel-metadata', '*/15 * * * *', 150000),
            ('sweep-stale-ais-vessels', 'sweep-stale-vessels',    '17 */6 * * *',  30000)
        ) AS t(jobname, function_name, schedule, timeout_ms)
    LOOP
        BEGIN
            PERFORM cron.unschedule(job.jobname);
        EXCEPTION
            WHEN OTHERS THEN NULL;
        END;

        PERFORM cron.schedule(
            job.jobname,
            job.schedule,
            format(
                'SELECT public.invoke_edge_function(%L, %s)',
                job.function_name,
                job.timeout_ms
            )
        );
    END LOOP;
END;
$$;
