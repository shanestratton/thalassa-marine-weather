/** Actual PostgreSQL/PostGIS cases. Imported only after the empty-localhost
 * fixture guard in buddy-watch-db.mjs. No provider, HTTP or delivery client. */
import assert from 'node:assert/strict';
import { evaluateBuddy, emptyBuddyState } from '../../utils/buddyWatch.ts';

const WIDTH = 16;
const scalar = async (client, sql, args = []) => Object.values((await client.query(sql, args)).rows[0] ?? {})[0];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBuddyPostgresCases({ db, pool, eq }) {
    const version = String(await scalar(db, 'SHOW server_version'));
    assert.match(version, /^17\.6(?:\D|$)/, 'actual PostgreSQL 17.6 required');
    const schema = await scalar(
        db,
        "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='postgis'",
    );
    eq(schema, 'extensions', 'PostGIS is actually installed in the dedicated extensions namespace');
    const postgis = await scalar(db, 'SELECT extensions.postgis_full_version()');
    const races = [];

    // Hold a real conflicting lock until all sixteen distinct backends are
    // observed waiting. This proves overlap, rather than sixteen serial calls
    // sharing one connection or a Promise.all that never meets contention.
    async function race(name, role, uid, holdSql, holdArgs, action, beforeRelease) {
        assert(['authenticated', 'service_role'].includes(role));
        const acquired = await Promise.allSettled(Array.from({ length: WIDTH }, () => pool.connect()));
        const clients = acquired.filter((result) => result.status === 'fulfilled').map((result) => result.value);
        if (clients.length !== WIDTH) {
            clients.forEach((client) => client.release());
            throw new Error(`${name}: could not acquire all sixteen fixture sessions`);
        }
        let running = [];
        let holding = false;
        try {
            const pids = await Promise.all(
                clients.map(async (client) => {
                    await client.query('BEGIN');
                    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid ?? '']);
                    await client.query(`SET LOCAL ROLE ${role}`);
                    return scalar(client, 'SELECT pg_backend_pid()');
                }),
            );
            eq(new Set(pids).size, WIDTH, `${name}: sixteen distinct actual database sessions`);
            await db.exec('BEGIN');
            holding = true;
            await db.query(holdSql, holdArgs);
            running = clients.map(async (client, index) => {
                try {
                    const value = await action(client, index);
                    await client.query('COMMIT');
                    return { ok: true, value };
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => {});
                    return { ok: false, code: error.code ?? null };
                }
            });
            const deadline = Date.now() + 5000;
            let blocked = 0;
            while (Date.now() < deadline) {
                await db.exec('SELECT pg_stat_clear_snapshot()');
                blocked = await scalar(
                    db,
                    "SELECT count(*)::integer FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND state='active' AND wait_event_type='Lock'",
                    [pids],
                );
                if (blocked === WIDTH) break;
                await delay(20);
            }
            eq(blocked, WIDTH, `${name}: every contender overlaps behind an actual PostgreSQL lock`);
            if (beforeRelease) await beforeRelease();
            await db.exec('COMMIT');
            holding = false;
            const results = await Promise.all(running);
            const receipt = { name, sessions: WIDTH, distinctBackends: WIDTH, blockedSessions: blocked };
            races.push(receipt);
            return { results, receipt };
        } finally {
            if (holding) await db.exec('ROLLBACK').catch(() => {});
            await Promise.allSettled(running);
            await Promise.allSettled(clients.map((client) => client.query('ROLLBACK')));
            clients.forEach((client) => client.release());
        }
    }

    const spatialMmsi = 456789012;
    const spatialAt = Date.now() - 1000;
    const area = (lat, lon) => ({ lat, lon, radiusNm: 2, label: 'Synthetic area' });
    const setPosition = (lon, lat) =>
        db.query(
            `INSERT INTO public.vessels(mmsi,data_source,position_at,location,sog,nav_status)
             VALUES($1,'aishub',to_timestamp($2::double precision/1000),extensions.ST_SetSRID(extensions.ST_MakePoint($3,$4),4326)::extensions.geography,0,0)
             ON CONFLICT(mmsi) DO UPDATE SET location=excluded.location`,
            [spatialMmsi, spatialAt, lon, lat],
        );
    // A public-schema lookalike must never intercept the namespace-qualified
    // geography adapter, even with public first in the caller's search path.
    await db.exec(`CREATE FUNCTION public.st_distance(extensions.geography,extensions.geography)
        RETURNS double precision LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forbidden public spatial lookup';END$$`);
    const facts = async (chosenArea) => {
        await db.exec('BEGIN;SET LOCAL ROLE service_role;SET LOCAL search_path=public,extensions');
        try {
            return await scalar(db, 'SELECT private_buddy_watch.facts($1,$2::jsonb)', [
                spatialMmsi,
                JSON.stringify(chosenArea),
            ]);
        } finally {
            await db.exec('ROLLBACK');
        }
    };
    await setPosition(0, 0);
    const colocated = await facts(area(0, 0));
    eq(colocated.distanceNm, 0, 'coincident geography is zero actual nautical miles');
    eq(
        Object.keys(colocated).sort(),
        ['at', 'distanceNm', 'navStatus', 'sog'],
        'spatial adapter returns scalar facts without provider or chosen-area coordinates',
    );
    const equatorialNm = (6378137 * Math.PI) / 180 / 1852;
    const east = await facts(area(0, 1));
    eq(
        Math.abs(east.distanceNm - equatorialNm) < 0.00001,
        true,
        'one equatorial degree agrees with WGS84 metres/1852, with longitude first',
    );
    await setPosition(0, 60);
    const highLatitude = await facts(area(60, 1));
    eq(
        highLatitude.distanceNm > 29.9 && highLatitude.distanceNm < 30.3,
        true,
        'high-latitude longitude separation is roughly half the equatorial distance',
    );
    await setPosition(179.99, 0);
    const dateline = await facts(area(0, -179.99));
    eq(
        Math.abs(dateline.distanceNm - equatorialNm * 0.02) < 0.00001,
        true,
        'dateline geography uses the short crossing rather than a planar/world-spanning distance',
    );
    eq((await facts(null)).distanceNm, null, 'no selected private area remains unknown, not zero');
    await db.exec('DROP FUNCTION public.st_distance(extensions.geography,extensions.geography)');

    const owner = '10000000-0000-4000-8000-000000000003';
    const boats = ['20000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005'];
    await db.query('INSERT INTO auth.users VALUES($1)', [owner]);
    for (const boat of boats) await db.query('INSERT INTO public.boats VALUES($1,$2)', [boat, owner]);
    await db.query('INSERT INTO public.push_device_tokens VALUES($1)', [owner]);
    const ownerLock = "SELECT pg_advisory_xact_lock(hashtextextended('buddy-watch:'||$1::text,0))";
    const configuration = (mmsi) => ({ mmsi, label: 'Synthetic concurrent buddy', enabled: true, area: null });
    const admission = await race('owner-ten-watch-admission', 'authenticated', owner, ownerLock, [owner], (c, i) =>
        scalar(c, 'SELECT public.configure_buddy_watch($1,NULL,NULL,$2::jsonb)', [
            boats[i % boats.length],
            JSON.stringify(configuration(345678910 + i)),
        ]),
    );
    eq(admission.results.filter((result) => result.ok).length, 10, 'only ten concurrent account admissions win');
    eq(
        admission.results.filter((result) => !result.ok).map((result) => result.code),
        Array(6).fill('54000'),
        'all six admission losers receive the bounded-capacity error',
    );
    const watches = (await db.query('SELECT * FROM public.vessel_watchlist WHERE owner_id=$1 ORDER BY id', [owner]))
        .rows;
    eq(watches.length, 10, 'ten-watch limit spans both owned hulls');
    eq(new Set(watches.map((watch) => watch.boat_id)).size, 2, 'both hulls actually competed for the account limit');
    const target = watches[0];
    const edit = await race('same-configuration-CAS', 'authenticated', owner, ownerLock, [owner], (c, i) =>
        scalar(c, 'SELECT public.configure_buddy_watch($1,$2,$3,$4::jsonb)', [
            target.boat_id,
            target.id,
            target.revision,
            JSON.stringify({ ...target.configuration, label: `CAS writer ${i}` }),
        ]),
    );
    eq(edit.results.filter((result) => result.ok).length, 1, 'exactly one same-revision configuration edit wins');
    eq(
        edit.results.filter((result) => !result.ok).map((result) => result.code),
        Array(15).fill('40001'),
        'fifteen configuration conflicts require a fresh review',
    );
    const edited = (await db.query('SELECT * FROM public.vessel_watchlist WHERE id=$1', [target.id])).rows[0];
    eq(edited.revision, edit.results.find((result) => result.ok).value, 'stored revision is the sole returned winner');

    async function work(id) {
        await db.exec('BEGIN;SET LOCAL ROLE service_role');
        try {
            const rows = await scalar(db, 'SELECT public.buddy_watch_work(NULL,32)');
            return rows.find((row) => row.id === id);
        } finally {
            await db.exec('ROLLBACK');
        }
    }
    const updateReport = (watch, at, sog = 0) =>
        db.query(
            `INSERT INTO public.vessels(mmsi,data_source,position_at,location,sog,nav_status)
             VALUES($1,'aishub',to_timestamp($2::double precision/1000),extensions.ST_SetSRID(extensions.ST_MakePoint(0,0),4326)::extensions.geography,$3,0)
             ON CONFLICT(mmsi) DO UPDATE SET position_at=excluded.position_at,sog=excluded.sog`,
            [watch.configuration.mmsi, at, sog],
        );
    const apply = (client, row, result) =>
        scalar(client, 'SELECT public.buddy_watch_apply($1,$2,$3,$4::jsonb,$5::jsonb)', [
            row.id,
            row.revision,
            row.stateRevision,
            JSON.stringify(row.facts),
            JSON.stringify(result),
        ]);
    const watchLock = 'SELECT id FROM public.vessel_watchlist WHERE id=$1 FOR UPDATE';
    const queueBefore = await scalar(db, 'SELECT count(*)::integer FROM public.push_notification_queue');
    await updateReport(edited, Date.now() - 1000);
    const initial = await work(edited.id);
    const initialResult = evaluateBuddy(emptyBuddyState(), initial.facts, null, Date.now());
    const first = await race('empty-state-CAS', 'service_role', null, watchLock, [edited.id], (c) =>
        apply(c, initial, initialResult),
    );
    eq(
        first.results.every((result) => result.ok),
        true,
        'empty-state contenders all finish normally',
    );
    eq(first.results.filter((result) => result.value === true).length, 1, 'only one empty-state CAS creates state');
    eq(first.results.filter((result) => result.value === false).length, 15, 'empty-state losers cannot replay');
    const stored = (await db.query('SELECT * FROM private_buddy_watch.states WHERE watch_id=$1', [edited.id])).rows[0];
    eq(stored.state, initialResult.state, 'sole stored state matches the original qualified assessment');
    await updateReport(edited, Date.now() - 500, 4);
    const next = await work(edited.id);
    const nextResult = evaluateBuddy(next.state, next.facts, null, Date.now());
    const updated = await race('existing-state-CAS', 'service_role', null, watchLock, [edited.id], (c) =>
        apply(c, next, nextResult),
    );
    eq(
        updated.results.every((result) => result.ok),
        true,
        'existing-state contenders all finish normally',
    );
    eq(updated.results.filter((result) => result.value === true).length, 1, 'one existing-state revision wins');
    eq(updated.results.filter((result) => result.value === false).length, 15, 'old state revision never replays');
    eq(
        await scalar(db, 'SELECT count(*)::integer FROM public.push_notification_queue'),
        queueBefore,
        'short samples stay silent',
    );

    const oldFacts = await work(edited.id);
    const oldAssessment = evaluateBuddy(oldFacts.state, oldFacts.facts, null, Date.now());
    const changedFacts = await race(
        'facts-change-while-apply-waits',
        'service_role',
        null,
        watchLock,
        [edited.id],
        (c) => apply(c, oldFacts, oldAssessment),
        () => updateReport(edited, oldFacts.facts.at + 1, 5),
    );
    eq(
        changedFacts.results.map((result) => [result.ok, result.value]),
        Array.from({ length: WIDTH }, () => [true, false]),
        'all pending assessments reject provider facts changed behind the row lock',
    );
    const beforeEdit = await work(edited.id);
    const beforeAssessment = evaluateBuddy(beforeEdit.state, beforeEdit.facts, null, Date.now());
    const changedConfig = await race(
        'configuration-change-while-apply-waits',
        'service_role',
        null,
        watchLock,
        [edited.id],
        (c) => apply(c, beforeEdit, beforeAssessment),
        async () => {
            await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
            await db.exec('SET LOCAL ROLE authenticated');
            await db.query('SELECT public.configure_buddy_watch($1,$2,$3,$4::jsonb)', [
                edited.boat_id,
                edited.id,
                beforeEdit.revision,
                JSON.stringify({ ...edited.configuration, label: 'Reviewed while worker waited' }),
            ]);
            await db.exec('RESET ROLE');
        },
    );
    eq(
        changedConfig.results.map((result) => [result.ok, result.value]),
        Array.from({ length: WIDTH }, () => [true, false]),
        'all pending assessments reject an explicit configuration change',
    );

    const since = Date.now() - 180000;
    const candidate = {
        observedAt: since,
        mode: 'stopped',
        area: 'unknown',
        candidate: 'moving',
        candidateSince: since,
        areaCandidate: 'unknown',
        areaSince: null,
        notSeen: false,
    };
    for (const watch of watches) {
        await updateReport(watch, Date.now() - 1000, 4);
        await db.query(
            `INSERT INTO private_buddy_watch.states(watch_id,state) VALUES($1,$2::jsonb)
             ON CONFLICT(watch_id) DO UPDATE SET state=excluded.state,revision=gen_random_uuid(),last_notice_at=NULL`,
            [watch.id, JSON.stringify(candidate)],
        );
    }
    await db.query("INSERT INTO private_buddy_watch.quotas VALUES($1,(now() AT TIME ZONE 'UTC')::date,11)", [owner]);
    const candidates = [];
    for (const watch of watches) {
        const row = await work(watch.id);
        const result = evaluateBuddy(row.state, row.facts, null, Date.now());
        eq(result.event, 'moving', 'fixture has a real sustained transition eligible for one ordinary notice');
        candidates.push({ row, result });
    }
    const quota = await race(
        'shared-owner-daily-quota',
        'service_role',
        null,
        'SELECT owner_id FROM private_buddy_watch.quotas WHERE owner_id=$1 FOR UPDATE',
        [owner],
        (c, i) => apply(c, candidates[i % candidates.length].row, candidates[i % candidates.length].result),
    );
    eq(
        quota.results.every((result) => result.ok),
        true,
        'all quota contenders return normally',
    );
    eq(
        quota.results.filter((result) => result.value === true).length,
        10,
        'each of the ten distinct states advances once',
    );
    eq(quota.results.filter((result) => result.value === false).length, 6, 'duplicate state contenders remain refused');
    eq(
        await scalar(db, 'SELECT used FROM private_buddy_watch.quotas WHERE owner_id=$1', [owner]),
        12,
        'quota stops at twelve',
    );
    const notices = (await db.query('SELECT * FROM public.push_notification_queue WHERE recipient_user_id=$1', [owner]))
        .rows;
    eq(notices.length, 1, 'sixteen overlapping requests consume only the one remaining ordinary notice slot');
    eq(
        await scalar(db, 'SELECT count(*)::integer FROM public.push_notification_queue'),
        queueBefore + 1,
        'concurrent quota does not affect another owner or duplicate a queue row',
    );
    const emitted = candidates.find((value) => value.row.id === notices[0].data.watch_id);
    eq(notices[0].data.observed_at, emitted.row.facts.at, 'concurrent queue retains the original provider clock');
    eq(
        /lat|lon|mmsi|position|token|url/.test(JSON.stringify(notices[0].data)),
        false,
        'queue facts contain no positions or identities from provider records',
    );
    return {
        serverVersion: version,
        postgisVersion: postgis,
        spatialAdapter: { exercised: true, namespace: schema, unit: 'nautical-miles', samples: 4 },
        races,
        concurrentFixtureQueueRows: notices.length,
    };
}
