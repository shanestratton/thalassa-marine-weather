import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ tiles: 1, offline: false, hydrate: vi.fn(async () => undefined) }));
vi.mock('../services/OfflineReliefService', () => ({
    hydrateRelief: state.hydrate,
    reliefStorage: () => ({ tiles: state.tiles, bytes: 44 }),
}));
vi.mock('../stores/uiStore', () => ({ useUIStore: { getState: () => ({ isOffline: state.offline }) } }));
import { initialReliefMapStyle } from '../services/initialReliefMapStyle';
const input = 'mapbox://styles/mapbox/dark-v11',
    style = { version: 8, sources: { composite: { type: 'vector', url: 'mapbox://fixture' } }, layers: [] };
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.tiles = 1;
    state.offline = false;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(style), { headers: { 'content-type': 'application/json' } })),
    );
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe('saved relief initial map construction on a boat LAN', () => {
    it('uses the normal style JSON on a working WAN without persisting Mapbox data', async () => {
        expect(await initialReliefMapStyle(input, 'test-only', new AbortController().signal)).toEqual(style);
        expect(fetch).toHaveBeenCalledWith(
            'https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=test-only',
            expect.objectContaining({ cache: 'no-store', credentials: 'omit', redirect: 'error' }),
        );
        expect(state.hydrate).toHaveBeenCalledOnce();
    });
    it('falls back when Wi-Fi reports online but the style cannot reach the WAN', async () => {
        vi.mocked(fetch).mockRejectedValue(new TypeError('No WAN'));
        expect(await initialReliefMapStyle(input, 'test-only', new AbortController().signal)).toMatchObject({
            version: 8,
            sources: {},
            layers: [{ id: 'land', type: 'background' }],
        });
    });
    it('honours the existing verified-offline state without any style request', async () => {
        state.offline = true;
        expect(await initialReliefMapStyle(input, 'test-only', new AbortController().signal)).not.toBe(input);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('retains ordinary map startup when no terrain has been saved', async () => {
        state.tiles = 0;
        expect(await initialReliefMapStyle(input, 'test-only', new AbortController().signal)).toBe(input);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('bounds a native-style fetch that ignores abort and cannot promote a late reply', async () => {
        let resolve!: (r: Response) => void;
        vi.mocked(fetch).mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const pending = initialReliefMapStyle(input, 'test-only', new AbortController().signal);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(4000);
        expect(await pending).toMatchObject({ sources: {}, layers: [{ id: 'land' }] });
        resolve(new Response(JSON.stringify(style), { headers: { 'content-type': 'application/json' } }));
        await Promise.resolve();
        expect(await pending).not.toEqual(style);
    });
    it('rejects an abandoned map startup instead of constructing it later', async () => {
        const abort = new AbortController();
        vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
        const pending = initialReliefMapStyle(input, 'test-only', abort.signal);
        const assertion = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
        abort.abort();
        await assertion;
    });
    it.each(['text/html', 'application/json'])('rejects invalid style payloads (%s)', async (mime) => {
        vi.mocked(fetch).mockResolvedValue(new Response('{}', { headers: { 'content-type': mime } }));
        expect(await initialReliefMapStyle(input, 'test-only', new AbortController().signal)).toMatchObject({
            sources: {},
            layers: [{ id: 'land' }],
        });
    });
});
