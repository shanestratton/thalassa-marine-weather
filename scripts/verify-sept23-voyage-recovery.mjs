// Read-only post-recovery proof; also prepares a guarded rollback locally.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
assert.ok(dir?.includes('/thalassa-sept23-recovery-'));
const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const save = (name, value) =>
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), {
        mode: 0o600,
        flag: 'wx',
    });
const manifest = read('manifest.json');
const before = read('cloud-before.json');
const { owner, boat, voyage, offsetNm } = manifest;
const prefix = 'recover_pi_20260923_tongue_row_';
const scope = `user_id='${owner}' AND boat_id='${boat}' AND voyage_id='${voyage}'`;
const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = `(SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE ${scope})`;
const protectedState = `jsonb_build_object(
 'retirements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY voyage_id) FROM public.live_track_retirements r WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'hidden',(SELECT jsonb_agg(to_jsonb(h) ORDER BY voyage_id) FROM public.voyage_log_hidden_voyages h WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY voyage_id) FROM public.voyage_plan_links l WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY voyage_id) FROM public.log_passage_memberships m WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'diaries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.diary_entries d WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'live_tail',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.live_track l WHERE ${scope}))`;
const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout='60s'; SELECT
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY timestamp,id) FROM public.ship_logs s WHERE ${scope}) AS logs,
 ${digest} AS digest,
 (SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE user_id='${owner}' AND voyage_id IS DISTINCT FROM '${voyage}') AS other_digest,
 ${protectedState} AS protected; COMMIT;`;
const out = execFileSync('/opt/homebrew/bin/supabase', ['db', 'query', '--linked', sql, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
});
const after = JSON.parse(out.slice(out.indexOf('{'))).rows[0];
assert.equal(after.logs.length, 1441);
assert.equal(after.other_digest, before.other_digest, 'Unrelated voyage history changed');
assert.deepEqual(after.protected, read('verified-cloud-before.json').protected, 'Related/privacy records changed');
const index = new Map(after.logs.map((p) => [p.id, p]));
const stable = ({ cumulative_distance_nm, distance_nm, waypoint_name, ...rest }) => rest;
for (const p of before.logs) {
    const now = index.get(p.id);
    assert.ok(now, 'Original row missing');
    assert.deepEqual(stable(now), stable(p), 'Original measurement changed');
    assert.ok(Math.abs(now.cumulative_distance_nm - p.cumulative_distance_nm - offsetNm) < 1e-10);
    if (p.id !== before.logs[0].id) {
        assert.equal(now.distance_nm, p.distance_nm);
        assert.equal(now.waypoint_name, p.waypoint_name);
    } else {
        assert.ok(Math.abs(now.distance_nm * 1852 - manifest.joinMetres) < 1e-8);
        assert.equal(now.waypoint_name, 'App recording began · original mark');
    }
}
const recovered = after.logs.filter((p) => p.client_operation_id?.startsWith(prefix));
assert.equal(recovered.length, 398);
assert.equal(new Set(recovered.map((p) => p.client_operation_id)).size, 398);
const proposed = new Map(read('recovered-prefix-samples.json').map((p) => [p.client_operation_id, p]));
for (const p of recovered) {
    const source = proposed.get(p.client_operation_id);
    assert.ok(source);
    assert.equal(Date.parse(p.timestamp), Date.parse(source.timestamp));
    for (const key of [
        'latitude',
        'longitude',
        'speed_kts',
        'course_deg',
        'wind_speed',
        'water_temp',
        'pressure',
        'distance_nm',
        'cumulative_distance_nm',
    ]) {
        if (source[key] === null) assert.equal(p[key], null);
        else assert.ok(Math.abs(p[key] - source[key]) < 1e-10, key);
    }
}
save('cloud-after.json', after);
const originalFields = before.logs.map(({ id, cumulative_distance_nm, distance_nm, waypoint_name }) => ({
    id,
    cumulative_distance_nm,
    distance_nm,
    waypoint_name,
}));
const rollback = `BEGIN;
SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='10s';
CREATE TEMP TABLE original_fields ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset(${lit(JSON.stringify(originalFields))}::jsonb) AS x(id uuid,cumulative_distance_nm double precision,distance_nm double precision,waypoint_name text);
GRANT SELECT ON original_fields TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='${owner}'; SET LOCAL request.jwt.claim.role='authenticated';
DO $preflight$ BEGIN
 IF auth.uid() IS DISTINCT FROM '${owner}'::uuid THEN RAISE EXCEPTION 'Owner mismatch'; END IF;
 PERFORM id FROM public.ship_logs WHERE ${scope} FOR UPDATE;
 IF (SELECT count(*) FROM public.ship_logs WHERE ${scope})<>1441 OR ${digest} IS DISTINCT FROM '${after.digest}' THEN RAISE EXCEPTION 'Recovered voyage changed: do not rollback'; END IF;
 IF ${protectedState} IS DISTINCT FROM ${lit(JSON.stringify(after.protected))}::jsonb THEN RAISE EXCEPTION 'Privacy or related records changed'; END IF;
END $preflight$;
DELETE FROM public.ship_logs WHERE ${scope} AND starts_with(client_operation_id,'${prefix}');
UPDATE public.ship_logs s SET cumulative_distance_nm=o.cumulative_distance_nm,distance_nm=o.distance_nm,waypoint_name=o.waypoint_name FROM original_fields o WHERE s.id=o.id AND s.user_id='${owner}' AND s.boat_id='${boat}' AND s.voyage_id='${voyage}';
DO $verify$ BEGIN
 IF (SELECT count(*) FROM public.ship_logs WHERE ${scope})<>1043 OR ${digest} IS DISTINCT FROM '${before.digest}' THEN RAISE EXCEPTION 'Rollback did not restore original track exactly'; END IF;
 IF ${protectedState} IS DISTINCT FROM ${lit(JSON.stringify(after.protected))}::jsonb THEN RAISE EXCEPTION 'Related records changed'; END IF;
END $verify$;
RESET ROLE;
COMMIT;
`;
save('rollback-if-needed.sql', rollback);
console.log(
    JSON.stringify(
        {
            verified: true,
            voyage,
            insertedCount: recovered.length,
            retainedCount: before.logs.length,
            totalCount: after.logs.length,
            unrelatedHistoryUnchanged: true,
            diaryAndPrivacyUnchanged: true,
            originalMeasurementsUnchanged: true,
            rollbackPath: join(dir, 'rollback-if-needed.sql'),
        },
        null,
        2,
    ),
);
