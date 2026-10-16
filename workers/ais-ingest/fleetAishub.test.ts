import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    FLEET_AIS_LIMITS,
    planFleetBoxes,
    readAisBody,
    startFleetAishubPoller,
    type FleetPollStore,
} from './fleetAishub';
const now = Date.parse('2026-10-16T00:00:00Z');
function store() {
    let next = 0,
        cursor = 0;
    return {
        claim: vi.fn(async () => {
            if (Date.now() < next) return null;
            next = Date.now() + 180000;
            return {
                token: 'fictional-claim',
                cursor: cursor++,
                issued_at: new Date().toISOString(),
                centres: [
                    { lat: 50, lon: 0 },
                    { lat: -45, lon: 170 },
                ],
            };
        }),
        finish: vi.fn(async () => {
            next = Date.now() + 61000;
        }),
    } satisfies FleetPollStore;
}
const db = () => ({ enqueue: vi.fn() });
const response = (url: unknown) => {
    const query = new URL(String(url)).searchParams;
    return new Response(
        JSON.stringify([
            { ERROR: false },
            [
                {
                    MMSI: 123456789,
                    TIME: new Date().toISOString(),
                    LATITUDE: (Number(query.get('latmin')) + Number(query.get('latmax'))) / 2,
                    LONGITUDE: (Number(query.get('lonmin')) + Number(query.get('lonmax'))) / 2,
                    SOG: 2,
                },
            ],
        ]),
    );
};
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});
describe('one persisted fleet-wide provider budget', () => {
    it('two replicas and a restart share one request budget; rotation is across areas, not per boat', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const shared = store(),
            sink = db(),
            urls: string[] = [];
        const fetcher = vi.fn(async (input: unknown) => {
            urls.push(String(input));
            return response(input);
        }) as unknown as typeof fetch;
        const a = startFleetAishubPoller(sink, shared, 'fictional-key', fetcher),
            b = startFleetAishubPoller(sink, shared, 'fictional-key', fetcher);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
        a();
        const restart = startFleetAishubPoller(sink, shared, 'fictional-key', fetcher);
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(urls[0]).not.toBe(urls[1]);
        expect(sink.enqueue).toHaveBeenCalledTimes(2);
        expect(sink.enqueue.mock.calls[0][0]).toMatchObject({
            data_source: 'aishub',
            position_at: new Date(now).toISOString(),
        });
        b();
        restart();
    });
    it('a held licence or unavailable claim never reaches the provider', async () => {
        vi.useFakeTimers();
        const shared = { claim: vi.fn(async () => null), finish: vi.fn() },
            fetcher = vi.fn();
        const stop = startFleetAishubPoller(db(), shared, 'fictional-key', fetcher as typeof fetch);
        await vi.advanceTimersByTimeAsync(180000);
        expect(fetcher).not.toHaveBeenCalled();
        expect(shared.finish).not.toHaveBeenCalled();
        stop();
    });
    it('a delayed claim is not spent after its local validity window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const shared = store(),
            original = shared.claim;
        shared.claim = vi.fn(async () => {
            const c = await original();
            await new Promise((resolve) => setTimeout(resolve, 6000));
            return c;
        });
        const fetcher = vi.fn(),
            stop = startFleetAishubPoller(db(), shared, 'fictional-key', fetcher as typeof fetch);
        await vi.advanceTimersByTimeAsync(7000);
        expect(fetcher).not.toHaveBeenCalled();
        expect(shared.finish).toHaveBeenCalledOnce();
        stop();
    });
    it('stopping during a streamed response terminates it and prevents late enqueues', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const shared = store(),
            sink = db();
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const fetcher = vi.fn(async () => new Response(body));
        const stop = startFleetAishubPoller(sink, shared, 'fictional-key', fetcher as typeof fetch);
        await vi.advanceTimersByTimeAsync(0);
        stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(cancelled).toBe(true);
        expect(sink.enqueue).not.toHaveBeenCalled();
    });
    it('the deadline covers a body that stalls after successful headers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        let cancelled = false;
        const shared = store(),
            sink = db();
        const fetcher = vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        cancel() {
                            cancelled = true;
                        },
                    }),
                ),
        );
        const stop = startFleetAishubPoller(sink, shared, 'fictional-key', fetcher as typeof fetch);
        await vi.advanceTimersByTimeAsync(26000);
        expect(cancelled).toBe(true);
        expect(sink.enqueue).not.toHaveBeenCalled();
        expect(shared.finish).toHaveBeenCalledWith('fictional-claim', expect.anything(), 'failed', 0, 0);
        stop();
    });
    it('rows outside the claimed box never enter the shared store', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const sink = db(),
            fetcher = vi.fn(
                async () =>
                    new Response(
                        JSON.stringify([
                            { ERROR: false },
                            [{ MMSI: 123456789, TIME: new Date().toISOString(), LATITUDE: 0, LONGITUDE: 0 }],
                        ]),
                    ),
            );
        const stop = startFleetAishubPoller(sink, store(), 'fictional-key', fetcher as typeof fetch);
        await vi.advanceTimersByTimeAsync(0);
        expect(sink.enqueue).not.toHaveBeenCalled();
        stop();
    });
});
describe('bounded worldwide coverage', () => {
    it.each([
        [0, 179.5],
        [0, -179.5],
        [89, 0],
        [-89, 0],
        [60, -150],
        [-45, 170],
    ])('bounds and splits the200NM area at%s,%s', (lat, lon) => {
        const boxes = planFleetBoxes([{ lat, lon }]);
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes.length).toBeLessThanOrEqual(24);
        for (const box of boxes) {
            expect(box.latMax - box.latMin).toBeLessThanOrEqual(8);
            expect(box.lonMax - box.lonMin).toBeLessThanOrEqual(16.001);
            expect(box.lonMin).toBeGreaterThanOrEqual(-180);
            expect(box.lonMax).toBeLessThanOrEqual(180);
        }
    });
    it('caps active centres and deduplicates overlapping interests', () => {
        expect(planFleetBoxes(Array(100).fill({ lat: 0, lon: 0 }))).toHaveLength(1);
        expect(
            planFleetBoxes([
                { lat: NaN, lon: 0 },
                { lat: 91, lon: 0 },
            ]),
        ).toEqual([]);
        expect(planFleetBoxes(Array.from({ length: 1000 }, (_, i) => ({ lat: 0, lon: i % 180 })))).toHaveLength(64);
    });
    it('cancels and rejects an oversized streamed payload without trusting Content-Length', async () => {
        let cancelled = false;
        const controller = new AbortController();
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new Uint8Array(FLEET_AIS_LIMITS.bytes + 1));
            },
            cancel() {
                cancelled = true;
            },
        });
        await expect(readAisBody(new Response(stream), controller.signal)).rejects.toThrow(/byte limit/);
        expect(cancelled).toBe(true);
    });
});
