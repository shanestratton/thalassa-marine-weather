import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    currentAssetSha256,
    decodeCurrentRegionalAsset,
    parseCurrentRegionalManifest,
    verifyCurrentRegionalEnvelope,
} from '../services/weather/api/currentRegionalContract';
import {
    createCurrentRegionalLoader,
    currentRegionsForBounds,
    currentRegionPartition,
    currentBoundsForPassage,
    loadRegionalCurrentSeries,
    CURRENT_REGIONAL_DOWNLOAD_BYTES,
} from '../services/weather/api/currentRegionalLoader';
import { createCurrentSeriesSampler } from '../services/weather/currentSeries';
import {
    currentRegionalFixture,
    fixtureKeyId,
    fixturePublicKey,
    signedCurrentManifest,
} from './helpers/currentRegionalFixture';
const T = Date.UTC(2026, 9, 16, 12),
    H = 3_600_000;
const keys = new Map([[fixtureKeyId, fixturePublicKey]]);
const request = { bounds: { north: 1, south: 0, west: 0, east: 1 }, startMs: T, endMs: T + H };
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function sourceFor(ids: string[], steps = 2, width = 2) {
    const files = new Map<string, Uint8Array>();
    for (const id of ids) {
        const { bytes, manifest } = currentRegionalFixture(id, T, steps, width);
        manifest.models.CMEMS!.sha256 = await currentAssetSha256(bytes);
        files.set(`${id}.json`, signedCurrentManifest(manifest));
        files.set(manifest.models.CMEMS!.filename, bytes);
    }
    const read = vi.fn(async (path: string, _limit: number, _signal: AbortSignal) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error('unavailable');
        return bytes;
    });
    return { keys, read, files };
}

describe('signed bounded regional currents', () => {
    it('verifies exact payload bytes and refuses wrong key, mutation or algorithm', async () => {
        const { manifest } = currentRegionalFixture('t-45-90', T);
        const signed = JSON.parse(new TextDecoder().decode(signedCurrentManifest(manifest)));
        expect(await verifyCurrentRegionalEnvelope(signed, keys)).toEqual(manifest);
        expect(await verifyCurrentRegionalEnvelope(signed, new Map())).toBeNull();
        expect(await verifyCurrentRegionalEnvelope({ ...signed, algorithm: 'SHA256' }, keys)).toBeNull();
        expect(
            await verifyCurrentRegionalEnvelope({ ...signed, payload: signed.payload.slice(0, -1) + 'A' }, keys),
        ).toBeNull();
    });
    it('decodes strict generated THCS data and returns a real time-varying field', async () => {
        const raw = currentRegionalFixture('t-45-90', T);
        expect(decodeCurrentRegionalAsset(raw.bytes, raw.manifest, 'CMEMS').tiles[0].sourceSha256).toBe('b'.repeat(64));
        const source = await sourceFor(['t-45-90']);
        const envelope = JSON.parse(new TextDecoder().decode(source.files.get('t-45-90.json')));
        const verified = await verifyCurrentRegionalEnvelope(envelope, keys);
        expect(parseCurrentRegionalManifest(verified, 't-45-90', Date.now()).regionId).toBe('t-45-90');
        const result = await createCurrentRegionalLoader(source)(request);
        expect(source.read.mock.calls.map(([path]) => path)).toHaveLength(2);
        expect(result?.tiles[0].sourceSha256).toBe('b'.repeat(64));
        expect(createCurrentSeriesSampler(result!)(0.5, 0.5, T + H / 2)).toMatchObject({ u: 1.5, v: 0 });
        expect(source.read).toHaveBeenCalledTimes(2);
    });
    it('requires every selected date-line half and preserves fixed geographic partitions', async () => {
        expect(currentBoundsForPassage({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toEqual({
            north: 1,
            south: -1,
            west: 178,
            east: -178,
        });
        const bounds = { north: 1, south: 0, west: 179, east: -179 };
        expect(currentRegionsForBounds(bounds)).toEqual(['t-45-0', 't-45-179']);
        expect(currentRegionPartition('t-45-179')).toBe('routing-currents-v1-9-35');
        const source = await sourceFor(['t-45-0', 't-45-179']);
        const result = await createCurrentRegionalLoader(source)({ ...request, bounds });
        const sample = createCurrentSeriesSampler(result!);
        expect(sample(0.5, 179.5, T)).toMatchObject({ u: 1 });
        expect(sample(0.5, -179.5, T)).toMatchObject({ u: 1 });
        source.files.delete('t-45-179.json');
        expect(await createCurrentRegionalLoader(source)({ ...request, bounds })).toBeNull();
    });
    it('refuses global, aborted, Satellite Mode and unsupported requests before reading', async () => {
        const source = await sourceFor(['t-45-90']);
        const load = createCurrentRegionalLoader(source);
        expect(await load({ ...request, bounds: { north: 90, south: -90, west: -180, east: 180 } })).toBeNull();
        expect(await load({ ...request, satelliteMode: true })).toBeNull();
        expect(await load({ ...request, signal: AbortSignal.abort() })).toBeNull();
        expect(await load({ ...request, endMs: T + 121 * H })).toBeNull();
        expect(source.read).not.toHaveBeenCalled();
    });
    it('production holds unverified provider/terms/keys closed with no WAN', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        for (const model of ['CMEMS', 'RTOFS'] as const) {
            expect(await loadRegionalCurrentSeries({ ...request, model })).toBeNull();
            expect(await loadRegionalCurrentSeries({ ...request, model, components: 'ocean+tide' })).toBeNull();
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects stale signatures/assets, missing tide/time, unavailable models and hash mismatches', async () => {
        const source = await sourceFor(['t-45-90']);
        const load = createCurrentRegionalLoader(source);
        expect(await load({ ...request, model: 'RTOFS' })).toBeNull();
        expect(await load({ ...request, components: 'ocean+tide' })).toBeNull();
        expect(await load({ ...request, endMs: T + 2 * H })).toBeNull();
        const asset = [...source.files.entries()].find(([key]) => key.endsWith('.thcs'))!;
        asset[1][asset[1].length - 1] ^= 1;
        expect(await load(request)).toBeNull();
        vi.setSystemTime(T + 37 * H);
        expect(await load(request)).toBeNull();
    });
    it('enforces one serial cohort and hard cancellation without releasing an ignored in-flight read early', async () => {
        let finish!: (bytes: Uint8Array) => void;
        const read = vi.fn(
            () =>
                new Promise<Uint8Array>((resolve) => {
                    finish = resolve;
                }),
        );
        const load = createCurrentRegionalLoader({ keys, read });
        const controller = new AbortController();
        const pending = load({ ...request, signal: controller.signal });
        expect(await load(request)).toBeNull();
        controller.abort();
        expect(await pending).toBeNull();
        expect(await load(request)).toBeNull();
        expect(read).toHaveBeenCalledOnce();
        finish(new Uint8Array());
        await Promise.resolve();
        await Promise.resolve();
    });
    it('settles the whole loader at its hard deadline even if a source ignores abort', async () => {
        vi.useFakeTimers();
        const read = vi.fn(() => new Promise<Uint8Array>(() => {}));
        const load = createCurrentRegionalLoader({ keys, read });
        const pending = load(request);
        await vi.advanceTimersByTimeAsync(8000);
        expect(await pending).toBeNull();
        expect(await load(request)).toBeNull();
        expect(read).toHaveBeenCalledOnce();
    });
    it('enforces the eight-MiB total including manifests and returns no partial eight-tile field', async () => {
        const bounds = { north: 2, south: 0, west: 0, east: 16 };
        const ids = currentRegionsForBounds(bounds)!;
        const source = await sourceFor(ids, 121, 32);
        const result = await createCurrentRegionalLoader(source)({ ...request, bounds });
        expect(result).toBeNull();
        const requestedLimits = source.read.mock.calls.map(([, limit]) => limit);
        expect(requestedLimits.at(-1)).toBeLessThan(1_000_000);
        expect(requestedLimits.every((n) => n <= CURRENT_REGIONAL_DOWNLOAD_BYTES)).toBe(true);
    });
    it('rejects exact-length/header/identity/coverage errors before a field can be exposed', () => {
        const { bytes, manifest } = currentRegionalFixture('t-45-90', T);
        expect(() => decodeCurrentRegionalAsset(bytes.subarray(0, -1), manifest, 'CMEMS')).toThrow('length');
        const bad = bytes.slice();
        new DataView(bad.buffer).setUint32(8, 40_000, true);
        expect(() => decodeCurrentRegionalAsset(bad, manifest, 'CMEMS')).toThrow('metadata size');
        expect(() =>
            decodeCurrentRegionalAsset(bytes, { ...manifest, generation: 'g-' + 'c'.repeat(24) }, 'CMEMS'),
        ).toThrow('identity');
        expect(() =>
            parseCurrentRegionalManifest(
                { ...manifest, models: { CMEMS: { ...manifest.models.CMEMS, filename: '../foreign.bin' } } },
                't-45-90',
                T,
            ),
        ).toThrow('asset identity');
    });
});
