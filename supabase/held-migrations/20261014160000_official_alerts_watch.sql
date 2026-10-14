-- Official warnings at the boat: the watcher's deliveries, its point match,
-- its status call and its cron job (2026-10-14, build 129, package 129-06).
--
-- HELD. Written with 129, NOT pushed: supabase db push applies every pending
-- file in supabase/migrations, and this one needs 129-05's
-- 20261014150000_official_alerts.sql (held too) and waits until Shane has
-- deployed send-push (the official_warning type) and official-alerts-watch.
-- Release both by moving them into supabase/migrations under stamps newer
-- than the newest applied migration, this one after 129-05's, and, in the
-- same commit, rewriting tests/OfficialAlertsWatchMigration.test.ts (and
-- 129-05's tests/OfficialAlertsMigration.test.ts) to read the released files
-- and assert the held copies are gone; then push. Until this runs, nothing
-- answers official_alerts_watch_status(), so the app keeps "Official marine
-- warnings at the boat" hidden: no switch is offered that nothing honours.
--
-- Why a watcher of its own, not a step after the ingest
-- ─────────────────────────────────────────────────────
-- ingest-official-alerts reads public feeds only, sharded and bounded in
-- time (ECCC stops 10 s before its 45 s limit); the watcher reads accounts,
-- devices and boat positions. Apart, a slow issuer never delays a push, a
-- failing push path never stalls the ingest, the ingest never touches user
-- data, and each says "unavailable" on its own. It is cyclone-watch's shape
-- (129-09), on its own cron two minutes after each ingest run.
--
-- What
-- ────
-- * official_alert_deliveries (129-05's table, user-keyed, behind the
--   account-deletion fence, ON DELETE CASCADE with the account and the alert)
--   gains what the watcher needs to send each warning once per account and to
--   treat its updates as one notification: provider_id, identifier and refs
--   (the CAP references, to find a chain), chain_key (the collapse id is
--   provider:chain_key; NWS's is its VTEC event), severity (what that
--   message told the account: an update buzzes again only when it rises
--   above the last one told) and silent (an update sent without a sound).
--   No position is stored.
-- * official_alerts_watch_match(points jsonb): for up to 2000 points
--   [{k, lat, lon}], one row per point with a warning in force there,
--   (k, alert_ids): by the warning's own polygon, else by a zone it names
--   whose shape holds the point, as official_alerts_at() matches, and a
--   marine warning within 3 NM (below); enabled providers only; withdrawn
--   and expired never. One row per point, not per (point, warning): the
--   watcher asks 500 points a call, and PostgREST's max_rows (1000) would
--   silently cut a per-warning reply in a busy hurricane. Service role
--   only: the points are boat positions and are neither stored nor logged.
--
-- A marine warning reaches 3 NM past its shape (as official_alerts_at)
-- ────────────────────────────────────────────────────────────────────
-- NWS's marine zones end where the open water does. Measured against the
-- api.weather.gov shapes on 2026-10-14: an Annapolis Back Creek marina is
-- 0.13 NM outside ANZ532, the Spa Creek moorings 0.56, City Dock 0.64, the
-- Severn off the Naval Academy 0.45, a home port saved as downtown Annapolis
-- 0.94, and Baltimore's Inner Harbor 0.02 NM outside ANZ538. Each is in a
-- land zone only (MDZ014, MDZ011), so an exact match never told a boat at
-- its berth, or placed by its home port, of the gale outside. So a zone
-- with NWS's marine letters (AM, AN, GM, PZ, PK, PH, PM, PS, LM, LS, LH, LO,
-- LE, LC, SL: classify.ts's NWS_MARINE_ZONE_AREAS) matches within 3 NM
-- (5556 m on the sphere, after a box test the GiST index answers), and so
-- does the polygon of an NWS warning that names marine zones only (a
-- Special Marine Warning, clipped to the water). 3 NM reaches every berth
-- above and not the next zone up the bay (ANZ531, 4.3 NM and more from
-- them). Land zones and land polygons still match exactly.
-- MeteoAlarm (129-05b) reaches 3 NM too, as official_alerts_at does: its
-- EMMA_ID outlines are land areas, so a berth or a boat just off the coast is
-- outside every one, and its own polygons (MET Norway's sea areas, Estonia's
-- harbours) reach the boat beside them.
-- * official_alerts_watch_status: one row, written at the end of every run
--   (when it ran, boats, pushes, held, failed). Service role only.
-- * official_alerts_watch_status(): what the app reads to decide whether to
--   show the switches: ran_at, nothing else. Signed-in callers only; SECURITY
--   DEFINER with a pinned search_path.
-- * The 'official-alerts-watch' cron job, every 5 min at :04, :09, ... :59,
--   two minutes after each ingest (2-59/5) and clear of check-weather-alerts
--   (:00, :30) and cyclone-watch (:10, :40), on the vault credential path:
--       SELECT public.invoke_edge_function('official-alerts-watch', 120000)
--   By state of cron.job (the 20261009075000 shore-watch pattern): an exact
--   active job is left alone, a paused one is left paused, any other is
--   replaced. No other job is read or changed.
--
-- Indexes (EXPLAIN reasoning; to be confirmed by EXPLAIN in the rehearsal)
-- ──────────────────────────────────────────────────────────────────────────
-- * The match reads 129-05's indexes: official_alerts_live_geom (GiST, WHERE
--   withdrawn_at IS NULL) for ST_Intersects(a.geom, point), the predicate
--   repeated so the partial index applies, a BitmapOr with the point one turn
--   east, and for the marine reach's && box before the ST_DWithin on the
--   sphere; official_alert_zones_geom (GiST) for the zones holding a point,
--   and the marine zones whose box comes within 3 NM;
--   official_alerts_live_zones (GIN, same partial predicate) for zones @>
--   ARRAY[code]. A nested loop over a few hundred boat points, each a few
--   index probes, against a few thousand live alerts on a busy US day.
-- * Deliveries are read per account: the primary key (user_id, alert_id,
--   channel) leads with user_id. No new index.
--
-- Undo
-- ────
--     SELECT cron.unschedule('official-alerts-watch');
--     DROP FUNCTION IF EXISTS public.official_alerts_watch_status();
--     DROP FUNCTION IF EXISTS public.official_alerts_watch_match(jsonb);
--     DROP TABLE IF EXISTS public.official_alerts_watch_status;
--     ALTER TABLE public.official_alert_deliveries
--         DROP COLUMN IF EXISTS provider_id, DROP COLUMN IF EXISTS identifier,
--         DROP COLUMN IF EXISTS refs, DROP COLUMN IF EXISTS chain_key,
--         DROP COLUMN IF EXISTS severity, DROP COLUMN IF EXISTS silent;
-- (the app then hides the switches again, as the status call no longer answers).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op, then confirms cron.job is back
-- to its prior state. lock_timeout and search_path are set for the session
-- and reset at the end.

SET lock_timeout = '5s';
SET search_path = pg_catalog, public, extensions;

DO $precheck$
BEGIN
    IF to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'official_alerts_watch: invoke_edge_function(text, integer, jsonb) is missing';
    END IF;
    IF to_regclass('public.official_alert_deliveries') IS NULL
        OR to_regclass('public.official_alerts') IS NULL
        OR to_regclass('public.official_alert_zones') IS NULL
        OR to_regclass('public.official_alert_providers') IS NULL THEN
        RAISE EXCEPTION 'official_alerts_watch: 129-05''s official alerts tables are missing; apply 20261014150000 first';
    END IF;
    IF to_regprocedure('public.official_alerts_at(double precision,double precision)') IS NULL THEN
        RAISE EXCEPTION 'official_alerts_watch: official_alerts_at() is missing; apply 20261014150000 first';
    END IF;
    IF to_regnamespace('cron') IS NULL THEN
        RAISE EXCEPTION 'official_alerts_watch: pg_cron (schema cron) is missing';
    END IF;
END;
$precheck$;

-- ── Deliveries: the chain, its strongest severity, and the quiet flag ────

ALTER TABLE public.official_alert_deliveries
    ADD COLUMN IF NOT EXISTS provider_id TEXT CHECK (provider_id IS NULL OR provider_id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
    ADD COLUMN IF NOT EXISTS identifier TEXT CHECK (identifier IS NULL OR length(identifier) BETWEEN 1 AND 300),
    ADD COLUMN IF NOT EXISTS refs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(refs) <= 500),
    ADD COLUMN IF NOT EXISTS chain_key TEXT CHECK (chain_key IS NULL OR chain_key ~ '^[0-9a-f]{16}$'),
    ADD COLUMN IF NOT EXISTS severity TEXT
        CHECK (severity IS NULL OR severity IN ('Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown')),
    ADD COLUMN IF NOT EXISTS silent BOOLEAN NOT NULL DEFAULT false;

-- ── Status: when the watcher last ran ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.official_alerts_watch_status (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    ran_at TIMESTAMPTZ NOT NULL,
    boats INTEGER,
    pushes INTEGER,
    held INTEGER,
    failed INTEGER
);

ALTER TABLE public.official_alerts_watch_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_alerts_watch_status FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_alerts_watch_status TO service_role;

CREATE OR REPLACE FUNCTION public.official_alerts_watch_status()
RETURNS TABLE (ran_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT s.ran_at FROM public.official_alerts_watch_status AS s WHERE s.id = 1;
$$;

REVOKE ALL ON FUNCTION public.official_alerts_watch_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.official_alerts_watch_status() TO authenticated;

-- ── The point match, with PostGIS qualified by its schema (as 129-05) ────

DO $functions$
DECLARE
    gis name;
BEGIN
    SELECT n.nspname INTO STRICT gis
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'postgis' AND n.nspname IN ('public', 'extensions');

    EXECUTE format($definition$
CREATE OR REPLACE FUNCTION public.official_alerts_watch_match(p_points jsonb)
RETURNS TABLE (k integer, alert_ids bigint[])
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $fn$
    WITH raw AS (
        SELECT e.value AS v
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_points) = 'array' THEN p_points ELSE '[]'::jsonb END) AS e
         LIMIT 2000
    ), nums AS (
        -- Each cast only where the value is a JSON number, so nothing else can raise.
        SELECT CASE WHEN jsonb_typeof(raw.v->'k') = 'number' THEN (raw.v->>'k')::numeric END AS kn,
               CASE WHEN jsonb_typeof(raw.v->'lat') = 'number' THEN (raw.v->>'lat')::double precision END AS lat,
               CASE WHEN jsonb_typeof(raw.v->'lon') = 'number' THEN (raw.v->>'lon')::double precision END AS lon
          FROM raw
    ), pts AS (
        SELECT CASE WHEN nums.kn = trunc(nums.kn) AND abs(nums.kn) < 1000000 THEN nums.kn::integer END AS pk,
               %1$I.ST_SetSRID(%1$I.ST_MakePoint(nums.lon, nums.lat), 4326) AS pt,
               -- The same point one turn east: a shape across 180 degrees is stored continuous (lon 179..181).
               %1$I.ST_SetSRID(%1$I.ST_MakePoint(nums.lon + 360, nums.lat), 4326) AS pt_east,
               -- The marine reach, 3 NM, as a box in degrees for the index (a nautical mile is a minute of latitude).
               3.0 / 60 / greatest(cos(radians(nums.lat)), 0.02) AS dx,
               3.0 / 60 AS dy
          FROM nums
         WHERE nums.kn IS NOT NULL
           AND nums.lat BETWEEN -90 AND 90
           AND nums.lon BETWEEN -180 AND 180
    ), hits AS (
        -- By the warning's own polygon.
        SELECT pts.pk, a.id
          FROM pts
          JOIN public.official_alerts AS a
            ON pts.pk IS NOT NULL
           AND a.withdrawn_at IS NULL
           AND (%1$I.ST_Intersects(a.geom, pts.pt) OR %1$I.ST_Intersects(a.geom, pts.pt_east))
        UNION
        -- An NWS marine warning's polygon (one naming marine zones only), or a MeteoAlarm one, within 3 NM.
        SELECT pts.pk, a.id
          FROM pts
          JOIN public.official_alerts AS a
            ON pts.pk IS NOT NULL
           AND a.withdrawn_at IS NULL
           AND (a.geom && %1$I.ST_Expand(pts.pt, pts.dx, pts.dy) OR a.geom && %1$I.ST_Expand(pts.pt_east, pts.dx, pts.dy))
           AND ((a.provider_id = 'nws'
                 AND cardinality(a.zones) > 0
                 AND NOT EXISTS (
                     SELECT 1 FROM unnest(a.zones) AS zc(code)
                      WHERE zc.code !~ '^nws:[a-z]+:(AM|AN|GM|PZ|PK|PH|PM|PS|LM|LS|LH|LO|LE|LC|SL)Z[0-9]{3}$'
                 ))
                OR a.provider_id ~ '^meteoalarm-')
           AND %1$I.ST_DWithin(a.geom::%1$I.geography, pts.pt::%1$I.geography, 5556)
        UNION
        -- By a zone it names whose shape holds the point, or an NWS marine zone or MeteoAlarm outline within 3 NM.
        SELECT pts.pk, a.id
          FROM pts
          JOIN public.official_alert_zones AS z
            ON pts.pk IS NOT NULL
           AND (%1$I.ST_Intersects(z.geom, pts.pt) OR %1$I.ST_Intersects(z.geom, pts.pt_east)
                OR ((z.code ~ '^nws:[a-z]+:(AM|AN|GM|PZ|PK|PH|PM|PS|LM|LS|LH|LO|LE|LC|SL)Z[0-9]{3}$' OR z.code ~ '^EMMA_ID:')
                    AND (z.geom && %1$I.ST_Expand(pts.pt, pts.dx, pts.dy)
                         OR z.geom && %1$I.ST_Expand(pts.pt_east, pts.dx, pts.dy))
                    AND %1$I.ST_DWithin(z.geom::%1$I.geography, pts.pt::%1$I.geography, 5556)))
          JOIN public.official_alerts AS a
            ON a.withdrawn_at IS NULL
           AND a.geom IS NULL
           AND a.provider_id = z.provider_id
           AND a.zones @> ARRAY[z.code]
    )
    SELECT hits.pk, array_agg(DISTINCT hits.id ORDER BY hits.id)
      FROM hits
      JOIN public.official_alerts AS a ON a.id = hits.id
      JOIN public.official_alert_providers AS p ON p.id = a.provider_id AND p.enabled
     WHERE a.expires_at IS NULL OR a.expires_at > now()
     GROUP BY hits.pk;
$fn$;
    $definition$, gis);
END;
$functions$;

REVOKE ALL ON FUNCTION public.official_alerts_watch_match(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.official_alerts_watch_match(jsonb) TO service_role;

-- ── The cron job (the shore-watch pattern, as 20261014120000) ───────────

DO $schedule$
DECLARE
    job_name CONSTANT TEXT := 'official-alerts-watch';
    want_schedule CONSTANT TEXT := '4-59/5 * * * *';
    want_command CONSTANT TEXT := 'SELECT public.invoke_edge_function(''official-alerts-watch'', 120000)';
    total INTEGER;
    paused INTEGER;
    exact INTEGER;
    existing RECORD;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE NOT active),
           count(*) FILTER (WHERE active
               AND schedule = want_schedule
               AND regexp_replace(btrim(command), '\s+', ' ', 'g') = want_command)
      INTO total, paused, exact
      FROM cron.job
     WHERE jobname = job_name;

    IF paused > 0 THEN
        RAISE NOTICE '% is paused; left paused. Resuming it is a deliberate step, not a migration.', job_name;
        RETURN;
    END IF;

    IF total = 1 AND exact = 1 THEN
        RETURN;
    END IF;

    FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job_name LOOP
        PERFORM cron.unschedule(existing.jobid);
    END LOOP;

    PERFORM cron.schedule(job_name, want_schedule, want_command);
END;
$schedule$;

DO $check$
DECLARE
    total INTEGER;
    declared INTEGER;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE NOT active
               OR (schedule = '4-59/5 * * * *'
                   AND regexp_replace(btrim(command), '\s+', ' ', 'g')
                       = 'SELECT public.invoke_edge_function(''official-alerts-watch'', 120000)'))
      INTO total, declared
      FROM cron.job
     WHERE jobname = 'official-alerts-watch';
    IF total <> 1 OR declared <> 1 THEN
        RAISE EXCEPTION 'official_alerts_watch: expected one official-alerts-watch job at 4-59/5 on invoke_edge_function; found % (% as declared)', total, declared;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.official_alert_deliveries'::regclass
           AND tgname = 'account_deletion_write_fence' AND NOT tgisinternal AND tgenabled <> 'D'
    ) THEN
        RAISE EXCEPTION 'official_alerts_watch: the deliveries lost their account-deletion fence';
    END IF;
END;
$check$;

RESET search_path;
RESET lock_timeout;
