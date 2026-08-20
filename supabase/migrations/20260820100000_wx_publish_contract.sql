-- The wx → Supabase publishing contract (ruling 2026-08-20: "we are not
-- using tailnet in the final product. the wx server should update supabase
-- which in turn updates the app.")
--
-- Two tables. The wx server (service role) WRITES forecasts; phones READ
-- them. Phones WRITE coarse-cell subscriptions; the wx server READS them to
-- know where to publish. Supabase can never reach the wx server (it lives on
-- a private tailnet), so the flow is push-only by construction.
--
-- Disk discipline (this database is a Micro we recently rescued from 1.8 TB
-- of accidental writes): rows are small point-forecast JSON, the publisher
-- upserts only when a model run actually changed, subscriptions are written
-- only on cell change or 6-hourly, and a sweep retires everything stale.

-- ── Forecasts: one row per (cell, model) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wx_point_forecasts (
    -- 0.25° cell, format 'lat4_lon4' of the SW corner ×100, e.g. '-2725_15300'
    -- (lat -27.25, lon 153.00). Coarse on purpose: weather resolution, and no
    -- precise vessel position ever leaves the phone.
    cell_id text NOT NULL,
    -- Open-Meteo model-domain ids as the app already uses them, plus
    -- 'spitfire'. Not CHECK-constrained: adding a model must be a publisher
    -- deploy, not a migration.
    model text NOT NULL,
    -- When the MODEL RUN was initialised (the forecast's true age) vs when
    -- this row landed. The app's staleness pill reads run_at.
    run_at timestamptz NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    -- Open-Meteo-response-shaped JSON ({current:{...}, hourly:{time:[],...}}),
    -- so the app parses it with the exact code that parses the live API.
    payload jsonb NOT NULL,
    PRIMARY KEY (cell_id, model)
);

ALTER TABLE public.wx_point_forecasts ENABLE ROW LEVEL SECURITY;

-- Weather is not sensitive; anyone with the app may read it.
DROP POLICY IF EXISTS wx_point_forecasts_read ON public.wx_point_forecasts;
CREATE POLICY wx_point_forecasts_read ON public.wx_point_forecasts
    FOR SELECT TO anon, authenticated USING (true);
-- Only the publisher writes (service role bypasses RLS; no client policy).

-- ── Subscriptions: which cells the fleet currently occupies ─────────────
CREATE TABLE IF NOT EXISTS public.wx_subscriptions (
    cell_id text PRIMARY KEY,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wx_subscriptions ENABLE ROW LEVEL SECURITY;

-- Deliberately anonymous: no user id, no precise position — a 0.25° cell is
-- ~25 km. Clients may announce presence in a cell and refresh its timestamp;
-- they may not read the fleet's cells back.
DROP POLICY IF EXISTS wx_subscriptions_announce ON public.wx_subscriptions;
CREATE POLICY wx_subscriptions_announce ON public.wx_subscriptions
    FOR INSERT TO anon, authenticated WITH CHECK (cell_id ~ '^-?\d{1,4}_-?\d{1,5}$');
DROP POLICY IF EXISTS wx_subscriptions_refresh ON public.wx_subscriptions;
CREATE POLICY wx_subscriptions_refresh ON public.wx_subscriptions
    FOR UPDATE TO anon, authenticated
    USING (true) WITH CHECK (cell_id ~ '^-?\d{1,4}_-?\d{1,5}$');

-- ── Sweep: forecasts age out at 48 h, empty cells at 14 days ────────────
CREATE OR REPLACE FUNCTION public.sweep_wx_publish()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    DELETE FROM public.wx_point_forecasts WHERE published_at < now() - interval '48 hours';
    DELETE FROM public.wx_subscriptions  WHERE last_seen_at  < now() - interval '14 days';
$$;
REVOKE ALL ON FUNCTION public.sweep_wx_publish() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('sweep-wx-publish')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-wx-publish');
        PERFORM cron.schedule('sweep-wx-publish', '41 * * * *', 'SELECT public.sweep_wx_publish()');
    END IF;
END;
$$;
