/**
 * Execute the actual catalogue migration in isolated, in-memory PostgreSQL
 * with real PostGIS, roles, grants, RLS, triggers and transactions. No project
 * credentials, database connection, listener or persistent database is used.
 *
 * Install these pinned packages in a temporary directory OUTSIDE this repo:
 * npm install --prefix /absolute/temp/path --ignore-scripts --no-audit --no-fund \
 *   --save-exact @electric-sql/pglite@0.5.8 @electric-sql/pglite-postgis@0.2.8
 * PGLITE_MODULE_PATH=/absolute/temp/path/node_modules/@electric-sql/pglite/dist/index.js \
 * PGLITE_POSTGIS_MODULE_PATH=/absolute/temp/path/node_modules/@electric-sql/pglite-postgis/dist/index.js \
 *   node scripts/check-cruising-catalogue-db.mjs
 *
 * PGlite/PostGIS runs PostgreSQL compiled to WASM, not the deployed Supabase
 * server. Its PostGIS package is experimental. Single-session tests do not
 * establish concurrency, real JWT/PostgREST behavior, deployment compatibility,
 * operational permissions, production query performance or navigation safety.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCruisingCatalogueClient } from '../services/dayPlanner/catalogue.ts';

const modulePath = process.env.PGLITE_MODULE_PATH;
const postgisPath = process.env.PGLITE_POSTGIS_MODULE_PATH;
if (!modulePath || !postgisPath) {
    throw new Error('Set PGLITE_MODULE_PATH and PGLITE_POSTGIS_MODULE_PATH to isolated package installations.');
}
const { PGlite } = await import(pathToFileURL(modulePath).href);
const { postgis } = await import(pathToFileURL(postgisPath).href);
const migration = await readFile(
    new URL('../supabase/migrations/20260928120000_cruising_trip_catalogue.sql', import.meta.url),
    'utf8',
);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const assertEqual = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
};

async function runSchema(schema) {
    const db = new PGlite({ extensions: { postgis } });
    const query = async (sql, params = []) => (await db.query(sql, params)).rows;
    const equal = async (sql, expected, label, params = []) =>
        assertEqual((await query(sql, params))[0]?.value, expected, `${schema}: ${label}`);
    const denied = async (sql, codes, label, params = []) => {
        await assert.rejects(
            () => db.query(sql, params),
            (error) => (Array.isArray(codes) ? codes : [codes]).includes(error.code),
            `${schema}: ${label}`,
        );
        checks++;
    };
    const asRole = (role) => db.exec(`RESET ROLE; SET ROLE ${role}`);
    const detail = 'SELECT public.cruising_catalogue_detail($1,$2) AS value';
    const readable = 'SELECT public.cruising_catalogue_is_readable($1,$2) AS value';
    const nearby = 'SELECT * FROM public.nearby_cruising_catalogue($1,$2,$3,$4)';
    // The only transport substitute: fixed RPC names mapped to actual SQL in
    // an authenticated transaction. PostgreSQL JSON serialization is retained
    // (including timestamp strings); rows/data/eligibility are never mocked.
    // This intentionally does not claim to test HTTP, JWTs or PostgREST itself.
    const client = createCruisingCatalogueClient({
        rpc(name, args) {
            const response = (async () => {
                try {
                    await db.exec('BEGIN; SET LOCAL ROLE authenticated');
                    let data;
                    if (name === 'nearby_cruising_catalogue') {
                        data = (
                            await query(
                                `SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb) AS value
                            FROM public.nearby_cruising_catalogue($1,$2,$3,$4) s`,
                                [args.p_latitude, args.p_longitude, args.p_radius_nm, args.p_limit],
                            )
                        )[0].value;
                    } else if (name === 'cruising_catalogue_detail') {
                        data = (await query(detail, [args.p_id, args.p_version]))[0].value;
                    } else {
                        throw new Error(`Unexpected test RPC: ${name}`);
                    }
                    await db.exec('COMMIT');
                    return { data, error: null };
                } catch (error) {
                    await db.exec('ROLLBACK');
                    return { data: null, error };
                }
            })();
            return Object.assign(response, { abortSignal: () => response });
        },
    });
    const signal = new AbortController().signal;
    const A = uuid(1),
        B = uuid(2),
        TRIP = uuid(3),
        OUT = uuid(4),
        RETURN = uuid(5);
    const versionSQL = `INSERT INTO public.cruising_catalogue_versions
        (entry_id,version,kind,name,summary,latitude,longitude,evidence,review_status,
         reviewed_at,review_due_at,reviewer_label,review_scope,limitations,activities,
         origin_destination_id,origin_destination_version,destination_id,destination_version,
         trip_id,trip_version,direction,checkpoints)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)`;
    let dates;
    const evidence = () => [
        {
            source_url: 'https://example.com/synthetic-evidence',
            source_label: 'Synthetic database fixture',
            retrieved_at: dates.retrieved,
            licence: 'Synthetic licence for fixture testing only',
            licence_url: 'https://example.com/synthetic-licence',
            attribution: 'Synthetic fixture author',
            scope: 'Database contract only; no real location or route reviewed',
        },
    ];
    const point = (sequence, latitude, longitude) => ({
        sequence,
        name: `Synthetic checkpoint ${sequence}`,
        latitude,
        longitude,
        required: true,
        evidence_note: 'Synthetic required checkpoint; no navigation evidence',
    });
    const outbound = () => [point(1, 0, 0), point(2, 0.01, 0), point(3, 0.02, 0.02)];
    // Deliberately different intermediate checkpoint: a return is independent.
    const returning = () => [point(1, 0.02, 0.02), point(2, 0, 0.01), point(3, 0, 0)];
    const fixture = (entry_id, overrides = {}) => ({
        entry_id,
        version: 1,
        kind: 'destination',
        name: 'Synthetic fixture',
        summary: 'Test data only; not a destination or navigation recommendation.',
        latitude: 0,
        longitude: 0,
        evidence: evidence(),
        review_status: 'reviewed',
        reviewed_at: dates.reviewed,
        review_due_at: dates.due,
        reviewer_label: 'Synthetic test editor',
        review_scope: 'Fixture validation only',
        limitations: ['Synthetic fixture; no real route review.'],
        activities: [],
        origin_destination_id: null,
        origin_destination_version: null,
        destination_id: null,
        destination_version: null,
        trip_id: null,
        trip_version: null,
        direction: null,
        checkpoints: null,
        ...overrides,
    });
    const params = (v) => [
        v.entry_id,
        v.version,
        v.kind,
        v.name,
        v.summary,
        v.latitude,
        v.longitude,
        JSON.stringify(v.evidence),
        v.review_status,
        v.reviewed_at,
        v.review_due_at,
        v.reviewer_label,
        v.review_scope,
        v.limitations,
        v.activities,
        v.origin_destination_id,
        v.origin_destination_version,
        v.destination_id,
        v.destination_version,
        v.trip_id,
        v.trip_version,
        v.direction,
        v.checkpoints === null ? null : JSON.stringify(v.checkpoints),
    ];
    const insert = (v) => query(versionSQL, params(v));
    const rejectVersion = (v, label, codes = ['P0001', '23514', '23503']) =>
        denied(versionSQL, codes, label, params(v));
    const entry = (id, kind = 'destination') =>
        query('INSERT INTO public.cruising_catalogue_entries(id,kind) VALUES ($1,$2)', [id, kind]);
    const publish = (id, version = 1) =>
        query(
            "UPDATE public.cruising_catalogue_entries SET current_version=$2,status='published',withdrawal_reason=NULL WHERE id=$1",
            [id, version],
        );
    const withdraw = (id) =>
        query(
            "UPDATE public.cruising_catalogue_entries SET status='withdrawn',withdrawal_reason='Synthetic withdrawal' WHERE id=$1",
            [id],
        );
    const expectHidden = async (id, version, label) => {
        await equal(detail, null, `${label}: exact RPC`, [id, version]);
        await equal(readable, false, `${label}: eligibility`, [id, version]);
        await equal(
            'SELECT count(*)::int AS value FROM public.cruising_catalogue_versions WHERE entry_id=$1 AND version=$2',
            0,
            `${label}: version RLS`,
            [id, version],
        );
        await equal(
            'SELECT count(*)::int AS value FROM public.cruising_catalogue_entries WHERE id=$1',
            0,
            `${label}: identity RLS`,
            [id],
        );
    };

    try {
        await db.exec(`
            CREATE ROLE anon;
            CREATE ROLE authenticated;
            CREATE ROLE service_role BYPASSRLS;
            CREATE SCHEMA extensions;
            GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
            CREATE EXTENSION postgis WITH SCHEMA ${schema};
            -- Emulate permissive inherited defaults: migration must remove them.
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
        `);
        await db.exec(migration);
        checks++;
        const info = (await query(`SELECT version() AS postgres, ${schema}.postgis_full_version() AS postgis`))[0];
        console.log(`${schema}: ${JSON.stringify(info)}`);
        dates = (
            await query(`SELECT
            to_char(now()-interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS retrieved,
            to_char(now()-interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed,
            to_char(now()+interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due,
            to_char(now()+interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS future,
            to_char(now()-interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expired`)
        )[0];
        await equal(
            `SELECT count(*)::int AS value FROM pg_class WHERE relname IN
            ('cruising_catalogue_entries','cruising_catalogue_versions') AND relrowsecurity`,
            2,
            'RLS is enabled on both tables',
        );
        await equal(
            `SELECT prosecdef AS value FROM pg_proc WHERE oid =
            'public.nearby_cruising_catalogue(double precision,double precision,double precision,integer)'::regprocedure`,
            true,
            'nearby runs with deliberately constrained owner authority',
        );
        await equal(
            `SELECT proconfig @> ARRAY['search_path=pg_catalog, public, extensions, pg_temp'] AS value
            FROM pg_proc WHERE oid =
            'public.nearby_cruising_catalogue(double precision,double precision,double precision,integer)'::regprocedure`,
            true,
            'nearby search path puts temporary types last',
        );
        await asRole('anon');
        for (const table of ['cruising_catalogue_entries', 'cruising_catalogue_versions']) {
            await denied(`SELECT * FROM public.${table}`, '42501', `anonymous cannot read ${table}`);
        }
        await denied(nearby, '42501', 'anonymous cannot call nearby', [0, 0, 30, 24]);
        await denied(detail, '42501', 'anonymous cannot call detail', [A, 1]);
        await denied(readable, '42501', 'anonymous cannot probe eligibility', [A, 1]);
        await asRole('authenticated');
        // A caller-controlled temporary type must not shadow PostGIS geography
        // when the owner-authority function is first compiled in this session.
        await db.exec('CREATE TEMP TABLE geography (untrusted text)');
        await denied(
            'INSERT INTO public.cruising_catalogue_entries(id,kind) VALUES ($1,$2)',
            '42501',
            'authenticated cannot insert identities',
            [A, 'destination'],
        );
        await denied(versionSQL, '42501', 'authenticated cannot insert versions', params(fixture(A)));
        for (const table of ['cruising_catalogue_entries', 'cruising_catalogue_versions']) {
            await denied(`UPDATE public.${table} SET kind='destination'`, '42501', 'authenticated cannot update');
            await denied(`DELETE FROM public.${table}`, '42501', 'authenticated cannot delete');
        }
        await denied(
            'TRUNCATE public.cruising_catalogue_entries,public.cruising_catalogue_versions',
            '42501',
            'authenticated cannot truncate',
        );
        await denied(
            'SELECT public.cruising_catalogue_validate_version()',
            '42501',
            'validation function is not exposed',
        );
        await denied('SELECT public.cruising_catalogue_guard_entry()', '42501', 'entry guard is not exposed');

        await asRole('service_role');
        for (const [id, kind] of [
            [A, 'destination'],
            [B, 'destination'],
            [TRIP, 'trip'],
            [OUT, 'route_variant'],
            [RETURN, 'route_variant'],
        ]) {
            await entry(id, kind);
        }
        await insert(fixture(A));
        await insert(fixture(B, { latitude: 0.02, longitude: 0.02 }));
        const trip = fixture(TRIP, {
            kind: 'trip',
            origin_destination_id: A,
            origin_destination_version: 1,
            destination_id: B,
            destination_version: 1,
        });
        const out = fixture(OUT, {
            kind: 'route_variant',
            trip_id: TRIP,
            trip_version: 1,
            direction: 'outbound',
            checkpoints: outbound(),
        });
        const back = fixture(RETURN, {
            ...out,
            entry_id: RETURN,
            latitude: 0.02,
            longitude: 0.02,
            direction: 'return',
            checkpoints: returning(),
        });
        await insert(trip);
        await insert(out);
        await insert(back);
        for (const id of [A, B, TRIP, OUT, RETURN]) await publish(id);
        // Deliberately grant the attacker CREATE only in this disposable DB.
        // Shorter overloads also test PostGIS in public; qualified full calls
        // must avoid choosing attacker functions that omit default arguments.
        await db.exec('RESET ROLE; GRANT CREATE ON SCHEMA public TO authenticated');
        await asRole('authenticated');
        const hostileSignatures = [
            [`st_distance(${schema}.geography,${schema}.geography)`, 'double precision'],
            [`st_dwithin(${schema}.geography,${schema}.geography,double precision)`, 'boolean'],
        ];
        if (schema === 'extensions') {
            await db.exec('CREATE TYPE public.geography AS (untrusted text)');
            hostileSignatures.push(
                ['st_makepoint(double precision,double precision)', 'extensions.geometry'],
                ['st_setsrid(extensions.geometry,integer)', 'extensions.geometry'],
                ['st_distance(extensions.geography,extensions.geography,boolean)', 'double precision'],
                ['st_dwithin(extensions.geography,extensions.geography,double precision,boolean)', 'boolean'],
            );
        }
        for (const [signature, resultType] of hostileSignatures) {
            await db.exec(`CREATE FUNCTION public.${signature} RETURNS ${resultType}
                LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Hostile public shadow executed'; END $$`);
        }
        await denied(
            `SELECT public.st_distance(NULL::${schema}.geography,NULL::${schema}.geography)`,
            schema === 'public' ? '42725' : 'P0001',
            'hostile public distance overload breaks an unsafe shortened call',
        );
        await denied(
            `SELECT public.st_dwithin(NULL::${schema}.geography,NULL::${schema}.geography,1::double precision)`,
            schema === 'public' ? '42725' : 'P0001',
            'hostile public within overload breaks an unsafe shortened call',
        );
        await asRole('authenticated');
        await equal('SELECT count(*)::int AS value FROM public.cruising_catalogue_versions', 5, 'valid graph visible');
        const summaries = await query(nearby, [0, 0, 30, 24]);
        assertEqual(
            summaries.map((v) => v.entry_id),
            [A, TRIP, B],
            'nearby has stable distance/id ordering and excludes variants',
        );
        assertEqual(
            summaries.some((v) => 'checkpoints' in v || 'location' in v),
            false,
            'nearby omits geometry',
        );
        assertEqual((await query(nearby, [0, 0, 30, 1])).length, 1, 'nearby enforces requested limit');
        const tripDetail = (await query(detail, [TRIP, 1]))[0].value;
        assertEqual(
            tripDetail.variants.map((v) => v.direction),
            ['outbound', 'return'],
            'trip lists separate directions',
        );
        assertEqual(tripDetail.variants_truncated, false, 'small trip has no truncation');
        assertEqual(
            (await query(detail, [OUT, 1]))[0].value.checkpoints,
            outbound(),
            'outbound preserves ordered required controls',
        );
        assertEqual(
            (await query(detail, [RETURN, 1]))[0].value.checkpoints,
            returning(),
            'return preserves independently supplied controls',
        );
        const clientSummaries = await client.nearby({ position: { lat: 0, lon: 0 }, signal });
        assertEqual(
            clientSummaries.map((v) => v.id),
            [A, TRIP, B],
            'real client accepts SQL nearby JSON/timestamps',
        );
        const clientDestination = await client.detail({ id: A, version: 1 }, { signal });
        assertEqual(clientDestination.kind, 'destination', 'real client accepts SQL exact destination');
        const clientTrip = await client.detail({ id: TRIP, version: 1 }, { signal });
        assertEqual(
            clientTrip.variants.map((v) => v.direction),
            ['outbound', 'return'],
            'real client accepts SQL exact trip',
        );
        for (const [id, direction] of [
            [OUT, 'outbound'],
            [RETURN, 'return'],
        ]) {
            const clientVariant = await client.detail({ id, version: 1 }, { signal });
            assertEqual(clientVariant.direction, direction, `real client preserves ${direction} direction`);
            assertEqual(
                clientVariant.checkpoints.every((v, i) => v.required && v.sequence === i + 1),
                true,
                `real client preserves ${direction} required controls`,
            );
        }
        for (const [signature] of hostileSignatures) await db.exec(`DROP FUNCTION public.${signature}`);
        if (schema === 'extensions') await db.exec('DROP TYPE public.geography');
        await db.exec('RESET ROLE; REVOKE CREATE ON SCHEMA public FROM authenticated');
        await asRole('authenticated');
        await equal(detail, null, 'unknown exact version has no fallback', [A, 99]);
        await equal(detail, null, 'unknown identity has no fallback', [uuid(999), 1]);
        for (const args of [
            [null, 1],
            [A, null],
            [A, 0],
            [A, -1],
        ]) {
            await denied(detail, '22023', 'invalid exact detail request', args);
        }
        for (const args of [
            [null, 0, 30, 24],
            [91, 0, 30, 24],
            [-91, 0, 30, 24],
            ['NaN', 0, 30, 24],
            ['Infinity', 0, 30, 24],
            ['-Infinity', 0, 30, 24],
            [0, null, 30, 24],
            [0, 181, 30, 24],
            [0, -181, 30, 24],
            [0, 'NaN', 30, 24],
            [0, 'Infinity', 30, 24],
            [0, 0, null, 24],
            [0, 0, 0, 24],
            [0, 0, -1, 24],
            [0, 0, 101, 24],
            [0, 0, 'NaN', 24],
            [0, 0, 'Infinity', 24],
            [0, 0, 30, null],
            [0, 0, 30, 0],
            [0, 0, 30, 51],
        ])
            await denied(nearby, '22023', 'invalid nearby bounds fail closed', args);
        await equal(
            'SELECT count(*)::int AS value FROM public.nearby_cruising_catalogue(90,180,100,50)',
            0,
            'north pole and positive dateline accepted',
        );
        await equal(
            'SELECT count(*)::int AS value FROM public.nearby_cruising_catalogue(-90,-180,100,50)',
            0,
            'south pole and negative dateline accepted',
        );

        await asRole('service_role');
        await denied(
            "UPDATE public.cruising_catalogue_versions SET name='Changed' WHERE entry_id=$1",
            '42501',
            'service cannot update immutable versions',
            [A],
        );
        for (const table of ['cruising_catalogue_entries', 'cruising_catalogue_versions']) {
            await denied(`DELETE FROM public.${table}`, '42501', 'service cannot delete');
        }
        await denied(
            'TRUNCATE public.cruising_catalogue_entries,public.cruising_catalogue_versions',
            '42501',
            'service cannot truncate',
        );
        await db.exec('RESET ROLE');
        await denied(
            "UPDATE public.cruising_catalogue_versions SET name='Changed' WHERE entry_id=$1",
            'P0001',
            'trigger independently blocks owner version edits',
            [A],
        );
        await denied(
            'DELETE FROM public.cruising_catalogue_versions WHERE entry_id=$1',
            'P0001',
            'trigger independently blocks owner version deletion',
            [OUT],
        );
        await denied(
            'DELETE FROM public.cruising_catalogue_entries WHERE id=$1',
            'P0001',
            'trigger independently blocks owner identity deletion',
            [OUT],
        );
        await asRole('service_role');
        await denied(
            "UPDATE public.cruising_catalogue_entries SET kind='trip' WHERE id=$1",
            'P0001',
            'identity kind immutable',
            [A],
        );
        await denied(
            'UPDATE public.cruising_catalogue_entries SET id=$2 WHERE id=$1',
            'P0001',
            'identity ID immutable',
            [A, uuid(999)],
        );
        await denied(
            'UPDATE public.cruising_catalogue_entries SET current_version=NULL WHERE id=$1',
            'P0001',
            'non-null pointer cannot be cleared',
            [A],
        );
        await denied(
            'UPDATE public.cruising_catalogue_entries SET current_version=99 WHERE id=$1',
            '23503',
            'current pointer must reference existing exact version',
            [A],
        );

        const BAD = uuid(50);
        await entry(BAD);
        for (const change of [
            { kind: 'trip' },
            { latitude: 91 },
            { longitude: -181 },
            { latitude: 'NaN' },
            { longitude: 'Infinity' },
            { latitude: '-Infinity' },
            { reviewed_at: dates.future },
            { review_due_at: dates.reviewed },
            { review_due_at: 'infinity' },
            { reviewed_at: '-infinity' },
            { limitations: [] },
            { limitations: [''] },
            { limitations: [null] },
            { activities: [''] },
            { evidence: [] },
            { evidence: [{}] },
            { evidence: [null] },
            { evidence: [{ ...evidence()[0], licence: '' }] },
            { evidence: [{ ...evidence()[0], licence_url: 'http://example.com' }] },
            { evidence: [{ ...evidence()[0], source_url: 'not-a-url' }] },
            { evidence: [{ ...evidence()[0], attribution: null }] },
            { evidence: [{ ...evidence()[0], retrieved_at: dates.future }] },
            { evidence: [{ ...evidence()[0], retrieved_at: dates.expired }] },
            { evidence: [{ ...evidence()[0], retrieved_at: '2026-01-01' }] },
            { evidence: [{ ...evidence()[0], scope: 'x'.repeat(2001) }] },
            { origin_destination_id: A },
            { destination_version: 1 },
        ])
            await rejectVersion(fixture(BAD, change), 'invalid version/evidence cannot be inserted', [
                'P0001',
                '23514',
                '23503',
                '22023',
            ]);
        for (const field of [
            'source_url',
            'source_label',
            'retrieved_at',
            'licence',
            'licence_url',
            'attribution',
            'scope',
        ]) {
            const item = evidence()[0];
            delete item[field];
            await rejectVersion(fixture(BAD, { evidence: [item] }), `missing evidence ${field} denied`);
        }
        await equal(
            'SELECT count(*)::int AS value FROM public.cruising_catalogue_versions WHERE entry_id=$1',
            0,
            'failed version inserts leave no partial content',
            [BAD],
        );

        const BAD_TRIP = uuid(51),
            BAD_ROUTE = uuid(52);
        await entry(BAD_TRIP, 'trip');
        await entry(BAD_ROUTE, 'route_variant');
        for (const change of [
            { latitude: 1 },
            { origin_destination_id: TRIP },
            { destination_id: A },
            { origin_destination_id: BAD_TRIP },
            { origin_destination_version: 99 },
            { destination_version: null },
        ])
            await rejectVersion(
                { ...trip, entry_id: BAD_TRIP, ...change },
                'invalid trip endpoints/self/cross-kind rejected',
            );
        for (const change of [
            { latitude: 1 },
            { direction: 'return' },
            { trip_id: A },
            { trip_id: BAD_ROUTE },
            { trip_version: 99 },
            { checkpoints: [point(1, 0, 0)] },
            { checkpoints: Array(257).fill(point(1, 0, 0)) },
            { checkpoints: [point(1, 0.01, 0), ...outbound().slice(1)] },
            { checkpoints: [...outbound().slice(0, 2), point(3, 0.03, 0.02)] },
            ...[
                { sequence: 3 },
                { sequence: '2' },
                { required: false },
                { latitude: 91 },
                { longitude: null },
                { latitude: 'NaN' },
                { longitude: 'Infinity' },
                { evidence_note: '' },
                { name: '' },
                { latitude: 0, longitude: 0 },
            ].map((change) => ({ checkpoints: [outbound()[0], { ...outbound()[1], ...change }, outbound()[2]] })),
        ])
            await rejectVersion(
                { ...out, entry_id: BAD_ROUTE, ...change },
                'invalid route direction/order/required controls rejected',
            );

        for (const [id, change] of [
            [
                uuid(60),
                {
                    review_status: 'pending',
                    reviewed_at: null,
                    review_due_at: null,
                    reviewer_label: null,
                    review_scope: null,
                },
            ],
            [uuid(61), { review_due_at: dates.expired }],
            [uuid(62), {}],
        ]) {
            await entry(id);
            await insert(fixture(id, change));
            if (id !== uuid(62)) await publish(id);
        }
        // Future inserts were rejected above. An owner-only synthetic fixture
        // also models an old record after a database-clock correction: read
        // eligibility must recheck the timestamp rather than trust insertion.
        await entry(uuid(63));
        await db.exec(
            'RESET ROLE; ALTER TABLE public.cruising_catalogue_versions DISABLE TRIGGER cruising_catalogue_immutable_versions',
        );
        try {
            await insert(fixture(uuid(63), { reviewed_at: dates.future }));
        } finally {
            await db.exec(
                'ALTER TABLE public.cruising_catalogue_versions ENABLE TRIGGER cruising_catalogue_immutable_versions',
            );
        }
        await asRole('service_role');
        await publish(uuid(63));
        for (const id of [uuid(60), uuid(61), uuid(62), uuid(63)]) {
            await equal(detail, null, 'RPC eligibility remains enforced for BYPASSRLS service role', [id, 1]);
        }
        await asRole('authenticated');
        for (const [id, label] of [
            [uuid(60), 'pending review'],
            [uuid(61), 'expired review'],
            [uuid(62), 'draft'],
            [uuid(63), 'future review'],
        ]) {
            await expectHidden(id, 1, label);
        }
        assertEqual(
            (await query(nearby, [0, 0, 30, 24])).map((v) => v.entry_id),
            [A, TRIP, B],
            'owner-authority nearby explicitly excludes draft/pending/expired/future reviews',
        );

        // Every withdrawal exit is fenced, including the null-pointer case.
        await asRole('service_role');
        for (let i = 100; i < 131; i++) {
            await entry(uuid(i), 'route_variant');
            await insert({ ...out, entry_id: uuid(i) });
            await publish(uuid(i));
        }
        await asRole('authenticated');
        const boundedTrip = await client.detail({ id: TRIP, version: 1 }, { signal });
        assertEqual(boundedTrip.variants.length, 32, 'trip details cap available variant references at 32');
        assertEqual(boundedTrip.variantsTruncated, true, 'trip details signal 33 available variants');
        await asRole('service_role');
        await withdraw(A);
        await asRole('authenticated');
        for (const id of [A, TRIP, OUT, RETURN]) await expectHidden(id, 1, 'withdrawal hides exact dependency graph');
        assertEqual(
            await client.detail({ id: TRIP, version: 1 }, { signal }),
            null,
            'real client receives null immediately after dependency withdrawal',
        );
        assertEqual(
            (await client.nearby({ position: { lat: 0, lon: 0 }, signal })).map((v) => v.id),
            [B],
            'real client nearby immediately hides withdrawn destination and its trip',
        );
        await asRole('service_role');
        for (const status of ['published', 'draft'])
            await denied(
                'UPDATE public.cruising_catalogue_entries SET status=$2,withdrawal_reason=NULL WHERE id=$1',
                'P0001',
                `same-version withdrawal exit to ${status} denied`,
                [A, status],
            );
        await denied(
            'UPDATE public.cruising_catalogue_entries SET withdrawal_reason=NULL WHERE id=$1',
            '23514',
            'withdrawal reason cannot be cleared while withdrawn',
            [A],
        );
        await insert(fixture(A, { version: 2, name: 'Synthetic replacement version' }));
        await publish(A, 2);
        await asRole('authenticated');
        await equal(detail, null, 'superseded exact destination stays null', [A, 1]);
        await equal(
            'SELECT version AS value FROM public.cruising_catalogue_versions WHERE entry_id=$1',
            2,
            'only current replacement is readable',
            [A],
        );
        for (const id of [TRIP, OUT, RETURN])
            await expectHidden(id, 1, 'destination recovery does not resurrect old dependants');
        await asRole('service_role');
        await denied(
            'UPDATE public.cruising_catalogue_entries SET current_version=1 WHERE id=$1',
            'P0001',
            'version pointer cannot move backwards',
            [A],
        );
        await insert({ ...trip, version: 2, origin_destination_version: 2 });
        await publish(TRIP, 2);
        await insert({ ...out, version: 2, trip_version: 2 });
        await publish(OUT, 2);
        await asRole('authenticated');
        await equal(readable, true, 'new trip version restores dependency graph deliberately', [TRIP, 2]);
        await equal(readable, true, 'new variant version restores dependency graph deliberately', [OUT, 2]);
        await equal(detail, null, 'superseded trip exact read stays null', [TRIP, 1]);
        await equal(detail, null, 'old return remains unavailable until independently replaced', [RETURN, 1]);
        await asRole('service_role');
        await withdraw(A);
        await insert(fixture(A, { version: 3 }));
        await query(
            "UPDATE public.cruising_catalogue_entries SET current_version=3,status='draft',withdrawal_reason=NULL WHERE id=$1",
            [A],
        );
        await denied(
            'UPDATE public.cruising_catalogue_entries SET current_version=2 WHERE id=$1',
            'P0001',
            'draft cannot restore withdrawn version',
            [A],
        );
        await publish(A, 3);
        await asRole('authenticated');
        await equal(readable, true, 'newer version can recover via draft', [A, 3]);
        for (const id of [TRIP, OUT])
            await expectHidden(id, 2, 'recovery through draft keeps previous dependencies hidden');
        await asRole('service_role');
        const EMPTY = uuid(70);
        await entry(EMPTY);
        await withdraw(EMPTY);
        for (const status of ['draft', 'published'])
            await denied(
                'UPDATE public.cruising_catalogue_entries SET status=$2,withdrawal_reason=NULL WHERE id=$1',
                'P0001',
                `withdrawn null pointer cannot escape to ${status}`,
                [EMPTY, status],
            );
        await insert(fixture(EMPTY));
        await publish(EMPTY);
        await asRole('authenticated');
        await equal(readable, true, 'withdrawn empty identity recovers with first reviewed version', [EMPTY, 1]);

        // Real geography crossing the dateline; no mocked distance functions.
        await asRole('service_role');
        const DATELINE = uuid(80);
        await entry(DATELINE);
        await insert(fixture(DATELINE, { longitude: -179.99 }));
        await publish(DATELINE);
        await asRole('authenticated');
        const across = await query(nearby, [0, 179.99, 2, 24]);
        assertEqual(
            across.map((v) => v.entry_id),
            [DATELINE],
            'geography finds destination across dateline',
        );
        assertEqual(
            across[0].distance_nm > 1 && across[0].distance_nm < 1.3,
            true,
            'PostGIS calculates plausible dateline distance',
        );
        await asRole('service_role');
        await db.exec('BEGIN');
        await entry(uuid(90));
        await rejectVersion(fixture(uuid(90), { evidence: [{}] }), 'invalid licensing aborts transaction');
        await db.exec('ROLLBACK');
        await equal(
            'SELECT count(*)::int AS value FROM public.cruising_catalogue_entries WHERE id=$1',
            0,
            'rollback removes staged identity',
            [uuid(90)],
        );

        // A modest synthetic scale verifies the index and inspects the actual
        // authenticated predicate separately; this is not a production benchmark.
        await db.exec(`INSERT INTO public.cruising_catalogue_entries(id,kind)
            SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'destination'
            FROM generate_series(1000,2999) n`);
        await query(
            `INSERT INTO public.cruising_catalogue_versions
            (entry_id,version,kind,name,summary,latitude,longitude,evidence,limitations)
            SELECT id,1,'destination','Synthetic index fixture','Index testing only',
                -80 + (row_number() OVER() % 16000) / 100.0,
                -170 + (row_number() OVER() % 34000) / 100.0,$1::jsonb,ARRAY['Synthetic index fixture']
            FROM public.cruising_catalogue_entries WHERE id >= $2::uuid`,
            [JSON.stringify(evidence()), uuid(1000)],
        );
        await db.exec('RESET ROLE; ANALYZE public.cruising_catalogue_versions;');
        const plan = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT entry_id FROM public.cruising_catalogue_versions
            WHERE ${schema}.ST_DWithin(location, ${schema}.ST_SetSRID(${schema}.ST_MakePoint(179.99::double precision,0::double precision),4326)::${schema}.geography,3704::double precision,true)`);
        assertEqual(
            JSON.stringify(plan).includes('cruising_catalogue_location_gist'),
            true,
            'actual selective spatial query uses GiST index at 2,000 synthetic rows',
        );
        const nearbyQueryBody = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT v.entry_id, v.version, v.kind,
                ${schema}.ST_Distance(v.location, ${schema}.ST_SetSRID(${schema}.ST_MakePoint(179.99::double precision,0::double precision),4326)::${schema}.geography,true) / 1852.0 AS distance_nm
            FROM public.cruising_catalogue_versions v
            WHERE v.kind IN ('destination','trip')
                AND ${schema}.ST_DWithin(v.location, ${schema}.ST_SetSRID(${schema}.ST_MakePoint(179.99::double precision,0::double precision),4326)::${schema}.geography,3704::double precision,true)
                AND public.cruising_catalogue_is_readable(v.entry_id,v.version)
            ORDER BY distance_nm, v.entry_id LIMIT 24`;
        const ownerPlan = await query(nearbyQueryBody);
        assertEqual(
            JSON.stringify(ownerPlan).includes('cruising_catalogue_location_gist'),
            true,
            'nearby body uses GiST under the function owner authority with explicit eligibility filter',
        );
        await asRole('authenticated');
        const authenticatedPlan = await query(nearbyQueryBody);
        const usesAuthenticatedIndex = JSON.stringify(authenticatedPlan).includes('cruising_catalogue_location_gist');
        const analyzed = authenticatedPlan[0]['QUERY PLAN'][0];
        assertEqual(
            analyzed.Plan['Actual Rows'],
            1,
            'authenticated spatial plan returns only the in-range visible row',
        );
        console.log(
            `${schema}: direct authenticated table query GiST index use: ${usesAuthenticatedIndex}; ` +
                `sequential scan: ${JSON.stringify(authenticatedPlan).includes('Seq Scan')}; ` +
                `shared hit blocks: ${analyzed.Plan['Shared Hit Blocks']}; execution ms: ${analyzed['Execution Time']}. ` +
                'Direct table access still obeys RLS.',
        );
        const rpcPlan = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT * FROM public.nearby_cruising_catalogue(0,179.99,2,24)`);
        const rpcAnalyzed = rpcPlan[0]['QUERY PLAN'][0];
        assertEqual(
            rpcAnalyzed.Plan['Actual Rows'],
            1,
            'authenticated owner-authority RPC returns only visible in-range row',
        );
        assertEqual(
            (await query(nearby, [0, 179.99, 2, 24])).map((v) => v.entry_id),
            [DATELINE],
            'actual authenticated definer RPC remains bounded at synthetic scale',
        );
        console.log(
            `${schema}: nearby owner-body GiST index use: true; actual authenticated RPC ` +
                `shared hit blocks: ${rpcAnalyzed.Plan['Shared Hit Blocks']}; execution ms: ${rpcAnalyzed['Execution Time']}. ` +
                'RPC EXPLAIN exposes Function Scan, so inner index use is checked separately under matching owner authority.',
        );
    } finally {
        await db.close();
    }
}

// The migration's prerequisite failure must leave no partial catalogue schema.
const missing = new PGlite();
try {
    await assert.rejects(
        () => missing.exec(migration),
        (error) => error.code === 'P0001',
    );
    checks++;
    await missing.exec('ROLLBACK');
    assertEqual(
        (await missing.query("SELECT to_regclass('public.cruising_catalogue_entries') AS value")).rows[0].value,
        null,
        'missing PostGIS rolls back migration without partial catalogue',
    );
} finally {
    await missing.close();
}
for (const schema of ['public', 'extensions']) await runSchema(schema);
console.log(
    `PASS: ${checks} executed PostgreSQL/PostGIS catalogue assertions across both extension schemas. Fresh in-memory fixtures only.`,
);
