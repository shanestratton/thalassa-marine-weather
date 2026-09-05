/**
 * The AIS cache ignored radius and limit, and the client never backed off.
 *
 * fetchNearby's throttle compared lat/lon alone. So a result fetched for 5 NM
 * satisfied a 12 NM request inside the 5 s window, and the outer ring of
 * vessels — the ones you are closing on — silently vanished. And the per-account
 * quota (720/hour) is reached by two devices each polling every 10 s, after
 * which every further poll fired anyway and drew another 429 (audit item 13).
 *
 * Now the cache is reused only when it is a SUPERSET (radius and limit at least
 * as large), and a 429 sets a cooldown honoured from Retry-After.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authHeaders = vi.hoisted(() => vi.fn(async () => ({ Authorization: 'Bearer test' })));
vi.mock('../services/supabase', () => ({ supabase: { supabaseUrl: 'https://x.test' } }));
vi.mock('../services/supabaseAuth', () => ({ getAuthenticatedFunctionHeaders: authHeaders }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AisStreamService } from '../services/AisStreamService';

const fc = (mmsi: string) => ({
    type: 'FeatureCollection' as const,
    features: [{ type: 'Feature', properties: { mmsi }, geometry: { type: 'Point', coordinates: [153, -27] } }],
});

const mmsiOf = (c: GeoJSON.FeatureCollection): unknown => c.features[0]?.properties?.mmsi;

let fetchMock: ReturnType<typeof vi.fn>;
function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
    const status = init.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? init.headers?.[k] ?? null },
        json: async () => body,
    };
}

beforeEach(() => {
    AisStreamService.clearCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    authHeaders.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('AIS cache respects radius and limit', () => {
    it('does NOT serve a narrow cached result for a wider request', async () => {
        fetchMock.mockResolvedValueOnce(respond(fc('narrow')));
        await AisStreamService.fetchNearby({ lat: -27.2, lon: 153.1, radiusNm: 5 });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Same spot, same 5 s window, but a WIDER radius — must refetch, not
        // hand back the 5 NM result.
        fetchMock.mockResolvedValueOnce(respond(fc('wide')));
        const second = await AisStreamService.fetchNearby({ lat: -27.2, lon: 153.1, radiusNm: 12 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mmsiOf(second)).toBe('wide');
        // And the request actually asked for 12 NM.
        expect(String(fetchMock.mock.calls[1][0])).toContain('radius=12');
    });

    it('DOES serve a cached superset for a narrower request', async () => {
        fetchMock.mockResolvedValueOnce(respond(fc('wide')));
        await AisStreamService.fetchNearby({ lat: -27.2, lon: 153.1, radiusNm: 12 });
        // A narrower ask inside the window reuses the wider cache — it has extras
        // a map layer can carry, and skipping the fetch is the whole point.
        const second = await AisStreamService.fetchNearby({ lat: -27.2, lon: 153.1, radiusNm: 5 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mmsiOf(second)).toBe('wide');
    });

    it('refetches when the limit grows, even at the same radius', async () => {
        fetchMock.mockResolvedValueOnce(respond(fc('small')));
        await AisStreamService.fetchNearby({ lat: -27.2, lon: 153.1, radiusNm: 10, limit: 50 });
        fetchMock.mockResolvedValueOnce(respond(fc('big')));
        await AisStreamService.fetchNearby({ lat: -27.2, lon: 153.1, radiusNm: 10, limit: 250 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('AIS client backs off on 429', () => {
    it('stops asking after a 429 and serves the last good result', async () => {
        fetchMock.mockResolvedValueOnce(respond(fc('good')));
        const first = await AisStreamService.fetchNearby({ lat: 0, lon: 0, radiusNm: 25 });
        expect(mmsiOf(first)).toBe('good');

        // 429 with a 30 s Retry-After. Move well past the 5 s throttle window
        // AND change the radius so the throttle would NOT short-circuit — the
        // COOLDOWN is what must stop this call.
        fetchMock.mockResolvedValueOnce(respond({ error: 'quota' }, { status: 429, headers: { 'Retry-After': '30' } }));
        const during = await AisStreamService.fetchNearby({ lat: 0, lon: 0, radiusNm: 26 });
        expect(mmsiOf(during)).toBe('good'); // last good, not empty

        // A further call while cooled down must NOT hit the network again.
        const callsAfter429 = fetchMock.mock.calls.length;
        await AisStreamService.fetchNearby({ lat: 10, lon: 10, radiusNm: 50 });
        expect(fetchMock.mock.calls.length).toBe(callsAfter429);
    });

    it('clearCache lifts the cooldown', async () => {
        fetchMock.mockResolvedValueOnce(respond(fc('x')));
        await AisStreamService.fetchNearby({ lat: 0, lon: 0, radiusNm: 25 });
        fetchMock.mockResolvedValueOnce(respond({}, { status: 429, headers: { 'Retry-After': '600' } }));
        await AisStreamService.fetchNearby({ lat: 0, lon: 0, radiusNm: 26 });

        AisStreamService.clearCache();
        fetchMock.mockResolvedValueOnce(respond(fc('fresh')));
        const after = await AisStreamService.fetchNearby({ lat: 0, lon: 0, radiusNm: 26 });
        expect(mmsiOf(after)).toBe('fresh');
    });
});
