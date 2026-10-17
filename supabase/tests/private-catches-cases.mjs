/** The unchanged 31 migration/ACL/deletion assertions, shared by WASM and real PostgreSQL. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export async function runPrivateCatchCases(db) {
    const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
    const migration = await read('../migrations/20261017003944_private_sighting_catches.sql');
    const old = await read('../migrations/20260806120000_account_deletion_durability.sql');
    const fence = old.match(
        /CREATE OR REPLACE FUNCTION public\.block_tombstoned_account_write\(\)[\s\S]+?REVOKE ALL ON FUNCTION public\.block_tombstoned_account_write\(\) FROM PUBLIC, anon, authenticated;/,
    )?.[0];
    assert.ok(fence, 'Use the actual existing tombstone fence, not a substitute.');
    const owner = '00000000-0000-4000-8000-000000000001',
        crew = '00000000-0000-4000-8000-000000000002';
    const fish = '10000000-0000-4000-8000-000000000001',
        bird = '10000000-0000-4000-8000-000000000002',
        theirs = '10000000-0000-4000-8000-000000000003';
    let checks = 0;
    const eq = (value, expected, label) => {
        assert.deepEqual(value, expected, label);
        checks++;
    };
    const scalar = async (sql) => Object.values((await db.query(sql)).rows[0])[0];
    async function as(user, sql, role = 'authenticated') {
        await db.exec(
            `SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub','${user ?? ''}',false), set_config('request.jwt.claim.role','${role}',false);`,
        );
        try {
            return await db.query(sql);
        } finally {
            await db.exec('RESET ROLE');
        }
    }
    async function refused(user, sql, code, role) {
        await assert.rejects(as(user, sql, role), (error) => error.code === code);
        checks++;
    }
    await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
        CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE TABLE public.account_deletion_jobs(user_id uuid PRIMARY KEY);
        CREATE TABLE public.sightings(id uuid PRIMARY KEY,observer_id uuid REFERENCES auth.users(id),taxon_group text,visibility text);
        ALTER TABLE public.sightings ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON public.sightings TO authenticated;
        CREATE POLICY crew_parent_read ON public.sightings FOR SELECT TO authenticated USING (observer_id=(SELECT auth.uid()) OR visibility='crew');
        INSERT INTO auth.users VALUES ('${owner}'),('${crew}');
        INSERT INTO public.sightings VALUES ('${fish}','${owner}','fish','crew'),('${bird}','${owner}','bird','private'),('${theirs}','${crew}','fish','crew');
        CREATE PUBLICATION supabase_realtime FOR TABLE public.sightings;
    `);
    await db.exec(fence);
    await db.exec(migration);
    eq(
        await scalar(
            `SELECT count(*)::int FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='sighting_catches'`,
        ),
        0,
        'No private Realtime membership',
    );
    eq(
        await scalar(`SELECT relrowsecurity FROM pg_class WHERE oid='public.sighting_catches'::regclass`),
        true,
        'RLS enabled',
    );
    eq(
        (await as(crew, `SELECT id FROM public.sightings WHERE id='${fish}'`)).rows.length,
        1,
        'Crew really can read the shared parent',
    );
    await as(owner, `INSERT INTO public.sighting_catches VALUES ('${fish}','${owner}','Cod',42.5,'released')`);
    checks++;
    eq(
        (await as(owner, 'SELECT species,length_cm,disposition FROM public.sighting_catches')).rows,
        [{ species: 'Cod', length_cm: '42.5', disposition: 'released' }],
        'Owner reads own catch',
    );
    eq((await as(crew, 'SELECT * FROM public.sighting_catches')).rows.length, 0, 'Crew cannot read private sidecar');
    await refused(null, 'SELECT * FROM public.sighting_catches', '42501', 'anon');
    await refused(crew, `INSERT INTO public.sighting_catches VALUES ('${bird}','${crew}','Cod',1,'kept')`, '42501');
    await refused(owner, `INSERT INTO public.sighting_catches VALUES ('${theirs}','${owner}','Cod',1,'kept')`, '42501');
    await refused(owner, `INSERT INTO public.sighting_catches VALUES ('${bird}','${owner}','Cod',1,'kept')`, '42501');
    await refused(owner, `UPDATE public.sighting_catches SET observer_id='${crew}'`, '42501');
    await refused(owner, `UPDATE public.sighting_catches SET sighting_id='${bird}'`, '42501');
    eq(
        (await as(crew, `UPDATE public.sighting_catches SET species='Leaked' RETURNING *`)).rows.length,
        0,
        'Crew cannot modify hidden row',
    );
    eq(
        (await as(crew, 'DELETE FROM public.sighting_catches RETURNING *')).rows.length,
        0,
        'Crew cannot delete hidden row',
    );
    for (const assignment of [
        "species=''",
        "species=' Cod'",
        "species=repeat('x',121)",
        'length_cm=0',
        'length_cm=2000.1',
        "disposition='unknown'",
        'species=NULL,length_cm=NULL,disposition=NULL',
    ])
        await refused(owner, `UPDATE public.sighting_catches SET ${assignment}`, '23514');
    await as(owner, `UPDATE public.sighting_catches SET species='Tuna',length_cm=55,disposition='kept'`);
    checks++;
    await db.exec(`INSERT INTO public.account_deletion_jobs VALUES ('${owner}')`);
    await refused(owner, `UPDATE public.sighting_catches SET length_cm=56`, '55000');
    await as(owner, 'DELETE FROM public.sighting_catches');
    checks++;
    await refused(
        owner,
        `INSERT INTO public.sighting_catches VALUES ('${fish}','${owner}','Cod',42,'released')`,
        '55000',
    );
    await db.exec('DELETE FROM public.account_deletion_jobs');
    await as(owner, `INSERT INTO public.sighting_catches VALUES ('${fish}','${owner}','Cod',42,'released')`);
    await db.exec(`DELETE FROM public.sightings WHERE id='${fish}'`);
    eq(await scalar('SELECT count(*)::int FROM public.sighting_catches'), 0, 'Parent deletion cascades private catch');
    await as(crew, `INSERT INTO public.sighting_catches VALUES ('${theirs}','${crew}','Cod',42,'released')`);
    // Parent does not cascade from auth in this minimal fixture: test the sidecar FK itself.
    await db.exec(
        `UPDATE public.sightings SET observer_id=NULL WHERE observer_id='${crew}'; DELETE FROM auth.users WHERE id='${crew}'`,
    );
    eq(
        await scalar('SELECT count(*)::int FROM public.sighting_catches'),
        0,
        'Auth deletion independently cascades private catch',
    );
    // A schema-wide publication must fail before the table is created.
    await db.exec(
        'DROP TABLE public.sighting_catches; DROP PUBLICATION supabase_realtime; CREATE PUBLICATION supabase_realtime FOR ALL TABLES;',
    );
    await assert.rejects(db.exec(migration), /migration refused/);
    checks++;
    await db.exec('ROLLBACK');
    eq(await scalar("SELECT to_regclass('public.sighting_catches')"), null, 'Refusal leaves no private table');
    await db.exec(
        'DROP PUBLICATION supabase_realtime; CREATE PUBLICATION supabase_realtime FOR TABLES IN SCHEMA public',
    );
    await assert.rejects(db.exec(migration), /migration refused/);
    checks++;
    await db.exec('ROLLBACK');
    eq(
        await scalar("SELECT to_regclass('public.sighting_catches')"),
        null,
        'Schema-wide publication also refuses before table creation',
    );

    return checks;
}
