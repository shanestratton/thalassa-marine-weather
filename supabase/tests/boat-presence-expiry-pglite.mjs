/** Separate local maintenance/refusal proof. Never installs or simulates cron. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { preparePresenceFixture, person } from './boat-presence-cases.mjs';
if (!process.env.PGLITE_MODULE_PATH) throw new Error('Existing local PGlite runtime required');
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const { pgcrypto } = await import(new URL('./contrib/pgcrypto.js', pathToFileURL(process.env.PGLITE_MODULE_PATH)));
const db = new PGlite({ extensions: { pgcrypto } });
let checks = 0;
const eq = (a, b) => {
    assert.deepEqual(a, b);
    checks++;
};
const scalar = async (sql) => Object.values((await db.query(sql)).rows[0])[0];
try {
    await preparePresenceFixture(db);
    const template = await readFile(new URL('../operations/boat_presence_expiry.example.sql', import.meta.url), 'utf8');
    await assert.rejects(db.exec(template), /Held presence expiry template/);
    checks++;
    await db.exec('ROLLBACK');
    eq(await scalar("SELECT to_regclass('cron.job')"), null);
    await db.exec(`INSERT INTO auth.users SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(2000,2069)n;
        INSERT INTO private_presence.boat_presence(owner_id) SELECT id FROM auth.users WHERE id>='${person(2000)}';
        INSERT INTO private_presence.samples(owner_id,fix_lat,fix_lon,fix_at,touched_at) SELECT owner_id,0.025,0.025,clock_timestamp()-interval '16 minutes',clock_timestamp()-interval '16 minutes' FROM private_presence.boat_presence;
        INSERT INTO private_presence.boat_presence(owner_id) VALUES ('${person(1)}');
        INSERT INTO private_presence.samples(owner_id,fix_lat,fix_lon,fix_at) VALUES ('${person(1)}',0.025,0.025,clock_timestamp());`);
    eq(await scalar('SELECT count(*)::int FROM private_presence.samples'), 71);
    await db.exec('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT private_presence.expire_batch()'), (e) => e.code === '42501');
    checks++;
    await db.exec('RESET ROLE');
    await db.exec('SET ROLE service_role');
    eq(await scalar('SELECT private_presence.expire_batch()'), 64);
    await db.exec('RESET ROLE');
    eq(await scalar('SELECT count(*)::int FROM private_presence.samples'), 7);
    await db.exec('SET ROLE service_role');
    eq(await scalar('SELECT private_presence.expire_batch()'), 6);
    eq(await scalar('SELECT private_presence.expire_batch()'), 0);
    await db.exec('RESET ROLE');
    eq(await scalar('SELECT owner_id::text FROM private_presence.samples'), person(1));
    console.info(
        JSON.stringify({ engine: 'PGlite', checks, result: 'PASS', cronInstalled: false, liveChanges: false }),
    );
} finally {
    await db.close();
}
