/** Node24 pure native-file/Edge-consumer interoperability; zero real fetches. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAromeFromStatic } from '../../supabase/functions/_shared/arome-upstream.ts';
import { AROME_STATIC_ORIGIN } from '../../services/weather/aromeStaticContract.ts';

const root = path.resolve(process.env.AROME_NATIVE_FIXTURE_DIR ?? '');
assert.ok(process.env.AROME_NATIVE_FIXTURE_DIR, 'unique generated native fixture path required');
const cohort = path.join(root, 'cohort');
const slot = await fs.readFile(path.join(cohort, 'prepared-slot.json'));
const parsed = JSON.parse(slot.toString('utf8'));
const requests = [];
const fetcher = async (input, init) => {
    const url = String(input);
    const prefix = `${AROME_STATIC_ORIGIN}/${parsed.model}/`;
    assert.ok(url.startsWith(prefix));
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    requests.push(url);
    assert.ok(requests.length <= 4, 'fixed static request cap');
    const suffix = url.slice(prefix.length);
    if (suffix === 'current-0.json') return new Response(slot);
    if (suffix === 'current-1.json') return new Response(null, { status: 404 });
    if (suffix === `cohorts/${parsed.manifestSha256}/manifest.json`)
        return new Response(await fs.readFile(path.join(cohort, 'manifest.json')));
    assert.match(suffix, /^tiles\/[a-f0-9]{64}\.bin\.gz$/);
    return new Response(await fs.readFile(path.join(cohort, suffix)));
};
const point = { lat: -25.25 + 400 * 0.025, lon: -157.5 + 400 * 0.025 };
const data = await fetchAromeFromStatic(
    parsed.model,
    point,
    (key) => (key === 'THALASSA_AROME_STATIC_ENABLED' ? 'true' : undefined),
    fetcher,
    () => Date.parse('2026-10-17T01:00:00Z'),
);
assert.equal(requests.length, 4);
assert.equal(data.seaCell.i, 400);
assert.equal(data.seaCell.j, 400);
assert.equal(data.seaCell.landFraction, 0);
assert.equal(data.hourly.time.length, 49);
assert.equal(data.hourly.time[48], Date.parse(parsed.runUtc) / 1000 + 48 * 3600);
assert.deepEqual(data.hourly.pressure_msl, Array(49).fill(1012.345));
assert.deepEqual(data.hourly.wind_speed_10m, Array(49).fill(Math.hypot(5, -2) / 0.5144444444444445));
assert.deepEqual(data.hourly.wind_direction_10m, Array(49).fill(((Math.atan2(-5, 2) * 180) / Math.PI + 360) % 360));
assert.deepEqual(data.hourly.temperature_2m, Array(49).fill(290 - 273.15));
assert.deepEqual(data.hourly.relative_humidity_2m, Array(49).fill(75));
assert.deepEqual(data.hourly.wind_gusts_10m, Array(49).fill(null));
assert.deepEqual(data.hourly.precipitation, Array(49).fill(null));
const proof = {
    schema: 1,
    fixtureOnly: true,
    providerRequests: 0,
    published: false,
    node: process.version,
    module: path.relative(process.cwd(), fileURLToPath(import.meta.url)),
    requests,
    model: data.model,
    runUtc: data.runUtc,
    cohortSha256: data.cohortSha256,
    seaCell: data.seaCell,
    hours: data.hourly.time.length,
    fields: Object.keys(data.hourly_units),
    passed: true,
};
await fs.writeFile(path.join(root, 'interop-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify(proof));
