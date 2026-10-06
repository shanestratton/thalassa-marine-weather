// @vitest-environment node
/**
 * 20261006120000_ocean_public_read.sql: the anon read behind
 * ocean.thalassawx.app. Text contracts; the rolled-back production replay
 * proves the same lines as anon, authenticated and a stranger before the push.
 *
 * The important one: ocean_public_rows repeats get_public_sightings' gate,
 * grid, time floors, ids, uncertainty and credit rule VERBATIM, so the anon
 * page can never show a position finer, a time earlier, or a row the
 * signed-in public read would not. And then it shows LESS: a blurred row
 * (threatened, or unnamed) is never an individual record, never has an hour,
 * counts only once its month has ended, and is placed only where 3 boats
 * logged it (Shane 2026-10-06: "ok i am the only punter at this stage").
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILE = '20261006120000_ocean_public_read.sql';
const sql = readFileSync(`supabase/migrations/${FILE}`, 'utf8');
const sightings = readFileSync('supabase/migrations/20261005150000_sightings.sql', 'utf8');
const strip = (s: string) => s.replace(/--[^\n]*\n/g, '\n');
const flat = (s: string) => strip(s).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');

function fn(name: string, source: string): string {
    const at = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(at, `${name} must be defined`).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('$$;', at));
}

const publicRead = flat(fn('get_public_sightings', sightings));
const rows = flat(fn('ocean_public_rows', sql));
const compute = flat(fn('ocean_summary_compute', sql));
const refresh = flat(fn('refresh_ocean_summary', sql));
const summary = flat(fn('get_ocean_summary', sql));
const box = flat(fn('get_ocean_sightings', sql));
const code = flat(sql);

/** Expressions that decide what the public may see, shared word for word. */
const SHARED = [
    "cutoff TIMESTAMPTZ := now() - INTERVAL '3 hours';",
    "WHERE s.visibility = 'public' AND s.taxon_group <> 'fish'",
    'AND s.created_at <= cutoff AND s.event_date <= cutoff',
    'greatest(s.created_at, s.event_date) AS c_seen',
    '(s.scientific_name IS NULL OR s.ever_sensitive OR COALESCE(t.sensitive, true)) AS c_coarse',
    'LEFT JOIN public.sighting_taxa AS t ON t.scientific_name = s.scientific_name',
    "CASE WHEN c.c_coarse THEN INTERVAL '1 hour' ELSE INTERVAL '10 minutes' END AS c_bucket",
    'public.sighting_fuzz(b.c_lat, b.c_coarse) AS f_lat',
    'public.sighting_fuzz(b.c_lon, b.c_coarse) AS f_lon',
    "WHEN b.c_coarse THEN date_trunc('hour', b.c_event, 'UTC')",
    "ELSE date_bin(INTERVAL '10 minutes', b.c_event, TIMESTAMPTZ '2000-01-01 00:00:00+00')",
    "md5(b.c_id::TEXT || CASE WHEN b.c_coarse THEN ':coarse' ELSE ':fine' END)::UUID AS f_id",
    "WHERE date_bin(b.c_bucket, b.c_seen, TIMESTAMPTZ '2000-01-01 00:00:00+00') + b.c_bucket <= cutoff",
    'greatest(CASE WHEN f.c_coarse THEN 7850 ELSE 790 END, COALESCE(f.c_uncertainty, 0))',
    'WHEN f.c_credit AND NOT f.c_coarse THEN (',
    'WHERE cfg.owner_id = f.c_observer AND cfg.enabled AND cfg.handle IS NOT NULL',
    "ORDER BY COALESCE(cfg.boat_id = f.c_boat, false) DESC, (cfg.scope = 'personal') DESC, cfg.created_at, cfg.id LIMIT 1",
    'WHERE f.f_lat BETWEEN p_south AND p_north AND f.f_lon BETWEEN p_west AND p_east',
];

describe('ocean public read migration', () => {
    it('sorts after the live head and never wraps itself in a transaction', () => {
        const files = readdirSync('supabase/migrations')
            .filter((f) => f.endsWith('.sql'))
            .sort();
        expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf('20261005160000_tombstone_fence_fails_closed.sql'));
        expect(strip(sql)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    });

    it('sets its lock timeout for the session (SET LOCAL is a no-op on push) and resets it at the end', () => {
        expect(strip(sql)).not.toMatch(/SET LOCAL/i);
        expect(strip(sql).trimStart()).toMatch(/^SET lock_timeout = '5s';/);
        expect(strip(sql).trimEnd()).toMatch(/RESET lock_timeout;$/);
    });

    it('repeats get_public_sightings word for word wherever it decides what is public', () => {
        for (const expression of SHARED) {
            expect(publicRead, `get_public_sightings: ${expression}`).toContain(expression);
            expect(rows, `ocean_public_rows: ${expression}`).toContain(expression);
        }
    });

    it('adds only the contributor, the instrument sea temperature and the seen month, internally', () => {
        expect(rows).toContain('COALESCE(s.vessel_owner_id, s.observer_id) AS c_contributor');
        expect(rows).toContain("CASE WHEN s.sea_temp_source = 'instrument' THEN s.sea_temp_c END AS c_sst");
        expect(rows).toContain("date_trunc('month', f.c_seen, 'UTC'),");
        expect(rows).not.toMatch(/photo|remarks|voyage_id|occurrence_remarks/i);
    });

    it('keeps the row source, the compute and the refresh internal: revoked from PUBLIC, anon and authenticated, granted to no one', () => {
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\.ocean_public_rows\(\s*DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION\s*\) FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\.ocean_summary_compute\(\) FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\.refresh_ocean_summary\(\) FROM PUBLIC, anon, authenticated;/,
        );
        for (const name of ['ocean_public_rows', 'ocean_summary_compute', 'refresh_ocean_summary']) {
            expect(sql).not.toMatch(new RegExp(`GRANT[^;]*ON FUNCTION public\\.${name}`));
        }
    });

    it('serves the summary from a one-row snapshot that pg_cron refreshes every 5 minutes', () => {
        expect(code).toContain(
            'CREATE TABLE IF NOT EXISTS public.ocean_summary_snapshot (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), summary JSONB NOT NULL, computed_at TIMESTAMPTZ NOT NULL DEFAULT now());',
        );
        expect(code).toContain('ALTER TABLE public.ocean_summary_snapshot ENABLE ROW LEVEL SECURITY;');
        expect(code).toContain('REVOKE ALL ON TABLE public.ocean_summary_snapshot FROM PUBLIC, anon, authenticated;');
        expect(code).not.toMatch(/GRANT[^;]*ON (TABLE )?public\.ocean_summary_snapshot/);
        // A direct anon call reads one row; it never recomputes.
        expect(summary).toContain('FROM public.ocean_summary_snapshot AS snap WHERE snap.id = 1');
        expect(summary).not.toMatch(/ocean_public_rows|ocean_summary_compute/);
        expect(refresh).toContain("pg_try_advisory_xact_lock(hashtextextended('thalassa:ocean_summary_refresh', 0))");
        expect(refresh).toContain('VALUES (1, public.ocean_summary_compute(), now())');
        expect(code).toContain(
            "SELECT cron.schedule('ocean-summary-refresh', '*/5 * * * *', $$SELECT public.refresh_ocean_summary()$$);",
        );
        expect(code).toContain('SELECT public.refresh_ocean_summary();');
    });

    it("never publishes a blurred row as an individual record, an hour or a lone boat's cell", () => {
        // Rows view: unblurred rows only.
        expect(box).toContain('WHERE NOT r.generalised AND (p_before IS NULL');
        // Summary: blurred rows count only once their seen month has ended…
        expect(compute).toContain("FROM r WHERE NOT r.generalised OR r.seen_month < date_trunc('month', now(), 'UTC')");
        // …are placed only where 3 boats logged that animal that month…
        expect(compute).toContain('count(DISTINCT contributor) AS cell_boats');
        expect(compute).toContain('SELECT * FROM cells_all WHERE NOT generalised OR cell_boats >= 3');
        expect(compute).toContain('SELECT * FROM placed ORDER BY n DESC, lat, lon LIMIT 20000');
        // …and never appear in the recent list, time of day, sea temperature or first/last times.
        expect(compute).toContain('fine AS MATERIALIZED (SELECT * FROM pub WHERE NOT generalised)');
        expect(compute).toContain('SELECT * FROM fine ORDER BY event_time DESC, sighting_id DESC LIMIT 50');
        expect(compute).toMatch(/'h', mod\([^;]*?FROM fine WHERE/);
        expect(compute).toMatch(/'t', floor\(sst\)::INT, count\(\*\) FROM fine WHERE/);
        expect(compute).toContain('SELECT min(event_time) AS first_time, max(event_time) AS last_time FROM fine');
        expect(compute).not.toMatch(/'first', |'last', /);
    });

    it('grants the two anon functions to anon and authenticated only', () => {
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_ocean_summary\(\) TO anon, authenticated;/);
        expect(sql).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.get_ocean_sightings\(\s*DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, UUID\s*\) TO anon, authenticated;/,
        );
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_ocean_summary\(\) FROM PUBLIC;/);
        for (const body of [rows, compute, refresh, summary, box]) {
            expect(body).toMatch(/SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp/);
        }
    });

    it('never names a private field in what anon can read', () => {
        const forbidden =
            /^(observer|observer_id|boat|boat_id|voyage|voyage_id|photo|photos|remarks|sea_temp|sea_temp_c|contributor|vessel_owner_id)$/;
        const keys = [...compute.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThan(30);
        for (const key of keys) expect(key).not.toMatch(forbidden);
        // The rows view returns exactly get_public_sightings' 13 columns.
        const columns = (body: string) =>
            [
                ...body
                    .slice(body.indexOf('RETURNS TABLE'), body.indexOf('LANGUAGE'))
                    .matchAll(/([a-z_]+) (?:UUID|TEXT|INTEGER|BOOLEAN|TIMESTAMPTZ|DOUBLE PRECISION)/g),
            ].map((m) => m[1]);
        expect(columns(box)).toEqual(columns(publicRead));
        expect(columns(box)).toHaveLength(13);
    });

    it('caps the anon reads: 10 degree boxes, 200 rows, 20000 cells (and says when it cut), 50 recent', () => {
        expect(box).toContain('OR p_north - p_south > 10 OR p_east - p_west > 10 THEN');
        expect(box).toContain("USING ERRCODE = '22023'");
        expect(box).toMatch(/ORDER BY r\.event_time DESC, r\.sighting_id DESC LIMIT 200;/);
        expect(compute).toMatch(/LIMIT 20000/);
        expect(compute).toContain("'cells_truncated', (SELECT count(*) > 20000 FROM placed)");
        expect(compute).toMatch(/LIMIT 50/);
        expect(compute).toContain('SELECT * FROM public.ocean_public_rows(-90, -180, 90, 180)');
    });

    it('publishes a boat count only from 3, sea temperature only from 5 readings and 3 boats, cells no finer than 0.1 degrees', () => {
        expect(compute).toContain("'boats', CASE WHEN tot.boats >= 3 THEN tot.boats END");
        expect(compute).toContain("'boats_min_shown', 3");
        expect(compute).toContain('HAVING count(*) >= 5 AND count(DISTINCT contributor) >= 3');
        expect(compute).toContain('((floor(r.latitude::NUMERIC / 0.1) + 0.5) * 0.1)::NUMERIC(6, 2) AS cell_lat');
        expect(compute).toContain('((floor(r.longitude::NUMERIC / 0.1) + 0.5) * 0.1)::NUMERIC(6, 2) AS cell_lon');
        // The contributor is only ever COUNTED, and only for the 3-boat floors:
        // the overall total, a blurred cell's placement and the SST gate.
        expect(compute.match(/contributor/g)).toHaveLength(3);
        expect(compute).toContain('count(DISTINCT contributor) AS boats');
        // A cell's own boat count is never output.
        expect(compute).toContain(
            'jsonb_build_array(lat, lon, taxon_group, scientific_name, generalised, y, m, n, animals)',
        );
    });

    it('leaves get_public_sightings, the table, its policies and the deletion reach alone', () => {
        const code = strip(sql);
        expect(code).not.toMatch(/FUNCTION public\.get_public_sightings/);
        expect(code).not.toMatch(/ALTER TABLE public\.sightings|POLICY/i);
        expect(code).not.toMatch(/account_deletion|tombstone|sighting_fuzz\(DOUBLE/);
    });
});
