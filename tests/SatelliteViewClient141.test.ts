import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    prepareSatelliteFrame,
    readSatelliteTimes,
    satelliteImagePlan,
    satelliteProductAt,
    type SatelliteTimesLease,
} from '../services/weather/satelliteView';
import { parseSatelliteTimes } from '../services/weather/satelliteViewContract';
const policy = vi.hoisted(() => ({ blocked: false }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => policy.blocked }));
vi.mock('../services/native/apiBase', () => ({ API_BASE: '/api' }));
const now = Date.parse('2026-10-17T03:30:00Z'),
    NativeURL = URL;
const xml = readFileSync('tests/fixtures/satellite141/himawari-domains.xml', 'utf8');
function lease(): SatelliteTimesLease {
    const times = parseSatelliteTimes(xml, 'himawari-ir', now);
    return { times, isCurrent: () => true, close: vi.fn() };
}
function png(width: number, height: number) {
    const bytes = new Uint8Array(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}
let width = 0,
    height = 0;
const draw = vi.fn(),
    close = vi.fn(),
    revoke = vi.fn();
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    policy.blocked = false;
    vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => `blob:http://localhost/00000000-0000-4000-8000-000000000000`),
        revokeObjectURL: revoke,
    });
    vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => ({ width, height, close })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () =>
            ({
                drawImage: draw,
                getImageData: (_x: number, _y: number, w: number, h: number) => ({
                    data: new Uint8ClampedArray(w * h * 4).fill(255),
                }),
            }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
        callback(new Blob(['local synthetic PNG'])),
    );
    vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => {
            const url = new NativeURL(input, 'https://local.test');
            if (url.searchParams.get('action') === 'times')
                return Promise.resolve(Response.json(parseSatelliteTimes(xml, 'himawari-ir', now)));
            width = Number(url.searchParams.get('width'));
            height = Number(url.searchParams.get('height'));
            return Promise.resolve(
                new Response(new Uint8Array(png(width, height)).buffer, {
                    headers: {
                        'content-type': 'image/png',
                        'x-thalassa-listed-time': url.searchParams.get('time')!,
                        'x-thalassa-satellite-product': 'himawari-ir',
                        'x-thalassa-satellite-window': `${url.searchParams.get('bbox')}:${width}x${height}`,
                    },
                }),
            );
        }),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('bounded original satellite viewport and handoff', () => {
    it('splits a dateline viewport into exactly two bounded sequential Mercator pieces', () => {
        const plan = satelliteImagePlan([170, -10, 190, 10]);
        expect(plan.box).toEqual([170, -10, 190, 10]);
        expect(plan.parts).toHaveLength(2);
        expect(plan.parts[0].box).toEqual([170, -10, 180, 10]);
        expect(plan.parts[1].box).toEqual([-180, -10, -170, 10]);
        expect(plan.parts[0].width + plan.parts[1].width).toBe(plan.width);
        expect(plan.width).toBeLessThanOrEqual(1024);
        expect(plan.height).toBeLessThanOrEqual(1024);
        expect(Object.isFrozen(plan.parts[0].box)).toBe(true);
    });
    it.each(
        [
            [0, -10, 361, 10],
            [0, 86, 1, 87],
            [NaN, 0, 1, 1],
            [1, 0, 0, 1],
        ].map((bounds) => ({ bounds })),
    )('holds unknown/non-Mercator views $bounds', ({ bounds }) => {
        expect(() => satelliteImagePlan(bounds)).toThrow();
    });
    it('chooses regional defaults as suggestions rather than invented coverage authority', () => {
        expect(satelliteProductAt([140, -30, 150, -20])).toBe('himawari-ir');
        expect(satelliteProductAt([-140, 0, -130, 10])).toBe('goes-west-ir');
        expect(satelliteProductAt([-80, 0, -70, 10])).toBe('goes-east-ir');
        expect(satelliteProductAt([0, 0, 10, 10])).toBe('meteosat-ir');
        expect(satelliteProductAt([0, 70, 10, 80])).toBe('viirs-night');
    });
    it('prepares one canvas with each bitmap closed, then transfers URL release to the presentation owner', async () => {
        const source = lease(),
            frame = source.times.frames.at(-1)!,
            controller = new AbortController(),
            plan = satelliteImagePlan([170, -10, 190, 10]);
        const prepared = await prepareSatelliteFrame(source, frame, plan, controller.signal, () => true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(draw).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledTimes(2);
        expect(prepared.alphaFraction).toBe(1);
        expect(prepared.isCurrent()).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        const image = prepared.claim();
        prepared.releaseUnclaimed();
        expect(revoke).not.toHaveBeenCalled();
        image.release!();
        image.release!();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(prepared.isCurrent()).toBe(false);
    });
    it('releases a late/unclaimed image and refuses copied frames or serialized viewport plans', async () => {
        const source = lease(),
            frame = source.times.frames.at(-1)!,
            plan = satelliteImagePlan([-1, -1, 1, 1]),
            signal = new AbortController().signal;
        await expect(prepareSatelliteFrame(source, { ...frame }, plan, signal, () => true)).rejects.toThrow(
            /selection/,
        );
        await expect(
            prepareSatelliteFrame(source, frame, JSON.parse(JSON.stringify(plan)), signal, () => true),
        ).rejects.toThrow(/selection/);
        expect(fetch).not.toHaveBeenCalled();
        const prepared = await prepareSatelliteFrame(source, frame, plan, signal, () => true);
        prepared.releaseUnclaimed();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(() => prepared.claim()).toThrow(/retired/);
    });
    it('does not start a request on a metered-link block', async () => {
        policy.blocked = true;
        const source = lease(),
            signal = new AbortController().signal;
        await expect(readSatelliteTimes('himawari-ir', signal, () => true)).rejects.toThrow(/Satellite Mode/);
        await expect(
            prepareSatelliteFrame(
                source,
                source.times.frames.at(-1)!,
                satelliteImagePlan([-1, -1, 1, 1]),
                signal,
                () => true,
            ),
        ).rejects.toThrow(/Satellite Mode/);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('returns an immutable metadata lease without aborting its successful read proof', async () => {
        const controller = new AbortController(),
            source = await readSatelliteTimes('himawari-ir', controller.signal, () => true);
        expect(source.isCurrent()).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(Object.isFrozen(source.times.frames[0])).toBe(true);
        controller.abort();
        expect(source.isCurrent()).toBe(false);
    });
    it('retires metadata on clock rollback, expiry or original owner change', async () => {
        let current = true;
        const source = await readSatelliteTimes('himawari-ir', new AbortController().signal, () => current);
        vi.setSystemTime(now - 3000);
        expect(source.isCurrent()).toBe(false);
        vi.setSystemTime(now);
        current = false;
        expect(source.isCurrent()).toBe(false);
        current = true;
        vi.setSystemTime(now + 120001);
        expect(source.isCurrent()).toBe(false);
        source.close();
    });
    it('closes a decoder result arriving after cancellation instead of producing a blob URL', async () => {
        let resolve!: (value: ImageBitmap) => void;
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(
                () =>
                    new Promise<ImageBitmap>((finish) => {
                        resolve = finish;
                    }),
            ),
        );
        const source = lease(),
            controller = new AbortController();
        const pending = prepareSatelliteFrame(
            source,
            source.times.frames.at(-1)!,
            satelliteImagePlan([-1, -1, 1, 1]),
            controller.signal,
            () => true,
        );
        const rejected = expect(pending).rejects.toBeDefined();
        await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
        controller.abort();
        await rejected;
        resolve({ width, height, close } as unknown as ImageBitmap);
        await Promise.resolve();
        expect(close).toHaveBeenCalledTimes(1);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
});
