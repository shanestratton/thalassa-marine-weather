import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ATMOS_CELLS,
    ATMOS_DATASETS,
    ATMOS_FIELDS,
    ATMOS_HEADER_BYTES,
    atmosFileBytes,
    canonicalAtmosGeneration,
    type AtmosDataset,
    type AtmosField,
} from '../services/weather/api/atmosContract';
import { sha256Hex } from '../services/weather/api/marineManifestContract';
import { atmosDewpointSpread, openAtmosSession } from '../services/weather/api/atmosSession';

const policy = vi.hoisted(() => ({ allowed: true }));
vi.mock('../services/networkPolicy', () => ({
    assertNetworkAllowed: () => {
        if (!policy.allowed) throw new Error('Satellite Mode');
    },
}));
const RUN = '2026-10-17T00:00:00Z';
const runMs = Date.parse(RUN);
const HOUR = 3_600_000;
const POINT = 90 * 360 + 180;
const original = { gust: 12, visibility: 5000, pressure: 101200, temperature: 290, dewpoint: 289 };

function fixture(dataset: AtmosDataset = 'ifs-pressure', missing?: { step: number; field: AtmosField }) {
    const spec = ATMOS_DATASETS[dataset];
    const buffers = new Map<number, ArrayBuffer>();
    for (const step of [0, 1, 2, spec.steps - 1]) {
        const buffer = new ArrayBuffer(atmosFileBytes(dataset));
        const view = new DataView(buffer);
        view.setUint32(0, 0x53414854, true);
        view.setUint8(4, 1);
        view.setUint8(5, spec.code);
        view.setUint8(6, spec.fields.length);
        view.setUint16(8, 360, true);
        view.setUint16(10, 181, true);
        view.setFloat64(12, -180, true);
        view.setFloat64(20, -90, true);
        view.setFloat64(28, 1, true);
        view.setFloat64(36, 1, true);
        view.setFloat64(44, runMs, true);
        view.setUint16(52, step * 6, true);
        spec.fields.forEach((field, channel) => {
            view.setUint8(56 + channel, ATMOS_FIELDS[field].code);
            const base = ATMOS_HEADER_BYTES + channel * ATMOS_CELLS * 5;
            const increment = field === 'pressure' ? 100 : field === 'visibility' ? 1000 : 0.1;
            for (let i = 0; i < ATMOS_CELLS; i++)
                view.setFloat32(base + i * 4, original[field] + step * increment, true);
            new Uint8Array(buffer, base + ATMOS_CELLS * 4, ATMOS_CELLS).fill(1);
            if (missing?.step === step && missing.field === field) {
                view.setFloat32(base + POINT * 4, 0, true);
                view.setUint8(base + ATMOS_CELLS * 4 + POINT, 0);
            }
        });
        buffers.set(step, buffer);
    }
    const hashes = Array.from({ length: spec.steps }, (_, step) => {
        const buffer = buffers.get(step);
        return buffer ? sha256Hex(new Uint8Array(buffer)) : 'a'.repeat(64);
    });
    const generation = canonicalAtmosGeneration(RUN, dataset, hashes);
    const manifest = {
        schema_version: 2,
        dataset: { key: dataset, id: spec.id },
        generation,
        generated_at: '2026-10-17T04:00:00Z',
        published_at: '2026-10-17T04:05:00Z',
        data_start: RUN,
        data_end: new Date(runMs + (spec.steps - 1) * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
        cadence_hours: 6,
        dimensions: { width: 360, height: 181 },
        bounds: { west: -180, south: -90, east: 179, north: 90 },
        producer: { commit: 'b'.repeat(40), run_id: 1, run_attempt: 1 },
        metadata: {
            model: spec.model,
            source_resolution_degrees: '0.25',
            display_resolution_degrees: '1',
            fields: spec.fields.join(','),
            attribution: spec.attribution,
            licence: spec.licence,
        },
        files: hashes.map((hash, step) => ({
            step,
            offset_hours: step * 6,
            data_time: new Date(runMs + step * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
            filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
            bytes: atmosFileBytes(dataset),
            sha256: hash,
            content_type: 'application/octet-stream',
        })),
    };
    const respond = (url: string) => {
        if (url.includes('manifest-v2.json'))
            return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
        const step = Number(/-h(\d{3})\.bin/.exec(url)?.[1]);
        const buffer = buffers.get(step);
        if (!buffer) throw new Error(`Fixture unexpected frame ${step}`);
        return new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } });
    };
    const fetch = vi.fn(async (url: string, _options?: RequestInit) => respond(url));
    vi.stubGlobal('fetch', fetch);
    return { fetch, respond, buffers, manifest };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(runMs + 5 * HOUR);
    policy.allowed = true;
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('caller-owned atmospheric display sessions', () => {
    it('matches the actual Python canonical generation vectors', () => {
        expect(canonicalAtmosGeneration(RUN, 'gfs-atmos', Array(29).fill('a'.repeat(64)))).toBe(
            'g-20261017T000000Z-e969399b1a46',
        );
        expect(canonicalAtmosGeneration(RUN, 'ifs-pressure', Array(41).fill('a'.repeat(64)))).toBe(
            'g-20261017T000000Z-cf9fb9291d40',
        );
    });

    it('loads only the selected bracket, interpolates native pressure and keeps a successful proof live', async () => {
        const f = fixture();
        const controller = new AbortController();
        const session = await openAtmosSession('ifs-pressure', controller.signal);
        const view = await session.readAt(runMs + 3 * HOUR);
        expect(view.validMs).toBe(runMs + 3 * HOUR);
        expect(view.fields.pressure?.values[POINT]).toBe(101250);
        expect(view.isCurrent()).toBe(true);
        expect(f.fetch).toHaveBeenCalledTimes(3);
        expect(f.fetch.mock.calls[0][0]).toBe(
            'https://pcisdplnodrphauixcau.supabase.co/functions/v1/forecast-assets/ifs-pressure/manifest-v2.json',
        );
        for (const [url, options] of f.fetch.mock.calls.slice(1)) {
            expect(url).toMatch(/\/ifs-pressure\/g-[^/]+-h00[01]\.bin$/);
            expect(options?.cache).toBe('force-cache');
            expect(options?.signal?.aborted).toBe(false);
        }
        session.close();
        expect(view.isCurrent()).toBe(false);
    });

    it('reuses the bracket, retires prior views on every new selection and evicts unrelated raw frames', async () => {
        const f = fixture();
        const session = await openAtmosSession('ifs-pressure', new AbortController().signal);
        const first = await session.readAt(runMs + 3 * HOUR);
        const second = await session.readAt(runMs + 4 * HOUR);
        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
        expect(f.fetch).toHaveBeenCalledTimes(3);
        await session.readAt(runMs + 12 * HOUR);
        await session.readAt(runMs);
        expect(f.fetch).toHaveBeenCalledTimes(5);
        session.close();
    });

    it('admits the actual final endpoint but never clamps a requested time outside coverage', async () => {
        const f = fixture();
        const session = await openAtmosSession('ifs-pressure', new AbortController().signal);
        const last = await session.readAt(runMs + 240 * HOUR);
        expect(last.validMs).toBe(runMs + 240 * HOUR);
        for (const time of [NaN, runMs - 1, runMs + 240 * HOUR + 1])
            await expect(session.readAt(time)).rejects.toThrow(/coverage/);
        expect(last.isCurrent()).toBe(false);
        expect(f.fetch).toHaveBeenCalledTimes(2);
        session.close();
    });

    it('keeps missing temporal contributors unknown and reports T−Td only as a finite point spread', async () => {
        fixture('gfs-atmos', { step: 1, field: 'visibility' });
        const session = await openAtmosSession('gfs-atmos', new AbortController().signal);
        const view = await session.readAt(runMs + 3 * HOUR);
        expect(view.fields.visibility?.validMask[POINT]).toBe(0);
        expect(view.fields.visibility?.values[POINT]).toBe(0);
        expect(atmosDewpointSpread(view, 0, 0)).toBeCloseTo(1);
        expect(atmosDewpointSpread(view, NaN, 0)).toBeNull();
        session.close();
        expect(atmosDewpointSpread(view, 0, 0)).toBeNull();
    });

    it('rejects a corrupt immutable asset before decoded publication', async () => {
        const f = fixture();
        new Uint8Array(f.buffers.get(0)!).fill(0, 100, 104);
        const session = await openAtmosSession('ifs-pressure', new AbortController().signal);
        await expect(session.readAt(runMs)).rejects.toThrow(/SHA-256/);
        session.close();
    });

    it.each(['owner', 'caller', 'metered', 'expiry', 'backwards'] as const)(
        'retires a returned frame on %s changes',
        async (reason) => {
            fixture();
            let owner = true;
            const controller = new AbortController();
            const session = await openAtmosSession('ifs-pressure', controller.signal, () => owner);
            const view = await session.readAt(runMs);
            if (reason === 'owner') owner = false;
            if (reason === 'caller') controller.abort();
            if (reason === 'metered') policy.allowed = false;
            if (reason === 'expiry') vi.setSystemTime(runMs + 5 * HOUR + 30 * 60_000);
            if (reason === 'backwards') vi.setSystemTime(runMs + 4 * HOUR);
            expect(view.isCurrent()).toBe(false);
            expect(session.isCurrent()).toBe(false);
            await expect(session.readAt(runMs)).rejects.toThrow();
            session.close();
        },
    );

    it('discards a late superseded fetch even if the fixture transport ignores cancellation', async () => {
        const f = fixture();
        const session = await openAtmosSession('ifs-pressure', new AbortController().signal);
        let finish!: (response: Response) => void;
        f.fetch.mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    finish = resolve;
                }),
        );
        const old = session.readAt(runMs);
        const rejected = expect(old).rejects.toThrow();
        const newest = await session.readAt(runMs + 6 * HOUR);
        finish(f.respond(f.manifest.files[0].filename));
        await rejected;
        expect(newest.isCurrent()).toBe(true);
        expect(newest.fields.pressure?.values[POINT]).toBe(101300);
        session.close();
    });

    it('refuses a pre-aborted or metered open before network I/O', async () => {
        const f = fixture();
        const controller = new AbortController();
        controller.abort();
        await expect(openAtmosSession('ifs-pressure', controller.signal)).rejects.toThrow();
        policy.allowed = false;
        await expect(openAtmosSession('gfs-atmos', new AbortController().signal)).rejects.toThrow('Satellite Mode');
        expect(f.fetch).not.toHaveBeenCalled();
    });

    it('refuses a runtime model alias before retaining ownership or fetching', async () => {
        const f = fixture();
        await expect(openAtmosSession('aifs' as AtmosDataset, new AbortController().signal)).rejects.toThrow(
            /Unsupported/,
        );
        expect(f.fetch).not.toHaveBeenCalled();
    });
});
