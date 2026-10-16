-- REVIEW PACKET ONLY. Never include in a normal migration push or execute in tests.
-- Preconditions: reviewed migration, all three exact Edge bundles + sender guard
-- read back, vessel-position publisher/registration completed, provider licence /
-- entitlement verified, disposable PostgreSQL concurrency proof, bounded rollout.
-- Entitlement/delivery fields are intentionally NOT populated by this script.
-- Source-only or a present key is not entitlement. No job is resumed automatically.
DO $held$
DECLARE item record;
BEGIN
    IF current_setting('thalassa.activate_weather_watch',true) IS DISTINCT FROM 'reviewed-137' THEN
        RAISE EXCEPTION 'Held weather watch: deployment review required';
    END IF;
    IF to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'Existing Vault invocation helper required';
    END IF;
    IF to_regprocedure('public.weather_position_telemetry(uuid,text,jsonb,text)') IS NULL THEN
        RAISE EXCEPTION 'Reviewed vessel-bound position backend required';
    END IF;
    IF EXISTS(SELECT 1 FROM private_weather_watch.weather_watch_health WHERE delivery_version<>1 OR entitlement_until IS NULL OR entitlement_until<=now()) THEN
        RAISE EXCEPTION 'Reviewed sender and entitlement proof required';
    END IF;
    FOR item IN SELECT * FROM (VALUES
        -- Quarter-hour UTC cadence also reaches :00 in half/quarter-hour zones.
        -- Each boat is evaluated only in the first ten minutes of its chosen hour;
        -- a local-date unique claim prevents repeats across DST's repeated hour.
        ('morning-briefing','*/15 * * * *'),
        ('nowcast-watch','*/5 * * * *'),
        ('convective-watch','*/30 * * * *')
    ) AS jobs(name,schedule) LOOP
        IF EXISTS(SELECT 1 FROM cron.job WHERE jobname=item.name) THEN
            RAISE EXCEPTION 'Existing job % requires explicit comparison; left untouched',item.name;
        END IF;
        PERFORM cron.schedule(item.name,item.schedule,format('SELECT public.invoke_edge_function(%L, 55000)',item.name));
    END LOOP;
END $held$;
-- Rollback (only these reviewed jobs): cron.alter_job(job_id, active := false).
-- Then zero their delivery_version/entitlement leases; queued rows fail the
-- sender's per-attempt guard. Preserve own settings for review, never auto-rearm.
