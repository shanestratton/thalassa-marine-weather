import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    parseSshManifest,
    sshGeneration,
    SSH_BOUNDS,
    SSH_CELLS,
    SSH_DATASET,
    SSH_FILE_BYTES,
    SSH_METADATA,
} from '../services/weather/api/sshManifestContract';
import { decodeSshObservation, fetchSshObservation } from '../services/weather/api/sshObservations';
import { sampleScalarGrid } from '../services/weather/scalarGridImage';

const day = Date.UTC(2026, 9, 16),
    now = day + 90_000_000;
function manifest() {
    const generation = sshGeneration('2026-10-16T00:00:00Z', ['d'.repeat(64)]);
    return {
        schema_version: 2,
        dataset: { key: 'ssh', id: SSH_DATASET },
        generation,
        generated_at: '2026-10-17T00:00:00Z',
        published_at: '2026-10-17T00:01:00Z',
        data_start: '2026-10-16T00:00:00Z',
        data_end: '2026-10-16T00:00:00Z',
        cadence_hours: 24,
        dimensions: { width: 720, height: 360 },
        bounds: { ...SSH_BOUNDS },
        metadata: { ...SSH_METADATA } as Record<string, string>,
        producer: { commit: 'a'.repeat(40), run_id: 123, run_attempt: 1 },
        files: [
            {
                step: 0,
                offset_hours: 0,
                data_time: '2026-10-16T00:00:00Z',
                filename: `${generation}-h000.bin`,
                bytes: SSH_FILE_BYTES,
                sha256: 'd'.repeat(64),
                content_type: 'application/octet-stream',
            },
        ],
    };
}
function binary() {
    const bytes = new Uint8Array(SSH_FILE_BYTES),
        view = new DataView(bytes.buffer);
    const header =
        '5448535301040000d002680100000000007866c000000000007056c00000000000786640000000000070564000280242a1010000000000000000000000000000';
    bytes.set(header.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
    for (let i = 0; i < SSH_CELLS; i++) {
        if (i % 720 >= 360) continue;
        bytes[64 + SSH_CELLS * 16 + i] = 1;
        [-0.2, 0.1, -0.4, 0.3].forEach((v, c) => view.setFloat32(64 + (c * SSH_CELLS + i) * 4, v, true));
    }
    return bytes;
}
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('independent observed SSH trust boundary', () => {
    it('matches the actual Python canonical generation vector', () => {
        expect(sshGeneration('2026-10-16T00:00:00Z', ['d'.repeat(64)])).toBe('g-20261016T000000Z-5591b5f0096c');
        expect(parseSshManifest(manifest(), now)).toMatchObject({
            sourceTimeMs: day,
            generation: 'g-20261016T000000Z-5591b5f0096c',
        });
    });
    it.each([
        ['non-demo product', (b: ReturnType<typeof manifest>) => (b.dataset.id = 'demo')],
        ['unit conversion', (b: ReturnType<typeof manifest>) => (b.metadata.units = 'ft,ft,kts,kts')],
        ['forecast label', (b: ReturnType<typeof manifest>) => (b.metadata.kind = 'forecast')],
        ['wrong grid', (b: ReturnType<typeof manifest>) => (b.dimensions.width = 1440)],
        ['future frame', (b: ReturnType<typeof manifest>) => (b.data_end = '2026-10-17T00:00:00Z')],
        ['retimed file', (b: ReturnType<typeof manifest>) => (b.files[0].offset_hours = 24)],
        ['unbound checksum', (b: ReturnType<typeof manifest>) => (b.files[0].sha256 = 'e'.repeat(64))],
        ['unsafe asset path', (b: ReturnType<typeof manifest>) => (b.files[0].filename = '../source.bin')],
        ['byte count', (b: ReturnType<typeof manifest>) => (b.files[0].bytes += 1)],
    ])('refuses %s', (_, mutate) => {
        const body = manifest();
        mutate(body);
        expect(() => parseSshManifest(body, now)).toThrow();
    });
    it('does not refresh source age from fetch/publication dates', () => {
        expect(() => parseSshManifest(manifest(), day + 4 * 86_400_000 + 1)).toThrow(/stale/);
        expect(() => parseSshManifest(manifest(), day - 1)).toThrow(/future/);
        expect(() => parseSshManifest({ ...manifest(), unexpected: 'field' }, now)).toThrow(/fields/);
    });
    it('decodes Python little-endian bytes and preserves signed native units and missing coast', () => {
        const grid = decodeSshObservation(binary(), parseSshManifest(manifest(), now));
        expect(grid.sourceTimeMs).toBe(day);
        expect(sampleScalarGrid(grid.adt, -179.75, -89.75)).toBeCloseTo(-0.2);
        expect(sampleScalarGrid(grid.sla, -179.75, -89.75)).toBeCloseTo(0.1);
        expect(sampleScalarGrid(grid.eastward, -179.75, -89.75)).toBeCloseTo(-0.4);
        expect(sampleScalarGrid(grid.northward, -179.75, -89.75)).toBeCloseTo(0.3);
        expect(sampleScalarGrid(grid.adt, 0.25, -89.75)).toBeNull();
        expect(sampleScalarGrid(grid.adt, 0, -89.75)).toBeNull();
    });
    it.each([
        ['THCU magic', (v: DataView) => v.setUint32(0, 0x55434854, true)],
        ['reserved bytes', (v: DataView) => v.setUint8(63, 1)],
        ['wrong original date', (v: DataView) => v.setBigInt64(44, BigInt(day + 86_400_000), true)],
        ['masked nonzero', (v: DataView) => v.setFloat32(64 + 360 * 4, 1, true)],
        ['unknown mask', (v: DataView) => v.setUint8(64 + SSH_CELLS * 16, 2)],
        ['nonfinite height', (v: DataView) => v.setFloat32(64, NaN, true)],
        ['impossible height', (v: DataView) => v.setFloat32(64, 6, true)],
    ])('refuses binary %s', (_, mutate) => {
        const bytes = binary();
        mutate(new DataView(bytes.buffer));
        expect(() => decodeSshObservation(bytes, parseSshManifest(manifest(), now))).toThrow();
    });
    it('does not borrow the caller input buffer', () => {
        const bytes = binary(),
            grid = decodeSshObservation(bytes, parseSshManifest(manifest(), now));
        bytes.fill(0);
        expect(sampleScalarGrid(grid.adt, -179.75, -89.75)).toBeCloseTo(-0.2);
    });
    it('rejects changed immutable bytes before passing observations to a layer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const bytes = binary(),
            fetcher = vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(JSON.stringify(manifest()), { headers: { 'content-type': 'application/json' } }),
                )
                .mockResolvedValueOnce(
                    new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
                );
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchSshObservation(new AbortController().signal)).rejects.toThrow(/SHA-256/);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('never begins a request for a retired map lease', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const controller = new AbortController();
        controller.abort();
        await expect(fetchSshObservation(controller.signal)).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
});
