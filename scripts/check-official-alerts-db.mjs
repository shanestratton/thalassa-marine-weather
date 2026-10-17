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
 * - a berth just outside an NWS marine zone, in a land zone only, is told of
 *   the marine warning on the water outside (matched_by 'nearby', within
 *   3 NM), as is a point just outside a marine-only warning polygon; a land
 *   zone or a land polygon never reaches past its shape (129-06 review);
 * - coverage live, partial (a warning in force that cannot be placed yet),
 *   unavailable (failing, stopped, never answered), off and not covered;
 * - official_alerts_apply() writes nothing for an unchanged alert (the row's
 *   xmin does not move), refuses a provider whose flag is off, withdraws once;
 * - prune_official_alerts() removes alerts 24 h after expiry or withdrawal;
 * - privileges: anon cannot call the RPC or read a table; authenticated can
 *   call the RPC only.
 * - MeteoAlarm (129-05b): its 39 rows on; its EMMA_ID outlines loaded through
 *   official_alert_zones_sync() from the fictional Geocodes JSON
 *   (tests/fixtures/official-alerts/meteoalarm-geocodes.json, by
 *   geocodes.ts); a warning placed at Marseille, Hamburg and Athens; a berth
 *   in Marseille's harbour, just outside the département's outline, told as
 *   'nearby'; open sea 12 NM off claimed by no one ('none', never "live,
 *   nothing in force"); an updated outline written once, a removed one
 *   dropped and its warning then unplaced ('partial'); a country with no
 *   outlines (polygons only) never claiming coverage but its warning shown;
 *   a country read 9 minutes ago 'unavailable'
 *   (MeteoAlarm's real time) where NWS at 9 minutes is still live; a sea
 *   area outside its country's box (the Irish Sea) and an island outline
 *   (a fictional Canaries one) covered by their country, and 'unavailable'
 *   when it fails; and a polygon-only neighbour (the United Kingdom) that is
 *   failing turning a live Irish outline's answer 'unavailable'.
 * PGlite is PostgreSQL compiled to WASM, not the deployed Supabase server, and
 * its PostGIS package is experimental. Single-session tests do not establish
 * concurrency, PostgREST behaviour or production query plans.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { meteoAlarmGeocodeZones, zoneSyncCalls } from '../supabase/functions/_shared/official-alerts/geocodes.ts';

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
const geocodes = meteoAlarmGeocodeZones(
    JSON.parse(
        await readFile(new URL('../tests/fixtures/official-alerts/meteoalarm-geocodes.json', import.meta.url), 'utf8'),
    ),
    'https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/MeteoAlarm_Geocodes_2026_07_31.json',
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
            (
                await query(
                    "SELECT id FROM public.official_alert_providers WHERE enabled AND adapter <> 'meteoalarm' ORDER BY id",
                )
            ).map((r) => r.id),
            ['eccc', 'nws'],
            `${schema}: NWS and ECCC on (JMA waits for its area outlines, the Bureau for a licence)`,
        );
        eq(
            (
                await query(
                    "SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS on_ FROM public.official_alert_providers WHERE adapter = 'meteoalarm'",
                )
            )[0],
            { n: 39, on_: 39 },
            `${schema}: 39 MeteoAlarm rows, all on under MeteoAlarm's own terms (129-05b)`,
        );
        eq(
            (
                await query(
                    "SELECT issuer, attribution, attribution_url FROM public.official_alert_providers WHERE id = 'meteoalarm-fr'",
                )
            )[0],
            {
                issuer: 'Météo-France (MeteoAlarm)',
                attribution: 'Warnings: Météo-France',
                attribution_url: 'https://meteoalarm.org/en/live/',
            },
            `${schema}: France's credit names its national service and links to www.meteoalarm.org`,
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

        // A berth just outside the marine zone (129-06 review): NWS's marine zones end at the water, so a
        // marina is in a land zone only. A marine zone, or a marine-only warning polygon, reaches 3 NM.
        eq(
            await apply(
                'nws',
                [
                    alert('land-fog', {
                        zones: ['nws:forecast:MDZ914'],
                        infos: [info('Dense Fog Advisory')],
                        content_hash: hash('1'),
                    }),
                    alert('poly-smw-marine', {
                        geometry: box(-76.5, 38.0, -76.2, 38.2),
                        zones: ['nws:forecast:ANZ534'],
                        infos: [info('Special Marine Warning')],
                        content_hash: hash('2'),
                    }),
                    alert('poly-land', {
                        geometry: box(-76.9, 38.0, -76.56, 38.2),
                        zones: ['nws:forecast:MDZ917'],
                        infos: [info('Severe Thunderstorm Warning')],
                        content_hash: hash('3'),
                    }),
                ],
                [],
                [
                    {
                        code: 'nws:forecast:MDZ914',
                        name: 'Fictional land zone',
                        geometry: box(-76.9, 38.7, -76.6, 38.95),
                    },
                ],
            ),
            { upserted: 3, withdrawn: 0, zones: 1 },
            `${schema}: a land zone and two polygons by the bay`,
        );
        const matched = async (lat, lon) => (await at(lat, lon)).alerts.map((a) => [a.identifier, a.matched_by]).sort();
        // 1.9 NM west of ANZ532, inside the land zone: the bay's advisory, nearby, and the land fog.
        eq(
            await matched(38.8, -76.64),
            [
                ['land-fog', 'zone'],
                ['zone-sca', 'nearby'],
            ],
            `${schema}: berth 1.9 NM outside the marine zone`,
        );
        eq((await at(38.8, -76.64)).coverage, 'live', `${schema}: berth: live, with the bay's advisory listed`);
        // 7 NM west: too far for the bay's advisory.
        eq(await matched(38.8, -76.75), [['land-fog', 'zone']], `${schema}: 7 NM inland`);
        // On the water 0.9 NM east of the land zone: the land fog never reaches past its shape.
        eq(await matched(38.8, -76.58), [['zone-sca', 'zone']], `${schema}: a land zone matches exactly`);
        // 1.4 NM outside a marine-only warning polygon (and 1.4 NM outside a land one): the marine one only.
        eq(await matched(38.1, -76.53), [['poly-smw-marine', 'nearby']], `${schema}: a marine polygon reaches 3 NM`);
        // Inside it: its exact match, not 'nearby'.
        eq(await matched(38.1, -76.3), [['poly-smw-marine', 'polygon']], `${schema}: exact over nearby`);
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
        r = await at(43.3, 5.37); // Marseille, before any MeteoAlarm outline is loaded or any ingest has run
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state])],
            ['none', []],
            `${schema}: Marseille: no outline loaded yet, so France claims nothing (never an all-clear)`,
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

        // ── MeteoAlarm (129-05b): outlines, placement, the reach, coverage ──
        const sync = (call) =>
            asService('SELECT public.official_alert_zones_sync($1, $2, $3::text[], $4::jsonb) AS r', [
                call.p_provider,
                call.p_scheme,
                call.p_codes,
                JSON.stringify(call.p_zones),
            ]).then((rows) => rows[0].r);
        for (const [provider, zones] of geocodes.byProvider) {
            for (const call of zoneSyncCalls(provider, zones)) await sync(call);
        }
        eq(
            (
                await query(
                    "SELECT provider_id, count(*)::int AS n FROM public.official_alert_zones WHERE code LIKE 'EMMA_ID:%' GROUP BY provider_id ORDER BY provider_id",
                )
            ).map((x) => [x.provider_id, x.n]),
            [
                ['meteoalarm-de', 1],
                ['meteoalarm-fr', 2],
                ['meteoalarm-gr', 2],
                ['meteoalarm-ie', 1],
            ],
            `${schema}: the hub's outlines loaded per country`,
        );
        for (const id of ['meteoalarm-fr', 'meteoalarm-de', 'meteoalarm-gr', 'meteoalarm-ee']) await live(id);
        const meteo = (identifier, zone, over = {}) =>
            alert(identifier, {
                sender: 'zz@zzmet.example',
                zones: zone ? [`EMMA_ID:${zone}`] : [],
                infos: [info('Orange coastal event warning (fictional)', { language: 'en-GB' })],
                content_hash: hash('7'),
                ...over,
            });
        await apply('meteoalarm-fr', [meteo('fr-913', 'FR913'), meteo('fr-914', 'FR914', { content_hash: hash('8') })]);
        await apply('meteoalarm-de', [meteo('de-901', 'DE901')]);
        await apply('meteoalarm-gr', [meteo('gr-911', 'GR911')]);
        for (const [lat, lon, provider, identifier, where] of [
            [43.2965, 5.3698, 'meteoalarm-fr', 'fr-913', 'Marseille'],
            [53.55, 9.99, 'meteoalarm-de', 'de-901', 'Hamburg'],
            [37.98, 23.73, 'meteoalarm-gr', 'gr-911', 'Athens'],
        ]) {
            r = await at(lat, lon);
            eq(
                [
                    r.coverage,
                    r.providers.map((p) => [p.id, p.state]),
                    r.alerts.map((a) => [a.identifier, a.matched_by]),
                ],
                ['live', [[provider, 'live']], [[identifier, 'zone']]],
                `${schema}: ${where}: placed by its EMMA_ID outline`,
            );
        }
        // Marseille's Vieux-Port, in the outline's harbour notch: just outside it, so 'nearby'.
        r = await at(43.27, 5.39);
        eq(
            [r.coverage, r.alerts.map((a) => [a.identifier, a.matched_by])],
            ['live', [['fr-913', 'nearby']]],
            `${schema}: a berth just outside the département's outline is told, as nearby`,
        );
        // 12 NM off Marseille: open sea, no outline within 3 NM, so France claims nothing there.
        r = await at(43.05, 5.37);
        eq([r.coverage, r.providers, r.alerts], ['none', [], []], `${schema}: open sea: none, never "live, nothing"`);
        // An outline that changed is written once; the same again writes nothing; one the hub dropped goes.
        const fr = geocodes.byProvider.get('meteoalarm-fr');
        const moved = fr.map((z) =>
            z.code === 'EMMA_ID:FR913'
                ? { ...z, geometry: z.geometry.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + 0.01, y]))) }
                : z,
        );
        eq(
            await sync(zoneSyncCalls('meteoalarm-fr', moved)[0]),
            { zones: 1, removed: 0 },
            `${schema}: one outline updated`,
        );
        eq(
            await sync(zoneSyncCalls('meteoalarm-fr', moved)[0]),
            { zones: 0, removed: 0 },
            `${schema}: unchanged: none written`,
        );
        eq(
            await sync(
                zoneSyncCalls(
                    'meteoalarm-fr',
                    moved.filter((z) => z.code !== 'EMMA_ID:FR914'),
                )[0],
            ),
            { zones: 0, removed: 1 },
            `${schema}: an outline the hub removed is dropped`,
        );
        r = await at(43.2965, 5.3698);
        eq(
            [r.coverage, r.providers[0].unplaced, r.providers[0].unplaced_newest?.identifier],
            ['partial', 1, 'fr-914'],
            `${schema}: a warning naming a removed outline is unplaced: partial, never live`,
        );
        await assert.rejects(
            () => sync({ p_provider: 'meteoalarm-fr', p_scheme: 'EMMA_ID', p_codes: ['nws:x:ANZ531'], p_zones: [] }),
            (e) => e.code === '22023',
        );
        checks++;
        // A country whose warnings are polygons only (Estonia): it claims no coverage, but its warning shows.
        await apply('meteoalarm-ee', [
            meteo('ee-1', null, { geometry: box(24.7, 59.42, 24.8, 59.46), content_hash: hash('6') }),
        ]);
        r = await at(59.44, 24.75); // Tallinn
        eq(
            [r.coverage, r.providers, r.alerts.map((a) => [a.identifier, a.matched_by])],
            ['none', [], [['ee-1', 'polygon']]],
            `${schema}: a polygon-only country's warning is shown; it claims nothing`,
        );
        eq(
            (await at(59.45, 24.85)).alerts.map((a) => [a.identifier, a.matched_by]),
            [['ee-1', 'nearby']],
            `${schema}: a MeteoAlarm polygon reaches 3 NM`,
        );
        // MeteoAlarm's real time: a country read 9 minutes ago is unavailable (since that read); 7, live.
        // NWS keeps its 30 minutes.
        const readAgo = (id, minutes) =>
            query(
                `UPDATE public.official_alert_providers SET unavailable_since = NULL,
                     last_success_at = now() - make_interval(mins => $2) WHERE id = $1`,
                [id, minutes],
            );
        await readAgo('meteoalarm-fr', 9);
        await readAgo('nws', 9);
        r = await at(43.2965, 5.3698);
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state, p.since === p.last_success_at])],
            ['unavailable', [['meteoalarm-fr', 'unavailable', true]]],
            `${schema}: MeteoAlarm read 9 min ago: unavailable, never a stale answer as live`,
        );
        eq((await at(39.1, -76.4)).coverage, 'live', `${schema}: NWS read 9 min ago: still live`);
        await readAgo('meteoalarm-fr', 7);
        eq(
            (await at(43.2965, 5.3698)).coverage,
            'partial',
            `${schema}: MeteoAlarm read 7 min ago: live (partial here)`,
        );
        await live('meteoalarm-fr');
        await live('nws');

        // The Irish Sea, inside Ireland's sea-area outline EI901 but east of Ireland's box (it ends at -5.90),
        // and in the United Kingdom's box. The UK sends polygons only: it has no outline.
        for (const id of ['meteoalarm-ie', 'meteoalarm-gb']) await live(id);
        r = await at(53.3, -5.5);
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state])],
            ['live', [['meteoalarm-ie', 'live']]],
            `${schema}: a sea area outside its country's box is that country's`,
        );
        // 1 NM east of EI901 (a berth off its edge): still Ireland's, within 3 NM.
        r = await at(53.5, -4.97);
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state])],
            ['live', [['meteoalarm-ie', 'live']]],
            `${schema}: within 3 NM of a sea-area outline`,
        );
        // The Met Office's feed fails: the neighbour's live outline no longer answers "nothing in force".
        await query(
            "UPDATE public.official_alert_providers SET unavailable_since = now() - interval '2 hours' WHERE id = 'meteoalarm-gb'",
        );
        r = await at(53.5, -4.97);
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state])],
            [
                'unavailable',
                [
                    ['meteoalarm-gb', 'unavailable'],
                    ['meteoalarm-ie', 'live'],
                ],
            ],
            `${schema}: a failing polygon-only neighbour makes it unavailable, never a false all-clear`,
        );
        await live('meteoalarm-gb');
        // An island outline far outside its country's box (a fictional one off Gran Canaria): Spain's.
        await sync(
            zoneSyncCalls('meteoalarm-es', [
                {
                    code: 'EMMA_ID:ES999',
                    name: 'Zz costa de una isla (fictional box)',
                    geometry: box(-15.6, 28.0, -15.3, 28.2).coordinates,
                    sourceUrl: 'https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/zz.json',
                },
            ])[0],
        );
        r = await at(28.1, -15.43);
        eq(
            [r.coverage, r.providers.map((p) => [p.id, p.state, p.since])],
            ['unavailable', [['meteoalarm-es', 'unavailable', null]]],
            `${schema}: an island outside its country's box: that country's, and unavailable until it answers`,
        );
        await live('meteoalarm-es');
        eq((await at(28.1, -15.43)).coverage, 'live', `${schema}: the island, once Spain answers: live`);

        // The outlines' loader is the service role's alone.
        await db.exec('RESET ROLE; SET ROLE authenticated');
        await assert.rejects(
            () => query("SELECT public.official_alert_zones_sync('meteoalarm-fr', 'EMMA_ID', '{}', '[]')"),
            (e) => e.code === '42501',
        );
        await db.exec('RESET ROLE');
        checks++;

        // A provider that is off is refused.
        await assert.rejects(
            () => apply('bom', [alert('x')]),
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
