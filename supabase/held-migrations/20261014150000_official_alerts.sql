-- Official warnings, server half (2026-10-14, build 129, package 129-05).
--
-- HELD. Written with 129, NOT pushed: supabase db push applies every pending
-- file in supabase/migrations, and this one waits until Shane has deployed
-- ingest-official-alerts. Release it by moving it into supabase/migrations
-- under a stamp newer than the newest applied migration and, in the same
-- commit, rewriting tests/OfficialAlertsMigration.test.ts to read the
-- released file (the b85cd258d vault-limits release), then push. Until it
-- runs, nothing answers official_alerts_at(), so 129-06 shows nothing.
--
-- What
-- ────
-- * official_alert_providers: one row per issuer feed, with its licence flag
--   (enabled), the reason for it (licence_note, with the URLs read), the
--   attribution its licence requires, a coarse coverage area, and its health:
--   last_success_at, last_error and last_error_at, unavailable_since. The
--   rows are seeded below, each with the flag the 14 Oct decision gave it:
--     nws          ON   (US Government, public domain)
--     eccc         ON   (ECCC Data Server End-use Licence, commercial use with credit)
--     jma          OFF  (its licence allows it: Public Data Terms of Use 1.0,
--                        commercial use with credit; but every JMA warning
--                        names municipalities and sea areas whose outlines are
--                        not loaded yet, so on it could place none of them.
--                        Shane turns it on once the outlines are loaded.)
--     meteoalarm-* ON   (39 countries, under MeteoAlarm's own Terms and
--                        Conditions, which need no registration (129-05b): its
--                        six rules are met, and each row's licence_note says how)
--     bom          OFF  (no licence for commercial use; no public CAP endpoint)
--   A row is never re-seeded over (ON CONFLICT DO NOTHING), so a flag Shane
--   has flipped is never flipped back by a re-run.
-- * official_alerts: one row per provider and CAP identifier (JMA: per office
--   and warning kind), holding every language block verbatim (infos), the
--   provider's zone keys, and a MultiPolygon simplified to about 100 m
--   (0.0009 degrees, ST_SimplifyPreserveTopology, then ST_MakeValid). Its
--   content_hash lets official_alerts_apply() skip an unchanged alert: a
--   re-ingest of the same feed writes no row. expires_at is when the issuer
--   stops listing it: for NWS the later of the CAP expires and NWS's ends
--   (NWS lists an alert until its ends; 36 of 224 on 13 Oct were past their
--   expires, 6 of them Gale Warnings). The ingest never stores an alert that
--   is already past expires_at, so the prune can never delete a row the next
--   ingest would put back.
-- * official_alert_zones: the shapes of the zones that zone-based warnings
--   name (NWS forecast, county, fire and marine zones, loaded from
--   api.weather.gov a few per run; MeteoAlarm's EMMA_ID outlines, loaded from
--   the hub's Geocodes JSON by scripts/load-meteoalarm-geocodes.mjs through
--   official_alert_zones_sync()). Zones without a shape (JMA areas until their
--   outlines are loaded; NWS's for the first couple of hours; an EMMA_ID the
--   hub adds before the next load) leave a warning "unplaced", and
--   official_alerts_at() then answers 'partial' for every point its provider
--   covers: never a silent all-clear.
-- * official_alert_deliveries: which account was pushed which warning, for
--   129-06. User-keyed: the account-deletion fence and ON DELETE CASCADE.
--   Nothing writes it yet.
-- * official_alerts_apply(): the ingest's one write call (service role only).
-- * official_alert_zones_sync(): one provider's outlines under one scheme
--   (EMMA_ID), as the hub's latest file has them: a changed one is written,
--   one the file no longer lists is removed (service role only, 129-05b).
-- * official_alerts_at(lat, lon): what is in force at a point (by polygon, or
--   by zone when the warning has no polygon of its own), every info block
--   verbatim, and a coverage answer: live, partial (live, but some warnings
--   in force cannot be placed), unavailable, off or none. Signed-in callers
--   and the service role.
-- * prune_official_alerts(): removes an alert 24 h after it expires or is
--   withdrawn (and one with neither after 30 days); hourly by pg_cron.
-- * Two cron jobs on the vault credential path, the 20261009075000
--   shore-watch way (an exact active job is left alone, a paused one is left
--   paused, any other is replaced):
--     official-alerts-ingest  2-59/5 * * * *  invoke_edge_function('ingest-official-alerts', 120000)
--     official-alerts-prune   17 * * * *      prune_official_alerts()
--   The ingest minutes (:02, :07, ... :57) stay clear of check-weather-alerts
--   (:00, :30) and cyclone-watch (:10, :40).
--
-- Indexes (EXPLAIN reasoning; to be confirmed by EXPLAIN in the rehearsal)
-- ──────────────────────────────────────────────────────────────────────────
-- * official_alerts_live_geom: GiST on geom WHERE withdrawn_at IS NULL. The
--   RPC's ST_Intersects(a.geom, point) carries the index-assisted && and the
--   same predicate, so the planner can take this partial index; the second
--   point (lon + 360, for shapes kept continuous across 180 degrees) makes it
--   a BitmapOr of two index scans, not a sequential scan. Live alerts are a
--   few thousand rows on a busy US day; withdrawn ones wait 24 h for pruning
--   and stay out of the index.
-- * official_alert_zones_geom: GiST on the zone shapes: the few zones that
--   hold the point are found first. Their keys go in as one uncorrelated
--   array, so official_alerts_live_zones (GIN on zones, same partial
--   predicate) answers zones && ARRAY[...] by index.
-- * official_alerts_live_unplaced: (provider_id, sent_at DESC) WHERE
--   withdrawn_at IS NULL AND geom IS NULL. The unplaced count reads only the
--   covering providers' live zone-only rows (a provider_id range of this
--   index), each checked against official_alert_zones by its primary key;
--   no JSON is built for them. The newest one is the first row of the same
--   range, so only it is read in full (its infos).
-- * (provider_id, identifier) is the unique key the ingest reads and upserts
--   on. expires_at and withdrawn_at are btree indexes for the pruning.
-- * official_alert_providers holds about 45 rows; a sequential scan of it is
--   cheaper than any index, and its GiST on coverage is there for when the
--   generic CAP rows grow.
--
-- Undo
-- ────
--     SELECT cron.unschedule('official-alerts-ingest');
--     SELECT cron.unschedule('official-alerts-prune');
--     DROP FUNCTION IF EXISTS public.official_alerts_at(double precision, double precision);
--     DROP FUNCTION IF EXISTS public.official_alerts_apply(text, jsonb, text[], jsonb, jsonb);
--     DROP FUNCTION IF EXISTS public.official_alert_zones_sync(text, text, text[], jsonb);
--     DROP FUNCTION IF EXISTS public.prune_official_alerts();
--     DROP TABLE IF EXISTS public.official_alert_deliveries, public.official_alert_zones,
--         public.official_alerts, public.official_alert_providers;
--     DROP FUNCTION IF EXISTS public.official_alert_geometry(jsonb);
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
        RAISE EXCEPTION 'official_alerts: invoke_edge_function(text, integer, jsonb) is missing';
    END IF;
    IF to_regprocedure('public.block_tombstoned_account_write()') IS NULL THEN
        RAISE EXCEPTION 'official_alerts: block_tombstoned_account_write() (the account-deletion fence) is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'postgis' AND n.nspname IN ('public', 'extensions')
    ) THEN
        RAISE EXCEPTION 'official_alerts: PostGIS must already be installed in public or extensions';
    END IF;
    IF to_regnamespace('cron') IS NULL THEN
        RAISE EXCEPTION 'official_alerts: pg_cron (schema cron) is missing';
    END IF;
END;
$precheck$;

-- ── Providers ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.official_alert_providers (
    id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
    adapter TEXT NOT NULL CHECK (adapter IN ('nws', 'meteoalarm', 'jma', 'eccc', 'cap')),
    issuer TEXT NOT NULL CHECK (length(btrim(issuer)) BETWEEN 1 AND 200),
    feed_url TEXT CHECK (feed_url IS NULL OR feed_url ~ '^https://[^[:space:]]+$'),
    enabled BOOLEAN NOT NULL DEFAULT false,
    licence_note TEXT NOT NULL CHECK (length(btrim(licence_note)) BETWEEN 1 AND 4000),
    attribution TEXT NOT NULL CHECK (length(btrim(attribution)) BETWEEN 1 AND 500),
    attribution_url TEXT CHECK (attribution_url IS NULL OR attribution_url ~ '^https://[^[:space:]]+$'),
    config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    coverage geometry(MultiPolygon, 4326) NOT NULL,
    feed_state JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(feed_state) = 'object' AND octet_length(feed_state::text) <= 262144),
    last_success_at TIMESTAMPTZ,
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
    last_error_at TIMESTAMPTZ,
    unavailable_since TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS official_alert_providers_coverage
    ON public.official_alert_providers USING gist (coverage);

-- ── Alerts ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.official_alerts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES public.official_alert_providers(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL CHECK (length(identifier) BETWEEN 1 AND 300),
    sender TEXT CHECK (sender IS NULL OR length(sender) <= 300),
    sent_at TIMESTAMPTZ NOT NULL,
    msg_type TEXT NOT NULL CHECK (msg_type IN ('Alert', 'Update')),
    status TEXT NOT NULL CHECK (status = 'Actual'),
    scope TEXT CHECK (scope IS NULL OR length(scope) <= 40),
    refs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(refs) <= 500),
    infos JSONB NOT NULL CHECK (
        jsonb_typeof(infos) = 'array'
        AND jsonb_array_length(infos) BETWEEN 1 AND 32
        AND octet_length(infos::text) <= 524288
    ),
    zones TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(zones) <= 4000),
    geom geometry(MultiPolygon, 4326),
    effective_at TIMESTAMPTZ,
    onset_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT official_alerts_provider_identifier UNIQUE (provider_id, identifier)
);

CREATE INDEX IF NOT EXISTS official_alerts_live_geom
    ON public.official_alerts USING gist (geom) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS official_alerts_live_zones
    ON public.official_alerts USING gin (zones) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS official_alerts_live_unplaced
    ON public.official_alerts (provider_id, sent_at DESC) WHERE withdrawn_at IS NULL AND geom IS NULL;
CREATE INDEX IF NOT EXISTS official_alerts_expires ON public.official_alerts (expires_at);
CREATE INDEX IF NOT EXISTS official_alerts_withdrawn
    ON public.official_alerts (withdrawn_at) WHERE withdrawn_at IS NOT NULL;

-- ── Zones ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.official_alert_zones (
    provider_id TEXT NOT NULL REFERENCES public.official_alert_providers(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (length(code) BETWEEN 3 AND 120),
    name TEXT CHECK (name IS NULL OR length(name) <= 300),
    geom geometry(MultiPolygon, 4326) NOT NULL,
    source_url TEXT CHECK (source_url IS NULL OR source_url ~ '^https://[^[:space:]]+$'),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, code)
);

CREATE INDEX IF NOT EXISTS official_alert_zones_geom ON public.official_alert_zones USING gist (geom);

-- ── Deliveries (129-06) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.official_alert_deliveries (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    alert_id BIGINT NOT NULL REFERENCES public.official_alerts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'push' CHECK (channel IN ('push')),
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, alert_id, channel)
);

CREATE INDEX IF NOT EXISTS official_alert_deliveries_alert ON public.official_alert_deliveries (alert_id);

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.official_alert_deliveries;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.official_alert_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

-- ── Privileges: service role only; the app reads through official_alerts_at() ──

ALTER TABLE public.official_alert_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.official_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.official_alert_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.official_alert_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_alert_providers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.official_alerts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.official_alert_zones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.official_alert_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_alert_providers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_alerts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_alert_zones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_alert_deliveries TO service_role;
GRANT USAGE ON SEQUENCE public.official_alerts_id_seq TO service_role;

-- ── The functions that call PostGIS, qualified with its schema ──────────
-- PostGIS lives in public or extensions (20260928120000 found both). Its
-- schema is resolved here, once, and every spatial call and type below is
-- qualified with it, so a same-named object elsewhere on the path can never
-- run as the definer.

DO $functions$
DECLARE
    gis name;
BEGIN
    SELECT n.nspname INTO STRICT gis
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'postgis' AND n.nspname IN ('public', 'extensions');

    -- GeoJSON from the ingest to a stored MultiPolygon: simplified to about
    -- 100 m (0.0009 degrees), made valid, polygons only, or NULL.
    EXECUTE format($definition$
CREATE OR REPLACE FUNCTION public.official_alert_geometry(g jsonb)
RETURNS %1$I.geometry
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, extensions, pg_temp
AS $fn$
    SELECT CASE WHEN m IS NULL OR %1$I.ST_IsEmpty(m) THEN NULL ELSE m END
      FROM (
        SELECT CASE WHEN g IS NULL OR jsonb_typeof(g) <> 'object' THEN NULL::%1$I.geometry
               ELSE %1$I.ST_Multi(%1$I.ST_CollectionExtract(%1$I.ST_MakeValid(
                   %1$I.ST_SimplifyPreserveTopology(
                       %1$I.ST_SetSRID(%1$I.ST_GeomFromGeoJSON(g::text), 4326), 0.0009)), 3))
               END AS m
      ) AS s;
$fn$;
    $definition$, gis);

    -- The ingest's one write call. Unchanged alerts are skipped twice over:
    -- the edge function sends only what changed, and the upsert's WHERE
    -- leaves a row whose content_hash is the same (and is not withdrawn)
    -- untouched. A provider whose licence flag is off is refused.
    EXECUTE format($definition$
CREATE OR REPLACE FUNCTION public.official_alerts_apply(
    p_provider text,
    p_upserts jsonb,
    p_withdraw text[],
    p_zones jsonb,
    p_status jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $fn$
DECLARE
    is_on boolean;
    upserted integer := 0;
    withdrawn integer := 0;
    zoned integer := 0;
BEGIN
    SELECT p.enabled INTO is_on FROM public.official_alert_providers AS p WHERE p.id = p_provider;
    IF is_on IS NULL THEN
        RAISE EXCEPTION 'official_alerts_apply: unknown provider' USING ERRCODE = '22023';
    END IF;
    IF NOT is_on THEN
        RAISE EXCEPTION 'official_alerts_apply: the provider''s licence flag is off' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(coalesce(p_upserts, '[]'::jsonb)) <> 'array'
        OR jsonb_typeof(coalesce(p_zones, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'official_alerts_apply: upserts and zones must be arrays' USING ERRCODE = '22023';
    END IF;

    WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb)) AS x(
            identifier text, sender text, sent_at timestamptz, msg_type text, status text, scope text,
            refs text[], infos jsonb, zones text[], geometry jsonb,
            effective_at timestamptz, onset_at timestamptz, expires_at timestamptz, content_hash text
        )
    ), written AS (
        INSERT INTO public.official_alerts AS a (
            provider_id, identifier, sender, sent_at, msg_type, status, scope, refs, infos, zones, geom,
            effective_at, onset_at, expires_at, content_hash
        )
        SELECT p_provider, i.identifier, i.sender, i.sent_at, i.msg_type, i.status, i.scope,
               coalesce(i.refs, '{}'), i.infos, coalesce(i.zones, '{}'), public.official_alert_geometry(i.geometry),
               i.effective_at, i.onset_at, i.expires_at, i.content_hash
          FROM incoming AS i
        ON CONFLICT (provider_id, identifier) DO UPDATE SET
            sender = EXCLUDED.sender,
            sent_at = EXCLUDED.sent_at,
            msg_type = EXCLUDED.msg_type,
            status = EXCLUDED.status,
            scope = EXCLUDED.scope,
            refs = EXCLUDED.refs,
            infos = EXCLUDED.infos,
            zones = EXCLUDED.zones,
            geom = EXCLUDED.geom,
            effective_at = EXCLUDED.effective_at,
            onset_at = EXCLUDED.onset_at,
            expires_at = EXCLUDED.expires_at,
            content_hash = EXCLUDED.content_hash,
            withdrawn_at = NULL,
            updated_at = now()
        WHERE a.content_hash IS DISTINCT FROM EXCLUDED.content_hash OR a.withdrawn_at IS NOT NULL
        RETURNING 1
    )
    SELECT count(*) INTO upserted FROM written;

    UPDATE public.official_alerts AS a
       SET withdrawn_at = now(), updated_at = now()
     WHERE a.provider_id = p_provider
       AND a.identifier = ANY (coalesce(p_withdraw, '{}'::text[]))
       AND a.withdrawn_at IS NULL;
    GET DIAGNOSTICS withdrawn = ROW_COUNT;

    WITH shapes AS (
        SELECT z.code, z.name, z.source_url, public.official_alert_geometry(z.geometry) AS geom
          FROM jsonb_to_recordset(coalesce(p_zones, '[]'::jsonb)) AS z(code text, name text, geometry jsonb, source_url text)
    ), written AS (
        INSERT INTO public.official_alert_zones AS t (provider_id, code, name, geom, source_url)
        SELECT p_provider, s.code, s.name, s.geom, s.source_url FROM shapes AS s WHERE s.geom IS NOT NULL
        ON CONFLICT (provider_id, code) DO UPDATE SET
            name = EXCLUDED.name,
            geom = EXCLUDED.geom,
            source_url = EXCLUDED.source_url,
            fetched_at = now()
        WHERE t.name IS DISTINCT FROM EXCLUDED.name
           OR %1$I.ST_AsBinary(t.geom) IS DISTINCT FROM %1$I.ST_AsBinary(EXCLUDED.geom)
        RETURNING 1
    )
    SELECT count(*) INTO zoned FROM written;

    IF p_status IS NOT NULL AND jsonb_typeof(p_status) = 'object' THEN
        UPDATE public.official_alert_providers AS p SET
            last_success_at = (p_status->>'last_success_at')::timestamptz,
            last_error = left(p_status->>'last_error', 500),
            last_error_at = (p_status->>'last_error_at')::timestamptz,
            unavailable_since = (p_status->>'unavailable_since')::timestamptz,
            feed_state = coalesce(p_status->'feed_state', p.feed_state),
            updated_at = now()
         WHERE p.id = p_provider;
    END IF;

    RETURN jsonb_build_object('upserted', upserted, 'withdrawn', withdrawn, 'zones', zoned);
END;
$fn$;
    $definition$, gis);

    -- One provider's outlines under one scheme (MeteoAlarm's EMMA_ID), as its
    -- source has them now (129-05b): p_codes is every code it keeps, p_zones
    -- this call's shapes (a batch of them; each call carries every code, so
    -- one batch never drops another's). A shape is written only when its name
    -- or geometry changed; a code under the scheme that p_codes no longer has
    -- is removed (the hub's change log: "Removal of obsolete geocodes"). A
    -- warning still naming a removed code is unplaced, so 'partial', never
    -- an all-clear. scripts/load-meteoalarm-geocodes.mjs calls it, and
    -- refuses to remove more than half of a country's outlines unless asked.
    EXECUTE format($definition$
CREATE OR REPLACE FUNCTION public.official_alert_zones_sync(
    p_provider text,
    p_scheme text,
    p_codes text[],
    p_zones jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $fn$
DECLARE
    written integer := 0;
    removed integer := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.official_alert_providers AS p WHERE p.id = p_provider) THEN
        RAISE EXCEPTION 'official_alert_zones_sync: unknown provider' USING ERRCODE = '22023';
    END IF;
    IF p_scheme IS NULL OR p_scheme !~ '^[A-Za-z][A-Za-z0-9_]{1,30}$'
        OR jsonb_typeof(coalesce(p_zones, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'official_alert_zones_sync: a scheme and an array of zones are needed' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM unnest(coalesce(p_codes, '{}'::text[])) AS c(code)
         WHERE c.code IS NULL OR left(c.code, length(p_scheme) + 1) <> p_scheme || ':'
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(p_zones, '[]'::jsonb)) AS z(v)
         WHERE NOT (z.v->>'code' = ANY (coalesce(p_codes, '{}'::text[])))
    ) THEN
        RAISE EXCEPTION 'official_alert_zones_sync: every code must be under the scheme and every shape among the codes'
            USING ERRCODE = '22023';
    END IF;

    WITH shapes AS (
        SELECT z.code, z.name, z.source_url, public.official_alert_geometry(z.geometry) AS geom
          FROM jsonb_to_recordset(coalesce(p_zones, '[]'::jsonb)) AS z(code text, name text, geometry jsonb, source_url text)
    ), written AS (
        INSERT INTO public.official_alert_zones AS t (provider_id, code, name, geom, source_url)
        SELECT p_provider, s.code, s.name, s.geom, s.source_url FROM shapes AS s WHERE s.geom IS NOT NULL
        ON CONFLICT (provider_id, code) DO UPDATE SET
            name = EXCLUDED.name,
            geom = EXCLUDED.geom,
            source_url = EXCLUDED.source_url,
            fetched_at = now()
        WHERE t.name IS DISTINCT FROM EXCLUDED.name
           OR %1$I.ST_AsBinary(t.geom) IS DISTINCT FROM %1$I.ST_AsBinary(EXCLUDED.geom)
        RETURNING 1
    )
    SELECT count(*) INTO written FROM written;

    DELETE FROM public.official_alert_zones AS z
     WHERE z.provider_id = p_provider
       AND left(z.code, length(p_scheme) + 1) = p_scheme || ':'
       AND NOT (z.code = ANY (coalesce(p_codes, '{}'::text[])));
    GET DIAGNOSTICS removed = ROW_COUNT;

    RETURN jsonb_build_object('zones', written, 'removed', removed);
END;
$fn$;
    $definition$, gis);

    -- What is in force at a point, and whether that answer can be trusted.
    --
    -- A warning is in force while it is not withdrawn and has not expired
    -- (one with no expiry, JMA's, until its office's next report says
    -- otherwise). It matches by its own polygon, else, when it has none, by
    -- any of its zones whose shape holds the point. Only providers whose
    -- licence flag is on are answered from.
    --
    -- A marine warning also matches within 3 NM of its shape (129-06 review,
    -- 14 Oct): NWS's marine zones end at the open water, so a boat at its
    -- berth, or placed by its home port, is in a land zone only (an
    -- Annapolis marina is 0.13 NM outside ANZ532, Baltimore's Inner Harbor
    -- 0.02 NM outside ANZ538) and an exact match answered "live, nothing in
    -- force" under a gale warning for the water outside. A zone with NWS's
    -- marine letters, or the polygon of an NWS warning naming marine zones
    -- only, matches within 3 NM (5556 m on the sphere, after a box the GiST
    -- index answers), and says so: matched_by 'nearby'. Land zones and land
    -- polygons match exactly. official_alerts_watch_match (20261014160000)
    -- matches the same way.
    --
    -- MeteoAlarm (129-05b) reaches 3 NM too: its EMMA_ID outlines are land
    -- areas (a departement, a Kreis), so a berth, or a boat just off the
    -- coast, is outside every one of them. An EMMA_ID outline and a MeteoAlarm
    -- warning's own polygon match within 3 NM as 'nearby'. And a MeteoAlarm
    -- country covers a point within 3 NM of one of its own outlines, wherever
    -- the outline is: its box takes in open sea where no MeteoAlarm warning is
    -- ever issued ("live, nothing in force" there would be a false all-clear),
    -- and leaves out islands and sea areas its outlines do hold (Madeira, the
    -- Canaries, Ireland's Irish Sea areas, the Frisian waters), so the box
    -- plays no part in it. A country whose warnings come as polygons with no
    -- outlines (the United Kingdom, Norway, Sweden, Estonia, Israel, Ukraine,
    -- Switzerland, Luxembourg and Andorra on 2026-10-14), or any before
    -- scripts/load-meteoalarm-geocodes.mjs has run, covers no point while it
    -- is live: its warnings are still shown where their polygons are. But a
    -- MeteoAlarm country that is not live is listed where its box holds a
    -- point another provider answers for, so a neighbour's outline (Met
    -- Éireann's sea area off Portrush, Denmark's Øresund off Helsingborg)
    -- never reads "live, nothing in force" while the Met Office's or SMHI's
    -- feed is failing there. Only there: the boxes are coarse (Norway's holds
    -- Tallinn), and where no one else answers the answer is 'none' anyway.
    --
    -- MeteoAlarm's terms ask for real time, never over 10 minutes behind: a
    -- MeteoAlarm country is live only while its last success (written on
    -- every 5-minute run, at the run's start) is under 8 minutes old
    -- (ingest.ts REALTIME_LIVE_MS), so with the app's 90 seconds
    -- (REALTIME_APP_MS) nothing shown as live is over 10 minutes behind.
    --
    -- Each provider whose coverage holds the point is listed with its state:
    --   live         answered within the last 30 min (MeteoAlarm: 8) and not
    --                failing;
    --   unavailable  failing (since unavailable_since), stopped (since its
    --                last success), or never answered (since null);
    --   off          its licence flag is off.
    -- and with `unplaced`: its warnings in force that cannot be placed (no
    -- polygon, and a zone with no shape yet), which could be anywhere it
    -- covers. `coverage` is the whole answer:
    --   unavailable  any enabled provider there is not live;
    --   partial      all are live, but one has warnings it cannot place:
    --                not an all-clear (the app shows unplaced_newest);
    --   live         every enabled provider there is live and placed all;
    --   off          only providers that are off cover it;
    --   none         nothing does.
    -- The text is returned as stored: the issuer's, in every language it
    -- sent, for the app to choose from.
    EXECUTE format($definition$
CREATE OR REPLACE FUNCTION public.official_alerts_at(p_lat double precision, p_lon double precision)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $fn$
DECLARE
    pt %1$I.geometry;
    pt_east %1$I.geometry;
    -- NWS marine zones (classify.ts NWS_MARINE_ZONE_AREAS), MeteoAlarm's outlines, and their reach.
    marine_zone CONSTANT text := '^nws:[a-z]+:(AM|AN|GM|PZ|PK|PH|PM|PS|LM|LS|LH|LO|LE|LC|SL)Z[0-9]{3}$';
    meteoalarm_zone CONSTANT text := '^EMMA_ID:';
    reach_m CONSTANT double precision := 5556;
    -- How old a last success may be while a provider is live; MeteoAlarm's terms ask for real time.
    stale_after CONSTANT interval := interval '30 minutes';
    realtime_live CONSTANT interval := interval '8 minutes';
    near_box %1$I.geometry;
    near_box_east %1$I.geometry;
    result jsonb;
BEGIN
    IF p_lat IS NULL OR p_lon IS NULL OR NOT (p_lat BETWEEN -90 AND 90) OR NOT (p_lon BETWEEN -180 AND 180) THEN
        RAISE EXCEPTION 'official_alerts_at: latitude or longitude out of range' USING ERRCODE = '22023';
    END IF;
    pt := %1$I.ST_SetSRID(%1$I.ST_MakePoint(p_lon, p_lat), 4326);
    -- The same point one turn east: a shape that crosses 180 degrees is stored continuous (lon 179..181).
    pt_east := %1$I.ST_SetSRID(%1$I.ST_MakePoint(p_lon + 360, p_lat), 4326);
    -- 3 NM as a box in degrees, for the index (a nautical mile is a minute of latitude).
    near_box := %1$I.ST_Expand(pt, 3.0 / 60 / greatest(cos(radians(p_lat)), 0.02), 3.0 / 60);
    near_box_east := %1$I.ST_Expand(pt_east, 3.0 / 60 / greatest(cos(radians(p_lat)), 0.02), 3.0 / 60);

    WITH zone_hits AS (
        -- The zones holding the point (inside), and NWS marine zones and MeteoAlarm outlines within 3 NM of it.
        SELECT z.provider_id, z.code,
               (%1$I.ST_Intersects(z.geom, pt) OR %1$I.ST_Intersects(z.geom, pt_east)) AS inside
          FROM public.official_alert_zones AS z
         WHERE %1$I.ST_Intersects(z.geom, pt) OR %1$I.ST_Intersects(z.geom, pt_east)
            OR ((z.code ~ marine_zone OR z.code ~ meteoalarm_zone)
                AND (z.geom && near_box OR z.geom && near_box_east)
                AND %1$I.ST_DWithin(z.geom::%1$I.geography, pt::%1$I.geography, reach_m))
    ), health AS (
        SELECT p.id, p.adapter, p.coverage, p.issuer, p.enabled, p.attribution, p.attribution_url, p.last_success_at,
               CASE
                   WHEN NOT p.enabled THEN 'off'
                   WHEN p.unavailable_since IS NOT NULL THEN 'unavailable'
                   WHEN p.last_success_at IS NULL
                     OR p.last_success_at < now() - CASE WHEN p.adapter = 'meteoalarm' THEN realtime_live ELSE stale_after END
                   THEN 'unavailable'
                   ELSE 'live'
               END AS state,
               CASE
                   WHEN NOT p.enabled THEN NULL
                   WHEN p.unavailable_since IS NOT NULL THEN p.unavailable_since
                   ELSE p.last_success_at
               END AS last_or_failing
          FROM public.official_alert_providers AS p
    ), covering AS (
        -- Who answers for the point: a provider whose coverage holds it; a MeteoAlarm country within 3 NM
        -- of one of its own outlines, wherever that is.
        SELECT h.* FROM health AS h
         WHERE CASE
                   WHEN h.adapter <> 'meteoalarm' THEN %1$I.ST_Intersects(h.coverage, pt)
                   ELSE EXISTS (SELECT 1 FROM zone_hits AS zh WHERE zh.provider_id = h.id)
               END
    ), prov AS (
        SELECT h.id, h.issuer, h.enabled, h.attribution, h.attribution_url, h.last_success_at, h.state,
               CASE WHEN h.state = 'unavailable' THEN h.last_or_failing END AS since
          FROM (
              SELECT * FROM covering
              UNION ALL
              -- And a MeteoAlarm country that is not live, where its box holds a point another answers for:
              -- its failure is never hidden behind a neighbour's live outline.
              SELECT h.* FROM health AS h
               WHERE h.adapter = 'meteoalarm' AND h.state = 'unavailable'
                 AND %1$I.ST_Intersects(h.coverage, pt)
                 AND EXISTS (SELECT 1 FROM covering)
                 AND NOT EXISTS (SELECT 1 FROM covering AS c WHERE c.id = h.id)
          ) AS h
    ), hits AS (
        SELECT a.id, 'polygon'::text AS matched_by
          FROM public.official_alerts AS a
         WHERE a.withdrawn_at IS NULL
           AND (a.expires_at IS NULL OR a.expires_at > now())
           AND (%1$I.ST_Intersects(a.geom, pt) OR %1$I.ST_Intersects(a.geom, pt_east))
        UNION
        -- An NWS marine warning's polygon (one naming marine zones only), or a MeteoAlarm one, within 3 NM.
        SELECT a.id, 'nearby'::text
          FROM public.official_alerts AS a
         WHERE a.withdrawn_at IS NULL
           AND (a.expires_at IS NULL OR a.expires_at > now())
           AND (a.geom && near_box OR a.geom && near_box_east)
           AND ((a.provider_id = 'nws'
                 AND cardinality(a.zones) > 0
                 AND NOT EXISTS (SELECT 1 FROM unnest(a.zones) AS zc(code) WHERE zc.code !~ marine_zone))
                OR a.provider_id ~ '^meteoalarm-')
           AND %1$I.ST_DWithin(a.geom::%1$I.geography, pt::%1$I.geography, reach_m)
        UNION
        -- 'zone' when a zone it names holds the point, 'nearby' when only one within 3 NM does.
        SELECT a.id,
               CASE WHEN EXISTS (
                   SELECT 1 FROM zone_hits AS zh
                    WHERE zh.inside AND zh.provider_id = a.provider_id AND zh.code = ANY (a.zones)
               ) THEN 'zone'::text ELSE 'nearby'::text END
          FROM public.official_alerts AS a
         WHERE a.withdrawn_at IS NULL
           AND (a.expires_at IS NULL OR a.expires_at > now())
           AND a.geom IS NULL
           AND a.zones && (SELECT coalesce(array_agg(zh.code), '{}'::text[]) FROM zone_hits AS zh)
           AND EXISTS (SELECT 1 FROM zone_hits AS zh WHERE zh.provider_id = a.provider_id AND zh.code = ANY (a.zones))
    ), unplaced_rows AS (
        -- Ids and sort keys only: infos are read for the newest one alone.
        SELECT a.id, a.provider_id, a.sent_at, a.identifier
          FROM public.official_alerts AS a
          JOIN prov ON prov.id = a.provider_id AND prov.enabled
         WHERE a.withdrawn_at IS NULL
           AND a.geom IS NULL
           AND (a.expires_at IS NULL OR a.expires_at > now())
           AND (cardinality(a.zones) = 0 OR EXISTS (
                SELECT 1 FROM unnest(a.zones) AS zc(code)
                 WHERE NOT EXISTS (
                     SELECT 1 FROM public.official_alert_zones AS z
                      WHERE z.provider_id = a.provider_id AND z.code = zc.code
                 )
           ))
    ), unplaced AS (
        SELECT r.provider_id, count(*) AS n
          FROM unplaced_rows AS r
         GROUP BY r.provider_id
    )
    SELECT jsonb_build_object(
        'lat', p_lat,
        'lon', p_lon,
        'at', now(),
        'coverage', CASE
            WHEN EXISTS (SELECT 1 FROM prov WHERE prov.enabled AND prov.state <> 'live') THEN 'unavailable'
            WHEN EXISTS (SELECT 1 FROM prov JOIN unplaced AS u ON u.provider_id = prov.id WHERE prov.state = 'live') THEN 'partial'
            WHEN EXISTS (SELECT 1 FROM prov WHERE prov.state = 'live') THEN 'live'
            WHEN EXISTS (SELECT 1 FROM prov) THEN 'off'
            ELSE 'none'
        END,
        'unplaced', coalesce((SELECT sum(u.n) FROM unplaced AS u), 0),
        'providers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', prov.id,
                       'issuer', prov.issuer,
                       'state', prov.state,
                       'since', prov.since,
                       'last_success_at', prov.last_success_at,
                       'attribution', prov.attribution,
                       'attribution_url', prov.attribution_url,
                       'unplaced', coalesce(u.n, 0),
                       'unplaced_newest', (
                           SELECT jsonb_build_object(
                                      'identifier', a.identifier,
                                      'event', a.infos->0->>'event',
                                      'areas', a.infos->0->'areaDesc'
                                  )
                             FROM unplaced_rows AS r
                             JOIN public.official_alerts AS a ON a.id = r.id
                            WHERE r.provider_id = prov.id
                            ORDER BY r.sent_at DESC, r.identifier
                            LIMIT 1
                       )
                   ) ORDER BY prov.id)
              FROM prov LEFT JOIN unplaced AS u ON u.provider_id = prov.id
        ), '[]'::jsonb),
        'alerts', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'provider', a.provider_id,
                       'issuer', p.issuer,
                       'identifier', a.identifier,
                       'sender', a.sender,
                       'sent', a.sent_at,
                       'msg_type', a.msg_type,
                       'effective', a.effective_at,
                       'onset', a.onset_at,
                       'expires', a.expires_at,
                       'matched_by', h.matched_by,
                       'infos', a.infos,
                       'attribution', p.attribution,
                       'attribution_url', p.attribution_url
                   ) ORDER BY a.sent_at DESC, a.identifier)
              -- One row per warning: its exact match (polygon, zone) over 'nearby'.
              FROM (SELECT DISTINCT ON (hits.id) hits.id, hits.matched_by
                      FROM hits ORDER BY hits.id, hits.matched_by = 'nearby', hits.matched_by) AS h
              JOIN public.official_alerts AS a ON a.id = h.id
              JOIN public.official_alert_providers AS p ON p.id = a.provider_id AND p.enabled
        ), '[]'::jsonb)
    ) INTO result;
    RETURN result;
END;
$fn$;
    $definition$, gis);
END;
$functions$;

REVOKE ALL ON FUNCTION public.official_alert_geometry(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.official_alert_geometry(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.official_alerts_apply(text, jsonb, text[], jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.official_alerts_apply(text, jsonb, text[], jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.official_alert_zones_sync(text, text, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.official_alert_zones_sync(text, text, text[], jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.official_alerts_at(double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.official_alerts_at(double precision, double precision) TO authenticated, service_role;

-- ── Pruning: 24 h after a warning expires or is withdrawn ───────────────

CREATE OR REPLACE FUNCTION public.prune_official_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    removed integer;
BEGIN
    DELETE FROM public.official_alerts AS a
     WHERE a.expires_at < now() - interval '24 hours'
        OR a.withdrawn_at < now() - interval '24 hours'
        OR (a.expires_at IS NULL AND a.withdrawn_at IS NULL AND a.sent_at < now() - interval '30 days');
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_official_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_official_alerts() TO service_role;

-- ── The providers, with their licence flags (decision A, 14 Oct) ────────
-- Coverage is drawn coarse (tens of km) and errs towards claiming an area:
-- a point just over a border may be "covered" by both sides' issuers, and
-- the RPC then lists both. Shapes are lon/lat (WKT order). NWS covers its
-- coastal, Great Lakes and Alaska offshore zones (PKZ312-PKZ510, outlines
-- read from api.weather.gov 2026-10-14; PKZ411 had seven alerts that week).
-- Its other offshore zones (Hawaii PHZ180, the Gulf, the Caribbean and the
-- Atlantic and Pacific offshore waters) are left out on purpose: none had an
-- alert in api.weather.gov's history that week (their warnings come in the
-- offshore text forecasts, not as CAP alerts), so claiming them would answer
-- 'live' with nothing in force, a false all-clear; 'none' there is honest.

INSERT INTO public.official_alert_providers
    (id, adapter, issuer, feed_url, enabled, licence_note, attribution, attribution_url, config, coverage)
VALUES
(
    'nws', 'nws', 'National Weather Service (NOAA)',
    'https://api.weather.gov/alerts/active?status=actual', true,
    'ON. US Government work, public domain. https://www.weather.gov/disclaimer (read 2026-10-14): information on NWS servers "is in the public domain, unless specifically noted otherwise, and may be used without charge for any lawful purpose"; it must not be presented as official after modification and must not imply endorsement. api.weather.gov asks for a User-Agent naming the application and contact; failed requests are not retried inside a minute.',
    'Warnings: National Weather Service (NOAA)', 'https://www.weather.gov/',
    '{}'::jsonb,
    ST_Multi(ST_GeomFromText('MULTIPOLYGON(('
        || '(-131.0 48.3,-124.75 48.45,-123.4 48.25,-123.15 48.45,-123.25 48.75,-123.1 49.0,-95.15 49.0,-95.15 49.38,-94.8 49.32,-94.6 48.72,-93.0 48.62,-91.5 48.05,-89.6 48.0,-88.4 48.3,-84.9 46.9,-84.4 46.5,-83.6 46.1,-82.5 45.3,-82.4 43.0,-82.5 42.6,-83.1 42.05,-82.65 41.68,-81.25 42.2,-80.0 42.4,-78.92 42.9,-79.05 43.25,-78.6 43.63,-76.5 43.75,-76.35 44.1,-75.8 44.4,-74.75 45.0,-71.5 45.0,-71.1 45.3,-70.25 45.9,-70.0 46.7,-69.2 47.45,-68.3 47.35,-67.8 47.07,-67.8 45.7,-67.4 45.15,-66.9 44.8,-66.5 44.4,-65.7 42.1,-64.0 38.0,-69.0 31.0,-76.5 28.0,-79.6 26.5,-79.8 25.4,-81.0 23.9,-83.0 24.2,-86.0 25.0,-88.0 25.5,-93.5 25.9,-97.15 25.95,-99.1 26.4,-99.5 27.5,-100.3 28.3,-101.4 29.8,-102.4 29.8,-103.1 29.0,-104.5 29.65,-104.9 30.6,-106.5 31.75,-108.2 31.78,-108.2 31.33,-111.07 31.33,-114.82 32.49,-114.72 32.72,-117.12 32.53,-118.5 31.5,-121.0 30.5,-123.0 31.0,-129.0 36.0,-131.0 42.0,-131.0 48.3)),'
        || '((-180.0 50.0,-165.0 52.0,-155.0 54.5,-144.0 54.6,-136.0 54.0,-133.0 54.6,-130.6 54.7,-130.0 55.9,-130.1 56.1,-131.8 56.6,-132.1 57.0,-133.4 58.4,-134.0 58.8,-135.0 59.6,-135.5 59.8,-136.6 59.6,-137.5 59.2,-139.0 60.0,-139.2 60.35,-141.0 60.3,-141.0 75.0,-168.97 75.0,-168.97 65.5,-172.5 64.0,-180.0 61.5,-180.0 50.0)),'
        || '((171.0 50.5,180.0 50.5,180.0 59.3,177.3 59.3,171.3 54.5,171.0 54.5,171.0 50.5)),'
        || '((-162.5 17.5,-153.5 17.5,-153.5 23.5,-162.5 23.5,-162.5 17.5)),'
        || '((-68.0 17.3,-64.2 17.3,-64.2 19.2,-68.0 19.2,-68.0 17.3)),'
        || '((144.2 12.9,146.3 12.9,146.3 20.7,144.2 20.7,144.2 12.9)),'
        || '((-171.3 -14.8,-167.9 -14.8,-167.9 -10.9,-171.3 -10.9,-171.3 -14.8)))', 4326))
),
(
    'eccc', 'eccc', 'Environment and Climate Change Canada',
    'https://dd.weather.gc.ca/', true,
    'ON. Environment and Climate Change Canada Data Servers End-use Licence, https://eccc-msc.github.io/open-data/licence/readme_en/ (read 2026-10-14): worldwide, royalty-free, for any lawful purpose including commercial; attribution required; alerts must be reproduced with "no alteration of the content or intent of the alert"; no use that suggests official status or ECCC endorsement. CAP files from the MSC Datamart, https://dd.weather.gc.ca/YYYYMMDD/WXO-DD/alerts/cap/.',
    'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada',
    'https://eccc-msc.github.io/open-data/licence/readme_en/',
    '{}'::jsonb,
    ST_Multi(ST_GeomFromText('MULTIPOLYGON(((-141.0 60.3,-139.2 60.35,-139.0 60.0,-137.5 59.2,-136.6 59.6,-135.5 59.8,-135.0 59.6,-134.0 58.8,-133.4 58.4,-132.1 57.0,-131.8 56.6,-130.1 56.1,-130.0 55.9,-130.6 54.7,-133.0 54.6,-139.0 54.0,-139.0 48.0,-131.0 48.3,-124.75 48.45,-123.4 48.25,-123.15 48.45,-123.25 48.75,-123.1 49.0,-95.15 49.0,-95.15 49.38,-94.8 49.32,-94.6 48.72,-93.0 48.62,-91.5 48.05,-89.6 48.0,-88.4 48.3,-84.9 46.9,-84.4 46.5,-83.6 46.1,-82.5 45.3,-82.4 43.0,-82.5 42.6,-83.1 42.05,-82.65 41.68,-81.25 42.2,-80.0 42.4,-78.92 42.9,-79.05 43.25,-78.6 43.63,-76.5 43.75,-76.35 44.1,-75.8 44.4,-74.75 45.0,-71.5 45.0,-71.1 45.3,-70.25 45.9,-70.0 46.7,-69.2 47.45,-68.3 47.35,-67.8 47.07,-67.8 45.7,-67.4 45.15,-66.9 44.8,-66.5 44.4,-65.7 42.1,-60.0 40.0,-46.0 43.0,-45.0 50.0,-52.0 58.0,-57.0 61.0,-58.5 66.5,-61.0 72.0,-68.0 76.0,-73.0 78.5,-66.0 80.5,-60.0 82.5,-60.0 84.0,-141.0 84.0,-141.0 60.3)))', 4326))
),
(
    'jma', 'jma', 'Japan Meteorological Agency (気象庁)',
    'https://www.data.jma.go.jp/developer/xml/feed/extra.xml', false,
    'OFF until its area outlines are loaded. Every JMA warning names municipalities (VPWW54, jma-city:) and sea areas (VPCU51, jma-sea:) with no polygon of its own, and their outlines (JMA''s forecast-area GIS data, https://www.data.jma.go.jp/developer/gis.html, same terms) are not loaded into official_alert_zones yet; turned on now, every JMA warning would be unplaced and Japan would read "partial" with nothing placeable. Load the outlines, then turn this row on. The licence allows it: JMA site content is under the Public Data Terms of Use 1.0 (公共データ利用規約（第1.0版）), https://www.jma.go.jp/jma/kishou/info/coment.html (read 2026-10-14); PDL 1.0 (https://www.digital.go.jp/resources/open_data/public_data_license_v1.0) allows commercial use, requires the source to be credited and an edit to be stated, and is compatible with CC BY 4.0. JMA''s notes on the XML (https://xml.kishou.go.jp/considerationforxml.pdf, 2020-09-01): secondary use, including to third parties, is in principle unrestricted unless contrary to the Meteorological Service Act; a warning must not be edited so that its substance changes; extracting one area''s elements and rebuilding them is allowed, and an edited telegram must say that it was edited and who is responsible. PULL feeds, https://xml.kishou.go.jp/xmlpull.html: more than 10 GB a day from one IP is blocked.',
    '出典：気象庁防災情報XML（Thalassaが地域ごとに再構成） / Source: Japan Meteorological Agency, rearranged by area by Thalassa',
    'https://www.jma.go.jp/jma/kishou/info/coment.html',
    '{}'::jsonb,
    ST_Multi(ST_GeomFromText('MULTIPOLYGON(((122.0 20.0,154.0 20.0,154.0 46.5,142.5 46.0,141.5 45.8,139.5 45.5,137.0 42.0,133.0 39.5,131.0 37.5,130.0 35.6,129.2 34.75,128.6 34.2,127.5 33.3,126.0 31.5,123.5 28.0,122.0 25.0,122.0 20.0)))', 4326))
),
(
    'bom', 'cap', 'Bureau of Meteorology',
    NULL, false,
    'OFF. No licence for commercial reuse: the Bureau''s RSS feeds are "for personal and non-commercial use only" (https://www.bom.gov.au/rss/, read 2026-10-14), no public CAP endpoint was found (the Bureau maintains the CAP-AU profile, https://data.gov.au/data/dataset/cap-au-std), and the combined licence email has no reply. Set feed_url and turn it on only with a written licence.',
    'Warnings: Bureau of Meteorology', 'https://www.bom.gov.au/',
    '{}'::jsonb,
    ST_Multi(ST_GeomFromText('MULTIPOLYGON(((112.0 -45.0,150.0 -45.0,160.0 -35.0,160.0 -28.0,157.0 -15.0,151.0 -12.0,145.0 -10.0,143.0 -9.5,141.0 -9.5,138.0 -8.5,130.0 -9.2,127.0 -10.0,124.0 -11.5,118.0 -13.0,112.0 -20.0,112.0 -45.0)))', 4326))
)
ON CONFLICT (id) DO NOTHING;

-- MeteoAlarm: one row per member country's legacy Atom feed, all ON under
-- MeteoAlarm's own Terms and Conditions (129-05b; the licence_note says how
-- each of its six rules is met). The issuer and the credit name the country's
-- participants, as MeteoAlarm's "Our Warning Providers" page lists them (rule
-- 2; supabase/functions/_shared/official-alerts/meteoalarm.ts holds the same
-- names, and tests/OfficialAlertsMigration.test.ts keeps them equal), and the
-- credit links to www.meteoalarm.org (rule 4). Coverage is each country's
-- bounding box (mainland and near islands). official_alerts_at() answers for
-- a country within 3 NM of its own EMMA_ID outlines (wherever they are, in
-- the box or not), and uses the box only to list a country that is not live.
INSERT INTO public.official_alert_providers
    (id, adapter, issuer, feed_url, enabled, licence_note, attribution, attribution_url, config, coverage)
SELECT
    'meteoalarm-' || c.code,
    'meteoalarm',
    c.participant || ' (MeteoAlarm)',
    'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-' || c.slug,
    true,
    'ON. MeteoAlarm Terms and Conditions, https://meteoalarm.org/en/live/page/terms-and-conditions (last updated 15/03/2024, read 2026-10-14), section 5: the warnings may be used and redistributed under terms equivalent to CC BY 4.0, with six more rules, each met here: (1) modified information goes with the original: Thalassa shows the issuer''s words verbatim, never modified; (2) the source is the national service for one country and "EUMETNET – MeteoAlarm" for more than one (this row''s issuer and attribution, the app''s card and notice, the push); (3) the time of issue is shown (the card, the push); (4) internet applications link to www.meteoalarm.org (the attribution link and the disclaimer); (5) operational redistribution in real time, the delay on average under 5 minutes and never over 10 minutes: ingest-official-alerts reads every MeteoAlarm feed on every 5-minute run, first, and records the read every run; official_alerts_at() calls a country live only while its last read is under 8 minutes old, else unavailable; and the app asks again every minute while MeteoAlarm is shown (keeping an answer 30 seconds), so nothing shown as live is over 10 minutes behind; a 429 or 503 from feeds.meteoalarm.org stops every request to it for the run, and its Retry-After is honoured across runs; (6) the disclaimer is published verbatim with every MeteoAlarm warning shown. Registration is optional: the Redistribution Hub''s support levels name "Registered" and "Non-Registered Redistributors" (https://meteoalarm.org/en/live/page/redistribution-hub, read 2026-10-14); it was requested from meteoalarm@geosphere.at on 2026-10-09. Shown as the hub''s Style Guide v1.0 (2026-02-19) asks: title of awareness level and type, the participant as source, onset and expiry with time zones, the area, every language sent, English where the reader''s is not. The EMMA_ID outlines (the hub''s Geocodes JSON, EUMETNET''s "Content") place warnings only, credited "Areas: EUMETNET – MeteoAlarm"; Shane is asking MeteoAlarm to confirm that use by email. https://feeds.meteoalarm.org/ sends no ETag or Last-Modified, so each poll reads the whole feed (1.99 MB for all 39 on 2026-10-14); nothing is written unless a warning changed.',
    'Warnings: ' || c.participant,
    'https://meteoalarm.org/en/live/',
    jsonb_build_object('country', c.code),
    ST_Multi(ST_MakeEnvelope(c.w, c.s, c.e, c.n, 4326))
FROM (VALUES
    ('ad', 'andorra', 'Andorra', 'Servei Meteorològic Nacional (SMN)', 1.40, 42.42, 1.79, 42.66),
    ('at', 'austria', 'Austria', 'GeoSphere Austria', 9.50, 46.35, 17.20, 49.05),
    ('be', 'belgium', 'Belgium', 'Institut Royal Météorologique/Koninklijk Meteorologisch Instituut (IRM/KMI)', 2.50, 49.45, 6.45, 51.60),
    ('ba', 'bosnia-herzegovina', 'Bosnia and Herzegovina', 'Federalni Hidrometeorološki Zavod BiH (FHMZ) / Republički Hidrometeorološki Zavod Republike Srpske (RHMZ RS)', 15.70, 42.55, 19.65, 45.30),
    ('bg', 'bulgaria', 'Bulgaria', 'National Institute of Meteorology and Hydrology (NIMH)', 22.35, 41.20, 28.70, 44.25),
    ('hr', 'croatia', 'Croatia', 'Državni Hidrometeorološki Zavod (DHMZ)', 13.20, 42.35, 19.50, 46.60),
    ('cy', 'cyprus', 'Cyprus', 'Cyprus Department of Meteorology (CYMET)', 32.20, 34.50, 34.65, 35.75),
    ('cz', 'czechia', 'Czechia', 'Czech Hydrometeorological Institute (CHMI)', 12.05, 48.50, 18.90, 51.10),
    ('dk', 'denmark', 'Denmark', 'Danmarks Meteorologiske Institut (DMI)', 7.80, 54.50, 15.30, 57.85),
    ('ee', 'estonia', 'Estonia', 'Estonian Environment Agency (ESTEA)', 21.60, 57.50, 28.25, 59.75),
    ('fi', 'finland', 'Finland', 'Finnish Meteorological Institute (FMI)', 19.00, 59.70, 31.60, 70.10),
    ('fr', 'france', 'France', 'Météo-France', -5.30, 41.30, 9.60, 51.15),
    ('de', 'germany', 'Germany', 'Deutscher Wetterdienst (DWD)', 5.85, 47.25, 15.05, 55.10),
    ('gr', 'greece', 'Greece', 'Hellenic National Meteorological Service (HNMS)', 19.30, 34.75, 29.70, 41.80),
    ('hu', 'hungary', 'Hungary', 'HungaroMet', 16.10, 45.70, 22.90, 48.60),
    ('is', 'iceland', 'Iceland', 'Icelandic Meteorological Office (IMO)', -24.60, 63.20, -13.40, 66.60),
    ('ie', 'ireland', 'Ireland', 'Met Éireann', -10.70, 51.35, -5.90, 55.45),
    ('il', 'israel', 'Israel', 'Israel Meteorological Service (IMS)', 34.20, 29.45, 35.90, 33.35),
    ('it', 'italy', 'Italy', 'Servizio Meteorologico dell’Aeronautica Militare (MeteoAM)', 6.60, 35.45, 18.60, 47.10),
    ('lv', 'latvia', 'Latvia', 'Latvijas Vides, Ģeoloģijas un Meteoroloģijas Centrs (LVĢMC)', 20.90, 55.65, 28.25, 58.10),
    ('lt', 'lithuania', 'Lithuania', 'Lietuvos Hidrometeorologijos Tarnyba (LHMT)', 20.90, 53.90, 26.85, 56.45),
    ('lu', 'luxembourg', 'Luxembourg', 'MeteoLux', 5.70, 49.44, 6.55, 50.20),
    ('mt', 'malta', 'Malta', 'Malta Meteorological Office (MAMO)', 14.15, 35.75, 14.60, 36.10),
    ('md', 'moldova', 'Moldova', 'Autoritatea de Meteorologie și Monitoring de Mediu (AMM)', 26.60, 45.45, 30.15, 48.50),
    ('me', 'montenegro', 'Montenegro', 'Zavod za Hidrometeorologiju i Seizmologiju (ZHMS)', 18.40, 41.80, 20.40, 43.60),
    ('nl', 'netherlands', 'Netherlands', 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)', 3.30, 50.75, 7.25, 53.60),
    ('no', 'norway', 'Norway', 'Meteorologisk Institutt (MET Norway) / Norges Vassdrags- og Energidirektorat (NVE)', 4.40, 57.90, 31.20, 71.25),
    ('pl', 'poland', 'Poland', 'Instytut Meteorologii i Gospodarki Wodnej - Państwowy Instytut Badawczy (IMGW-PIB)', 14.10, 49.00, 24.20, 54.90),
    ('pt', 'portugal', 'Portugal', 'Instituto Português do Mar e da Atmosfera (IPMA)', -9.60, 36.90, -6.15, 42.20),
    ('mk', 'republic-of-north-macedonia', 'North Macedonia', 'Hydrometeorological Service of Republic of North Macedonia (HMS)', 20.45, 40.85, 23.05, 42.40),
    ('ro', 'romania', 'Romania', 'Administrația Națională de Meteorologie (ANM)', 20.25, 43.60, 29.90, 48.30),
    ('rs', 'serbia', 'Serbia', 'Republički Hidrometeorološki Zavod Srbije (RHMZ)', 18.80, 42.20, 23.05, 46.20),
    ('sk', 'slovakia', 'Slovakia', 'Slovenský Hydrometeorologický Ústav (SHMÚ)', 16.80, 47.70, 22.60, 49.65),
    ('si', 'slovenia', 'Slovenia', 'Agencija Republike Slovenije za Okolje (ARSO)', 13.35, 45.40, 16.65, 46.90),
    ('es', 'spain', 'Spain', 'Agencia Estatal de Meteorología (AEMET)', -9.40, 35.90, 4.40, 43.85),
    ('se', 'sweden', 'Sweden', 'Sveriges Meteorologiska och Hydrologiska Institut (SMHI)', 10.90, 55.30, 24.20, 69.10),
    ('ch', 'switzerland', 'Switzerland', 'Federal Office of Meteorology and Climatology MeteoSwiss', 5.95, 45.80, 10.50, 47.85),
    ('ua', 'ukraine', 'Ukraine', 'Ukrainian Hydrometeorological Center (UHMC)', 22.10, 44.35, 40.25, 52.40),
    ('gb', 'united-kingdom', 'United Kingdom', 'Met Office / Environment Agency (EA) / Natural Resources Wales (NRW) / Scottish Environment Protection Agency (SEPA)', -8.70, 49.85, 1.80, 60.90)
) AS c(code, slug, country, participant, w, s, e, n)
ON CONFLICT (id) DO NOTHING;

-- ── The cron jobs (the shore-watch pattern, as 20261014120000) ──────────

DO $schedule$
DECLARE
    job RECORD;
    total INTEGER;
    paused INTEGER;
    exact INTEGER;
    existing RECORD;
BEGIN
    FOR job IN
        SELECT * FROM (VALUES
            ('official-alerts-ingest', '2-59/5 * * * *',
             'SELECT public.invoke_edge_function(''ingest-official-alerts'', 120000)'),
            ('official-alerts-prune', '17 * * * *', 'SELECT public.prune_official_alerts()')
        ) AS j(job_name, want_schedule, want_command)
    LOOP
        SELECT count(*),
               count(*) FILTER (WHERE NOT active),
               count(*) FILTER (WHERE active
                   AND schedule = job.want_schedule
                   AND regexp_replace(btrim(command), '\s+', ' ', 'g') = job.want_command)
          INTO total, paused, exact
          FROM cron.job
         WHERE jobname = job.job_name;

        IF paused > 0 THEN
            RAISE NOTICE '% is paused; left paused. Resuming it is a deliberate step, not a migration.', job.job_name;
            CONTINUE;
        END IF;

        IF total = 1 AND exact = 1 THEN
            CONTINUE;
        END IF;

        FOR existing IN SELECT jobid FROM cron.job WHERE jobname = job.job_name LOOP
            PERFORM cron.unschedule(existing.jobid);
        END LOOP;

        PERFORM cron.schedule(job.job_name, job.want_schedule, job.want_command);
    END LOOP;
END;
$schedule$;

DO $check$
DECLARE
    total INTEGER;
    declared INTEGER;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE NOT active
               OR (jobname = 'official-alerts-ingest' AND schedule = '2-59/5 * * * *'
                   AND regexp_replace(btrim(command), '\s+', ' ', 'g')
                       = 'SELECT public.invoke_edge_function(''ingest-official-alerts'', 120000)')
               OR (jobname = 'official-alerts-prune' AND schedule = '17 * * * *'
                   AND regexp_replace(btrim(command), '\s+', ' ', 'g') = 'SELECT public.prune_official_alerts()'))
      INTO total, declared
      FROM cron.job
     WHERE jobname IN ('official-alerts-ingest', 'official-alerts-prune');
    IF total <> 2 OR declared <> 2 THEN
        RAISE EXCEPTION 'official_alerts: expected the ingest and prune jobs as declared; found % (% as declared)', total, declared;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.official_alert_deliveries'::regclass
           AND tgname = 'account_deletion_write_fence' AND NOT tgisinternal AND tgenabled <> 'D'
    ) THEN
        RAISE EXCEPTION 'official_alerts: the account-deletion fence did not install';
    END IF;
END;
$check$;

RESET search_path;
RESET lock_timeout;
