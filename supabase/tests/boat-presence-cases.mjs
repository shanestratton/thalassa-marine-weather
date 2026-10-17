/** Common SQL/ACL cases for WASM and the separately guarded real PG17.6 adapter. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export const person = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const boat = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const presenceMigration = new URL('../migrations/20261017015015_boat_presence.sql', import.meta.url);
export async function preparePresenceFixture(db) {
    const durability = await readFile(
        new URL('../migrations/20260806120000_account_deletion_durability.sql', import.meta.url),
        'utf8',
    );
    const fence = durability.match(
        /CREATE OR REPLACE FUNCTION public\.block_tombstoned_account_write\(\)[\s\S]+?REVOKE ALL ON FUNCTION public\.block_tombstoned_account_write\(\) FROM PUBLIC, anon, authenticated;/,
    )?.[0];
    assert.ok(fence, 'Actual product tombstone fence required');
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
        GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
        CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE TABLE public.account_deletion_jobs(user_id uuid PRIMARY KEY);
        CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
            name text,archived_at timestamptz,released_at timestamptz);
        CREATE TABLE public.user_active_vessels(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
            boat_id uuid REFERENCES public.boats(id) ON DELETE CASCADE);
        CREATE TABLE public.boat_members(boat_id uuid,user_id uuid,PRIMARY KEY(boat_id,user_id));
        CREATE TABLE public.vessel_crew(owner_id uuid,crew_user_id uuid,status text);
        INSERT INTO auth.users SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,12)n;
        INSERT INTO public.boats SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
            ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Fictional boat '||n,NULL,NULL FROM generate_series(1,12)n;
        INSERT INTO public.user_active_vessels SELECT owner_id,id FROM public.boats;
        CREATE PUBLICATION supabase_realtime FOR TABLE public.boats;`);
    await db.exec(fence);
    await db.exec(await readFile(presenceMigration, 'utf8'));
}
export async function runPresenceCases(db) {
    await preparePresenceFixture(db);
    let checks = 0;
    const eq = (a, b, label) => {
        assert.deepEqual(a, b, label);
        checks++;
    };
    const scalar = async (sql, args) => Object.values((await db.query(sql, args)).rows[0])[0];
    async function as(id, sql, args = [], role = 'authenticated') {
        await db.exec(
            `SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub','${id ?? ''}',false),set_config('request.jwt.claim.role','${role}',false)`,
        );
        try {
            return await db.query(sql, args);
        } finally {
            await db.exec('RESET ROLE');
        }
    }
    const call = async (n, action, input = {}) =>
        (
            await as(person(n), 'SELECT public.boat_presence_control($1,$2::jsonb) answer', [
                action,
                JSON.stringify(input),
            ])
        ).rows[0].answer;
    const denied = async (fn, code) => {
        await assert.rejects(fn, (e) => e.code === code);
        checks++;
    };
    const state = (n) => call(n, 'state');
    async function configure(n, tier) {
        const old = await state(n);
        return call(n, 'configure', { revision: old.revision, tier });
    }
    async function begin(n, kind) {
        const s = await state(n),
            nonce = person(100 + n + (kind === 'reader' ? 100 : 0));
        return {
            state: await call(n, 'begin', { revision: s.revision, sessionRevision: s[kind + 'Revision'], kind, nonce }),
            nonce,
        };
    }
    async function fix(n, lease, lat = -27.12, lon = 153.15, extra = {}) {
        return call(n, 'fix', {
            revision: lease.state.revision,
            ...lease.nonces,
            latitude: lat,
            longitude: lon,
            observedAt: new Date().toISOString(),
            ...extra,
        });
    }
    const pub = async (n) => {
        const x = await begin(n, 'publisher');
        return { ...x, nonces: { publisherNonce: x.nonce } };
    };
    const reader = async (n) => {
        const x = await begin(n, 'reader');
        return { ...x, nonces: { readerNonce: x.nonce } };
    };
    const nearby = (n, r) => call(n, 'nearby', { revision: r.state.revision, readerNonce: r.nonce });
    const mature = (n) =>
        db.exec(`UPDATE private_presence.samples SET pending_at=clock_timestamp()-interval '5 minutes 1 second',
        pending_bucket=floor(extract(epoch FROM clock_timestamp()-interval '5 minutes 1 second')/300),fix_at=clock_timestamp()-interval '20 seconds' WHERE owner_id='${person(n)}'`);
    eq(
        await scalar("SELECT count(*)::int FROM pg_publication_tables WHERE schemaname='private_presence'"),
        0,
        'Never Realtime',
    );
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='private_presence' AND c.relkind='r' AND c.relrowsecurity",
        ),
        4,
        'All private tables use RLS',
    );
    eq(
        await scalar(
            "SELECT prosecdef FROM pg_proc WHERE oid='public.boat_presence_control(text,jsonb)'::regprocedure",
        ),
        false,
        'Exposed wrapper is invoker',
    );
    eq(
        await scalar("SELECT prosecdef FROM pg_proc WHERE oid='private_presence.call(text,jsonb)'::regprocedure"),
        true,
        'Definer implementation private',
    );
    for (const table of ['boat_presence', 'samples', 'friend_invites', 'friends'])
        await denied(() => as(person(1), `SELECT * FROM private_presence.${table}`), '42501');
    await denied(() => as(null, "SELECT public.boat_presence_control('state')", [], 'anon'), '42501');
    await denied(() => as(person(1), 'SELECT private_presence.expire_batch()'), '42501');
    await denied(() => call(1, 'other'), '22023');
    await denied(() => call(1, 'state', { latitude: 1 }), '22023');
    await denied(() => call(1, 'state', []), '22023');
    let s = await state(1);
    eq(s.tier, 'off', 'Fresh consent OFF');
    eq(s.publisherActive, false, 'No sign-in publication');
    eq(s.vesselId, boat(1), 'Actual active owned vessel');
    await denied(
        () =>
            call(1, 'begin', {
                revision: s.revision,
                sessionRevision: s.publisherRevision,
                kind: 'publisher',
                nonce: person(90),
            }),
        '55000',
    );
    const viewing = await reader(2);
    await fix(2, viewing);
    eq((await nearby(2, viewing)).points, [], 'Reader without publication sees nothing and shares nothing');
    eq(
        await scalar(`SELECT pending_at FROM private_presence.samples WHERE owner_id='${person(2)}'`),
        null,
        'View is independent from publish consent',
    );
    s = await configure(1, 'nearby');
    const publishing = await pub(1);
    await fix(1, publishing);
    eq((await nearby(2, viewing)).points.length, 0, 'Five minute delay enforced');
    const pending = await scalar(`SELECT pending_at::text FROM private_presence.samples WHERE owner_id='${person(1)}'`);
    await db.exec(
        `UPDATE private_presence.samples SET fix_at=clock_timestamp()-interval '20 seconds' WHERE owner_id='${person(1)}'`,
    );
    await fix(1, publishing, -27.8, 153.2);
    eq(
        await scalar(`SELECT pending_at::text FROM private_presence.samples WHERE owner_id='${person(1)}'`),
        pending,
        'Heartbeat cannot postpone pending first fix',
    );
    await mature(1);
    await fix(1, publishing, -27.8, 153.2);
    let points = (await nearby(2, viewing)).points;
    eq(points.length, 1, 'Matured snapshot visible within25NM');
    eq(points[0].latitude, -27.125, 'Original first latitude rounded');
    eq(points[0].longitude, 153.175, 'Longitude is cell centre');
    eq(points[0].label, 'Thalassa boat', 'Nearby has no hull name');
    eq(
        Object.keys(points[0]).sort(),
        ['bucketAt', 'id', 'label', 'latitude', 'longitude', 'tier', 'validUntil'].sort(),
        'No user/boat/fix/source IDs',
    );
    eq(points[0].id.length, 64, 'Viewer-bound opaque handle');
    assert.ok(Date.parse(points[0].validUntil) - Date.now() <= 30000);
    checks++;
    assert.ok(Date.now() - Date.parse(points[0].bucketAt) >= 300000);
    checks++;
    await denied(() => fix(1, publishing, 0, 0, { observedAt: new Date(Date.now() - 31000).toISOString() }), '22023');
    await denied(() => fix(1, publishing, 0, 0, { observedAt: new Date(Date.now() + 6000).toISOString() }), '22023');
    await denied(() => fix(1, publishing, 91, 0), '22023');
    const oldFix = await scalar(`SELECT fix_at FROM private_presence.samples WHERE owner_id='${person(1)}'`);
    await denied(() => fix(1, publishing, 0, 0, { observedAt: oldFix }), '22023');
    s = await call(1, 'configure', { revision: s.revision, tier: 'off' });
    await denied(() => fix(1, publishing), '40001');
    eq((await nearby(2, viewing)).points.length, 0, 'Off removes publication');
    eq(
        await scalar(`SELECT count(*)::int FROM private_presence.samples WHERE owner_id='${person(1)}'`),
        0,
        'Off deletes all snapshots',
    );
    await denied(() => call(1, 'configure', { revision: publishing.state.revision, tier: 'nearby' }), '40001');
    // Stop overtakes begin; retry cannot revive that nonce/revision.
    const nonce = person(900),
        before = await state(1);
    await call(1, 'end', { revision: before.revision, sessionRevision: before.readerRevision, kind: 'reader', nonce });
    await denied(
        () =>
            call(1, 'begin', {
                revision: before.revision,
                sessionRevision: before.readerRevision,
                kind: 'reader',
                nonce,
            }),
        '40001',
    );
    const first = await reader(1);
    await call(1, 'end', {
        revision: first.state.revision,
        sessionRevision: before.readerRevision,
        kind: 'reader',
        nonce: first.nonce,
    });
    await denied(() => fix(1, first), '40001');
    // Active A->B->A must rotate twice, even if the client sees A again.
    const a = await configure(3, 'nearby');
    await db.exec(`INSERT INTO public.boats VALUES ('${boat(30)}','${person(3)}','Other hull',NULL,NULL);
        UPDATE public.user_active_vessels SET boat_id='${boat(30)}' WHERE user_id='${person(3)}';
        UPDATE public.user_active_vessels SET boat_id='${boat(3)}' WHERE user_id='${person(3)}'`);
    const b = await state(3);
    eq(b.tier, 'off', 'A-B-A retires consent');
    assert.notEqual(a.revision, b.revision);
    checks++;
    await denied(() => call(3, 'configure', { revision: a.revision, tier: 'nearby' }), '40001');
    await db.exec(`UPDATE public.user_active_vessels SET boat_id='${boat(1)}' WHERE user_id='${person(3)}'`);
    eq((await state(3)).vesselId, null, 'Crew selected hull is not owned context');
    await denied(() => begin(3, 'reader'), '55000');
    // Friend invitation is explicit, single-use and context-bound.
    await db.exec(`UPDATE private_presence.boat_presence SET reads=0 WHERE owner_id='${person(2)}'`);
    await configure(4, 'friends');
    const friendsPub = await pub(4);
    await fix(4, friendsPub);
    const invited = await call(4, 'invite', { revision: friendsPub.state.revision, label: 'Known friend' });
    eq(invited.token.length, 64, '256bit invitation');
    eq(
        await scalar(
            `SELECT token_hash='${invited.token}' FROM private_presence.friend_invites WHERE owner_id='${person(4)}'`,
        ),
        false,
        'Only token hash stored',
    );
    eq(
        (await call(2, 'preview', { token: invited.token })).vesselName,
        'Fictional boat 4',
        'Preview requires possession',
    );
    await denied(() => call(4, 'accept', { token: invited.token }), '55000');
    eq((await call(2, 'accept', { token: invited.token })).accepted, true, 'Explicit accepted friend');
    await denied(() => call(2, 'accept', { token: invited.token }), '55000');
    await mature(4);
    await fix(4, friendsPub);
    eq(
        (await nearby(2, viewing)).points.some((p) => p.tier === 'friends'),
        true,
        'Accepted friend sees delayed snapshot',
    );
    const strangers = await reader(5);
    await fix(5, strangers);
    eq(
        (await nearby(5, strangers)).points.some((p) => p.tier === 'friends'),
        false,
        'Stranger cannot see friend snapshot',
    );
    const grants = (await call(2, 'friends')).friends;
    eq(grants.length, 1, 'Recipient can manage accepted grant');
    await denied(() => call(5, 'revoke', { grantId: grants[0].id }), '55000');
    await call(2, 'revoke', { grantId: grants[0].id });
    eq((await nearby(2, viewing)).points.length, 0, 'Revocation takes effect on next bounded read');
    await configure(6, 'crew');
    const crewPub = await pub(6);
    await fix(6, crewPub);
    await mature(6);
    await fix(6, crewPub);
    await db.exec(`INSERT INTO public.boat_members VALUES ('${boat(6)}','${person(2)}')`);
    eq((await nearby(2, viewing)).points.length, 0, 'Unilaterally added member is insufficient');
    await db.exec(`INSERT INTO public.vessel_crew VALUES ('${person(6)}','${person(2)}','pending')`);
    eq((await nearby(2, viewing)).points.length, 0, 'Pending crew is insufficient');
    // Reset only fixture read quota, preserving the real production cap.
    await db.exec(
        `UPDATE private_presence.boat_presence SET reads=0 WHERE owner_id='${person(2)}'; UPDATE public.vessel_crew SET status='accepted'`,
    );
    eq((await nearby(2, viewing)).points.length, 1, 'Live accepted crew and membership intersect');
    await db.exec(`DELETE FROM public.boat_members WHERE boat_id='${boat(6)}'`);
    eq((await nearby(2, viewing)).points.length, 0, 'Crew removal immediate on read');
    const prior = await state(6);
    await db.exec(`UPDATE public.boats SET archived_at=clock_timestamp() WHERE id='${boat(6)}'`);
    assert.notEqual((await state(6)).revision, prior.revision);
    checks++;
    eq(
        await scalar(`SELECT count(*)::int FROM private_presence.samples WHERE owner_id='${person(6)}'`),
        0,
        'Archive erases samples',
    );
    const expiry = await configure(7, 'nearby'),
        ep = await pub(7);
    await fix(7, ep);
    await mature(7);
    await fix(7, ep);
    await db.exec(
        `UPDATE private_presence.boat_presence SET publisher_until=clock_timestamp()-interval '1 second' WHERE owner_id='${person(7)}'`,
    );
    await denied(() => fix(7, ep), '40001');
    eq((await nearby(2, viewing)).points.length, 0, 'Expired foreground lease hidden');
    await denied(() => call(7, 'configure', { revision: expiry.revision, tier: 'nope' }), '22023');
    // Tombstone deletes private source data and prevents any resurrection.
    await db.exec(`INSERT INTO public.account_deletion_jobs VALUES ('${person(4)}')`);
    eq(
        await scalar(`SELECT count(*)::int FROM private_presence.boat_presence WHERE owner_id='${person(4)}'`),
        0,
        'Tombstone removes source config/cascades data',
    );
    await denied(() => state(4), '55000');
    await db.exec(`DELETE FROM auth.users WHERE id='${person(7)}'`);
    eq(
        await scalar(`SELECT count(*)::int FROM private_presence.boat_presence WHERE owner_id='${person(7)}'`),
        0,
        'Auth deletion cascades',
    );
    // Six reads per minute; no arbitrary centre/radius/window parameters.
    await db.exec(`UPDATE private_presence.boat_presence SET reads=6 WHERE owner_id='${person(2)}'`);
    await denied(() => nearby(2, viewing), '54000');
    await denied(
        () => call(2, 'nearby', { revision: viewing.state.revision, readerNonce: viewing.nonce, latitude: 0 }),
        '22023',
    );
    return checks;
}
