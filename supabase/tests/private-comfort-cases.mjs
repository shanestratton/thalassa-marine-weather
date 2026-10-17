/** Shared cases: local WASM is development proof; the separate Linux17.6
 * adapter must run this exact migration and these assertions before live use. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export const comfortMigration = new URL('../migrations/20261017050550_private_passage_comfort.sql', import.meta.url);
export const person = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const boat = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const session = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const part = { hM: 1, periodS: 8, fromDeg: 90 };
export async function prepareComfortFixture(db) {
    const old = await readFile(
        new URL('../migrations/20260806120000_account_deletion_durability.sql', import.meta.url),
        'utf8',
    );
    const fence = old.match(
        /CREATE OR REPLACE FUNCTION public\.block_tombstoned_account_write\(\)[\s\S]+?REVOKE ALL ON FUNCTION public\.block_tombstoned_account_write\(\) FROM PUBLIC, anon, authenticated;/,
    )?.[0];
    assert.ok(fence, 'Actual account-deletion fence required');
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;GRANT USAGE ON SCHEMA public,auth TO anon,authenticated;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz);
 CREATE TABLE public.account_deletion_jobs(user_id uuid PRIMARY KEY);
 CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,archived_at timestamptz,released_at timestamptz);
 CREATE TABLE public.user_active_vessels(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,boat_id uuid REFERENCES public.boats(id) ON DELETE CASCADE);
 CREATE TABLE public.boat_profiles(boat_id uuid PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,revision bigint,profile jsonb);
 CREATE TABLE public.ship_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
 boat_id uuid REFERENCES public.boats(id) ON DELETE CASCADE,client_operation_id text,source text,entry_type text,
 voyage_id text,timestamp timestamptz,latitude float8,longitude float8,UNIQUE(user_id,client_operation_id));
 ALTER TABLE public.ship_logs ENABLE ROW LEVEL SECURITY;GRANT SELECT ON public.ship_logs TO authenticated;
 CREATE POLICY fixture_shared_log ON public.ship_logs FOR SELECT TO authenticated USING(true);
 INSERT INTO auth.users SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,12)n;
 INSERT INTO auth.sessions SELECT ('20000000'||substr(id::text,9))::uuid,id,NULL FROM auth.users;
 INSERT INTO public.boats SELECT ('10000000'||substr(id::text,9))::uuid,id,NULL,NULL FROM auth.users;
 INSERT INTO public.user_active_vessels SELECT owner_id,id FROM public.boats;
 INSERT INTO public.boat_profiles SELECT id,1,'{"type":"sail","length":40}' FROM public.boats;
 CREATE PUBLICATION supabase_realtime FOR TABLE public.ship_logs;`);
    await db.exec(fence);
    await db.exec(await readFile(comfortMigration, 'utf8'));
}
export async function runComfortCases(db) {
    await prepareComfortFixture(db);
    let checks = 0;
    const eq = (a, b, label) => {
        assert.deepEqual(a, b, label);
        checks++;
    };
    const scalar = async (sql, args) => Object.values((await db.query(sql, args)).rows[0])[0];
    const as = async (n, sql, args = [], role = 'authenticated', sid = session(n)) => {
        await db.exec(
            `SET ROLE ${role};SELECT set_config('request.jwt.claim.sub','${n ? person(n) : ''}',false),set_config('request.jwt.claims','${JSON.stringify({ session_id: sid })}',false)`,
        );
        try {
            return await db.query(sql, args);
        } finally {
            await db.exec('RESET ROLE');
        }
    };
    const call = async (n, action, input = {}) =>
        (await as(n, 'SELECT public.private_passage_comfort($1,$2::jsonb) answer', [action, JSON.stringify(input)]))
            .rows[0].answer;
    const denied = async (fn, code) => {
        await assert.rejects(fn, (e) => e.code === code);
        checks++;
    };
    const lease = (s) => ({ context: s.context, epoch: s.epoch, revision: s.revision });
    async function payload(n, s, op, over = {}) {
        const now = new Date().toISOString();
        await db.query(
            `INSERT INTO public.ship_logs(user_id,boat_id,client_operation_id,source,entry_type,voyage_id,timestamp,latitude,longitude)
   VALUES($1,$2,$3,'device','auto','fictional-voyage',$4,0,0) ON CONFLICT DO NOTHING`,
            [person(n), boat(n), op, now],
        );
        return {
            ...lease(s),
            operation: op,
            reportedAt: now,
            fixAt: now,
            latitude: 0,
            longitude: 0,
            level: 2,
            parts: { total: part, windSea: null, swell: null, secondarySwell: null },
            fetchedAt: now,
            validAt: now,
            ...over,
        };
    }
    eq(
        await scalar("SELECT count(*)::int FROM pg_publication_tables WHERE schemaname='private_comfort'"),
        0,
        'No private Realtime membership',
    );
    eq(
        await scalar(
            "SELECT bool_and(relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='private_comfort' AND c.relkind='r'",
        ),
        true,
        'Every private table has RLS',
    );
    for (const table of ['contexts', 'cohorts', 'reports', 'deleted_operations']) {
        await denied(() => as(1, `SELECT * FROM private_comfort.${table}`), '42501');
        await denied(() => as(1, `DELETE FROM private_comfort.${table}`), '42501');
    }
    await denied(() => as(1, "SELECT public.private_passage_comfort('state')", [], 'anon'), '42501');
    await denied(() => call(null, 'state'), '22023');
    await denied(
        () => as(1, "SELECT public.private_passage_comfort('state')", [], 'authenticated', session(2)),
        '42501',
    );
    await db.exec(`UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='${session(2)}'`);
    await denied(() => call(2, 'state'), '42501');
    await db.exec(`UPDATE auth.sessions SET not_after=NULL WHERE id='${session(2)}'`);
    let s = await call(1, 'state');
    eq(s.reports, [], 'Starts uncalibrated');
    eq(s.profile, { type: 'sail', length: 40 });
    const p = await payload(1, s, 'capture-one');
    s = await call(1, 'save', p);
    eq(s.reports.length, 1);
    eq(s.reports[0].operation, 'capture-one');
    eq(s.reports[0].qualified, true, 'Actual unchanged capture is eligible');
    await db.exec("UPDATE public.ship_logs SET latitude=1 WHERE client_operation_id='capture-one'");
    eq(
        (await call(1, 'state')).reports[0].qualified,
        false,
        'Edited parent remains privately deletable but cannot qualify',
    );
    await db.exec("UPDATE public.ship_logs SET latitude=0 WHERE client_operation_id='capture-one'");
    eq((await call(1, 'save', { ...p, level: 0 })).reports[0].level, 2, 'Idempotent operation cannot rewrite report');
    eq((await as(2, 'SELECT id FROM public.ship_logs')).rows.length, 1, 'Crew fixture can read shared log');
    eq((await call(2, 'state')).reports, [], 'Crew cannot get private report');
    const crewState = await call(2, 'state');
    await denied(() => call(2, 'save', { ...p, ...lease(crewState) }), '23503');
    await denied(() => call(1, 'state', { owner_id: person(2) }), '22023');
    await denied(() => call(1, 'unknown'), '22023');
    await denied(() => call(1, 'save', { ...p, context: person(90) }), '40001');
    for (const over of [
        { fixAt: new Date(Date.now() - 46000).toISOString() },
        { fixAt: new Date(Date.now() + 6000).toISOString() },
        { validAt: new Date(Date.now() - 31 * 60000).toISOString() },
        { fetchedAt: new Date(Date.now() - 31 * 60000).toISOString() },
        { latitude: 1 },
        { longitude: 181 },
        { level: 4 },
        { parts: { total: { ...part, periodS: 0 }, windSea: null, swell: null, secondarySwell: null } },
        { parts: { total: part, windSea: null, swell: null, secondarySwell: null, secret: 'extra' } },
        { parts: null },
    ])
        await denied(() => call(1, 'save', { ...p, ...over }), '22023');
    const imported = await payload(1, s, 'imported');
    await db.exec("UPDATE public.ship_logs SET source='gpx_import' WHERE client_operation_id='imported'");
    await denied(() => call(1, 'save', imported), '23503');
    await call(1, 'delete', { ...lease(s), operation: 'capture-one' });
    eq(
        await scalar("SELECT count(*)::int FROM private_comfort.reports WHERE operation='capture-one'"),
        0,
        'Delete erases the private report payload',
    );
    eq(
        await scalar("SELECT count(*)::int FROM private_comfort.deleted_operations WHERE operation='capture-one'"),
        1,
        'Only bounded operation tombstone remains',
    );
    eq((await call(1, 'save', p)).reports, [], 'Deleted report cannot resurrect');
    const late = await payload(1, s, 'late');
    await call(1, 'delete', { ...lease(s), operation: 'late' });
    eq((await call(1, 'save', late)).reports, [], 'Delete before save is fenced');
    const reset = await call(1, 'reset', lease(s));
    assert.notEqual(reset.epoch, s.epoch);
    checks++;
    await denied(() => call(1, 'save', p), '40001');
    s = reset;
    const profileOld = await payload(1, s, 'profile-old');
    await db.exec(`UPDATE public.boat_profiles SET revision=2 WHERE boat_id='${boat(1)}'`);
    await denied(() => call(1, 'save', profileOld), '40001');
    s = await call(1, 'state');
    eq(s.revision, 2);
    eq(s.reports, []);
    // A-B-A active-vessel switch cannot revive the old context UUID.
    await db.exec(`INSERT INTO public.boats VALUES('${boat(99)}','${person(1)}',NULL,NULL);
 INSERT INTO public.boat_profiles VALUES('${boat(99)}',1,'{"type":"sail","length":50}');
 UPDATE public.user_active_vessels SET boat_id='${boat(99)}' WHERE user_id='${person(1)}';
 UPDATE public.user_active_vessels SET boat_id='${boat(1)}' WHERE user_id='${person(1)}'`);
    await denied(() => call(1, 'reset', lease(s)), '40001');
    s = await call(1, 'state');
    const beforeArchive = s;
    await db.exec(`UPDATE public.boats SET archived_at=clock_timestamp() WHERE id='${boat(1)}';
        UPDATE public.boats SET archived_at=NULL WHERE id='${boat(1)}'`);
    await denied(() => call(1, 'reset', lease(beforeArchive)), '40001');
    s = await call(1, 'state');
    const beforeTransfer = s;
    await db.exec(`UPDATE public.boats SET owner_id='${person(2)}' WHERE id='${boat(1)}';
        UPDATE public.boats SET owner_id='${person(1)}' WHERE id='${boat(1)}'`);
    await denied(() => call(1, 'reset', lease(beforeTransfer)), '40001');
    s = await call(1, 'state');
    const parentDelete = await payload(1, s, 'parent-delete');
    await call(1, 'save', parentDelete);
    await db.exec("DELETE FROM public.ship_logs WHERE client_operation_id='parent-delete'");
    eq((await call(1, 'state')).reports, [], 'Parent deletion cascades private row');
    await db.exec(`UPDATE public.boats SET released_at=clock_timestamp() WHERE id='${boat(1)}'`);
    await denied(() => call(1, 'state'), '42501');
    await db.exec(`UPDATE public.boats SET released_at=NULL WHERE id='${boat(1)}'`);
    await db.exec(`INSERT INTO public.account_deletion_jobs VALUES('${person(1)}')`);
    await denied(() => call(1, 'state'), '55000');
    await db.exec(`DELETE FROM auth.users WHERE id='${person(1)}'`);
    eq(
        await scalar(`SELECT count(*)::int FROM private_comfort.reports WHERE owner_id='${person(1)}'`),
        0,
        'Account cascade',
    );
    const capped = await call(3, 'state');
    for (let n = 0; n < 120; n++) {
        if (n % 20 === 0) await db.query('UPDATE private_comfort.contexts SET calls=0 WHERE owner_id=$1', [person(3)]);
        await call(3, 'save', await payload(3, capped, `bounded-slot-${n}`));
    }
    eq((await call(3, 'state')).reports.length, 120, 'Actual RPC admits exactly120 retained report/deletion slots');
    const over = await payload(3, capped, 'over-cap');
    await denied(() => call(3, 'save', over), '54000');
    await denied(() => call(3, 'delete', { ...lease(capped), operation: 'extra-delete-slot' }), '54000');
    await db.exec(`UPDATE public.boat_profiles SET profile='{"length":40}' WHERE boat_id='${boat(4)}'`);
    await denied(() => call(4, 'state'), '42501');
    return checks;
}
