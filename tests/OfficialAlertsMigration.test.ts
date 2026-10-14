import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    HEARTBEAT_MS,
    PROVIDER_TIMEOUT_MS,
    REALTIME_APP_MS,
    REALTIME_HEARTBEAT_MS,
    REALTIME_LIVE_MS,
    RUN_BUDGET_MS,
    RUN_PERIOD_MS,
} from '../supabase/functions/_shared/official-alerts/ingest';
import { SIMPLIFY_DEGREES } from '../supabase/functions/_shared/official-alerts/normalize';
import {
    METEOALARM_LINK,
    meteoAlarmParticipants,
    METEOALARM_SOURCE,
} from '../supabase/functions/_shared/official-alerts/meteoalarm';

// The official warnings' tables, write call, point query, pruning and cron jobs
// (129-05). Written with 129, NOT pushed: supabase db push applies every file
// in supabase/migrations, and this one waits until Shane has deployed
// ingest-official-alerts. It is released by moving it into
// supabase/migrations under a stamp newer than the newest applied one, and this
// test is rewritten in that same commit to read the released file and assert
// the held copy is gone (the b85cd258d vault-limits release).
//
// Nothing here touches a database: the SQL is checked statically (a lexer for
// quotes, dollar quotes and brackets, the repo's own migration audit run on a
// copy, and the rules below). The behaviour at Chesapeake Bay, Marseille and
// Tokyo Bay is exercised in isolated PGlite/PostGIS by
// scripts/check-official-alerts-db.mjs, run with Shane's yes.
const FILE = '20261014150000_official_alerts.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const between = (from: string, to: string) => sql.slice(sql.indexOf(from), sql.indexOf(to, sql.indexOf(from)));
const rpc = between('CREATE OR REPLACE FUNCTION public.official_alerts_at', '$fn$;');
const apply = between('CREATE OR REPLACE FUNCTION public.official_alerts_apply', '$fn$;');
const zoneSync = between('CREATE OR REPLACE FUNCTION public.official_alert_zones_sync', '$fn$;');

/** Quotes, dollar quotes, comments and brackets: balanced, and every top-level statement ends in ';'. */
function lex(text: string): { ok: boolean; problem?: string; statements: string[] } {
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
        if (rest.startsWith('/*')) {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) return { ok: false, problem: 'open block comment', statements };
            i = end + 2;
            continue;
        }
        if (text[i] === "'") {
            let j = i + 1;
            for (;;) {
                const q = text.indexOf("'", j);
                if (q < 0) return { ok: false, problem: `open string at ${i}`, statements };
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
            if (end < 0) return { ok: false, problem: `open ${dollar[0]} at ${i}`, statements };
            i = end + dollar[0].length;
            continue;
        }
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
        if (depth < 0) return { ok: false, problem: `unbalanced ) at ${i}`, statements };
        if (text[i] === ';' && depth === 0) {
            statements.push(text.slice(start, i).trim());
            start = i + 1;
        }
        i++;
    }
    if (depth !== 0) return { ok: false, problem: 'unbalanced (', statements };
    if (text.slice(start).replace(/--.*$/gm, '').trim()) return { ok: false, problem: 'trailing text', statements };
    return { ok: true, statements };
}

/** Ray casting on a WKT ring list (lon lat pairs). */
function inside(rings: number[][][], lon: number, lat: number): boolean {
    return rings.some((ring) => {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    });
}

/** Every seeded provider's coverage, read from the migration itself. */
function coverage(): Map<string, number[][][]> {
    const out = new Map<string, number[][][]>();
    for (const m of migration.matchAll(
        /\(\s*'([a-z-]+)', '(nws|eccc|jma|cap)',[\s\S]*?MULTIPOLYGON\(([\s\S]*?)', 4326\)\)/g,
    )) {
        const wkt = m[3].replace(/'\s*\|\|\s*'/g, '');
        const rings = [...wkt.matchAll(/\(\(?([-0-9. ,]+)\)/g)].map((r) =>
            r[1]
                .replace(/^\(/, '')
                .split(',')
                .map((pair) => pair.trim().split(/\s+/).map(Number)),
        );
        out.set(m[1], rings);
    }
    for (const m of migration.matchAll(
        /\('([a-z]{2})', '[a-z-]+', '[^']+', '[^']+', (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/g,
    )) {
        const [w, s, e, n] = [m[2], m[3], m[4], m[5]].map(Number);
        out.set(`meteoalarm-${m[1]}`, [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ]);
    }
    return out;
}
const covering = (lat: number, lon: number) =>
    [...coverage()]
        .filter(([, rings]) => inside(rings, lon, lat))
        .map(([id]) => id)
        .sort();

describe('official alerts migration', () => {
    it('is held out of supabase/migrations, so the 129 release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('official_alert'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261014150000_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
    });

    it('parses: quotes, dollar quotes and brackets balance, and every statement is one the file means to run', () => {
        const top = lex(migration);
        expect(top.problem).toBeUndefined();
        for (const s of top.statements) {
            expect(s.replace(/^(--.*\n|\s)+/, '')).toMatch(/^(SET|RESET|DO|CREATE|ALTER|REVOKE|GRANT|DROP|INSERT)\b/);
        }
        // The bodies built with format(): balanced too, once the PostGIS schema is put in.
        const bodies = [...migration.matchAll(/format\(\$definition\$([\s\S]*?)\$definition\$, gis\)/g)].map((m) =>
            m[1].replace(/%1\$I/g, 'extensions'),
        );
        expect(bodies).toHaveLength(4);
        for (const body of bodies) {
            const inner = lex(body);
            expect(inner.problem).toBeUndefined();
            expect(inner.statements).toHaveLength(1);
            expect(inner.statements[0]).toMatch(/^CREATE OR REPLACE FUNCTION public\.official_alert/);
            expect(body).not.toMatch(/%(?!1\$I)/);
            const fn = /\$fn\$([\s\S]*)\$fn\$/.exec(body)![1];
            expect(lex(fn.replace(/;\s*$/, ';')).problem).toBeUndefined();
        }
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });

    it('passes the repo’s migration audit as if released (definer search_path pinned, EXECUTE stated)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'official-alerts-audit-'));
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
        // The audit splits on $$; a definer built inside format() is checked here by name.
        expect(rpc).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public, extensions, pg_temp/);
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\.official_alerts_at\(double precision, double precision\) FROM PUBLIC, anon;/,
        );
        expect(sql).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.official_alerts_at\(double precision, double precision\) TO authenticated, service_role;/,
        );
    });

    it('keeps every table private to the service role, the deliveries behind the account-deletion fence', () => {
        for (const t of [
            'official_alert_providers',
            'official_alerts',
            'official_alert_zones',
            'official_alert_deliveries',
        ]) {
            expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t} (`);
            expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
            expect(sql).toContain(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
            expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${t} TO service_role;`);
        }
        expect(sql).not.toMatch(/CREATE POLICY/);
        expect(sql).toMatch(/user_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
        expect(sql).toMatch(/alert_id BIGINT NOT NULL REFERENCES public\.official_alerts\(id\) ON DELETE CASCADE/);
        expect(sql).toMatch(
            /CREATE TRIGGER account_deletion_write_fence\s+BEFORE INSERT OR UPDATE ON public\.official_alert_deliveries\s+FOR EACH ROW EXECUTE FUNCTION public\.block_tombstoned_account_write\('user_id'\);/,
        );
    });

    it('one row per provider and CAP identifier, with a content hash and a ~100 m MultiPolygon', () => {
        expect(sql).toContain('CONSTRAINT official_alerts_provider_identifier UNIQUE (provider_id, identifier)');
        expect(sql).toContain("content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$')");
        expect(sql).toContain('geom geometry(MultiPolygon, 4326),');
        expect(sql).toMatch(
            /ST_SimplifyPreserveTopology\(\s*%1\$I\.ST_SetSRID\(%1\$I\.ST_GeomFromGeoJSON\(g::text\), 4326\), 0\.0009\)/,
        );
        expect(SIMPLIFY_DEGREES).toBe(0.0009);
        expect(sql).toMatch(/ST_Multi\(%1\$I\.ST_CollectionExtract\(%1\$I\.ST_MakeValid\(/);
    });

    it('official_alerts_apply writes only what changed and refuses a provider whose flag is off', () => {
        expect(apply).toContain('SECURITY INVOKER');
        expect(apply).toContain('ON CONFLICT (provider_id, identifier) DO UPDATE SET');
        expect(apply).toContain(
            'WHERE a.content_hash IS DISTINCT FROM EXCLUDED.content_hash OR a.withdrawn_at IS NOT NULL',
        );
        expect(apply).toMatch(
            /SET withdrawn_at = now\(\), updated_at = now\(\)\s+WHERE a\.provider_id = p_provider\s+AND a\.identifier = ANY/,
        );
        expect(apply).toContain('AND a.withdrawn_at IS NULL;');
        expect(apply).toContain("RAISE EXCEPTION 'official_alerts_apply: the provider''s licence flag is off'");
        expect(apply).toMatch(/OR %1\$I\.ST_AsBinary\(t\.geom\) IS DISTINCT FROM %1\$I\.ST_AsBinary\(EXCLUDED\.geom\)/);
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.official_alerts_apply(text, jsonb, text[], jsonb, jsonb) FROM PUBLIC, anon, authenticated;',
        );
        expect(sql).toContain(
            'GRANT EXECUTE ON FUNCTION public.official_alerts_apply(text, jsonb, text[], jsonb, jsonb) TO service_role;',
        );
    });

    it('official_alerts_at: in force means not withdrawn and not expired; a polygon matches, else a zone', () => {
        const inForce =
            /a\.withdrawn_at IS NULL\s+(AND a\.geom IS NULL\s+)?AND \(a\.expires_at IS NULL OR a\.expires_at > now\(\)\)/g;
        expect(rpc.match(inForce)).toHaveLength(4);
        expect(rpc).toMatch(/AND \(%1\$I\.ST_Intersects\(a\.geom, pt\) OR %1\$I\.ST_Intersects\(a\.geom, pt_east\)\)/);
        // A zone match only for a warning with no polygon of its own, and only the provider's own zones.
        expect(rpc).toMatch(
            /AND a\.geom IS NULL\s+AND a\.zones && \(SELECT coalesce\(array_agg\(zh\.code\), '\{\}'::text\[\]\) FROM zone_hits AS zh\)/,
        );
        expect(rpc).toContain('WHERE zh.provider_id = a.provider_id AND zh.code = ANY (a.zones)');
        expect(rpc).toContain("'matched_by', h.matched_by");
        // A marine warning reaches 3 NM past its shape (129-06 review): a berth outside NWS's marine
        // zone is told of the gale on the water outside, and the answer says it is 'nearby'.
        expect(rpc).toContain(
            "marine_zone CONSTANT text := '^nws:[a-z]+:(AM|AN|GM|PZ|PK|PH|PM|PS|LM|LS|LH|LO|LE|LC|SL)Z[0-9]{3}$';",
        );
        expect(rpc).toContain('reach_m CONSTANT double precision := 5556;');
        expect(rpc).toMatch(
            /OR \(\(z\.code ~ marine_zone OR z\.code ~ meteoalarm_zone\)\s+AND \(z\.geom && near_box OR z\.geom && near_box_east\)\s+AND %1\$I\.ST_DWithin\(z\.geom::%1\$I\.geography, pt::%1\$I\.geography, reach_m\)\)/,
        );
        // MeteoAlarm's outlines are land areas: a berth, or a boat off the coast, is just outside them
        // (129-05b). An EMMA_ID outline and a MeteoAlarm polygon reach 3 NM too, as 'nearby'.
        expect(rpc).toContain("meteoalarm_zone CONSTANT text := '^EMMA_ID:';");
        expect(rpc).toMatch(
            /WHERE zc\.code !~ marine_zone\)\)\s+OR a\.provider_id ~ '\^meteoalarm-'\)\s+AND %1\$I\.ST_DWithin\(a\.geom::%1\$I\.geography, pt::%1\$I\.geography, reach_m\)/,
        );
        expect(rpc).toContain("THEN 'zone'::text ELSE 'nearby'::text END");
        // An exact match wins over 'nearby' for the same warning.
        expect(rpc).toContain("ORDER BY hits.id, hits.matched_by = 'nearby', hits.matched_by");
        expect(rpc).toContain('pt_east := %1$I.ST_SetSRID(%1$I.ST_MakePoint(p_lon + 360, p_lat), 4326);');
        // Only providers whose flag is on are answered from, and every info block goes back verbatim.
        expect(rpc).toContain('JOIN public.official_alert_providers AS p ON p.id = a.provider_id AND p.enabled');
        expect(rpc).toContain("'infos', a.infos");
        expect(rpc).toContain("'attribution', p.attribution");
        expect(rpc).toMatch(
            /RAISE EXCEPTION 'official_alerts_at: latitude or longitude out of range' USING ERRCODE = '22023'/,
        );
    });

    it('official_alerts_at: a coverage answer that is never a false all-clear', () => {
        expect(rpc).toMatch(
            /WHEN NOT p\.enabled THEN 'off'\s+WHEN p\.unavailable_since IS NOT NULL THEN 'unavailable'\s+WHEN p\.last_success_at IS NULL\s+OR p\.last_success_at < now\(\) - CASE WHEN p\.adapter = 'meteoalarm' THEN realtime_live ELSE stale_after END\s+THEN 'unavailable'\s+ELSE 'live'/,
        );
        expect(rpc).toContain("stale_after CONSTANT interval := interval '30 minutes';");
        // Since when: failing since, else the last success (null when never answered); none while live or off.
        expect(rpc).toContain("CASE WHEN h.state = 'unavailable' THEN h.last_or_failing END AS since");
        // Any enabled provider there that is not live makes the whole answer unavailable; a live one with
        // warnings in force it cannot place (no polygon, a zone with no shape yet) makes it partial, never
        // live; "off" only when nothing on covers it.
        expect(rpc).toMatch(
            /'coverage', CASE\s+WHEN EXISTS \(SELECT 1 FROM prov WHERE prov\.enabled AND prov\.state <> 'live'\) THEN 'unavailable'\s+WHEN EXISTS \(SELECT 1 FROM prov JOIN unplaced AS u ON u\.provider_id = prov\.id WHERE prov\.state = 'live'\) THEN 'partial'\s+WHEN EXISTS \(SELECT 1 FROM prov WHERE prov\.state = 'live'\) THEN 'live'\s+WHEN EXISTS \(SELECT 1 FROM prov\) THEN 'off'\s+ELSE 'none'/,
        );
        // Warnings that cannot be placed are counted, never dropped.
        expect(rpc).toMatch(/AND \(cardinality\(a\.zones\) = 0 OR EXISTS \(/);
        expect(rpc).toContain("'unplaced', coalesce(u.n, 0)");
        // Counted without building JSON for each one; only the newest is read in full.
        const unplaced = rpc.slice(
            rpc.indexOf('unplaced_rows AS ('),
            rpc.indexOf("SELECT jsonb_build_object(\n        'lat'"),
        );
        expect(unplaced).not.toMatch(/jsonb_agg|infos/);
        expect(unplaced).toMatch(
            /SELECT r\.provider_id, count\(\*\) AS n\s+FROM unplaced_rows AS r\s+GROUP BY r\.provider_id/,
        );
        expect(rpc).toMatch(/ORDER BY r\.sent_at DESC, r\.identifier\s+LIMIT 1/);
        // A healthy provider is refreshed well inside the 30 minutes, even when sharded over two slots.
        expect(HEARTBEAT_MS + 2 * RUN_PERIOD_MS).toBeLessThan(30 * 60_000);
    });

    it('MeteoAlarm is live only while its last read is under 8 minutes old, so nothing shown as live is over 10 behind (rule 5)', () => {
        // The SQL's window is ingest.ts's REALTIME_LIVE_MS.
        const m = /realtime_live CONSTANT interval := interval '(\d+) minutes';/.exec(rpc);
        expect(m).not.toBeNull();
        expect(Number(m![1]) * 60_000).toBe(REALTIME_LIVE_MS);
        // A warning missing from a live answer was published after the last read began; the app shows an
        // answer at most REALTIME_APP_MS after it was given. Together, under 10 minutes.
        expect(REALTIME_LIVE_MS + REALTIME_APP_MS).toBeLessThan(10 * 60_000);
        // A healthy country writes its last success every run, and is never older than one period plus the
        // run's own time (the budget and one provider's timeout), so a healthy country is never called stopped.
        expect(REALTIME_HEARTBEAT_MS).toBeLessThan(RUN_PERIOD_MS);
        expect(RUN_PERIOD_MS + RUN_BUDGET_MS + PROVIDER_TIMEOUT_MS).toBeLessThan(REALTIME_LIVE_MS);
    });

    it('indexes: GiST on live alert shapes and on zones, GIN on live zone keys', () => {
        expect(sql).toMatch(
            /CREATE INDEX IF NOT EXISTS official_alerts_live_geom\s+ON public\.official_alerts USING gist \(geom\) WHERE withdrawn_at IS NULL;/,
        );
        expect(sql).toMatch(
            /CREATE INDEX IF NOT EXISTS official_alerts_live_zones\s+ON public\.official_alerts USING gin \(zones\) WHERE withdrawn_at IS NULL;/,
        );
        expect(sql).toContain(
            'CREATE INDEX IF NOT EXISTS official_alert_zones_geom ON public.official_alert_zones USING gist (geom);',
        );
        // The unplaced count and its newest warning, per provider, by index.
        expect(sql).toMatch(
            /CREATE INDEX IF NOT EXISTS official_alerts_live_unplaced\s+ON public\.official_alerts \(provider_id, sent_at DESC\) WHERE withdrawn_at IS NULL AND geom IS NULL;/,
        );
        expect(migration).toContain('Indexes (EXPLAIN reasoning');
    });

    it('prunes an alert 24 h after it expires or is withdrawn, hourly', () => {
        const prune = between('CREATE OR REPLACE FUNCTION public.prune_official_alerts()', '$$;');
        expect(prune).toMatch(
            /WHERE a\.expires_at < now\(\) - interval '24 hours'\s+OR a\.withdrawn_at < now\(\) - interval '24 hours'\s+OR \(a\.expires_at IS NULL AND a\.withdrawn_at IS NULL AND a\.sent_at < now\(\) - interval '30 days'\)/,
        );
        expect(sql).toContain("('official-alerts-prune', '17 * * * *', 'SELECT public.prune_official_alerts()')");
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.prune_official_alerts() FROM PUBLIC, anon, authenticated;',
        );
    });

    it('schedules the ingest every 5 minutes on the vault credential path, the shore-watch way', () => {
        expect(sql).toContain(
            "('official-alerts-ingest', '2-59/5 * * * *',\n             'SELECT public.invoke_edge_function(''ingest-official-alerts'', 120000)')",
        );
        expect(sql).toContain("RAISE NOTICE '% is paused; left paused.");
        expect(sql).toMatch(/to_regprocedure\('public\.invoke_edge_function\(text,integer,jsonb\)'\) IS NULL/);
        expect(sql).toContain('IF total <> 2 OR declared <> 2 THEN');
    });

    it('seeds each provider with its licence flag, its reason and the credit its licence asks for', () => {
        const row = (id: string) => {
            const at = migration.indexOf(`\n    '${id}', '`);
            return migration.slice(at, migration.indexOf('ST_Multi(', at));
        };
        expect(row('nws')).toMatch(/'https:\/\/api\.weather\.gov\/alerts\/active\?status=actual', true,/);
        expect(row('nws')).toContain('https://www.weather.gov/disclaimer');
        expect(row('nws')).toContain("'Warnings: National Weather Service (NOAA)'");
        expect(row('eccc')).toMatch(/'https:\/\/dd\.weather\.gc\.ca\/', true,/);
        expect(row('eccc')).toContain('no alteration of the content or intent of the alert');
        expect(row('eccc')).toContain(
            "'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada'",
        );
        // The licence allows JMA, but its warnings name municipalities and sea areas whose outlines are not
        // loaded yet: on, every one would be unplaced. Off until they are.
        expect(row('jma')).toMatch(/feed\/extra\.xml', false,/);
        expect(row('jma')).toContain('OFF until');
        expect(row('jma')).toContain('公共データ利用規約（第1.0版）');
        expect(row('jma')).toContain('https://xml.kishou.go.jp/considerationforxml.pdf');
        expect(row('jma')).toContain('出典：気象庁防災情報XML');
        expect(row('bom')).toMatch(/NULL, false,/);
        expect(row('bom')).toContain('personal and non-commercial use only');
        // MeteoAlarm: 39 member feeds, every one ON under its own terms (129-05b). Registration is
        // optional; the six rules of the Terms and Conditions are met (the note says how).
        const meteo = between(
            'INSERT INTO public.official_alert_providers\n    (id, adapter, issuer, feed_url, enabled, licence_note, attribution, attribution_url, config, coverage)\nSELECT',
            'ON CONFLICT (id) DO NOTHING;',
        );
        expect(meteo).toMatch(
            /'https:\/\/feeds\.meteoalarm\.org\/feeds\/meteoalarm-legacy-atom-' \|\| c\.slug,\s+true,/,
        );
        expect(meteo).not.toMatch(/c\.slug,\s+false,/);
        expect(meteo).not.toContain('no reply yet');
        const note = /'(ON\. MeteoAlarm Terms and Conditions[^]*?)',\n/.exec(meteo)![1];
        for (const said of [
            'https://meteoalarm.org/en/live/page/terms-and-conditions',
            'last updated 15/03/2024',
            'CC BY 4.0',
            'Non-Registered Redistributors',
            `"${METEOALARM_SOURCE}" for more than one`,
            'the time of issue',
            'www.meteoalarm.org',
            'under 5 minutes',
            'never over 10',
            'the disclaimer',
            `"Areas: ${METEOALARM_SOURCE}"`,
        ]) {
            expect(note, said).toContain(said);
        }
        expect(note.length).toBeLessThanOrEqual(4000);
        // The source is the national service: its name in the issuer and the credit, linked to
        // www.meteoalarm.org (rule 4), never "MeteoAlarm.org (EUMETNET) and the national weather service".
        expect(meteo).toContain("c.participant || ' (MeteoAlarm)'");
        expect(meteo).toContain("'Warnings: ' || c.participant");
        expect(meteo).toContain(`'${METEOALARM_LINK}'`);
        expect(meteo).not.toContain('MeteoAlarm.org (EUMETNET) and the national weather service');
        const rows = [...meteo.matchAll(/\('([a-z]{2})', '([a-z-]+)', '([^']+)', '([^']+)', /g)];
        expect(rows).toHaveLength(39);
        expect(rows.map((m) => m[2])).toEqual(
            expect.arrayContaining(['germany', 'france', 'greece', 'republic-of-north-macedonia']),
        );
        // Each country's participants, as the shared table names them (the push and the app read it).
        for (const [, code, , , participant] of rows) {
            expect(participant, code).toBe(meteoAlarmParticipants(`meteoalarm-${code}`).join(' / '));
        }
        expect(rows.find((m) => m[1] === 'fr')![4]).toBe('Météo-France');
        expect(rows.find((m) => m[1] === 'de')![4]).toBe('Deutscher Wetterdienst (DWD)');
        expect(rows.find((m) => m[1] === 'gr')![4]).toBe('Hellenic National Meteorological Service (HNMS)');
        expect(sql.match(/ON CONFLICT \(id\) DO NOTHING;/g)).toHaveLength(2);
    });

    it('official_alert_zones_sync loads the hub’s outlines: changed ones written, removed ones dropped, service role only', () => {
        expect(zoneSync).toContain('SECURITY INVOKER');
        expect(zoneSync).toMatch(/p_provider text,\s+p_scheme text,\s+p_codes text\[\],\s+p_zones jsonb/);
        expect(zoneSync).toContain("RAISE EXCEPTION 'official_alert_zones_sync: unknown provider'");
        // Every shape sent is one of the codes kept, all under the scheme.
        expect(zoneSync).toContain(
            "RAISE EXCEPTION 'official_alert_zones_sync: every code must be under the scheme and every shape among the codes'",
        );
        // Written only when the name or the shape changed.
        expect(zoneSync).toMatch(
            /ON CONFLICT \(provider_id, code\) DO UPDATE SET[\s\S]*WHERE t\.name IS DISTINCT FROM EXCLUDED\.name\s+OR %1\$I\.ST_AsBinary\(t\.geom\) IS DISTINCT FROM %1\$I\.ST_AsBinary\(EXCLUDED\.geom\)/,
        );
        // The provider's outlines under the scheme that the hub no longer lists are removed.
        expect(zoneSync).toMatch(
            /DELETE FROM public\.official_alert_zones AS z\s+WHERE z\.provider_id = p_provider\s+AND left\(z\.code, length\(p_scheme\) \+ 1\) = p_scheme \|\| ':'\s+AND NOT \(z\.code = ANY \(coalesce\(p_codes, '\{\}'::text\[\]\)\)\);/,
        );
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.official_alert_zones_sync(text, text, text[], jsonb) FROM PUBLIC, anon, authenticated;',
        );
        expect(sql).toContain(
            'GRANT EXECUTE ON FUNCTION public.official_alert_zones_sync(text, text, text[], jsonb) TO service_role;',
        );
        expect(migration).toContain(
            'DROP FUNCTION IF EXISTS public.official_alert_zones_sync(text, text, text[], jsonb);',
        );
    });

    it('a MeteoAlarm country covers a point within 3 NM of its own outlines, box or not; one that is not live, its box where another answers', () => {
        // zone_hits first (the zones holding the point, and the marine and EMMA_ID ones within 3 NM), then
        // the providers. The others by their coverage. A MeteoAlarm one where one of its outlines is, even an
        // island or a sea area outside its box (Las Palmas, the Irish Sea), so open sea is never "live,
        // nothing in force"; and, while it is failing, stopped or never answered, where its box holds a point
        // another provider answers for, so a polygon-only country's failure is never hidden behind a
        // neighbour's live outline.
        expect(rpc.indexOf('WITH zone_hits AS (')).toBeGreaterThan(0);
        expect(rpc).toMatch(
            /covering AS \(\s+SELECT h\.\* FROM health AS h\s+WHERE CASE\s+WHEN h\.adapter <> 'meteoalarm' THEN %1\$I\.ST_Intersects\(h\.coverage, pt\)\s+ELSE EXISTS \(SELECT 1 FROM zone_hits AS zh WHERE zh\.provider_id = h\.id\)\s+END/,
        );
        // A MeteoAlarm country that is not live joins where its box holds a point another answers for.
        expect(rpc).toMatch(
            /SELECT \* FROM covering\s+UNION ALL\s+SELECT h\.\* FROM health AS h\s+WHERE h\.adapter = 'meteoalarm' AND h\.state = 'unavailable'\s+AND %1\$I\.ST_Intersects\(h\.coverage, pt\)\s+AND EXISTS \(SELECT 1 FROM covering\)\s+AND NOT EXISTS \(SELECT 1 FROM covering AS c WHERE c\.id = h\.id\)/,
        );
        expect(rpc.indexOf('zone_hits AS (')).toBeLessThan(rpc.indexOf('covering AS ('));
        expect(rpc.indexOf('covering AS (')).toBeLessThan(rpc.indexOf('prov AS ('));
    });

    it('every coverage ring is closed and simple (no edge crosses another), so PostGIS reads it as valid', () => {
        const cross = (a: number[], b: number[], c: number[], d: number[]) => {
            const o = (p: number[], q: number[], r: number[]) =>
                Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
            return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
        };
        const all = coverage();
        expect(all.size).toBe(4 + 39);
        for (const [id, rings] of all) {
            for (const ring of rings) {
                expect(ring[0], id).toEqual(ring[ring.length - 1]);
                expect(ring.length, id).toBeGreaterThanOrEqual(5);
                for (let i = 0; i < ring.length - 1; i++) {
                    for (let j = i + 2; j < ring.length - 1; j++) {
                        if (i === 0 && j === ring.length - 2) continue;
                        expect(cross(ring[i], ring[i + 1], ring[j], ring[j + 1]), `${id} edges ${i} and ${j}`).toBe(
                            false,
                        );
                    }
                }
            }
        }
    });

    it('coverage: Chesapeake Bay is NWS, Marseille MeteoAlarm France (near its outlines), Tokyo Bay JMA (off), Newport the Bureau (off)', () => {
        expect(covering(39.1, -76.4)).toEqual(['nws']); // upper Chesapeake Bay
        expect(covering(37.0, -76.1)).toEqual(['nws']); // Chesapeake Bay mouth
        expect(covering(43.3, 5.37)).toEqual(['meteoalarm-fr']); // Marseille
        expect(covering(35.5, 139.8)).toEqual(['jma']); // Tokyo Bay
        expect(covering(-27.2, 153.1)).toEqual(['bom']); // Newport, Moreton Bay
        expect(covering(37.94, 23.65)).toEqual(['meteoalarm-gr']); // Piraeus
        expect(covering(53.55, 9.99)).toEqual(['meteoalarm-de']); // Hamburg
        expect(covering(43.65, -79.38)).toEqual(['eccc']); // Toronto
        expect(covering(44.65, -63.57)).toEqual(['eccc']); // Halifax
        expect(covering(48.4, -123.37)).toEqual(['eccc']); // Victoria BC
        expect(covering(61.2, -149.9)).toEqual(['nws']); // Anchorage
        expect(covering(52.9, 173.2)).toEqual(['nws']); // Attu, west of 180
        expect(covering(21.3, -157.86)).toEqual(['nws']); // Honolulu
        // NWS's Alaska offshore zones, which carry CAP alerts (PKZ411 had seven in the week to 14 Oct).
        expect(covering(57.5, 178.0)).toEqual(['nws']); // PKZ411, Bering Sea offshore west of 180
        expect(covering(55.3, -150.0)).toEqual(['nws']); // PKZ352, Gulf of Alaska offshore
        expect(covering(74.0, -155.0)).toEqual(['nws']); // PKZ505, Central US Arctic offshore
        expect(covering(58.0, 175.0)).toEqual([]); // west of PKZ411's edge (the Russian side)
        // Offshore zones whose warnings are not CAP alerts here (none for PHZ180, GMZ046, ANZ910, AMZ069,
        // PZZ820 or PMZ011 in the week to 14 Oct): claimed, they would read "live" with nothing in force.
        expect(covering(25.0, -160.0)).toEqual([]); // Hawaiian offshore waters
        expect(covering(24.5, -90.0)).toEqual([]); // central Gulf offshore
        expect(covering(0, -150)).toEqual([]); // mid-Pacific: not covered
        expect(covering(-36.85, 174.76)).toEqual([]); // Auckland: no provider yet
    });
});

describe('the edge function the cron calls', () => {
    const edge = readFileSync('supabase/functions/ingest-official-alerts/index.ts', 'utf8');
    it('guards itself as a cron entry point and logs counts only', () => {
        expect(edge).toContain('requireServiceRolePost(');
        expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(edge).toContain(".from('official_alert_providers')");
        expect(edge).toContain("db.rpc('official_alerts_apply', args)");
        expect(edge).toContain(".select('identifier, content_hash, withdrawn_at, expires_at')");
        expect(edge).not.toMatch(/console\.\w+\([^)]*\b(lat|lon|feed_state|feedState)\b/);
    });

    it('is declared credentialless in config.toml with its reason', () => {
        const config = readFileSync('supabase/config.toml', 'utf8');
        const at = config.indexOf('[functions.ingest-official-alerts]');
        expect(at).toBeGreaterThan(0);
        expect(config.slice(at, config.indexOf('verify_jwt', at))).toMatch(/# .*service key/);
        expect(config.slice(at, config.indexOf('\n\n', at))).toContain('verify_jwt = false');
    });
});
