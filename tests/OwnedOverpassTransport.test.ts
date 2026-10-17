import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../services/supabase', () => ({
    supabase: { auth },
    supabaseUrl: 'https://project.example',
    supabaseAnonKey: 'public-test-key',
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: vi.fn(() => false) }));
import { satelliteModeActive } from '../services/networkPolicy';
import { fetchOwnedOverpass } from '../services/osm/ownedOverpass';
import { OWN_OSM_MAX_BYTES, queryForOwnedOsm } from '../services/osm/ownedOverpassContract';

// Fictional qualified database; these prove transport, not planet admission.
const now = Date.UTC(2026, 9, 17, 0);
const operation = {
    schema: 1 as const,
    kind: 'names' as const,
    bbox: [-28, 153, -27, 154] as [number, number, number, number],
};
const query = queryForOwnedOsm(operation);
const packet = (sourceAt = new Date(now - 86400_000).toISOString()) => ({
    elements: [{ type: 'node', id: 42, lat: -27.5, lon: 153.5, tags: { place: 'town', name: 'Fixture' } }],
    osm3s: { timestamp_osm_base: sourceAt },
    thalassaSource: { schema: 1, complete: true, cohortSha256: 'a'.repeat(64), licence: 'ODbL-1.0', sourceAt },
});
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockReset().mockImplementation(async () => new Response(JSON.stringify(packet())));
    auth.getSession.mockReset().mockResolvedValue({ data: { session: null } });
    vi.mocked(satelliteModeActive).mockReturnValue(false);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('owned OSM actual app transport', () => {
    it('sends a fixed bounded descriptor, public credential, no raw QL or endpoint choice, retaining original source date', async () => {
        const reached = vi.fn();
        const result = await fetchOwnedOverpass(query, { reached });
        expect(result.thalassaSource.sourceAt).toBe(new Date(now - 86400_000).toISOString());
        expect(result.elements[0].id).toBe(42);
        expect(result.queryComplete).toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(reached).toHaveBeenCalledOnce();
        const [url, init] = fetcher.mock.calls[0];
        expect(url).toBe('https://project.example/functions/v1/owned-overpass');
        expect(init?.redirect).toBe('error');
        expect(JSON.parse(String(init?.body))).toEqual(operation);
        expect(init?.headers).toMatchObject({ apikey: 'public-test-key', Authorization: 'Bearer public-test-key' });
        expect(String(init?.body)).not.toContain('out:json');
    });

    it('uses only a currently unexpired session bearer; stale tokens use the existing public lane', async () => {
        auth.getSession.mockResolvedValue({
            data: { session: { access_token: 'current-session', expires_at: now / 1000 + 31 } },
        });
        await fetchOwnedOverpass(query);
        expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer current-session' });
        auth.getSession.mockResolvedValue({
            data: { session: { access_token: 'stale-session', expires_at: now / 1000 + 29 } },
        });
        await fetchOwnedOverpass(query);
        expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer public-test-key' });
    });

    it('refuses arbitrary QL, Satellite, offline, invalid deadline and retired intent before sending/counting', async () => {
        const reached = vi.fn();
        await expect(fetchOwnedOverpass('[out:json];node;out;', { reached })).rejects.toThrow();
        vi.mocked(satelliteModeActive).mockReturnValue(true);
        await expect(fetchOwnedOverpass(query, { reached })).rejects.toThrow();
        vi.mocked(satelliteModeActive).mockReturnValue(false);
        const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        await expect(fetchOwnedOverpass(query, { reached })).rejects.toThrow();
        offline.mockRestore();
        const controller = new AbortController();
        controller.abort();
        await expect(fetchOwnedOverpass(query, { signal: controller.signal, reached })).rejects.toThrow();
        await expect(fetchOwnedOverpass(query, { timeoutMs: 30_001, reached })).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        expect(reached).not.toHaveBeenCalled();
    });

    it.each([404, 406, 429, 500, 503, 504])(
        'HTTP%s remains unavailable after one reached owned attempt',
        async (status) => {
            fetcher.mockResolvedValue(new Response('private diagnostic', { status }));
            const reached = vi.fn();
            await expect(fetchOwnedOverpass(query, { reached })).rejects.toThrow('unavailable');
            expect(fetcher).toHaveBeenCalledOnce();
            expect(reached).toHaveBeenCalledOnce();
        },
    );

    it('bounds auth before any network request and leaves its ask unspent', async () => {
        auth.getSession.mockImplementation(() => new Promise(() => undefined));
        const reached = vi.fn();
        const refused = expect(fetchOwnedOverpass(query, { timeoutMs: 50, reached })).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(50);
        await refused;
        expect(fetcher).not.toHaveBeenCalled();
        expect(reached).not.toHaveBeenCalled();
    });

    it('retires ignored native headers and counts the sent timeout once, cancelling a late body', async () => {
        let release!: (response: Response) => void;
        fetcher.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const reached = vi.fn();
        const refused = expect(fetchOwnedOverpass(query, { timeoutMs: 50, reached })).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(50);
        await refused;
        const cancel = vi.fn();
        release(new Response(new ReadableStream({ cancel })));
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(reached).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('includes a stalled body in the same deadline and cancels the actual reader', async () => {
        const cancel = vi.fn();
        fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel })));
        const reached = vi.fn();
        const refused = expect(fetchOwnedOverpass(query, { timeoutMs: 50, reached })).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(50);
        await refused;
        expect(reached).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('closing after send retires the ignored native request without spending a timed-out ask', async () => {
        fetcher.mockImplementation(() => new Promise(() => undefined));
        const controller = new AbortController(),
            reached = vi.fn();
        const refused = expect(fetchOwnedOverpass(query, { signal: controller.signal, reached })).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(1);
        controller.abort();
        await refused;
        expect(fetcher).toHaveBeenCalledOnce();
        expect(reached).not.toHaveBeenCalled();
    });

    it('refuses declared/streamed byte overflow, invalid UTF8, partial output and missing/expired/forged source clocks', async () => {
        const invalid = [
            new Response('{}', { headers: { 'content-length': String(OWN_OSM_MAX_BYTES + 1) } }),
            new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(new Uint8Array(OWN_OSM_MAX_BYTES));
                        c.enqueue(new Uint8Array(1));
                        c.close();
                    },
                }),
            ),
            new Response(new Uint8Array([0xff])),
            new Response('{'),
            new Response(JSON.stringify({ ...packet(), remark: 'partial timeout' })),
            new Response(JSON.stringify({ elements: [] })),
            new Response(JSON.stringify(packet(new Date(now - 46 * 86400_000).toISOString()))),
            new Response(JSON.stringify(packet(new Date(now + 300_001).toISOString()))),
            new Response(JSON.stringify({ ...packet(), osm3s: { timestamp_osm_base: new Date(now).toISOString() } })),
        ];
        for (const response of invalid) {
            fetcher.mockResolvedValueOnce(response);
            await expect(fetchOwnedOverpass(query)).rejects.toThrow();
        }
        expect(fetcher).toHaveBeenCalledTimes(invalid.length);
    });
});
