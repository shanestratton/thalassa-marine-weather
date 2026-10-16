// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRegionalGeneration, stageRegionalGeneration } from '../tools/currents138/regionalPublisher';
import {
    decodeCurrentRegionalAsset,
    verifyCurrentRegionalEnvelope,
    parseCurrentRegionalManifest,
} from '../services/weather/api/currentRegionalContract';
import { createCurrentSeriesSampler, type CurrentSeries } from '../services/weather/currentSeries';
import { currentRegionalFixture } from './helpers/currentRegionalFixture';

const at = Date.UTC(2026, 9, 16, 12);
const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 19)]),
    format: 'der',
    type: 'pkcs8',
});
const publicKey = new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
        if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'thalassa-current138-')))
            throw Error('Unsafe cleanup');
        fs.rmSync(root, { recursive: true, force: true });
    }
});
function source(id = 't-45-90', width = 2, steps = 2): CurrentSeries {
    const fixture = currentRegionalFixture(id, at, steps, width);
    return decodeCurrentRegionalAsset(fixture.bytes, fixture.manifest, 'CMEMS');
}
const pack = (sources = [source()]) => buildRegionalGeneration(sources, at, 'fixture-only', key);
function destination() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-current138-'));
    roots.push(root);
    return path.join(root, 'generation');
}
async function unpack(build: ReturnType<typeof pack>, id = 't-45-90') {
    const envelope = JSON.parse(Buffer.from(build.files.get(id + '.json')!).toString('utf8'));
    const payload = await verifyCurrentRegionalEnvelope(envelope, new Map([['fixture-only', publicKey]]));
    const manifest = parseCurrentRegionalManifest(payload, id, at);
    return decodeCurrentRegionalAsset(build.files.get(manifest.models.CMEMS!.filename)!, manifest, 'CMEMS');
}

describe('bounded offline regional publisher', () => {
    it('real app verifies the exact signed output and preserves masks, units, times and source identity', async () => {
        const input = source();
        input.tiles[0].sourceSha256 = 'c'.repeat(64);
        input.tiles[0].ocean.u[0][0] = NaN;
        input.tiles[0].ocean.known[0][0] = 0;
        const build = pack([input]),
            actual = await unpack(build);
        expect(actual.tiles[0].sourceSha256).toBe('c'.repeat(64));
        expect(actual.tiles[0].ocean.times).toEqual([at, at + 3600000]);
        expect(actual.tiles[0].ocean.known[0][0]).toBe(0);
        expect(Number.isNaN(actual.tiles[0].ocean.u[0][0])).toBe(true);
        expect(createCurrentSeriesSampler(actual)(2, 0, at)).toBeNull();
        expect(createCurrentSeriesSampler(actual)(0, 2, at)?.u).toBe(1);
        expect(createCurrentSeriesSampler(actual)(0, 2, at + 3600000)?.u).toBe(2);
        expect(createCurrentSeriesSampler(actual)(0, 2, at - 1)).toBeNull();
    });
    it('generation is deterministic across input order and changes for actual data', () => {
        const first = source(),
            second = source('t-45-91');
        first.tiles.push(second.tiles[0]);
        const swapped = { ...first, tiles: [...first.tiles].reverse() };
        expect(pack([first]).generation).toBe(pack([swapped]).generation);
        const previous = pack([first]).generation;
        swapped.tiles[0].ocean.u[0][0] += 0.25;
        expect(pack([swapped]).generation).not.toBe(previous);
    });
    it('rejects stale clocks, unverified basis and nonfinite known values', () => {
        const original = source();
        expect(() => buildRegionalGeneration([original], at + 37 * 3600000, 'fixture-only', key)).toThrow(/clock/);
        expect(() => pack([{ ...original, vectorBasis: 'grid-relative' } as unknown as CurrentSeries])).toThrow(
            /basis/,
        );
        original.tiles[0].ocean.u[0][0] = NaN;
        expect(() => pack([original])).toThrow(/known nonfinite/);
    });
    it('rejects incomplete regions, unsupported grids and duplicate models', () => {
        const input = source();
        input.tiles[0].west = 0.5;
        expect(() => pack([input])).toThrow(/incomplete fixed region/);
        expect(() => pack([source(), source()])).toThrow(/duplicate model/);
        const large = source('t-45-90', 64);
        const planes = large.tiles[0].ocean;
        planes.times = Array.from({ length: 121 }, (_, index) => at + index * 3600000);
        planes.u = planes.times.map(() => planes.u[0].slice());
        planes.v = planes.times.map(() => planes.v[0].slice());
        planes.known = planes.times.map(() => planes.known[0].slice());
        expect(() => pack([large])).toThrow(/asset cap/);
    });
    it('uses the actual normalized RTOFS three-hour axis and refuses modelled tide', async () => {
        const input = source();
        input.model = 'RTOFS';
        input.tiles[0].ocean.cadenceHours = 3;
        input.tiles[0].ocean.times[1] = at + 3 * 3600000;
        const build = pack([input]);
        const envelope = JSON.parse(Buffer.from(build.files.get('t-45-90.json')!).toString());
        const manifest = parseCurrentRegionalManifest(
            await verifyCurrentRegionalEnvelope(envelope, new Map([['fixture-only', publicKey]])),
            't-45-90',
            at,
        );
        const actual = decodeCurrentRegionalAsset(build.files.get(manifest.models.RTOFS!.filename)!, manifest, 'RTOFS');
        expect(actual.tiles[0].ocean.times[1]).toBe(at + 3 * 3600000);
        input.tiles[0].tide = input.tiles[0].ocean;
        expect(() => pack([input])).toThrow(/tidal model/);
    });
    it('stages a fresh immutable directory and reads all assets before manifests', async () => {
        const build = pack(),
            output = destination();
        const original = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
            if (String(file).endsWith('.json') && !String(file).endsWith('STAGED.json'))
                for (const row of build.receipt.files.filter((row) => row.kind === 'asset'))
                    expect(fs.existsSync(path.join(output, row.name))).toBe(true);
            return original(file, data, options);
        });
        await stageRegionalGeneration(build, output);
        expect(JSON.parse(fs.readFileSync(path.join(output, 'STAGED.json'), 'utf8')).publication).toBe(false);
        await expect(stageRegionalGeneration(build, output)).rejects.toThrow();
        expect((await unpack(build)).generation).toBe(build.generation);
    });
    it('refuses changed files or false accounting before creating output', async () => {
        const build = pack(),
            output = destination();
        build.receipt.bytes = 1;
        await expect(stageRegionalGeneration(build, output)).rejects.toThrow(/accounting/);
        expect(fs.existsSync(output)).toBe(false);
        const next = pack();
        next.files.values().next().value![15] ^= 1;
        await expect(stageRegionalGeneration(next, output)).rejects.toThrow(/bytes changed/);
        expect(fs.existsSync(output)).toBe(false);
    });
    it('an interrupted stage never writes manifest or readiness receipt', async () => {
        const build = pack(),
            output = destination(),
            controller = new AbortController(),
            original = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
            const result = original(file, data, options);
            controller.abort();
            return result;
        });
        await expect(stageRegionalGeneration(build, output, controller.signal)).rejects.toThrow(/cancelled/);
        expect(fs.readdirSync(output).some((file) => file.endsWith('.json'))).toBe(false);
    });
    it('a pre-cancelled stage writes nothing', async () => {
        const output = destination(),
            controller = new AbortController();
        controller.abort();
        await expect(stageRegionalGeneration(pack(), output, controller.signal)).rejects.toThrow(/cancelled/);
        expect(fs.existsSync(output)).toBe(false);
    });
});
