// One-off, owner-scoped repair. Defaults to a transactional rollback rehearsal.
// --apply commits only after exact snapshot/source checks. No dates/content/media change.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owner = 'a4dbb302-d4ab-43a5-881f-737e9c56d50c';
const boat = '8b364a98-86f6-4a5c-9f9a-5793d1a8ee39';
const changes = [
    {
        id: 'd3db949e-673e-4fd5-93e3-386caa667c58',
        title: 'Daydreaming, Cold Beers & a Netflix Emergency',
        latitude: -20.253911666666667,
        longitude: 148.81443833333333,
        voyage_id: 'voyage_recovered_pi_20260924_butterfly_daydream',
        evidence: 'GPS from the original 01-Daydream-welcome.jpg, 24 September 2026 11:35:43 AEST; GPS horizontal positioning error 4.75 m. Published upload copies had metadata removed.',
    },
    {
        id: '50dc6a13-782c-421c-b931-109b1c1989cd',
        title: 'Seventy-Five Boats & One Floating Test Lab',
        latitude: -20.1163016666667,
        longitude: 148.983233333333,
        voyage_id: 'voyage_1790124398484_ykoyqfm54',
        evidence: 'IMG_2146.PNG original capture timestamp is 23 September 2026 11:07:13 AEST. Nearest recorded boat fix a858c838-bb44-44b8-bb8e-ee024309812a is 11:07:22.808 AEST (9.808 seconds later); approximate story position, not an interpolated measurement.',
    },
];
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const ids = changes.map((change) => literal(change.id)).join(',');
const query = (sql) => {
    let output;
    try {
        output = execFileSync('/opt/homebrew/bin/supabase', ['db', 'query', '--linked', sql, '--output', 'json'], {
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
            timeout: 60_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        // Never log the complete SQL/snapshot on failure.
        throw new Error(`Database query failed: ${String(error.stderr ?? '').slice(0, 800)}`);
    }
    return JSON.parse(output.slice(output.indexOf('{'))).rows;
};
const before = query(`BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
SELECT to_jsonb(d) AS row FROM public.diary_entries d
WHERE user_id=${literal(owner)} AND boat_id=${literal(boat)} AND id IN (${ids}) ORDER BY id; COMMIT;`).map((row) => row.row);
assert.equal(before.length, 2);
for (const change of changes) {
    const row = before.find((item) => item.id === change.id);
    assert.equal(row.title, change.title);
    assert.equal(row.latitude, null);
    assert.equal(row.longitude, null);
    assert.equal(row.voyage_id, null);
    assert.equal(row.is_public, true);
    assert.ok(Number.isSafeInteger(row.client_revision));
    assert.ok(row.client_operation_id);
}
const folder = mkdtempSync(join(tmpdir(), 'thalassa-diary-pin-repair-'));
const save = (name, value) => writeFileSync(join(folder, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
save('before.json', before);
save('changes-with-provenance.json', changes);
const snapshots = before.map((row) => `(${literal(row.id)}::uuid,${literal(JSON.stringify(row))}::jsonb)`).join(',');
const updates = changes.map((change) => `(${literal(change.id)}::uuid,${change.latitude},${change.longitude},${literal(change.voyage_id)})`).join(',');
const sql = `BEGIN;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE diary_pin_before ON COMMIT DROP AS SELECT * FROM (VALUES ${snapshots}) AS input(id,snapshot);
GRANT SELECT ON diary_pin_before TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', ${literal(owner)}, true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.diary_entries d JOIN diary_pin_before b ON b.id=d.id AND b.snapshot=to_jsonb(d)) <> 2 THEN RAISE EXCEPTION 'Diary changed: re-audit required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.ship_logs WHERE id='a858c838-bb44-44b8-bb8e-ee024309812a' AND user_id=${literal(owner)} AND boat_id=${literal(boat)} AND voyage_id='voyage_1790124398484_ykoyqfm54' AND archived=false AND abs(latitude-(-20.1163016666667))<1e-10 AND abs(longitude-148.983233333333)<1e-10) THEN RAISE EXCEPTION 'Screenshot GPS source changed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.ship_logs WHERE user_id=${literal(owner)} AND boat_id=${literal(boat)} AND voyage_id='voyage_recovered_pi_20260924_butterfly_daydream' AND archived=false AND waypoint_name='Daydream Island · recovered arrival') THEN RAISE EXCEPTION 'Daydream trip source unavailable'; END IF;
END $$;
UPDATE public.diary_entries d SET latitude=v.lat, longitude=v.lon, voyage_id=v.voyage_id,
 client_revision=d.client_revision+1, updated_at=now()
FROM (VALUES ${updates}) AS v(id,lat,lon,voyage_id)
WHERE d.id=v.id AND d.user_id=${literal(owner)} AND d.boat_id=${literal(boat)}
 AND d.latitude IS NULL AND d.longitude IS NULL AND d.voyage_id IS NULL AND d.is_public=true;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.diary_entries d JOIN diary_pin_before b ON b.id=d.id
     WHERE (to_jsonb(d)-ARRAY['latitude','longitude','voyage_id','client_revision','updated_at'])=(b.snapshot-ARRAY['latitude','longitude','voyage_id','client_revision','updated_at'])
       AND d.client_revision=(b.snapshot->>'client_revision')::integer+1
       AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL AND d.voyage_id IS NOT NULL) <> 2
 THEN RAISE EXCEPTION 'Repair changed unexpected data'; END IF;
 IF (SELECT count(*) FROM public.diary_entries d JOIN (VALUES ${updates}) AS v(id,lat,lon,voyage_id) ON d.id=v.id
     WHERE abs(d.latitude-v.lat)<1e-10 AND abs(d.longitude-v.lon)<1e-10 AND d.voyage_id=v.voyage_id) <> 2
 THEN RAISE EXCEPTION 'Repaired position mismatch'; END IF;
END $$;
SELECT id,title,latitude,longitude,voyage_id,client_revision FROM public.diary_entries WHERE id IN (${ids}) ORDER BY id;
${process.argv.includes('--apply') ? 'COMMIT' : 'ROLLBACK'};`;
save('repair.sql', sql);
const result = query(sql);
save('result.json', result);
console.log(JSON.stringify({ committed: process.argv.includes('--apply'), backupFolder: folder, result }, null, 2));
