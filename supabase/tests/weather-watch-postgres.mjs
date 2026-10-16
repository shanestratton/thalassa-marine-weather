/** ACTUAL PostgreSQL17.6 locks/CAS/quota proof. Empty localhost fixture only.
 * PG_MODULE_PATH points to an outside-repo pinned node-postgres installation.
 * No HTTP extension, webhooks, product credentials, provider calls or notifications. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const url = new URL(process.env.WEATHER_WATCH_TEST_DATABASE_URL ?? 'http://invalid');
if (
    process.env.THALASSA_DISPOSABLE_WEATHER_TEST !== '1' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/weather137_test' ||
    !process.env.PG_MODULE_PATH
)
    throw new Error('Only the explicit empty localhost weather137_test fixture is allowed.');
const module = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
    Pool = module.Pool ?? module.default.Pool;
const pool = new Pool({ connectionString: url.href, max: 18, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const owner = '10000000-0000-4000-8000-000000000001',
    other = '10000000-0000-4000-8000-000000000002',
    boat = '20000000-0000-4000-8000-000000000001',
    relay = 'fictional_relay_0001';
let checks = 0;
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await pool.query(sql, args)).rows[0] ?? {})[0];
async function roleQuery(role, who, sql, args = []) {
    const c = await pool.connect();
    try {
        await c.query(
            "SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",
            [who ?? '', role],
        );
        await c.query(`SET ROLE ${role}`);
        return Object.values((await c.query(sql, args)).rows[0] ?? {})[0];
    } finally {
        await c.query('RESET ROLE');
        c.release();
    }
}
const asOwner = (sql, args = []) => roleQuery('authenticated', owner, sql, args);
const service = (sql, args = []) => roleQuery('service_role', null, sql, args);
const register = (expected, sourceKey) =>
    asOwner('SELECT public.configure_weather_position($1,$2,$3,$4,$5,true)', [
        boat,
        expected,
        relay,
        'a'.repeat(64),
        sourceKey,
    ]);
const ingest = (proof) =>
    service('SELECT public.weather_position_telemetry($1,$2,$3::jsonb,$4)', [
        owner,
        relay,
        JSON.stringify(proof),
        'UTC',
    ]);
try {
    eq(await scalar('SELECT current_database()'), 'weather137_test', 'isolated database');
    eq(await scalar("SELECT count(*)::integer FROM pg_tables WHERE schemaname='public'"), 0, 'refuse nonempty schema');
    const version = String(await scalar('SHOW server_version'));
    assert.match(version, /^17\.6(?:\D|$)/);
    checks++;
    await pool.query(await read('weather-watch-base.sql'));
    await pool.query(await read('../held-migrations/20261016152301_weather_watch_optins.sql'));
    await pool.query(await read('../held-migrations/20261016161522_weather_position_binding.sql'));
    const stamp = Date.now(),
        preferences = {
            morning: true,
            rain: true,
            storm: true,
            gust: true,
            hour: new Date(stamp).getUTCHours(),
            zone: 'UTC',
            gustKts: 25,
            samples: [
                {
                    key: 'spot:public',
                    kind: 'spot',
                    label: 'Synthetic point',
                    lat: 0,
                    lon: 0,
                    sourceAt: stamp,
                    expiresAt: stamp + 86400000,
                },
            ],
        };
    const profile = await asOwner('SELECT public.configure_weather_watch($1,NULL,$2::jsonb)', [
        boat,
        JSON.stringify(preferences),
    ]);
    await pool.query('INSERT INTO pi_diary_relays VALUES($1,$2,$3,true)', [relay, owner, boat]);
    const bindings = await Promise.allSettled(['b'.repeat(64), 'c'.repeat(64)].map((key) => register(null, key)));
    eq(bindings.filter((r) => r.status === 'fulfilled').length, 1, 'one source CAS winner');
    eq(bindings.filter((r) => r.status === 'rejected' && r.reason.code === '40001').length, 1, 'loser reviewable');
    const winning = bindings.findIndex((r) => r.status === 'fulfilled'),
        binding = bindings[winning].value,
        sourceKey = ['b'.repeat(64), 'c'.repeat(64)][winning];
    const proof = {
        schema: 1,
        revision: binding.revision,
        selfKey: 'a'.repeat(64),
        sourceKey,
        lat: 0,
        lon: 0,
        at: Date.now() - 1000,
    };
    await ingest(proof);
    eq(
        await scalar('SELECT count(*)::integer FROM private_weather_watch.weather_position_receipts'),
        1,
        'explicit qualified receipt',
    );
    await pool.query(
        "INSERT INTO cron.job VALUES(1,'morning-briefing',true,'*/15 * * * *',format('SELECT public.invoke_edge_function(%L, 55000)','morning-briefing')),(2,'nowcast-watch',true,'*/5 * * * *',format('SELECT public.invoke_edge_function(%L, 55000)','nowcast-watch')),(3,'convective-watch',true,'*/30 * * * *',format('SELECT public.invoke_edge_function(%L, 55000)','convective-watch'));INSERT INTO cron.job_run_details SELECT jobid,'succeeded',now() FROM cron.job;UPDATE private_weather_watch.weather_watch_health SET function_version=1,delivery_version=1,entitlement_until=now()+interval '1 day',succeeded_at=now();",
    );
    const claim = (feature, event, boatId = boat, revision = profile.revision) =>
        service('SELECT public.weather_watch_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
            boatId,
            revision,
            feature,
            ['morning', 'rain'].includes(feature) ? 'live:boat' : 'spot:public',
            event,
            new Date(stamp).toISOString(),
            new Date(stamp + 600000).toISOString(),
            'Forecast',
            'Synthetic check',
            ['morning', 'rain'].includes(feature) ? binding.revision : null,
            ['morning', 'rain'].includes(feature) ? new Date(proof.at).toISOString() : null,
        ]);
    for (const feature of ['rain', 'storm', 'gust', 'morning']) {
        const day = new Date(stamp).toISOString().slice(0, 10),
            results = await Promise.all(
                Array.from({ length: 16 }, (_, i) => claim(feature, feature === 'morning' ? day : `${feature}:${i}`)),
            );
        eq(results.filter(Boolean).length, 1, `one ${feature} interval/day winner across16 transactions`);
    }
    eq(await scalar('SELECT count(*)::integer FROM push_notification_queue'), 4, 'four independent family budgets');
    const queued = await scalar(
        "SELECT queue_id FROM private_weather_watch.weather_watch_deliveries WHERE feature='rain'",
    );
    eq(
        await service('SELECT public.weather_watch_delivery_current($1)', [queued]),
        true,
        'current binding delivery permitted',
    );
    const contenders = await Promise.all(
        Array.from({ length: 9 }, async (_, i) => {
            const id = `20000000-0000-4000-8000-${String(i + 2).padStart(12, '0')}`;
            await pool.query('INSERT INTO boats VALUES($1,$2,NULL)', [id, owner]);
            const p = await asOwner('SELECT public.configure_weather_watch($1,NULL,$2::jsonb)', [
                id,
                JSON.stringify(preferences),
            ]);
            return { id, revision: p.revision };
        }),
    );
    const account = await Promise.all(contenders.map((p, i) => claim('storm', `account:${i}`, p.id, p.revision)));
    eq(account.filter(Boolean).length, 7, 'account cap eight includes prior vessel, even across nine concurrent boats');
    eq(
        await scalar(
            "SELECT count(*)::integer FROM private_weather_watch.weather_watch_deliveries WHERE feature='storm'",
        ),
        8,
        'exact account total',
    );
    // Hold the new-source CAS transaction. A queued old-source telemetry proof
    // must wait for the same boat lock and then fail the new revision boundary.
    const c = await pool.connect();
    let replacement;
    try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
        await c.query('SET LOCAL ROLE authenticated');
        replacement = (
            await c.query('SELECT public.configure_weather_position($1,$2,$3,$4,$5,true) AS answer', [
                boat,
                binding.revision,
                relay,
                'a'.repeat(64),
                'd'.repeat(64),
            ])
        ).rows[0].answer;
        const late = ingest({ ...proof, at: Date.now() - 1000 });
        let waiting = 0;
        for (let i = 0; i < 250; i++) {
            waiting = await scalar(
                "SELECT count(*)::integer FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT public.weather_position_telemetry%' AND wait_event_type='Lock'",
            );
            if (waiting) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        eq(waiting, 1, 'old proof actually waits behind the source CAS transaction');
        await c.query('COMMIT');
        await late;
    } catch (error) {
        await c.query('ROLLBACK');
        throw error;
    } finally {
        c.release();
    }
    eq(
        await scalar('SELECT count(*)::integer FROM private_weather_watch.weather_position_receipts WHERE boat_id=$1', [
            boat,
        ]),
        0,
        'old in-flight proof cannot restore replaced source',
    );
    eq(
        await service('SELECT public.weather_watch_delivery_current($1)', [queued]),
        false,
        'queued old-source notice cannot deliver',
    );
    const current = { ...proof, revision: replacement.revision, sourceKey: 'd'.repeat(64), at: Date.now() - 500 };
    await ingest(current);
    await ingest({ ...proof, at: Date.now() - 1000 });
    eq(
        await scalar('SELECT revision::text FROM private_weather_watch.weather_position_receipts WHERE boat_id=$1', [
            boat,
        ]),
        replacement.revision,
        'late old-registration packet cannot erase a qualified replacement',
    );
    await ingest({ ...current, at: current.at - 100, lat: 1 });
    eq(
        Number(
            await scalar(
                'SELECT extract(epoch FROM measured_at)*1000 FROM private_weather_watch.weather_position_receipts WHERE boat_id=$1',
                [boat],
            ),
        ),
        current.at,
        'late same-source packet cannot replace a newer position',
    );
    await pool.query('UPDATE pi_diary_relays SET enabled=false WHERE relay_id=$1', [relay]);
    eq(
        (await service("SELECT public.weather_watch_work('rain',NULL,16)")).length,
        0,
        'revoked relay stops all moving-boat work',
    );
    eq(
        await roleQuery('authenticated', other, 'SELECT public.weather_watch_status($1)', [boat]),
        null,
        'cross-owner status closed',
    );
    console.log(
        JSON.stringify({
            checks,
            postgres: version,
            parallelPerFeature: 16,
            competingSourceBinds: 2,
            accountContenders: 9,
            productDatabaseUsed: false,
            notificationsSent: 0,
        }),
    );
} finally {
    await pool.end();
}
