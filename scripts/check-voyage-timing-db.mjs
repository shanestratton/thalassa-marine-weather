/** Isolated PostgreSQL check. Does not connect to or change the linked project.
 * PGLITE_MODULE_PATH=/tmp/.../node_modules/@electric-sql/pglite/dist/index.js node scripts/check-voyage-timing-db.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const db = new PGlite();
try {
    await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
        CREATE TABLE public.ship_logs (
            id text PRIMARY KEY, user_id uuid, voyage_id text, timestamp timestamptz,
            cumulative_distance_nm double precision, speed_kts double precision,
            latitude double precision, longitude double precision, entry_type text,
            source text, is_on_water boolean, archived boolean
        );
        CREATE TABLE voyage_plan_links (user_id uuid, voyage_id text, plan_voyage_id text);
        CREATE TABLE saved_routes (user_id uuid, id text, trip_id text, planned_route_id text, passage_voyage_id uuid, deleted boolean DEFAULT false);
    `);
    const migration = await readFile(
        new URL('../supabase/migrations/20260923110000_voyage_departure_timing.sql', import.meta.url),
        'utf8',
    );
    await db.exec(migration);
    await db.exec('ALTER TABLE ship_logs ADD COLUMN saved_route_id text');
    await db.exec(
        await readFile(
            new URL('../supabase/migrations/20260923120000_log_passage_display.sql', import.meta.url),
            'utf8',
        ),
    );
    const epoch = Date.parse('2026-09-23T00:00:00Z');
    const iso = (s) => new Date(epoch + s * 1000).toISOString();
    let id = 0;
    async function fix(voyage, seconds, metres = 0, speed = 0, extra = {}) {
        await db.query(`INSERT INTO ship_logs VALUES ($1,$2,$3,$4,$5,$6,$7,153,'auto',$8,true,$9,NULL)`, [
            String(++id).padStart(4, '0'),
            extra.user === 'other' ? '00000000-0000-0000-0000-000000000002' : '00000000-0000-0000-0000-000000000001',
            voyage,
            iso(seconds),
            extra.distance ?? metres / 1852,
            speed,
            -27 + metres / 111195,
            extra.source ?? 'device',
            extra.archived ?? false,
        ]);
    }
    for (const [s, m, speed] of [
        [0, 0, 0],
        [3600, 0, 0],
        [7200, 0, 2],
        [7220, 20, 2],
        [7240, 40, 2],
        [10800, 1000, 0],
    ]) {
        await fix('sailing', s, m, speed);
    }
    for (const s of [0, 3600, 7200]) await fix('docked', s, 4, 0.1);
    await fix('spike', 0);
    await fix('spike', 10, 100, 8);
    await fix('spike', 20);
    await fix('spike', 40);
    for (const s of [0, 20, 40]) await fix('no-distance', s, s, 2, { distance: 0 });
    for (const s of [0, 1400, 1440]) await fix('gap', s, s, 2);
    await fix('duplicates', 0, 0, 2);
    await fix('duplicates', 0, 0, 2);
    await fix('duplicates', 40, 50, 2);
    await fix('imported', 0, 0, 0, { source: 'gpx_import' });
    await fix('imported', 3600);
    await fix('historical', -86400);
    await fix('historical', -80000);
    await fix('historical-docked', -86400);
    for (const s of [-79200, -79180, -79160]) await fix('historical-docked', s, s + 79200, 2);
    await db.exec(`
        INSERT INTO log_passage_memberships (user_id, voyage_id, passage_group_id)
            VALUES (auth.uid(), 'historical', 'northbound'), (auth.uid(), 'historical-docked', 'northbound'),
                ('00000000-0000-0000-0000-000000000002', 'sailing', 'private-other');
        INSERT INTO saved_routes (user_id, id, trip_id, planned_route_id) VALUES (auth.uid(), 'leg-one', 'planned-trip', 'plan-one');
        INSERT INTO voyage_plan_links VALUES (auth.uid(), 'sailing', 'plan-one');
    `);
    await fix('private', 0, 0, 0, { user: 'other' });
    await fix('archived', 0, 0, 0, { archived: true });
    const { rows } = await db.query('SELECT * FROM get_voyage_summaries(false)');
    const get = (v) => rows.find((r) => r.voyage_id === v);
    assert.equal(new Date(get('sailing').departed_at).toISOString(), iso(7200));
    assert.equal(new Date(get('sailing').started_at).toISOString(), iso(0));
    assert.equal(Number(get('sailing').entry_count), 6);
    for (const v of ['docked', 'spike', 'no-distance', 'gap', 'duplicates']) assert.equal(get(v).departed_at, null, v);
    assert.equal(new Date(get('imported').departed_at).toISOString(), iso(0));
    assert.equal(new Date(get('historical').departed_at).toISOString(), iso(-86400));
    assert.equal(new Date(get('historical-docked').departed_at).toISOString(), iso(-79200));
    assert.equal(get('historical').passage_group_id, 'northbound');
    assert.equal(get('historical-docked').passage_group_id, 'northbound');
    assert.equal(get('sailing').passage_group_id, 'planned-trip');
    assert.equal(get('docked').passage_group_id, null);
    assert.equal(get('private'), undefined);
    assert.equal(get('archived'), undefined);
    const archived = await db.query("SELECT * FROM get_voyage_summaries(true) WHERE voyage_id = 'archived'");
    assert.equal(archived.rows.length, 1);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM ship_logs')).rows[0].n), id);
    const permissions =
        await db.query(`SELECT has_function_privilege('anon', 'get_voyage_summaries(boolean)', 'EXECUTE') AS anon,
        has_function_privilege('authenticated', 'get_voyage_summaries(boolean)', 'EXECUTE') AS signed_in`);
    assert.deepEqual(permissions.rows[0], { anon: false, signed_in: true });
    await db.exec('GRANT USAGE ON SCHEMA auth TO authenticated; SET ROLE authenticated');
    const memberships = await db.query('SELECT * FROM log_passage_memberships');
    assert.equal(memberships.rows.length, 2);
    await assert.rejects(
        db.exec(
            `INSERT INTO log_passage_memberships VALUES ('00000000-0000-0000-0000-000000000002', 'foreign', 'leak', now())`,
        ),
    );
    await db.exec('RESET ROLE');
    console.log(
        'Voyage timing PostgreSQL checks passed: departure, jitter, gaps, duplicate fixes, history, ownership and grants.',
    );
} finally {
    await db.close();
}
