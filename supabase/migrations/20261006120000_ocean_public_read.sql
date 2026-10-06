-- ═══════════════════════════════════════════════════════════════════════════
-- Thalassa Ocean: the public read behind ocean.thalassawx.app (2026-10-06)
--
-- Shane 2026-10-05: "a live webpage like the public page we have for our
-- diary. only this will be a public page for all boats … call it
-- ocean.thalassawx.app". The page is for anyone, signed in or not, so it needs
-- a read the anon key can make. That read starts from exactly the rows
-- get_public_sightings (20261005150000) shows a signed-in stranger:
--   - public, non-fish rows, at least 3 hours old by server AND event time,
--     each appearing only once its whole time bucket is 3 hours old;
--   - positions on a 0.01 deg grid (about 1 km), or 0.1 deg (about 10 km) for
--     threatened species, rows ever named as threatened, and group-only rows;
--   - times floored to 10 minutes, or the hour when blurred;
--   - per-precision ids; no photos, notes, observer, boat or voyage; a credit
--     handle only on an unblurred row whose skipper ticked it.
-- and then shows anyone LESS than that, never more:
--
-- STRICTER FOR BLURRED ROWS (Shane 2026-10-06: "ok i am the only punter at
-- this stage"). While one boat logs, a blurred row's floored hour plus that
-- boat's public voyage-log track (exact points, 30 days) would place a
-- threatened animal to within metres, whatever the 10 km grid says. So on the
-- anon read a blurred row is never an individual record and never carries an
-- hour: it counts in the totals, species and month histograms only once the
-- month it was seen in has ended (so watching the counters tick says nothing
-- finer than the month), and it is placed in a 0.1 deg cell only when at
-- least 3 boats logged that animal in that cell that month.
--
-- CHEAP FOR ANYONE TO ASK: the summary is computed by pg_cron every 5 minutes
-- into a one-row snapshot, and get_ocean_summary() only reads that row, so a
-- loop of direct anon calls costs one indexed read each, not a recompute.
--
-- Also here: Thalassa's own subdomain names (ocean, www, api, tiles…) can no
-- longer be taken as a boat's voyage-log handle, for every writer.
--
-- Untouched: get_public_sightings, the sightings table and its RLS,
-- sighting_fuzz, and the account-deletion reach functions.
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back replay runs
-- it twice to prove a re-run is a no-op. lock_timeout is set for the session
-- (SET LOCAL is a no-op outside a transaction block, as the 2026-10-06 push
-- showed) and reset at the end.
-- ═══════════════════════════════════════════════════════════════════════════

SET lock_timeout = '5s';

-- ── 1. Reserved names ──────────────────────────────────────────────────────
-- Equal to RESERVED_HANDLES in src/publicHosts.ts (a test keeps them equal).
-- Used by a CHECK, so every role that writes the table needs EXECUTE; the list
-- itself is public (it is in the web bundle).

CREATE OR REPLACE FUNCTION public.voyage_log_handle_reserved(p_handle TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT lower(btrim(COALESCE(p_handle, ''))) = ANY (ARRAY[
        'ocean', 'watch', 'tiles', 'api', 'sightings', 'seabed', 'www', 'app',
        'mail', 'admin', 'status', 'docs', 'help', 'support', 'cdn', 'static',
        'assets', 'auth', 'login', 'dev', 'staging', 'preview', 'embed', 'data',
        'map', 'maps'
    ]::TEXT[]);
$$;

REVOKE ALL ON FUNCTION public.voyage_log_handle_reserved(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.voyage_log_handle_reserved(TEXT) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.voyage_log_handle_reserved(TEXT) IS
    'Thalassa Ocean (2026-10-06): true for subdomain names Thalassa keeps for itself (ocean, www, api, tiles…), which no voyage log may hold. Equal to RESERVED_HANDLES in src/publicHosts.ts.';

-- ── 2. Every writer, every PATCH ───────────────────────────────────────────
-- The owner policy lets a skipper UPDATE their own handle to anything, and
-- the derive trigger runs on INSERT only, so only a CHECK closes every path.
-- 0 of the live handles are reserved (checked 2026-10-06).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conname = 'voyage_log_configs_handle_not_reserved'
           AND conrelid = 'public.voyage_log_configs'::REGCLASS
    ) THEN
        ALTER TABLE public.voyage_log_configs
            ADD CONSTRAINT voyage_log_configs_handle_not_reserved
            CHECK (handle IS NULL OR NOT public.voyage_log_handle_reserved(handle)) NOT VALID;
    END IF;
END
$$;

ALTER TABLE public.voyage_log_configs VALIDATE CONSTRAINT voyage_log_configs_handle_not_reserved;

-- ── 3. Auto-derived handles skip reserved names ────────────────────────────
-- Identical to the live body except the loop. A boat named "Ocean" now gets
-- 'ocean-2'. SECURITY DEFINER lets the collision check see every boat's
-- handle: as the caller, RLS showed only their own rows, so a second boat
-- with a taken name hit the UNIQUE index (23505) instead of getting '-2'.
-- An explicit handle is still returned untouched; the CHECK refuses a
-- reserved one (23514).

CREATE OR REPLACE FUNCTION public.voyage_log_set_handle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    base_slug TEXT;
    candidate TEXT;
    suffix    INT := 1;
BEGIN
    IF NEW.handle IS NOT NULL AND NEW.handle <> '' THEN
        RETURN NEW;
    END IF;

    SELECT public.slugify(vessel_name) INTO base_slug
    FROM public.vessel_identity
    WHERE owner_id = NEW.owner_id;

    IF base_slug IS NULL OR base_slug = '' THEN
        base_slug := 'vessel-' || substr(NEW.owner_id::text, 1, 8);
    END IF;

    candidate := base_slug;
    WHILE public.voyage_log_handle_reserved(candidate)
          OR EXISTS (SELECT 1 FROM public.voyage_log_configs WHERE handle = candidate) LOOP
        suffix := suffix + 1;
        candidate := base_slug || '-' || suffix;
    END LOOP;

    NEW.handle := candidate;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.voyage_log_set_handle() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.voyage_log_set_handle() IS
    'Voyage log: derive a handle from the vessel name on insert, skipping taken and reserved names (2026-10-06: reserved names, SECURITY DEFINER so the collision check sees every boat).';

-- ── 4. The internal row source (never granted) ─────────────────────────────
-- The same gate, grid, time floor, ids, uncertainty and credit as
-- get_public_sightings, with three internal extras that never leave the anon
-- functions as values: the contributing boat (counted only: the 3-boat
-- floors), the boat's own instrument sea temperature (only ever a 1 deg C
-- histogram of unblurred rows, once a species has 5 readings from 3 boats),
-- and the UTC month the row was seen or logged in (the blurred-row release).
-- tests/ocean/OceanMigrationContract.test.ts pins the shared expressions to
-- get_public_sightings so the two cannot drift.

CREATE OR REPLACE FUNCTION public.ocean_public_rows(
    p_south DOUBLE PRECISION,
    p_west DOUBLE PRECISION,
    p_north DOUBLE PRECISION,
    p_east DOUBLE PRECISION
)
RETURNS TABLE (
    sighting_id UUID,
    contributor UUID,
    taxon_group TEXT,
    scientific_name TEXT,
    vernacular_name TEXT,
    taxon_rank TEXT,
    individual_count INTEGER,
    has_calf BOOLEAN,
    event_time TIMESTAMPTZ,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    uncertainty_m INTEGER,
    generalised BOOLEAN,
    sst REAL,
    seen_month TIMESTAMPTZ,
    credit TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    cutoff TIMESTAMPTZ := now() - INTERVAL '3 hours';
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT s.id AS c_id,
               COALESCE(s.vessel_owner_id, s.observer_id) AS c_contributor,
               s.observer_id AS c_observer,
               s.boat_id AS c_boat,
               s.taxon_group AS c_group,
               s.scientific_name AS c_name,
               t.vernacular_name AS c_vernacular,
               t.taxon_rank AS c_rank,
               s.individual_count AS c_count,
               s.has_calf AS c_calf,
               s.event_date AS c_event,
               greatest(s.created_at, s.event_date) AS c_seen,
               s.decimal_latitude AS c_lat,
               s.decimal_longitude AS c_lon,
               s.coordinate_uncertainty_in_meters AS c_uncertainty,
               s.credit_public AS c_credit,
               -- Only the boat's own sensor: a forecast value says nothing
               -- about what the animal was swimming in.
               CASE WHEN s.sea_temp_source = 'instrument' THEN s.sea_temp_c END AS c_sst,
               -- Coarse: any group-only row, a row ever named as threatened,
               -- and a named species by its catalogue flag (unknown = coarse).
               (s.scientific_name IS NULL OR s.ever_sensitive OR COALESCE(t.sensitive, true)) AS c_coarse
          FROM public.sightings AS s
          LEFT JOIN public.sighting_taxa AS t
            ON t.scientific_name = s.scientific_name
         WHERE s.visibility = 'public'
           AND s.taxon_group <> 'fish'
           -- Pre-filters only: the bucket gate below decides.
           AND s.created_at <= cutoff
           AND s.event_date <= cutoff
           AND s.decimal_latitude BETWEEN p_south - 0.1 AND p_north + 0.1
           AND s.decimal_longitude BETWEEN p_west - 0.1 AND p_east + 0.1
    ),
    bucketed AS (
        SELECT c.*,
               CASE WHEN c.c_coarse THEN INTERVAL '1 hour' ELSE INTERVAL '10 minutes' END AS c_bucket
          FROM candidates AS c
    ),
    fuzzed AS (
        SELECT b.*,
               public.sighting_fuzz(b.c_lat, b.c_coarse) AS f_lat,
               public.sighting_fuzz(b.c_lon, b.c_coarse) AS f_lon,
               CASE
                   WHEN b.c_coarse THEN date_trunc('hour', b.c_event, 'UTC')
                   ELSE date_bin(INTERVAL '10 minutes', b.c_event, TIMESTAMPTZ '2000-01-01 00:00:00+00')
               END AS f_time,
               -- Per precision, so the fine and coarse copies of one row do not link.
               md5(b.c_id::TEXT || CASE WHEN b.c_coarse THEN ':coarse' ELSE ':fine' END)::UUID AS f_id
          FROM bucketed AS b
         -- A row appears only once its whole bucket is 3 hours old, so the
         -- moment it first appears says no more than its floored time.
         WHERE date_bin(b.c_bucket, b.c_seen, TIMESTAMPTZ '2000-01-01 00:00:00+00') + b.c_bucket <= cutoff
    )
    SELECT f.f_id,
           f.c_contributor,
           f.c_group,
           f.c_name,
           f.c_vernacular,
           f.c_rank,
           f.c_count,
           f.c_calf,
           f.f_time,
           f.f_lat,
           f.f_lon,
           greatest(CASE WHEN f.c_coarse THEN 7850 ELSE 790 END, COALESCE(f.c_uncertainty, 0)),
           f.c_coarse,
           f.c_sst::REAL,
           date_trunc('month', f.c_seen, 'UTC'),
           -- Never on a coarse row: a credited public voyage log's track would
           -- place a threatened animal better than its 8 km cell.
           CASE
               WHEN f.c_credit AND NOT f.c_coarse THEN (
                   SELECT cfg.handle
                     FROM public.voyage_log_configs AS cfg
                    WHERE cfg.owner_id = f.c_observer
                      AND cfg.enabled
                      AND cfg.handle IS NOT NULL
                    ORDER BY COALESCE(cfg.boat_id = f.c_boat, false) DESC,
                             (cfg.scope = 'personal') DESC,
                             cfg.created_at,
                             cfg.id
                    LIMIT 1
               )
           END
      FROM fuzzed AS f
     -- The box is tested on the FUZZED point only.
     WHERE f.f_lat BETWEEN p_south AND p_north
       AND f.f_lon BETWEEN p_west AND p_east;
END;
$$;

-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- and authenticated by name, so revoking PUBLIC alone would leave it callable.
REVOKE ALL ON FUNCTION public.ocean_public_rows(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.ocean_public_rows(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) IS
    'Thalassa Ocean (2026-10-06), INTERNAL: get_public_sightings'' rows (same gate, grid, floors, ids, credit) plus the contributor, instrument SST and seen month, for ocean_summary_compute and get_ocean_sightings only. Never granted.';

-- ── 5. The summary, computed by the scheduler ──────────────────────────────
-- Cells are 0.1 deg (never finer than a public row) by group, species,
-- blurred flag, year and month. A blurred row counts only once its seen month
-- has ended, and is placed in a cell only when that cell-month-animal has at
-- least 3 boats; it is never in the recent list, the time-of-day or sea
-- temperature histograms, or the first/last times. Boats are shown only when
-- >= 3, otherwise null ("fewer than 3"); no per-area or per-species boat
-- counts at all. Time of day is local solar hour from the gridded longitude
-- (works anywhere on Earth); sea temperature is 1 deg C bins of instrument
-- readings on unblurred rows, once a species has 5 readings from 3 boats.

CREATE OR REPLACE FUNCTION public.ocean_summary_compute()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    WITH r AS MATERIALIZED (
        SELECT * FROM public.ocean_public_rows(-90, -180, 90, 180)
    ),
    -- What may be counted at all: every unblurred row; a blurred row only
    -- once the month it was seen (or logged) in has ended.
    pub AS MATERIALIZED (
        SELECT r.*,
               ((floor(r.latitude::NUMERIC / 0.1) + 0.5) * 0.1)::NUMERIC(6, 2) AS cell_lat,
               ((floor(r.longitude::NUMERIC / 0.1) + 0.5) * 0.1)::NUMERIC(6, 2) AS cell_lon,
               extract(year FROM r.event_time AT TIME ZONE 'UTC')::INT AS y,
               extract(month FROM r.event_time AT TIME ZONE 'UTC')::INT AS m
          FROM r
         WHERE NOT r.generalised
            OR r.seen_month < date_trunc('month', now(), 'UTC')
    ),
    fine AS MATERIALIZED (
        SELECT * FROM pub WHERE NOT generalised
    ),
    tot AS (
        SELECT count(*) AS sightings,
               COALESCE(sum(individual_count), 0) AS animals,
               count(DISTINCT scientific_name) AS species,
               count(DISTINCT contributor) AS boats
          FROM pub
    ),
    tot_fine AS (
        SELECT min(event_time) AS first_time, max(event_time) AS last_time FROM fine
    ),
    cells_all AS (
        SELECT cell_lat AS lat,
               cell_lon AS lon,
               taxon_group,
               scientific_name,
               generalised,
               y,
               m,
               count(*) AS n,
               sum(individual_count) AS animals,
               count(DISTINCT contributor) AS cell_boats
          FROM pub
         GROUP BY 1, 2, 3, 4, 5, 6, 7
    ),
    -- A blurred cell is placed only when 3 boats share it; a lone boat's
    -- threatened sighting stays in the totals with no position at all.
    placed AS (
        SELECT * FROM cells_all WHERE NOT generalised OR cell_boats >= 3
    ),
    cells AS (
        SELECT * FROM placed ORDER BY n DESC, lat, lon LIMIT 20000
    ),
    sp AS (
        SELECT scientific_name,
               min(vernacular_name) AS vernacular_name,
               min(taxon_group) AS taxon_group,
               bool_or(generalised) AS generalised,
               count(*) AS n,
               sum(individual_count) AS animals
          FROM pub
         WHERE scientific_name IS NOT NULL
         GROUP BY scientific_name
    ),
    sst_ok AS (
        SELECT scientific_name
          FROM fine
         WHERE scientific_name IS NOT NULL AND sst IS NOT NULL
         GROUP BY scientific_name
        HAVING count(*) >= 5 AND count(DISTINCT contributor) >= 3
    ),
    hist AS (
        SELECT scientific_name, 'm' AS k, m AS b, count(*) AS n
          FROM pub WHERE scientific_name IS NOT NULL GROUP BY 1, 2, 3
        UNION ALL
        SELECT scientific_name, 'y', y, count(*)
          FROM pub WHERE scientific_name IS NOT NULL GROUP BY 1, 2, 3
        UNION ALL
        SELECT scientific_name, 'h', mod(mod(floor(extract(epoch FROM event_time) / 3600 + longitude / 15)::INT, 24) + 24, 24), count(*)
          FROM fine WHERE scientific_name IS NOT NULL GROUP BY 1, 2, 3
        UNION ALL
        SELECT scientific_name, 't', floor(sst)::INT, count(*)
          FROM fine WHERE scientific_name IN (SELECT scientific_name FROM sst_ok) AND sst IS NOT NULL GROUP BY 1, 2, 3
    ),
    recent AS (
        SELECT * FROM fine ORDER BY event_time DESC, sighting_id DESC LIMIT 50
    )
    SELECT jsonb_build_object(
        'v', 1,
        'status', 'ok',
        'generated_at', now(),
        'delay_hours', 3,
        'grid', jsonb_build_object('fine_deg', 0.01, 'coarse_deg', 0.1, 'cell_deg', 0.1),
        'totals', (
            SELECT jsonb_build_object(
                'sightings', tot.sightings,
                'animals', tot.animals,
                'species', tot.species,
                'boats', CASE WHEN tot.boats >= 3 THEN tot.boats END,
                'boats_min_shown', 3,
                'first_time', tot_fine.first_time,
                'last_time', tot_fine.last_time
            ) FROM tot, tot_fine
        ),
        'groups', COALESCE((
            SELECT jsonb_object_agg(taxon_group, jsonb_build_array(n, animals))
              FROM (SELECT taxon_group, count(*) AS n, sum(individual_count) AS animals FROM pub GROUP BY 1) AS g
        ), '{}'::JSONB),
        'cells', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(lat, lon, taxon_group, scientific_name, generalised, y, m, n, animals)
                             ORDER BY n DESC, lat, lon)
              FROM cells
        ), '[]'::JSONB),
        'cells_truncated', (SELECT count(*) > 20000 FROM placed),
        'species', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'sci', sp.scientific_name,
                'name', sp.vernacular_name,
                'group', sp.taxon_group,
                'generalised', sp.generalised,
                'n', sp.n,
                'animals', sp.animals,
                'months', (SELECT jsonb_object_agg(b, n) FROM hist AS h WHERE h.scientific_name = sp.scientific_name AND h.k = 'm'),
                'hours', (SELECT jsonb_object_agg(b, n) FROM hist AS h WHERE h.scientific_name = sp.scientific_name AND h.k = 'h'),
                'years', (SELECT jsonb_object_agg(b, n) FROM hist AS h WHERE h.scientific_name = sp.scientific_name AND h.k = 'y'),
                'sst', (SELECT jsonb_object_agg(b, n) FROM hist AS h WHERE h.scientific_name = sp.scientific_name AND h.k = 't')
            ) ORDER BY sp.n DESC, sp.scientific_name)
              FROM sp
        ), '[]'::JSONB),
        'recent', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', sighting_id,
                'group', taxon_group,
                'sci', scientific_name,
                'name', vernacular_name,
                'rank', taxon_rank,
                'count', individual_count,
                'calf', has_calf,
                'time', event_time,
                'lat', latitude,
                'lon', longitude,
                'uncertainty_m', uncertainty_m,
                'generalised', generalised,
                'credit', credit
            ) ORDER BY event_time DESC, sighting_id DESC)
              FROM recent
        ), '[]'::JSONB)
    );
$$;

REVOKE ALL ON FUNCTION public.ocean_summary_compute() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.ocean_summary_compute() IS
    'Thalassa Ocean (2026-10-06), INTERNAL: the public summary (totals; 0.1 deg cells by group/species/blurred/year/month, blurred ones only with >= 3 boats, limit 20000; species month/year histograms, solar-hour and instrument SST histograms from unblurred rows only, SST from 5 readings and 3 boats; the newest 50 unblurred rows). Blurred rows count only once their seen month has ended. Run by refresh_ocean_summary only.';

-- ── 6. The snapshot the public reads ───────────────────────────────────────
-- One row. Written only by refresh_ocean_summary (pg_cron, every 5 minutes),
-- read only through get_ocean_summary. RLS on with no policies, and no client
-- role holds any privilege on it.

CREATE TABLE IF NOT EXISTS public.ocean_summary_snapshot (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    summary JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ocean_summary_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ocean_summary_snapshot FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.ocean_summary_snapshot IS
    'Thalassa Ocean (2026-10-06): the one-row public summary, refreshed every 5 minutes by pg_cron (job ocean-summary-refresh). Aggregates and gridded unblurred rows only; read through get_ocean_summary().';

CREATE OR REPLACE FUNCTION public.refresh_ocean_summary()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- One refresh at a time; an overlapping run simply skips.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('thalassa:ocean_summary_refresh', 0)) THEN
        RETURN;
    END IF;
    INSERT INTO public.ocean_summary_snapshot (id, summary, computed_at)
    VALUES (1, public.ocean_summary_compute(), now())
    ON CONFLICT (id) DO UPDATE
        SET summary = EXCLUDED.summary,
            computed_at = EXCLUDED.computed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_ocean_summary() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.refresh_ocean_summary() IS
    'Thalassa Ocean (2026-10-06): recompute the public summary snapshot (pg_cron job ocean-summary-refresh, every 5 minutes). Not callable by any client role.';

-- ── 7. The anon summary: one row read ──────────────────────────────────────
-- generated_at is when the snapshot was computed, so a page can say how old
-- it is. Caching can only make it later, never earlier, so the 3-hour delay
-- and the month release still hold.

CREATE OR REPLACE FUNCTION public.get_ocean_summary()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT snap.summary || jsonb_build_object('generated_at', snap.computed_at)
           FROM public.ocean_summary_snapshot AS snap
          WHERE snap.id = 1),
        jsonb_build_object('v', 1, 'status', 'not-ready')
    );
$$;

REVOKE ALL ON FUNCTION public.get_ocean_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ocean_summary() TO anon, authenticated;
COMMENT ON FUNCTION public.get_ocean_summary() IS
    'Thalassa Ocean public summary (2026-10-06), anon-callable: reads the one-row snapshot pg_cron refreshes every 5 minutes (see ocean_summary_compute for what it holds). Kill switch: REVOKE EXECUTE FROM anon.';

-- ── 8. The anon rows: unblurred rows, one bounded box at a time ────────────
-- The same 13 columns as get_public_sightings, but only unblurred rows: a
-- blurred row is never an individual public record on this read (section 5).
-- A box is at most 10 deg each way, at most 200 rows a page, newest first;
-- page with the (event_time, sighting_id) of the last row.

CREATE OR REPLACE FUNCTION public.get_ocean_sightings(
    p_south DOUBLE PRECISION,
    p_west DOUBLE PRECISION,
    p_north DOUBLE PRECISION,
    p_east DOUBLE PRECISION,
    p_before TIMESTAMPTZ DEFAULT NULL,
    p_before_id UUID DEFAULT NULL
)
RETURNS TABLE (
    sighting_id UUID,
    taxon_group TEXT,
    scientific_name TEXT,
    vernacular_name TEXT,
    taxon_rank TEXT,
    individual_count INTEGER,
    has_calf BOOLEAN,
    event_time TIMESTAMPTZ,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    uncertainty_m INTEGER,
    generalised BOOLEAN,
    credit TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    IF p_south IS NULL OR p_west IS NULL OR p_north IS NULL OR p_east IS NULL
       OR p_south < -90 OR p_north > 90 OR p_south >= p_north
       OR p_west < -180 OR p_east > 180 OR p_west >= p_east
       OR p_north - p_south > 10 OR p_east - p_west > 10 THEN
        RAISE EXCEPTION 'An ocean sightings box is south < north, west < east, at most 10 degrees each way'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT r.sighting_id,
           r.taxon_group,
           r.scientific_name,
           r.vernacular_name,
           r.taxon_rank,
           r.individual_count,
           r.has_calf,
           r.event_time,
           r.latitude,
           r.longitude,
           r.uncertainty_m,
           r.generalised,
           r.credit
      FROM public.ocean_public_rows(p_south, p_west, p_north, p_east) AS r
     WHERE NOT r.generalised
       AND (p_before IS NULL
            OR (r.event_time, r.sighting_id) < (p_before, COALESCE(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::UUID)))
     ORDER BY r.event_time DESC, r.sighting_id DESC
     LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ocean_sightings(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ocean_sightings(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID
) TO anon, authenticated;
COMMENT ON FUNCTION public.get_ocean_sightings(
    DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID
) IS
    'Thalassa Ocean public rows (2026-10-06), anon-callable: the get_public_sightings columns and rules (3 h delay, 0.01 deg grid, floored time, per-precision ids) for UNBLURRED rows only (a blurred row is never an individual record here), a box at most 10 deg each way, 200 rows a page, newest first; page with (event_time, sighting_id). Kill switch: REVOKE EXECUTE FROM anon.';

-- ── 9. Schedule and seed ───────────────────────────────────────────────────
-- A named job, so a re-run updates it in place rather than adding a second.

SELECT cron.schedule('ocean-summary-refresh', '*/5 * * * *', $$SELECT public.refresh_ocean_summary()$$);

SELECT public.refresh_ocean_summary();

RESET lock_timeout;
