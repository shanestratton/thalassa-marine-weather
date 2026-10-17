/** No product connection/credential/DDL. Exact empty Linux17.6 service only. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { comfortFixtureConfig, assertComfortFixtureFacts } from './private-comfort-disposable.mjs';
import { runComfortCases, person, boat, session, part, comfortMigration } from './private-comfort-cases.mjs';
const config = comfortFixtureConfig(process.env, process.platform),
    module = await import(pathToFileURL(config.modulePath).href),
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
        `SET ROLE authenticated;SELECT set_config('request.jwt.claim.sub','${person(n)}',false),set_config('request.jwt.claims','${JSON.stringify({ session_id: session(n) })}',false)`,
    );
    try {
        return (
            await c.query('SELECT public.private_passage_comfort($1,$2::jsonb) answer', [action, JSON.stringify(input)])
        ).rows[0].answer;
    } finally {
        await c.query('RESET ROLE');
    }
}
const lease = (s) => ({ context: s.context, epoch: s.epoch, revision: s.revision });
async function payload(n, s, op) {
    const now = new Date().toISOString();
    await db.query(
        `INSERT INTO public.ship_logs(user_id,boat_id,client_operation_id,source,entry_type,voyage_id,timestamp,latitude,longitude)
 VALUES($1,$2,$3,'device','auto','real-pg-fixture',$4,0,0)`,
        [person(n), boat(n), op, now],
    );
    return {
        ...lease(s),
        operation: op,
        reportedAt: now,
        fixAt: now,
        latitude: 0,
        longitude: 0,
        level: 1,
        parts: { total: part, windSea: null, swell: null, secondarySwell: null },
        fetchedAt: now,
        validAt: now,
    };
}
async function contested(n, ops, whileBlocked) {
    const gate = clients[3];
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20260806))', [person(n)]);
    const pending = ops.map((fn, i) => fn(clients[i + 1]));
    try {
        const until = Date.now() + 3000;
        while (true) {
            const waiting = Number(
                await scalar(
                    "SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND state='active' AND wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid))",
                    [ops.map((_, i) => clients[i + 1].processID), gate.processID],
                ),
            );
            if (waiting === ops.length) break;
            assert.ok(Date.now() < until, 'Every contender must actually wait on this known gate');
            await new Promise((r) => setTimeout(r, 10));
        }
        checks++;
        if (whileBlocked) await whileBlocked();
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
 (SELECT count(*) FROM pg_namespace WHERE nspname='auth') auth_schema,(SELECT count(*) FROM pg_roles WHERE rolname<>'postgres' AND rolname !~ '^pg_') auth_roles,
 (SELECT count(*) FROM pg_database WHERE datname NOT IN('postgres','template0','template1','comfort141_test')) databases,(SELECT count(*) FROM pg_publication) publications`)
    ).rows[0];
    assertComfortFixtureFacts(facts);
    const sqlChecks = await runComfortCases(fixture);
    let s = await call(db, 5, 'state'),
        p = await payload(5, s, 'duplicate');
    let result = await contested(5, [(c) => call(c, 5, 'save', p), (c) => call(c, 5, 'save', p)]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 2);
    checks++;
    assert.equal((await call(db, 5, 'state')).reports.length, 1);
    checks++;
    races++;
    s = await call(db, 6, 'state');
    p = await payload(6, s, 'delete-race');
    result = await contested(6, [
        (c) => call(c, 6, 'save', p),
        (c) => call(c, 6, 'delete', { ...lease(s), operation: p.operation }),
    ]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 2);
    checks++;
    assert.equal((await call(db, 6, 'state')).reports.length, 0);
    checks++;
    races++;
    s = await call(db, 7, 'state');
    p = await payload(7, s, 'reset-race');
    result = await contested(7, [(c) => call(c, 7, 'save', p), (c) => call(c, 7, 'reset', lease(s))]);
    assert.ok(result.some((x) => x.status === 'fulfilled'));
    checks++;
    assert.equal((await call(db, 7, 'state')).reports.length, 0);
    checks++;
    races++;
    s = await call(db, 8, 'state');
    p = await payload(8, s, 'profile-race');
    result = await contested(8, [(c) => call(c, 8, 'save', p)], () =>
        db.query('UPDATE public.boat_profiles SET revision=revision+1 WHERE boat_id=$1', [boat(8)]),
    );
    assert.equal(result[0].status, 'rejected');
    assert.equal(result[0].reason.code, '40001');
    checks += 2;
    assert.equal((await call(db, 8, 'state')).reports.length, 0);
    checks++;
    races++;
    s = await call(db, 9, 'state');
    p = await payload(9, s, 'session-race');
    result = await contested(9, [(c) => call(c, 9, 'save', p)], () =>
        db.query('DELETE FROM auth.sessions WHERE id=$1', [session(9)]),
    );
    assert.equal(result[0].status, 'rejected');
    assert.equal(result[0].reason.code, '42501');
    checks += 2;
    races++;
    s = await call(db, 10, 'state');
    p = await payload(10, s, 'deletion-race');
    result = await contested(10, [(c) => call(c, 10, 'save', p)], () =>
        db.query('INSERT INTO public.account_deletion_jobs VALUES($1)', [person(10)]),
    );
    assert.equal(result[0].status, 'rejected');
    assert.equal(result[0].reason.code, '55000');
    checks += 2;
    races++;
    s = await call(db, 11, 'state');
    p = await payload(11, s, 'quota-parent');
    await call(db, 11, 'save', p);
    await db.query(
        `INSERT INTO private_comfort.reports SELECT owner_id,boat_id,'slot-'||n,log_id,capture_fingerprint,epoch,profile_revision,voyage_id,captured_at,reported_at,level,parts,fetched_at,valid_at
 FROM private_comfort.reports CROSS JOIN generate_series(1,118)n WHERE owner_id=$1`,
        [person(11)],
    );
    const a = await payload(11, s, 'last-slot-a'),
        b = await payload(11, s, 'last-slot-b');
    result = await contested(11, [(c) => call(c, 11, 'save', a), (c) => call(c, 11, 'save', b)]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    checks++;
    assert.equal(result.filter((x) => x.status === 'rejected' && x.reason.code === '54000').length, 1);
    checks++;
    assert.equal((await call(db, 11, 'state')).reports.length, 120);
    checks++;
    races++;
    // Real lifecycle statements invoke the product retirement trigger while
    // holding the boat row; the absent cohort boat FK avoids a reverse edge.
    for (const { actor, kind } of [
        { actor: 5, kind: 'archive-restore' },
        { actor: 6, kind: 'transfer-A-B-A' },
    ]) {
        s = await call(db, actor, 'state');
        p = await payload(actor, s, `lifecycle-${kind}`);
        result = await contested(actor, [
            (c) => call(c, actor, 'save', p),
            async (c) => {
                await c.query('BEGIN');
                try {
                    if (kind === 'archive-restore') {
                        await c.query('UPDATE public.boats SET archived_at=clock_timestamp() WHERE id=$1', [
                            boat(actor),
                        ]);
                        await c.query('UPDATE public.boats SET archived_at=NULL WHERE id=$1', [boat(actor)]);
                    } else {
                        await c.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [person(2), boat(actor)]);
                        await c.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [person(actor), boat(actor)]);
                    }
                    await c.query('COMMIT');
                    return true;
                } catch (error) {
                    await c.query('ROLLBACK');
                    throw error;
                }
            },
        ]);
        assert.equal(result[1].status, 'fulfilled');
        checks++;
        assert.ok(
            result[0].status === 'fulfilled' || (result[0].status === 'rejected' && result[0].reason.code === '40001'),
        );
        checks++;
        assert.equal((await call(db, actor, 'state')).reports.length, 0);
        checks++;
        await assert.rejects(call(db, actor, 'save', p), (e) => e.code === '40001');
        checks++;
        races++;
    }
    console.info(
        JSON.stringify({
            engine: 'PostgreSQL',
            facts,
            sqlChecks,
            concurrencyChecks: checks,
            knownGatePaths: races,
            migrationSha256: createHash('sha256')
                .update(await readFile(comfortMigration))
                .digest('hex'),
            result: 'PASS',
            liveChanges: false,
        }),
    );
} finally {
    await Promise.all(clients.map((c) => c.end()));
}
