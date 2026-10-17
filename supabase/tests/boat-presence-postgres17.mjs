/** Dedicated Linux17.6 service-container proof. No product credentials/network/DDL. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { presenceFixtureConfig, assertPresenceFixtureFacts } from './boat-presence-disposable.mjs';
import { runPresenceCases, person, boat } from './boat-presence-cases.mjs';
const config = presenceFixtureConfig(process.env, process.platform);
const module = await import(pathToFileURL(config.modulePath).href),
    Client = module.Client ?? module.default.Client;
const clients = await Promise.all(
    Array.from({ length: 4 }, async () => {
        const c = new Client(config.connection);
        await c.connect();
        return c;
    }),
);
const db = clients[0],
    fixture = { exec: (sql) => db.query(sql), query: (sql, args) => db.query(sql, args) };
let races = 0,
    checks = 0;
const scalar = async (sql, args) => Object.values((await db.query(sql, args)).rows[0])[0];
async function call(c, n, action, input = {}) {
    await c.query(
        `SET ROLE authenticated;SELECT set_config('request.jwt.claim.sub','${person(n)}',false),set_config('request.jwt.claim.role','authenticated',false)`,
    );
    try {
        return (
            await c.query('SELECT public.boat_presence_control($1,$2::jsonb) answer', [action, JSON.stringify(input)])
        ).rows[0].answer;
    } finally {
        await c.query('RESET ROLE');
    }
}
async function contested(actor, ops) {
    const gate = clients[3];
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20260806))', [person(actor)]);
    const pending = ops.map((op, i) => op(clients[i + 1]));
    try {
        const until = Date.now() + 3000;
        while (true) {
            const waiting = Number(
                await scalar(
                    "SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND state='active' AND wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid))",
                    [ops.map((_, i) => clients[i + 1].processID), gate.processID],
                ),
            );
            if (waiting >= ops.length) break;
            assert.ok(Date.now() < until, 'Both competing paths must actually block on the gate');
            await new Promise((r) => setTimeout(r, 10));
        }
        checks++;
        await gate.query('COMMIT');
        return await Promise.allSettled(pending);
    } catch (error) {
        await gate.query('ROLLBACK');
        await Promise.allSettled(pending);
        throw error;
    }
}
try {
    const facts = (
        await db.query(`SELECT current_database() database,current_user "user",current_setting('server_version_num') server_version_num,version(),
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_' AND c.relkind IN('r','p','v','m','S','f')) tables,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_') functions,
        (SELECT count(*) FROM pg_namespace WHERE nspname='auth') auth_schema,
        (SELECT count(*) FROM pg_roles WHERE rolname<>'postgres' AND rolname !~ '^pg_') auth_roles,
        (SELECT count(*) FROM pg_database WHERE datname NOT IN('postgres','template0','template1','presence140_test')) databases,
        (SELECT count(*) FROM pg_publication) publications`)
    ).rows[0];
    assertPresenceFixtureFacts(facts);
    const sqlChecks = await runPresenceCases(fixture);
    let s = await call(db, 8, 'state');
    let result = await contested(8, [
        (c) => call(c, 8, 'configure', { revision: s.revision, tier: 'nearby' }),
        (c) => call(c, 8, 'configure', { revision: s.revision, tier: 'crew' }),
    ]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    checks++;
    assert.equal(result.filter((x) => x.status === 'rejected' && x.reason.code === '40001').length, 1);
    checks++;
    races++;
    s = await call(db, 8, 'state');
    const nonce = person(800);
    result = await contested(8, [
        (c) => call(c, 8, 'begin', { revision: s.revision, sessionRevision: s.readerRevision, kind: 'reader', nonce }),
        (c) => call(c, 8, 'end', { revision: s.revision, sessionRevision: s.readerRevision, kind: 'reader', nonce }),
    ]);
    assert.ok(result.some((x) => x.status === 'fulfilled'));
    checks++;
    assert.equal(
        await scalar(`SELECT reader_nonce FROM private_presence.boat_presence WHERE owner_id='${person(8)}'`),
        null,
    );
    checks++;
    races++;
    s = await call(db, 8, 'configure', { revision: s.revision, tier: 'friends' });
    const invite = await call(db, 8, 'invite', { revision: s.revision, label: 'Concurrency fixture' });
    result = await contested(8, [
        (c) => call(c, 9, 'accept', { token: invite.token }),
        (c) => call(c, 10, 'accept', { token: invite.token }),
    ]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    checks++;
    assert.equal(await scalar(`SELECT count(*)::int FROM private_presence.friends WHERE owner_id='${person(8)}'`), 1);
    checks++;
    assert.equal(
        await scalar(`SELECT count(*)::int FROM private_presence.friend_invites WHERE owner_id='${person(8)}'`),
        0,
    );
    checks++;
    races++;
    s = await call(db, 11, 'state');
    s = await call(db, 11, 'configure', { revision: s.revision, tier: 'nearby' });
    s = await call(db, 11, 'begin', {
        revision: s.revision,
        sessionRevision: s.publisherRevision,
        kind: 'publisher',
        nonce: person(811),
    });
    const fix = () => ({
        revision: s.revision,
        publisherNonce: person(811),
        latitude: 0.1,
        longitude: 0.1,
        observedAt: new Date().toISOString(),
    });
    result = await contested(11, [
        (c) => call(c, 11, 'configure', { revision: s.revision, tier: 'off' }),
        (c) => call(c, 11, 'fix', fix()),
    ]);
    assert.ok(result[0].status === 'fulfilled');
    checks++;
    assert.equal((await call(db, 11, 'state')).tier, 'off');
    checks++;
    assert.equal(await scalar(`SELECT count(*)::int FROM private_presence.samples WHERE owner_id='${person(11)}'`), 0);
    checks++;
    races++;
    s = await call(db, 11, 'state');
    s = await call(db, 11, 'configure', { revision: s.revision, tier: 'nearby' });
    s = await call(db, 11, 'begin', {
        revision: s.revision,
        sessionRevision: s.publisherRevision,
        kind: 'publisher',
        nonce: person(811),
    });
    await db.query(`INSERT INTO public.boats VALUES ('${boat(31)}','${person(11)}','Fictional alternative',NULL,NULL)`);
    result = await contested(11, [
        async (c) => {
            await c.query(
                `BEGIN;UPDATE public.user_active_vessels SET boat_id='${boat(31)}' WHERE user_id='${person(11)}';UPDATE public.user_active_vessels SET boat_id='${boat(11)}' WHERE user_id='${person(11)}';COMMIT`,
            );
        },
        (c) => call(c, 11, 'fix', fix()),
    ]);
    assert.ok(result[0].status === 'fulfilled');
    checks++;
    const after = await call(db, 11, 'state');
    assert.equal(after.tier, 'off');
    assert.notEqual(after.revision, s.revision);
    checks += 2;
    races++;
    s = await call(db, 11, 'configure', { revision: after.revision, tier: 'nearby' });
    s = await call(db, 11, 'begin', {
        revision: s.revision,
        sessionRevision: s.publisherRevision,
        kind: 'publisher',
        nonce: person(811),
    });
    result = await contested(11, [
        (c) => c.query(`UPDATE public.boats SET archived_at=clock_timestamp() WHERE id='${boat(11)}'`),
        (c) => call(c, 11, 'fix', fix()),
    ]);
    assert.ok(result[0].status === 'fulfilled');
    checks++;
    assert.equal((await call(db, 11, 'state')).vesselId, null);
    checks++;
    assert.equal(await scalar(`SELECT count(*)::int FROM private_presence.samples WHERE owner_id='${person(11)}'`), 0);
    checks++;
    races++;
    s = await call(db, 12, 'state');
    s = await call(db, 12, 'configure', { revision: s.revision, tier: 'nearby' });
    s = await call(db, 12, 'begin', {
        revision: s.revision,
        sessionRevision: s.publisherRevision,
        kind: 'publisher',
        nonce: person(812),
    });
    result = await contested(12, [
        (c) => c.query(`INSERT INTO public.account_deletion_jobs VALUES ('${person(12)}')`),
        (c) =>
            call(c, 12, 'fix', {
                revision: s.revision,
                publisherNonce: person(812),
                latitude: 0,
                longitude: 0,
                observedAt: new Date().toISOString(),
            }),
    ]);
    assert.ok(result[0].status === 'fulfilled');
    checks++;
    assert.equal(
        await scalar(`SELECT count(*)::int FROM private_presence.boat_presence WHERE owner_id='${person(12)}'`),
        0,
    );
    checks++;
    assert.equal(await scalar(`SELECT count(*)::int FROM private_presence.samples WHERE owner_id='${person(12)}'`), 0);
    checks++;
    races++;
    console.info(
        JSON.stringify({
            engine: 'actual isolated Linux PostgreSQL',
            postgres: facts.version,
            database: facts.database,
            sqlChecks,
            concurrencyChecks: checks,
            competingPaths: races,
            result: 'PASS',
            disposable: true,
            liveProductChanges: false,
        }),
    );
} finally {
    await Promise.all(clients.map((c) => c.end()));
}
