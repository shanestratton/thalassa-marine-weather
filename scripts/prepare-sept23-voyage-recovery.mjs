// Prepare only: preserve the existing Tongue Bay -> Butterfly Bay voyage and
// prepend the missing original Pi observations. Review/dry-run SQL separately.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const owner = 'a4dbb302-d4ab-43a5-881f-737e9c56d50c';
const boat = '8b364a98-86f6-4a5c-9f9a-5793d1a8ee39';
const voyage = 'voyage_1790124398484_ykoyqfm54';
const scope = `user_id='${owner}' AND boat_id='${boat}' AND voyage_id='${voyage}'`;
const prefix = 'recover_pi_20260923_tongue_row_';
const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;
const query = (sql) => {
    const out = execFileSync('/opt/homebrew/bin/supabase', ['db', 'query', '--linked', sql, '--output', 'json'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out.slice(out.indexOf('{'))).rows;
};
const before = read('cloud-before.json');
const old = before.logs;
assert.equal(old.length, 1043);
assert.ok(
    old.every(
        (p) =>
            p.user_id === owner &&
            p.boat_id === boat &&
            p.voyage_id === voyage &&
            p.archived === false &&
            !p.linked_plan_id &&
            !p.saved_route_id,
    ),
);
assert.equal(old[0].waypoint_name, 'Voyage Start');
assert.equal(old.at(-1).waypoint_name, 'Voyage End');
assert.equal(old.at(-1).cumulative_distance_nm, 11.19);
assert.equal(Date.parse(old[0].timestamp), Date.parse('2026-09-23T00:46:38.516Z'));
assert.equal(Date.parse(old.at(-1).timestamp), Date.parse('2026-09-23T02:23:01.259Z'));
assert.equal(before.hidden, null);
assert.equal(before.links, null);
assert.equal(before.memberships, null);
assert.equal(before.diaries.length, 1);
assert.equal(before.diaries[0].voyage_id, voyage);
assert.equal(before.retirements.length, 1);
assert.equal(before.retirements[0].reason, 'archived'); // Restored durable history: do not revive its live shadow.

const pi = read('pi-original-samples.json');
const sourceHash = createHash('sha256')
    .update(readFileSync(join(dir, 'pi-original-samples.json')))
    .digest('hex');
assert.equal(sourceHash, 'f3328d68856aa9c8c159324accbc3b6d5913628bd95033817a4d993a65840efd');
// Last observed stationary fix before sustained push-off. The 56-second
// sampling interval brackets departure; no exact cast-off event is invented.
const start = Date.parse('2026-09-22T23:30:39.680Z');
const end = Date.parse(old[0].timestamp);
const missing = pi.filter((p) => p.at_ms >= start && p.at_ms < end);
assert.equal(missing.length, 398);
assert.equal(missing[0].source_rowid, 35400);
assert.equal(missing.at(-1).source_rowid, 35797);
assert.ok(missing[0].sog_kts < 0.8 && missing[1].sog_kts >= 0.8);
assert.ok(
    missing.every(
        (p) =>
            Number.isSafeInteger(p.source_rowid) &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lon) &&
            Math.abs(p.lat) <= 90 &&
            Math.abs(p.lon) <= 180,
    ),
);
assert.equal(new Set(missing.map((p) => p.at_ms)).size, missing.length);
const radians = (value) => (value * Math.PI) / 180;
const nm = (a, b) =>
    3440.065 *
    2 *
    Math.asin(
        Math.sqrt(
            Math.min(
                1,
                Math.sin(radians(b.lat - a.lat) / 2) ** 2 +
                    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon - a.lon) / 2) ** 2,
            ),
        ),
    );
const cardinal = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const finite = (value) => (Number.isFinite(value) ? value : null);
const provenance = `Recovered missing Tongue Bay departure on 25 September 2026 from 398 original onboard Pi GPS observations recorded 23 September 2026. GPS-estimated departure is bracketed by the last stationary fix at 09:30:39.680 AEST and first moving fix at 09:31:35.690 AEST. No coordinates or timestamps interpolated. Existing voyage ${voyage}, its 1043 original app fixes and linked diary are retained. Original app recording began at 10:46:38.516 AEST; original cumulative totals are offset by the sampled missing distance including the measured join. Original Pi source SHA256 ${sourceHash}.`;
let distance = 0;
let maxGapMs = 0;
let maxDerivedKts = 0;
const rows = missing.map((p, index) => {
    const prev = missing[index - 1];
    const leg = prev ? nm(prev, p) : 0;
    const gap = prev ? p.at_ms - prev.at_ms : 0;
    if (prev) assert.ok(gap > 0);
    distance += leg;
    maxGapMs = Math.max(maxGapMs, gap);
    if (gap) maxDerivedKts = Math.max(maxDerivedKts, leg / (gap / 3_600_000));
    return {
        timestamp: new Date(p.at_ms).toISOString(),
        latitude: p.lat,
        longitude: p.lon,
        speed_kts: finite(p.sog_kts),
        course_deg: finite(p.cog_deg),
        wind_speed: finite(p.tws_kts),
        wind_direction: Number.isFinite(p.twd_deg)
            ? cardinal[Math.round((((p.twd_deg % 360) + 360) % 360) / 22.5) % 16]
            : null,
        water_temp: finite(p.water_temp_c),
        pressure: finite(p.pressure_hpa),
        client_operation_id: `${prefix}${p.source_rowid}`,
        distance_nm: leg,
        cumulative_distance_nm: distance,
        entry_type: index === 0 ? 'waypoint' : 'auto',
        waypoint_name: index === 0 ? 'Tongue Bay · recovered departure' : null,
        notes: index === 0 ? provenance : null,
    };
});
const joinNm = nm(missing.at(-1), { lat: old[0].latitude, lon: old[0].longitude });
const joinGapMs = end - missing.at(-1).at_ms;
const offsetNm = distance + joinNm;
maxDerivedKts = Math.max(maxDerivedKts, joinNm / (joinGapMs / 3_600_000));
assert.ok(maxGapMs < 60_000 && maxDerivedKts < 11);
assert.ok(joinGapMs > 0 && joinGapMs < 4000 && joinNm * 1852 < 11);
assert.ok(offsetNm > 6.7 && offsetNm < 6.72);
const protectedState = `jsonb_build_object(
 'retirements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY voyage_id) FROM public.live_track_retirements r WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'hidden',(SELECT jsonb_agg(to_jsonb(h) ORDER BY voyage_id) FROM public.voyage_log_hidden_voyages h WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY voyage_id) FROM public.voyage_plan_links l WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY voyage_id) FROM public.log_passage_memberships m WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'diaries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.diary_entries d WHERE user_id='${owner}' AND voyage_id='${voyage}'),
 'live_tail',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.live_track l WHERE ${scope}))`;
const digest = `(SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE ${scope})`;
const otherDigest = `(SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE user_id='${owner}' AND voyage_id IS DISTINCT FROM '${voyage}')`;
const fresh = query(
    `BEGIN READ ONLY; SET LOCAL statement_timeout='60s'; SELECT ${digest} AS digest, ${otherDigest} AS other_digest, ${protectedState} AS protected, (SELECT count(*) FROM public.voyages WHERE user_id='${owner}' AND status='active') AS active; COMMIT;`,
)[0];
assert.equal(fresh.digest, before.digest, 'Target changed: audit again');
assert.equal(fresh.other_digest, before.other_digest, 'Other history changed: audit again');
assert.equal(fresh.active, 0, 'Do not modify while a voyage is active');
for (const key of ['retirements', 'hidden', 'links', 'memberships', 'diaries', 'live_tail'])
    assert.deepEqual(fresh.protected[key], before[key], `${key} changed`);
save('verified-cloud-before.json', fresh);
save('recovered-prefix-samples.json', rows);
const manifest = {
    owner,
    boat,
    voyage,
    sourceSha256: sourceHash,
    insertedCount: rows.length,
    retainedCount: old.length,
    resultingCount: rows.length + old.length,
    start: rows[0].timestamp,
    pushOffFirstMoving: new Date(missing[1].at_ms).toISOString(),
    joinAt: old[0].timestamp,
    end: old.at(-1).timestamp,
    offsetNm,
    finalDistanceNm: old.at(-1).cumulative_distance_nm + offsetNm,
    joinGapMs,
    joinMetres: joinNm * 1852,
    maxGapMs,
    maxDerivedKts,
    provenance,
};
save('manifest.json', manifest);

const sql = `BEGIN;
SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='10s';
CREATE TEMP TABLE recovered_prefix ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset(${lit(JSON.stringify(rows))}::jsonb) AS x(timestamp timestamptz,latitude double precision,longitude double precision,speed_kts double precision,course_deg double precision,wind_speed double precision,wind_direction text,water_temp double precision,pressure double precision,client_operation_id text,distance_nm double precision,cumulative_distance_nm double precision,entry_type text,waypoint_name text,notes text);
GRANT SELECT ON recovered_prefix TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='${owner}'; SET LOCAL request.jwt.claim.role='authenticated';
DO $preflight$ BEGIN
 IF auth.uid() IS DISTINCT FROM '${owner}'::uuid THEN RAISE EXCEPTION 'Owner mismatch'; END IF;
 PERFORM id FROM public.ship_logs WHERE ${scope} FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.ship_logs WHERE user_id='${owner}' AND starts_with(client_operation_id,'${prefix}')) THEN RAISE EXCEPTION 'Recovery already applied: verify instead of rerun'; END IF;
 IF (SELECT count(*) FROM public.ship_logs WHERE ${scope})<>1043 OR ${digest} IS DISTINCT FROM '${before.digest}' THEN RAISE EXCEPTION 'Originals changed since backup'; END IF;
 IF ${otherDigest} IS DISTINCT FROM '${before.other_digest}' THEN RAISE EXCEPTION 'Other history changed'; END IF;
 IF ${protectedState} IS DISTINCT FROM ${lit(JSON.stringify(fresh.protected))}::jsonb THEN RAISE EXCEPTION 'Privacy or related records changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.voyages WHERE user_id='${owner}' AND status='active') THEN RAISE EXCEPTION 'Active voyage: defer history recovery'; END IF;
END $preflight$;
CREATE TEMP TABLE original_track ON COMMIT DROP AS SELECT * FROM public.ship_logs WHERE ${scope};
UPDATE public.ship_logs SET cumulative_distance_nm=cumulative_distance_nm+${offsetNm},
 distance_nm=CASE WHEN id='${old[0].id}'::uuid THEN ${joinNm} ELSE distance_nm END,
 waypoint_name=CASE WHEN id='${old[0].id}'::uuid THEN 'App recording began · original mark' ELSE waypoint_name END
WHERE ${scope};
INSERT INTO public.ship_logs(user_id,boat_id,voyage_id,timestamp,latitude,longitude,speed_kts,course_deg,wind_speed,wind_direction,water_temp,pressure,client_operation_id,distance_nm,cumulative_distance_nm,entry_type,waypoint_name,notes,source,archived,is_on_water)
SELECT '${owner}'::uuid,'${boat}'::uuid,'${voyage}',timestamp,latitude,longitude,speed_kts,course_deg,wind_speed,wind_direction,water_temp,pressure,client_operation_id,distance_nm,cumulative_distance_nm,entry_type,waypoint_name,notes,'device',false,NULL FROM recovered_prefix ORDER BY timestamp;
DO $verify$ BEGIN
 IF (SELECT count(*) FROM public.ship_logs WHERE ${scope})<>1441 THEN RAISE EXCEPTION 'Combined track count mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM recovered_prefix r LEFT JOIN public.ship_logs s ON s.user_id='${owner}' AND s.client_operation_id=r.client_operation_id WHERE s.id IS NULL OR s.boat_id IS DISTINCT FROM '${boat}'::uuid OR s.voyage_id IS DISTINCT FROM '${voyage}' OR s.timestamp IS DISTINCT FROM r.timestamp OR s.latitude IS DISTINCT FROM r.latitude OR s.longitude IS DISTINCT FROM r.longitude OR s.speed_kts IS DISTINCT FROM r.speed_kts OR s.course_deg IS DISTINCT FROM r.course_deg OR s.distance_nm IS DISTINCT FROM r.distance_nm OR s.cumulative_distance_nm IS DISTINCT FROM r.cumulative_distance_nm) THEN RAISE EXCEPTION 'Recovered observations mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM original_track o LEFT JOIN public.ship_logs s ON s.id=o.id WHERE s.id IS NULL OR (to_jsonb(s)-ARRAY['cumulative_distance_nm','distance_nm','waypoint_name']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['cumulative_distance_nm','distance_nm','waypoint_name']) OR s.cumulative_distance_nm IS DISTINCT FROM o.cumulative_distance_nm+${offsetNm} OR s.distance_nm IS DISTINCT FROM CASE WHEN o.id='${old[0].id}'::uuid THEN ${joinNm} ELSE o.distance_nm END OR s.waypoint_name IS DISTINCT FROM CASE WHEN o.id='${old[0].id}'::uuid THEN 'App recording began · original mark' ELSE o.waypoint_name END) THEN RAISE EXCEPTION 'Original observations altered beyond derived offset/start label'; END IF;
 IF ${otherDigest} IS DISTINCT FROM '${before.other_digest}' THEN RAISE EXCEPTION 'Other history changed'; END IF;
 IF ${protectedState} IS DISTINCT FROM ${lit(JSON.stringify(fresh.protected))}::jsonb THEN RAISE EXCEPTION 'Related records not preserved'; END IF;
END $verify$;
SELECT * FROM public.get_voyage_summaries(false) WHERE voyage_id='${voyage}';
RESET ROLE;
`;
save('dry-run.sql', sql + 'ROLLBACK;\n');
save('apply.sql', sql + 'COMMIT;\n');
console.log(JSON.stringify(manifest, null, 2));
