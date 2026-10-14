import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NWS_MARINE_ZONE_AREAS } from '../supabase/functions/_shared/official-alerts/classify';

// The official warnings watcher's database half (129-06): the deliveries'
// chain columns, the batched point match it reads, its status call and its
// cron job. HELD, like 129-05's 20261014150000_official_alerts.sql, which it
// needs: released by moving both into supabase/migrations under stamps newer
// than the newest applied one (this one after 129-05's), rewriting this test
// in that commit to read the released file and assert the held copy is gone.
//
// Nothing here touches a database: the SQL is checked statically (quotes,
// dollar quotes and brackets; the repo's own migration audit on a copy; the
// rules below).
const FILE = '20261014160000_official_alerts_watch.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = existsSync(join(held, FILE)) ? readFileSync(join(held, FILE), 'utf8') : '';
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** Quotes, dollar quotes, comments and brackets balance; top-level statements end in ';'. */
function lex(text: string): { problem?: string; statements: string[] } {
    const statements: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; ) {
        const rest = text.slice(i);
        if (rest.startsWith('--')) {
            const nl = text.indexOf('\n', i);
            i = nl < 0 ? text.length : nl + 1;
            continue;
        }
        if (text[i] === "'") {
            let j = i + 1;
            for (;;) {
                const q = text.indexOf("'", j);
                if (q < 0) return { problem: `open string at ${i}`, statements };
                if (text[q + 1] === "'") j = q + 2;
                else {
                    i = q + 1;
                    break;
                }
            }
            continue;
        }
        const dollar = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest);
        if (dollar && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
            const end = text.indexOf(dollar[0], i + dollar[0].length);
            if (end < 0) return { problem: `open ${dollar[0]} at ${i}`, statements };
            i = end + dollar[0].length;
            continue;
        }
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
        if (depth < 0) return { problem: `unbalanced ) at ${i}`, statements };
        if (text[i] === ';' && depth === 0) {
            statements.push(text.slice(start, i).trim());
            start = i + 1;
        }
        i++;
    }
    if (depth !== 0) return { problem: 'unbalanced (', statements };
    if (text.slice(start).replace(/--.*$/gm, '').trim()) return { problem: 'trailing text', statements };
    return { statements };
}

describe('official alerts watch migration', () => {
    it('is held out of supabase/migrations with 129-05’s, and comes after it', () => {
        expect(existsSync(join(held, FILE))).toBe(true);
        expect(readdirSync(release).filter((name) => name.includes('official_alert'))).toEqual([]);
        expect(existsSync(join(held, '20261014150000_official_alerts.sql'))).toBe(true);
        expect(FILE > '20261014150000_official_alerts.sql').toBe(true);
        // It refuses to run before 129-05's tables and RPC exist.
        expect(sql).toMatch(/to_regclass\('public\.official_alert_deliveries'\) IS NULL/);
        expect(sql).toMatch(
            /to_regprocedure\('public\.official_alerts_at\(double precision,double precision\)'\) IS NULL/,
        );
    });

    it('parses: every statement balanced, the format() body too, and no BEGIN/COMMIT', () => {
        const top = lex(migration);
        expect(top.problem).toBeUndefined();
        for (const s of top.statements) {
            expect(s.replace(/^(--.*\n|\s)+/, '')).toMatch(/^(SET|RESET|DO|CREATE|ALTER|REVOKE|GRANT|DROP)\b/);
        }
        const bodies = [...migration.matchAll(/format\(\$definition\$([\s\S]*?)\$definition\$, gis\)/g)].map((m) =>
            m[1].replace(/%1\$I/g, 'extensions'),
        );
        expect(bodies).toHaveLength(1);
        const inner = lex(bodies[0]);
        expect(inner.problem).toBeUndefined();
        expect(inner.statements[0]).toMatch(/^CREATE OR REPLACE FUNCTION public\.official_alerts_watch_match\(/);
        expect(bodies[0]).not.toMatch(/%(?!1\$I)/);
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });

    it('passes the repo’s migration audit as if released', () => {
        const dir = mkdtempSync(join(tmpdir(), 'official-alerts-watch-audit-'));
        try {
            mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
            copyFileSync(join(held, FILE), join(dir, 'supabase/migrations', FILE));
            const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts/audit-supabase-migrations.mjs')], {
                cwd: dir,
                encoding: 'utf8',
            });
            expect(run.stderr).toBe('');
            expect(run.stdout).toContain('Supabase migration audit passed (1 files).');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('gives each delivery its chain, severity and quiet flag, re-runnably', () => {
        for (const column of ['provider_id', 'identifier', 'refs', 'chain_key', 'severity', 'silent']) {
            expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `));
        }
        expect(sql).toMatch(/chain_key ~ '\^\[0-9a-f\]\{16\}\$'/);
        expect(sql).toMatch(/severity IN \('Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'\)/);
        // 129-05's table, its fence and its cascade stay as they were.
        expect(sql).not.toMatch(/DROP TABLE|DROP TRIGGER|CREATE TABLE IF NOT EXISTS public\.official_alert_deliveries/);
    });

    it('matches every boat in one call, service role only, live and enabled warnings only', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.official_alerts_watch_match'));
        const body = fn.slice(0, fn.indexOf('$fn$;'));
        expect(body).toMatch(/SECURITY INVOKER/);
        expect(body).toMatch(/SET search_path = pg_catalog, public, extensions, pg_temp/);
        expect(body).toMatch(/a\.withdrawn_at IS NULL/);
        expect(body).toMatch(/a\.expires_at IS NULL OR a\.expires_at > now\(\)/);
        expect(body).toMatch(/p\.enabled/);
        // By the warning's own polygon, else by a zone it names, as official_alerts_at() matches.
        expect(body).toMatch(/a\.geom IS NULL/);
        expect(body).toMatch(/a\.zones @> ARRAY\[z\.code\]/);
        // A shape kept continuous across 180 degrees is found one turn east too.
        expect(body).toMatch(/\+ 360/);
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\.official_alerts_watch_match\(jsonb\) FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.official_alerts_watch_match\(jsonb\) TO service_role;/);
    });

    it('answers one row per boat, so PostgREST’s 1000-row cap never cuts a reply short', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.official_alerts_watch_match'));
        const body = fn.slice(0, fn.indexOf('$fn$;'));
        expect(body).toMatch(/RETURNS TABLE \(k integer, alert_ids bigint\[\]\)/);
        expect(body).toMatch(/SELECT hits\.pk, array_agg\(DISTINCT hits\.id ORDER BY hits\.id\)/);
        expect(body).toMatch(/GROUP BY hits\.pk;\s*$/);
        // Enabled and in force is checked once, over every way a warning matched.
        expect(body).toMatch(
            /FROM hits\s+JOIN public\.official_alerts AS a ON a\.id = hits\.id\s+JOIN public\.official_alert_providers AS p ON p\.id = a\.provider_id AND p\.enabled\s+WHERE a\.expires_at IS NULL OR a\.expires_at > now\(\)/,
        );
    });

    it('reaches a marine warning 3 NM past its shape, so a boat at its berth is told; land stays exact', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.official_alerts_watch_match'));
        const body = fn.slice(0, fn.indexOf('$fn$;'));
        // NWS's marine zone letters, the same as classify.ts reads for marine fog, smoke and ash.
        const marine = `'^nws:[a-z]+:(${NWS_MARINE_ZONE_AREAS.join('|')})Z[0-9]{3}$'`;
        expect(body.split(marine)).toHaveLength(3);
        // A marine zone within 3 NM (5556 m on the sphere), after a box the GiST index answers.
        expect(body).toMatch(/3\.0 \/ 60 \/ greatest\(cos\(radians\(nums\.lat\)\), 0\.02\) AS dx/);
        expect(body).toMatch(
            /OR \(\(z\.code ~ '[^']+' OR z\.code ~ '[^']+'\)\s+AND \(z\.geom && %1\$I\.ST_Expand\(pts\.pt, pts\.dx, pts\.dy\)\s+OR z\.geom && %1\$I\.ST_Expand\(pts\.pt_east, pts\.dx, pts\.dy\)\)\s+AND %1\$I\.ST_DWithin\(z\.geom::%1\$I\.geography, pts\.pt::%1\$I\.geography, 5556\)\)\)/,
        );
        // A marine warning's own polygon (NWS, naming marine zones only) too; any other polygon exactly.
        expect(body).toMatch(
            /AND \(\(a\.provider_id = 'nws'\s+AND cardinality\(a\.zones\) > 0\s+AND NOT EXISTS \(\s+SELECT 1 FROM unnest\(a\.zones\) AS zc\(code\)\s+WHERE zc\.code !~ '[^']+'\s+\)\)\s+OR a\.provider_id ~ '[^']+'\)\s+AND %1\$I\.ST_DWithin\(a\.geom::%1\$I\.geography, pts\.pt::%1\$I\.geography, 5556\)/,
        );
        // The land match is the exact one: a land zone needs its shape to hold the point.
        expect(body).toMatch(
            /AND \(%1\$I\.ST_Intersects\(z\.geom, pts\.pt\) OR %1\$I\.ST_Intersects\(z\.geom, pts\.pt_east\)\s+OR \(\(z\.code ~/,
        );
        // The marine letters are not any US state's or territory's (a land zone never reaches 3 NM).
        const states =
            'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP';
        for (const st of states.split(' ')) expect(NWS_MARINE_ZONE_AREAS).not.toContain(st);
    });

    it('reaches a MeteoAlarm outline or polygon 3 NM too, as official_alerts_at does (129-05b)', () => {
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.official_alerts_watch_match'));
        const body = fn.slice(0, fn.indexOf('$fn$;'));
        // MeteoAlarm's EMMA_ID outlines are land areas: a boat at its berth is just outside them.
        expect(body).toMatch(
            /OR \(\(z\.code ~ '[^']+' OR z\.code ~ '\^EMMA_ID:'\)\s+AND \(z\.geom && %1\$I\.ST_Expand\(pts\.pt, pts\.dx, pts\.dy\)/,
        );
        // And a MeteoAlarm warning's own polygon (MET Norway's sea areas, Estonia's harbours).
        expect(body).toMatch(
            /WHERE zc\.code !~ '[^']+'\s+\)\)\s+OR a\.provider_id ~ '\^meteoalarm-'\)\s+AND %1\$I\.ST_DWithin\(a\.geom::%1\$I\.geography, pts\.pt::%1\$I\.geography, 5556\)/,
        );
        const at = readFileSync(join(held, '20261014150000_official_alerts.sql'), 'utf8');
        expect(at).toContain("meteoalarm_zone CONSTANT text := '^EMMA_ID:';");
    });

    it('answers the app’s switch with when the watcher last ran, and nothing else', () => {
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.official_alerts_watch_status (');
        expect(sql).toContain('ALTER TABLE public.official_alerts_watch_status ENABLE ROW LEVEL SECURITY;');
        expect(sql).toContain('REVOKE ALL ON public.official_alerts_watch_status FROM PUBLIC, anon, authenticated;');
        const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.official_alerts_watch_status()'));
        expect(fn.slice(0, fn.indexOf('$$;'))).toMatch(
            /RETURNS TABLE \(ran_at timestamptz\)[\s\S]*SECURITY DEFINER\s+SET search_path = pg_catalog, public/,
        );
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.official_alerts_watch_status\(\) FROM PUBLIC, anon;/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.official_alerts_watch_status\(\) TO authenticated;/);
    });

    it('schedules the watcher every 5 minutes, two minutes after each ingest, clear of the other watchers', () => {
        expect(sql).toContain("job_name CONSTANT TEXT := 'official-alerts-watch';");
        expect(sql).toContain("want_schedule CONSTANT TEXT := '4-59/5 * * * *';");
        expect(sql).toContain(
            "want_command CONSTANT TEXT := 'SELECT public.invoke_edge_function(''official-alerts-watch'', 120000)';",
        );
        const minutes = Array.from({ length: 12 }, (_, i) => 4 + 5 * i);
        // ingest at 2-59/5; check-weather-alerts at :00 and :30; cyclone-watch at :10 and :40.
        for (const taken of [0, 30, 10, 40, ...Array.from({ length: 12 }, (_, i) => 2 + 5 * i)]) {
            expect(minutes).not.toContain(taken);
        }
        // A paused job is left paused; an exact active one is left alone (the shore-watch pattern).
        expect(sql).toMatch(/IF paused > 0 THEN[\s\S]*left paused/);
        expect(sql).toMatch(/IF total = 1 AND exact = 1 THEN\s*RETURN;/);
    });
});
