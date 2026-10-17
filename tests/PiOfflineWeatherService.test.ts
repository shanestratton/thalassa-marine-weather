import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
    base: 'https://boat.local:3443' as string | null,
    key: 'boat-key' as string | null,
    request: vi.fn(),
}));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => state.base } }));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => (state.key ? { publicKeySpki: state.key } : null),
    pinnedPiRequest: state.request,
}));
import { readPiAnalysis, readPiSatellite } from '../services/PiOfflineWeatherService';
const satellite = () => ({
    schema: 1,
    fetchedAt: Date.now(),
    frames: [
        { iso: new Date(Date.now()).toISOString(), timeMs: Date.now(), dataUrl: 'data:image/jpeg;base64,/9j/4A==' },
    ],
});
beforeEach(() => {
    vi.clearAllMocks();
    state.base = 'https://boat.local:3443';
    state.key = 'boat-key';
});
describe('paired LAN-only offline weather', () => {
    it('uses only the pinned local route and never falls back to the internet', async () => {
        const snapshot = satellite();
        // Keep the iso/time pair exact even across a clock tick.
        snapshot.frames[0].timeMs = Date.parse(snapshot.frames[0].iso);
        state.request.mockResolvedValue({ status: 200, data: JSON.stringify(snapshot) });
        const result = await readPiSatellite();
        expect(result?.frames).toHaveLength(1);
        expect(state.request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://boat.local:3443/api/offline-weather/satellite',
                responseType: 'text',
            }),
        );
    });
    it('refuses an unpaired, unreachable or remote lane without requesting anything', async () => {
        state.key = null;
        expect(await readPiSatellite()).toBeNull();
        state.key = 'boat-key';
        state.base = null;
        expect(await readPiSatellite()).toBeNull();
        expect(state.request).not.toHaveBeenCalled();
    });
    it('discards a response when pairing changes while it is in flight', async () => {
        const value = {
            schema: 1,
            id: 'opc-atl-analysis',
            dataUrl: 'data:image/gif;base64,R0lGODlh',
            fetchedAt: Date.now(),
            sourceUrl: 'https://ocean.weather.gov/chart.gif',
            attribution: 'NOAA',
        };
        state.request.mockImplementation(async () => {
            state.key = 'another-boat';
            return { status: 200, data: JSON.stringify(value) };
        });
        expect(await readPiAnalysis(value.id)).toBeNull();
    });
    it('rejects arbitrary image URLs, too many frames and traversal IDs', async () => {
        const bad = satellite();
        bad.frames[0].dataUrl = 'https://outside.example/image.jpg';
        state.request.mockResolvedValue({ status: 200, data: JSON.stringify(bad) });
        expect(await readPiSatellite()).toBeNull();
        state.request.mockResolvedValue({
            status: 200,
            data: JSON.stringify({ ...bad, frames: Array(7).fill(bad.frames[0]) }),
        });
        expect(await readPiSatellite()).toBeNull();
        const count = state.request.mock.calls.length;
        expect(await readPiAnalysis('../private')).toBeNull();
        expect(state.request).toHaveBeenCalledTimes(count);
    });
});
