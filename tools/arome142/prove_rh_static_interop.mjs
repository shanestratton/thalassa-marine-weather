/** Generated ecCodes→static→actual Edge point consumer, never a provider proof. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchAromeFromStatic } from '../../supabase/functions/_shared/arome-upstream.ts';
import { AROME_STATIC_ORIGIN } from '../../services/weather/aromeStaticContract.ts';

assert.ok(process.env.AROME_RH_NATIVE_FIXTURE_DIR, 'unique generated native fixture path required');
const root = path.resolve(process.env.AROME_RH_NATIVE_FIXTURE_DIR);
const cohort = path.join(root, 'cohort');
const slot = await fs.readFile(path.join(cohort, 'prepared-slot.json'));
const parsed = JSON.parse(slot.toString('utf8'));
const nativeRaw = await fs.readFile(path.join(cohort, 'native-proof.json'));
const native = JSON.parse(nativeRaw.toString('utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(cohort, 'manifest.json'), 'utf8'));
assert.equal(createHash('sha256').update(nativeRaw).digest('hex'), manifest.nativeProofSha256);
assert.equal(native.optionalDisplayQualification.policy, 'upper-rh-display-unavailable-v1');
assert.equal(native.optionalDisplayQualification.displayAvailability, 'partial');
assert.equal(native.optionalDisplayQualification.upperDisplayUnavailableCells, 255813);
assert.equal(native.optionalDisplayQualification.sourceBitmapMissingCells, 2);
assert.equal(native.originalSourceGribBytesModified, false);
assert.equal(native.allOriginalGridLocationsPreserved, true);
assert.equal('allOriginalCellsPreserved' in native, false);
const requests = [];
const fetcher = async (input, init) => {
    const url = String(input);
    const prefix = `${AROME_STATIC_ORIGIN}/${parsed.model}/`;
    assert.ok(url.startsWith(prefix));
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    requests.push(url);
    assert.ok(requests.length <= 4);
    const suffix = url.slice(prefix.length);
    if (suffix === 'current-0.json') return new Response(slot);
    if (suffix === 'current-1.json') return new Response(null, { status: 404 });
    if (suffix === `cohorts/${parsed.manifestSha256}/manifest.json`)
        return new Response(await fs.readFile(path.join(cohort, 'manifest.json')));
    assert.match(suffix, /^tiles\/[a-f0-9]{64}\.bin\.gz$/);
    return new Response(await fs.readFile(path.join(cohort, suffix)));
};
const data = await fetchAromeFromStatic(
    parsed.model,
    { lat: -20, lon: 166 },
    (key) => (key === 'THALASSA_AROME_STATIC_ENABLED' ? 'true' : undefined),
    fetcher,
    () => Date.parse('2026-10-17T01:00:00Z'),
);
assert.equal(requests.length, 4);
assert.equal(data.seaCell.i, 300);
assert.equal(data.seaCell.j, 240);
assert.equal(data.hourly.time.length, 49);
assert.deepEqual(
    data.hourly.relative_humidity_2m,
    Array.from({ length: 49 }, (_, hour) =>
        [6, 7, 8, 11].includes(hour) ? null : hour === 9 ? 100 : hour === 10 ? 0 : 75,
    ),
);
assert.deepEqual(data.hourly.pressure_msl, Array(49).fill(1012.345));
assert.deepEqual(data.hourly.wind_speed_10m, Array(49).fill(Math.hypot(5, -2) / 0.5144444444444445));
assert.deepEqual(data.hourly.temperature_2m, Array(49).fill(290 - 273.15));
assert.equal(data.runUtc, parsed.runUtc);
const proof = {
    schema: 1,
    fixtureOnly: true,
    providerRequests: 0,
    published: false,
    policy: native.optionalDisplayQualification.policy,
    nativeProofSha256: manifest.nativeProofSha256,
    unchangedNearestSeaCell: data.seaCell,
    requests,
    nullHours: [6, 7, 8, 11],
    validNeighborNotBorrowed: true,
    windTemperaturePressurePreserved: true,
    passed: true,
};
await fs.writeFile(path.join(root, 'rh-interop-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify(proof));
