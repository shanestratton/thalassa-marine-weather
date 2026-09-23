/** Narrow, user-approved recovery. Prepare is read-only; SQL is reviewed separately. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = 'a4dbb302-d4ab-43a5-881f-737e9c56d50c';
const BOAT = '8b364a98-86f6-4a5c-9f9a-5793d1a8ee39';
const OLD = 'voyage_1789439313134_5xka8gz8r';
const NEW = 'voyage_recovered_pi_1789439313134_5xka8gz8r';
const CURRENT = 'voyage_1789727911316_jgthpaqcr';
const STAGING = 'recovery_sept15_20260921';
const DIARIES = ['e6d8b482-af7f-40cf-80c2-5792aa42e71d', '9dd1d955-9757-4d99-8160-eea48b2d89e5', '04f3bf49-b4a6-4c77-b852-92a665716631'];
const START = 1789439313134;
const END = Date.parse('2026-09-17T00:45:00Z');
const dir = mkdtempSync(join(tmpdir(), 'thalassa-sept15-recovery-'));
const save = (name, value) => writeFileSync(join(dir, name), value, { mode: 0o600, flag: 'wx' });
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const ids = DIARIES.map(literal).join(',');
const q = (sql) => {
    const out = execFileSync('/opt/homebrew/bin/supabase', ['db', 'query', '--linked', sql, '--output', 'json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(out.slice(out.indexOf('{'))).rows;
};
const guards = `jsonb_build_object(
    'current_count', (SELECT count(*) FROM public.ship_logs WHERE user_id='${OWNER}' AND voyage_id='${CURRENT}'),
    'current_digest', (SELECT md5(string_agg(to_jsonb(s)::text, '' ORDER BY id)) FROM public.ship_logs s WHERE user_id='${OWNER}' AND voyage_id='${CURRENT}'),
    'old_count', (SELECT count(*) FROM public.ship_logs WHERE user_id='${OWNER}' AND voyage_id='${OLD}'),
    'retirement', (SELECT jsonb_agg(to_jsonb(r) ORDER BY voyage_id) FROM public.live_track_retirements r WHERE user_id='${OWNER}' AND voyage_id='${OLD}')
)`;
const backup = q(`BEGIN READ ONLY; SET LOCAL statement_timeout='30s'; SELECT ${guards} AS guards,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.diary_entries d WHERE id IN (${ids}) AND user_id='${OWNER}' AND boat_id='${BOAT}') AS diaries,
    (SELECT count(*) FROM public.ship_logs WHERE voyage_id='${NEW}') AS recovery_count; COMMIT;`)[0];
save('cloud-before.json', JSON.stringify(backup, null, 2));
assert.equal(backup.guards.current_count, 18286);
assert.equal(backup.guards.old_count, 0);
assert.ok(backup.guards.retirement?.some((r) => r.reason === 'deleted'));
assert.equal(backup.recovery_count, 0, 'Recovery exists already: inspect, do not create another recovery');
assert.equal(backup.diaries.length, 3);
for (const d of backup.diaries) assert.equal(d.voyage_id, OLD);

const remote = `const Database=require('better-sqlite3');const db=new Database('cache/track/track.db',{readonly:true,fileMustExist:true});db.pragma('query_only=ON');const rows=db.prepare('SELECT rowid AS source_rowid,* FROM track_points WHERE at_ms>=? AND at_ms<=? ORDER BY at_ms,rowid').all(${START},${END});process.stdout.write(JSON.stringify(rows));db.close();`;
const raw = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', 'shanes@100.86.90.84', `cd /opt/thalassa-pi-cache && node -e ${shellQuote(remote)}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
save('pi-original-samples.json', raw);
const points = JSON.parse(raw);
assert.equal(points.length, 16018);
const sha256 = createHash('sha256').update(raw).digest('hex');
const radians = (n) => n * Math.PI / 180;
function distance(a, b) {
    const dlat = radians(b.lat - a.lat), dlon = radians(b.lon - a.lon);
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dlon / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
let total = 0, maxGapMs = 0, maxDerivedKnots = 0;
const cardinal = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const finiteOrNull = (n) => Number.isFinite(n) ? n : null;
const provenance = `Recovered from onboard Pi GPS samples on 21 September 2026; original deleted voyage ${OLD}. Provisional window: original voyage creation through reported Gladstone arrival plus 15 minutes; exact original stop time unavailable. Timestamps and coordinates are original observations; distances are derived between recorded fixes. Not a reconstruction of original app log entries. Source SHA256 ${sha256}.`;
const rows = points.map((p, i) => {
    assert.ok(Number.isSafeInteger(p.source_rowid));
    assert.ok(Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180);
    assert.ok(p.at_ms >= START && p.at_ms <= END);
    const prev = points[i - 1];
    const leg = prev ? distance(prev, p) : 0;
    if (prev) {
        const gap = p.at_ms - prev.at_ms;
        assert.ok(gap >= 0);
        maxGapMs = Math.max(maxGapMs, gap);
        if (gap > 0) maxDerivedKnots = Math.max(maxDerivedKnots, leg / (gap / 3600000));
    }
    total += leg;
    return {
        timestamp: new Date(p.at_ms).toISOString(), latitude: p.lat, longitude: p.lon,
        client_operation_id: `recover_pi_1789439313134_row_${p.source_rowid}`,
        distance_nm: leg, cumulative_distance_nm: total,
        speed_kts: finiteOrNull(p.sog_kts), course_deg: finiteOrNull(p.cog_deg), wind_speed: finiteOrNull(p.tws_kts),
        wind_direction: Number.isFinite(p.twd_deg) ? cardinal[Math.round(((p.twd_deg % 360 + 360) % 360) / 22.5) % 16] : null,
        water_temp: finiteOrNull(p.water_temp_c), pressure: finiteOrNull(p.pressure_hpa),
        entry_type: i === 0 ? 'waypoint' : 'auto', waypoint_name: i === 0 ? 'Recovered GPS track · Newport to Gladstone' : null,
        notes: i === 0 ? provenance : null,
    };
});
assert.equal(new Set(rows.map((r) => r.client_operation_id)).size, rows.length);
assert.ok(maxGapMs < 15 * 60000);
assert.ok(total > 300 && total < 315);
const manifest = { owner: OWNER, boat: BOAT, oldVoyage: OLD, recoveredVoyage: NEW, sourceSha256: sha256, count: rows.length, first: rows[0].timestamp, last: rows.at(-1).timestamp, distanceNm: total, maxGapMs, maxDerivedKnots, provenance };
save('manifest.json', JSON.stringify(manifest, null, 2));
const payload = JSON.stringify(rows);
assert.ok(!payload.includes('$recovery_data$'));
const expectedGuard = literal(JSON.stringify(backup.guards));
const expectedDiaries = literal(JSON.stringify(backup.diaries));
save('stage-init.sql', `BEGIN;
CREATE SCHEMA ${STAGING};
REVOKE ALL ON SCHEMA ${STAGING} FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE ${STAGING}.samples (operation_id text PRIMARY KEY, payload jsonb NOT NULL);
REVOKE ALL ON TABLE ${STAGING}.samples FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE ${STAGING}.samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${STAGING}.samples FORCE ROW LEVEL SECURITY;
COMMIT;\n`);
for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = JSON.stringify(rows.slice(offset, offset + 500));
    save(`stage-${String(offset / 500).padStart(3, '0')}.sql`, `BEGIN; SET LOCAL statement_timeout='30s';
INSERT INTO ${STAGING}.samples(operation_id,payload)
SELECT x->>'client_operation_id',x FROM jsonb_array_elements($batch$${batch}$batch$::jsonb) x
ON CONFLICT(operation_id) DO NOTHING;
DO $check$ BEGIN
IF EXISTS(SELECT 1 FROM jsonb_array_elements($batch$${batch}$batch$::jsonb) x LEFT JOIN ${STAGING}.samples s ON s.operation_id=x->>'client_operation_id' WHERE s.payload IS DISTINCT FROM x) THEN RAISE EXCEPTION 'Staging mismatch'; END IF;
END $check$; COMMIT;\n`);
}
const sql = `BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='10s';
CREATE TEMP TABLE recovered_samples ON COMMIT DROP AS
SELECT x.* FROM ${STAGING}.samples s CROSS JOIN LATERAL jsonb_to_record(s.payload) AS x(
 timestamp timestamptz, latitude double precision, longitude double precision, client_operation_id text,
 distance_nm double precision, cumulative_distance_nm double precision, speed_kts double precision, course_deg double precision,
 wind_speed double precision, wind_direction text, water_temp double precision, pressure double precision, entry_type text, waypoint_name text, notes text);
GRANT SELECT ON recovered_samples TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='${OWNER}';
SET LOCAL request.jwt.claim.role='authenticated';
DO $preflight$ DECLARE recovery_row record; BEGIN
  IF auth.uid() IS DISTINCT FROM '${OWNER}'::uuid THEN RAISE EXCEPTION 'Owner context mismatch'; END IF;
  IF ${guards} IS DISTINCT FROM ${expectedGuard}::jsonb THEN RAISE EXCEPTION 'Protected voyage/retirement changed'; END IF;
  FOR recovery_row IN SELECT user_id,client_operation_id FROM public.diary_entries WHERE id IN (${ids}) AND user_id='${OWNER}' AND boat_id='${BOAT}' ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('diary-relay:'||recovery_row.user_id::text||':'||recovery_row.client_operation_id,0));
  END LOOP;
  PERFORM id FROM public.diary_entries WHERE id IN (${ids}) FOR UPDATE;
  IF (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.diary_entries d WHERE id IN (${ids}) AND user_id='${OWNER}' AND boat_id='${BOAT}') IS DISTINCT FROM ${expectedDiaries}::jsonb THEN RAISE EXCEPTION 'Diary changed since backup'; END IF;
  IF EXISTS(SELECT 1 FROM public.ship_logs WHERE voyage_id='${NEW}') THEN RAISE EXCEPTION 'Recovery already exists; verify instead of rerunning'; END IF;
END $preflight$;
INSERT INTO public.ship_logs(user_id,boat_id,voyage_id,timestamp,latitude,longitude,client_operation_id,distance_nm,cumulative_distance_nm,speed_kts,course_deg,wind_speed,wind_direction,water_temp,pressure,entry_type,waypoint_name,notes,source,archived,is_on_water)
SELECT '${OWNER}'::uuid,'${BOAT}'::uuid,'${NEW}',timestamp,latitude,longitude,client_operation_id,distance_nm,cumulative_distance_nm,speed_kts,course_deg,wind_speed,wind_direction,water_temp,pressure,entry_type,waypoint_name,notes,'device',false,NULL
FROM recovered_samples ORDER BY timestamp,client_operation_id
ON CONFLICT(user_id,client_operation_id) DO NOTHING;
DO $verify$ DECLARE n integer; BEGIN
  IF (SELECT count(*) FROM public.ship_logs WHERE user_id='${OWNER}' AND boat_id='${BOAT}' AND voyage_id='${NEW}') <> ${rows.length} THEN RAISE EXCEPTION 'Recovery row count mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM recovered_samples r LEFT JOIN public.ship_logs s ON s.user_id='${OWNER}' AND s.client_operation_id=r.client_operation_id WHERE s.id IS NULL OR s.voyage_id IS DISTINCT FROM '${NEW}' OR s.timestamp IS DISTINCT FROM r.timestamp OR s.latitude IS DISTINCT FROM r.latitude OR s.longitude IS DISTINCT FROM r.longitude OR s.cumulative_distance_nm IS DISTINCT FROM r.cumulative_distance_nm) THEN RAISE EXCEPTION 'Recovered sample differs'; END IF;
  UPDATE public.diary_entries SET voyage_id='${NEW}',client_revision=client_revision+1
  WHERE id IN (${ids}) AND user_id='${OWNER}' AND boat_id='${BOAT}' AND voyage_id='${OLD}';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n <> 3 THEN RAISE EXCEPTION 'Expected exactly three diary relinks'; END IF;
  IF ${guards} IS DISTINCT FROM ${expectedGuard}::jsonb THEN RAISE EXCEPTION 'Protected voyage/retirement changed'; END IF;
END $verify$;
SELECT '${NEW}' AS recovered_voyage,count(*) AS samples,min(timestamp) AS first_sample,max(timestamp) AS last_sample,max(cumulative_distance_nm) AS sampled_distance_nm,
 (SELECT count(*) FROM public.diary_entries WHERE id IN (${ids}) AND user_id='${OWNER}' AND boat_id='${BOAT}' AND voyage_id='${NEW}') AS linked_diaries
FROM public.ship_logs WHERE user_id='${OWNER}' AND boat_id='${BOAT}' AND voyage_id='${NEW}';
RESET ROLE;
DROP TABLE ${STAGING}.samples RESTRICT;
DROP SCHEMA ${STAGING} RESTRICT;
`;
save('dry-run.sql', sql + 'ROLLBACK;\n');
save('apply.sql', sql + 'COMMIT;\n');
console.log(JSON.stringify({ directory: dir, ...manifest, sqlBytes: Buffer.byteLength(sql) }, null, 2));
