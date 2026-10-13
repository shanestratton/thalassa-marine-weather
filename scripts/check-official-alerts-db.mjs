/**
 * Execute the held official-alerts migration (129-05) in isolated, in-memory
 * PostgreSQL with real PostGIS, and test official_alerts_at() by SQL at
 * Chesapeake Bay, Marseille and Tokyo Bay. No project credentials, database
 * connection or persistent database is used.
 *
 * Install these pinned packages in a temporary directory OUTSIDE this repo
 * (the ones scripts/check-cruising-catalogue-db.mjs uses):
 * npm install --prefix /absolute/temp/path --ignore-scripts --no-audit --no-fund \
 *   --save-exact @electric-sql/pglite@0.5.8 @electric-sql/pglite-postgis@0.2.8
 * PGLITE_MODULE_PATH=/absolute/temp/path/node_modules/@electric-sql/pglite/dist/index.js \
 * PGLITE_POSTGIS_MODULE_PATH=/absolute/temp/path/node_modules/@electric-sql/pglite-postgis/dist/index.js \
 *   node scripts/check-official-alerts-db.mjs
 *
 * What it proves, in both PostGIS schemas (public and extensions):
 * - the file applies twice (a re-run is a no-op) and leaves exactly the two
 *   cron jobs, as declared;
 * - in force, expired, withdrawn and outside; a polygon match versus a zone
 *   match; a shape across 180 degrees;
 * - coverage live, partial (a warning in force that cannot be placed yet),
 *   unavailable (failing, stopped, never answered), off and not covered;
 * - official_alerts_apply() writes nothing for an unchanged alert (the row's
 *   xmin does not move), refuses a provider whose flag is off, withdraws once;
 * - prune_official_alerts() removes alerts 24 h after expiry or withdrawal;
 * - privileges: anon cannot call the RPC or read a table; authenticated can
 *   call the RPC only.
 * PGlite is PostgreSQL compiled to WASM, not the deployed Supabase server, and
 * its PostGIS package is experimental. Single-session tests do not establish
 * concurrency, PostgREST behaviour or production query plans.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.PGLITE_MODULE_PATH;
const postgisPath = process.env.PGLITE_POSTGIS_MODULE_PATH;
if (!modulePath || !postgisPath) {
    throw new Error('Set PGLITE_MODULE_PATH and PGLITE_POSTGIS_MODULE_PATH to isolated package installations.');
}
const { PGlite } = await import(pathToFileURL(modulePath).href);
const { postgis } = await import(pathToFileURL(postgisPath).href);
const migration = await readFile(
    new URL('../supabase/held-migrations/20261014150000_official_alerts.sql', import.meta.url),
    'utf8',
);
let checks = 0;
const eq = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
};

const box = (w, s, e, n) => ({
    type: 'MultiPolygon',
    coordinates: [
        [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    ],
});
const hash = (c) => c.repeat(64);
const info = (event, extra = {}) => ({
    language: 'en-US',
    event,
    headline: `${event} (test text)`,
    description: 'Fictional text for the database check.',
    severity: 'Moderate',
    urgency: 'Expected',
    certainty: 'Likely',
    areaDesc: ['Fictional area'],
    ...extra,
});
const alert = (identifier, over = {}) => ({
    identifier,
    sender: 'fixture',
    sent_at: new Date(Date.now() - 3_600_000).toISOString(),
    msg_type: 'Alert',
    status: 'Actual',
    scope: 'Public',
    refs: [],
    infos: [info('Small Craft Advisory')],
    zones: [],
    geometry: null,
    effective_at: null,
    onset_at: null,
    expires_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    content_hash: hash('a'),
    ...over,
});

async function runSchema(schema) {
    const db = new PGlite({ extensions: { postgis } });
    const query = async (sql, params = []) => (await db.query(sql, params)).rows;
    const asService = async (sql, params = []) => {
        await db.exec('RESET ROLE; SET ROLE service_role');
        try {
            return await query(sql, params);
        } finally {
            await db.exec('RESET ROLE');
        }
    };
    const apply = (provider, upserts = [], withdraw = [], zones = [], status = null) =>
        asService('SELECT public.official_alerts_apply($1, $2::jsonb, $3::text[], $4::jsonb, $5::jsonb) AS r', [
            provider,
            JSON.stringify(upserts),
            withdraw,
            JSON.stringify(zones),
            status ? JSON.stringify(status) : null,
        ]).then((rows) => rows[0].r);
    const at = async (lat, lon, role = 'authenticated') => {
        await db.exec(`RESET ROLE; SET ROLE ${role}`);
        try {
            return (await query('SELECT public.official_alerts_at($1, $2) AS r', [lat, lon]))[0].r;
        } finally {
            await db.exec('RESET ROLE');
        }
    };
    const live = (id) =>
        query(
            `UPDATE public.official_alert_providers SET last_success_at = now(), unavailable_since = NULL WHERE id = $1`,
            [id],
        );
    try {
        await db.exec(`
            CREATE ROLE anon;
            CREATE ROLE authenticated;
            CREATE ROLE service_role BYPASSRLS;
            CREATE SCHEMA extensions;
            GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
            CREATE EXTENSION postgis WITH SCHEMA ${schema};
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY);
            CREATE SCHEMA cron;
            CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean NOT NULL DEFAULT true);
            CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS
                'INSERT INTO cron.job (jobname, schedule, command) VALUES (n, s, c) RETURNING jobid';
            CREATE FUNCTION cron.unschedule(id bigint) RETURNS boolean LANGUAGE sql AS
                'DELETE FROM cron.job WHERE jobid = id RETURNING true';
            CREATE FUNCTION public.invoke_edge_function(text, integer DEFAULT 30000, jsonb DEFAULT '{}') RETURNS void
                LANGUAGE sql AS 'SELECT';
            CREATE FUNCTION public.block_tombstoned_account_write() RETURNS trigger LANGUAGE plpgsql AS
                'BEGIN RETURN NEW; END';
        `);
        await db.exec(migration);
        await db.exec(migration); // a re-run is a no-op
        eq(
            (await query('SELECT jobname, schedule, command FROM cron.job ORDER BY jobname')).map((r) => [
                r.jobname,
                r.schedule,
                r.command,
            ]),
            [
                [
                    'official-alerts-ingest',
                    '2-59/5 * * * *',
                    "SELECT public.invoke_edge_function('ingest-official-alerts', 120000)",
                ],
                ['official-alerts-prune', '17 * * * *', 'SELECT public.prune_official_alerts()'],
            ],
            `${schema}: two cron jobs, as declared, after two runs`,
        );
        eq(
            (await query('SELECT id FROM public.official_alert_providers WHERE enabled ORDER BY id')).map((r) => r.id),
            ['eccc', 'nws'],
            `${schema}: only NWS and ECCC start on (JMA waits for its area outlines)`,
        );
        eq(
            Number(
                (
                    await query(
                        "SELECT count(*) AS n FROM public.official_alert_providers WHERE id LIKE 'meteoalarm-%'",
                    )
                )[0].n,
            ),
            39,
            `${schema}: 39 MeteoAlarm rows`,
        );

        // ── Chesapeake Bay (NWS) ──
        await live('nws');
        const upper = box(-76.55, 38.95, -76.25, 39.35);
        eq(
            await apply(
                'nws',
                [
                    alert('zone-sca', { zones: ['nws:forecast:ANZ531', 'nws:forecast:ANZ532'] }),
                    alert('poly-smw', {
                        geometry: box(-76.5, 38.3, -76.2, 38.6),
                        infos: [info('Special Marine Warning')],
                        content_hash: hash('b'),
                    }),
                    alert('expired', {
                        geometry: upper,
                        expires_at: new Date(Date.now() - 3_600_000).toISOString(),
                        content_hash: hash('c'),
                    }),
                    alert('gone', { geometry: upper, content_hash: hash('d') }),
                    alert('across-180', {
                        geometry: {
                            type: 'MultiPolygon',
                            coordinates: [
                                [
                                    [
                                        [179.5, 51],
                                        [180.5, 51],
                                        [180.5, 52],
                                        [179.5, 52],
                                        [179.5, 51],
                                    ],
                                ],
                            ],
                        },
                        content_hash: hash('e'),
                    }),
                ],
                ['gone'],
                [
                    {
                        code: 'nws:forecast:ANZ531',
                        name: 'Fictional zone',
                        geometry: upper,
                        source_url: 'https://api.weather.gov/zones/forecast/ANZ531',
                    },
                ],
            ),
            { upserted: 5, withdrawn: 1, zones: 1 },
            `${schema}: first apply`,
        );
        let r = await at(39.1, -76.4);
        eq(r.coverage, 'partial', `${schema}: upper bay: live, but ANZ532 has no shape yet, so not an all-clear`);
        eq(
            r.alerts.map((a) => [a.identifier, a.matched_by]),
            [['zone-sca', 'zone']],
            `${schema}: upper bay: the zone alert only (expired and withdrawn ones are out)`,
        );
        eq(r.alerts[0].infos[0].description, 'Fictional text for the database check.', `${schema}: text verbatim`);
        eq(
            r.providers.map((p) => [p.id, p.state, p.unplaced, p.unplaced_newest?.identifier]),
            [['nws', 'live', 1, 'zone-sca']],
            `${schema}: ANZ532 has no shape`,
        );
        await apply(
            'nws',
            [],
            [],
            [
                {
                    code: 'nws:forecast:ANZ532',
                    name: 'Fictional zone 2',
                    geometry: box(-76.6, 38.7, -76.3, 38.95),
                    source_url: 'https://api.weather.gov/zones/forecast/ANZ532',
                },
            ],
        );
        r = await at(39.1, -76.4);
        eq([r.coverage, r.unplaced], ['live', 0], `${schema}: every NWS warning placed: live`);
        eq(
            (
                await query(
                    "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'official_alerts_live_unplaced'",
                )
            )[0].n,
            1,
            `${schema}: the unplaced index`,
        );
        r = await at(38.45, -76.35);
        eq(
            r.alerts.map((a) => [a.identifier, a.matched_by]),
            [['poly-smw', 'polygon']],
            `${schema}: polygon match`,
        );
        r = await at(37.0, -75.9);
        eq([r.coverage, r.alerts.length], ['live', 0], `${schema}: covered, nothing in force at the bay mouth`);
        eq(
            (await at(51.5, -179.9)).alerts.map((a) => a.identifier),
            ['across-180'],
            `${schema}: west of 180`,
        );
        eq(
            (await at(51.5, 179.9)).alerts.map((a) => a.identifier),
            ['across-180'],
            `${schema}: east of 180`,
        );

        // Unchanged: nothing written (xmin stays); changed: one row; withdraw once.
        const xmin = async (id) =>
            (await asService('SELECT xmin::text AS x FROM public.official_alerts WHERE identifier = $1', [id]))[0].x;
        const before = await xmin('zone-sca');
        eq(
            await apply('nws', [alert('zone-sca', { zones: ['nws:forecast:ANZ531', 'nws:forecast:ANZ532'] })]),
            { upserted: 0, withdrawn: 0, zones: 0 },
            `${schema}: an unchanged alert is not written`,
        );
        eq(await xmin('zone-sca'), before, `${schema}: the row was not rewritten`);
        eq(
            (await apply('nws', [alert('zone-sca', { zones: ['nws:forecast:ANZ531'], content_hash: hash('f') })]))
                .upserted,
            1,
            `${schema}: a changed alert is one write`,
        );
        eq((await apply('nws', [], ['poly-smw'])).withdrawn, 1, `${schema}: withdrawn once`);
        eq((await apply('nws', [], ['poly-smw'])).withdrawn, 0, `${schema}: and never twice`);

        // Coverage states.
        await query(
            "UPDATE public.official_alert_providers SET unavailable_since = now() - interval '20 minutes' WHERE id = 'nws'",
        );
        r = await at(39.1, -76.4);
        eq(
            [r.coverage, r.providers[0].state, r.alerts.length],
            ['unavailable', 'unavailable', 1],
            `${schema}: failing`,
        );
        await query(
            "UPDATE public.official_alert_providers SET unavailable_since = NULL, last_success_at = now() - interval '31 minutes' WHERE id = 'nws'",
        );
        r = await at(39.1, -76.4);
        eq(r.coverage, 'unavailable', `${schema}: stopped (no success for 31 min)`);
        await live('nws');
        r = await at(43.65, -79.38); // Toronto: ECCC, never answered
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state, p.since])],
            ['unavailable', [['eccc', 'unavailable', null]]],
            `${schema}: never answered`,
        );
        r = await at(43.3, 5.37); // Marseille
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state])],
            ['off', [['meteoalarm-fr', 'off']]],
            `${schema}: Marseille, provider off`,
        );
        eq((await at(-27.2, 153.1)).coverage, 'off', `${schema}: Newport, the Bureau is off`);
        eq((await at(0, -150)).coverage, 'none', `${schema}: mid-Pacific, not covered`);

        // ── Tokyo Bay (JMA, off until its outlines are loaded) ──
        eq((await at(35.5, 139.8)).coverage, 'off', `${schema}: Tokyo Bay, JMA off`);
        await query("UPDATE public.official_alert_providers SET enabled = true WHERE id = 'jma'");
        await live('jma');
        await apply('jma', [
            alert('jma:VPCU51:010000:21', {
                zones: ['jma-sea:9991'],
                expires_at: null,
                infos: [info('海上強風警報', { language: 'ja-JP', description: '東京湾（架空）では　南西の風が強く' })],
                content_hash: hash('9'),
            }),
        ]);
        r = await at(35.5, 139.8);
        eq(
            [r.coverage, r.alerts.length, r.unplaced],
            ['partial', 0, 1],
            `${schema}: Tokyo Bay: one warning unplaced, so partial, never live`,
        );
        eq(r.providers[0].unplaced_newest.event, '海上強風警報', `${schema}: named, in Japanese`);
        await apply(
            'jma',
            [],
            [],
            [{ code: 'jma-sea:9991', name: '東京湾（架空）', geometry: box(139.6, 35.2, 140.1, 35.7) }],
        );
        r = await at(35.5, 139.8);
        eq(
            [r.coverage, r.alerts.map((a) => [a.identifier, a.matched_by, a.infos[0].description]), r.unplaced],
            ['live', [['jma:VPCU51:010000:21', 'zone', '東京湾（架空）では　南西の風が強く']], 0],
            `${schema}: Tokyo Bay: placed by its zone once the shape is loaded`,
        );

        // A provider that is off is refused.
        await assert.rejects(
            () => apply('meteoalarm-fr', [alert('x')]),
            (e) => e.code === '42501',
        );
        checks++;

        // Pruning: 24 h after expiry or withdrawal.
        await query(
            "UPDATE public.official_alerts SET expires_at = now() - interval '25 hours' WHERE identifier = 'expired'",
        );
        await query(
            "UPDATE public.official_alerts SET withdrawn_at = now() - interval '25 hours' WHERE identifier = 'gone'",
        );
        eq((await asService('SELECT public.prune_official_alerts() AS n'))[0].n, 2, `${schema}: pruned two`);
        eq(
            (await query("SELECT count(*)::int AS n FROM public.official_alerts WHERE identifier = 'poly-smw'"))[0].n,
            1,
            `${schema}: a warning withdrawn minutes ago is kept`,
        );

        // Privileges.
        await assert.rejects(
            () => at(39.1, -76.4, 'anon'),
            (e) => e.code === '42501',
        );
        checks++;
        await db.exec('RESET ROLE; SET ROLE authenticated');
        await assert.rejects(
            () => query('SELECT 1 FROM public.official_alerts'),
            (e) => e.code === '42501',
        );
        await db.exec('RESET ROLE');
        checks++;
    } finally {
        await db.close();
    }
}

for (const schema of ['public', 'extensions']) await runSchema(schema);
console.log(`PASS: ${checks} executed PostgreSQL/PostGIS official-alerts assertions across both extension schemas.`);
