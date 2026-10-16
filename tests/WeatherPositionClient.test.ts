import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
    rpc: vi.fn(),
    request: vi.fn(),
    satellite: false,
    base: 'https://boat.synthetic.invalid',
    pairing: { deviceId: 'fictional-pi', publicKeySpki: 'synthetic-key', pairedAt: '2026-10-16T00:00:00Z' },
    device: { chartDeviceId: 'fictional-phone' },
    foreground: true,
}));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.satellite }));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => mock.pairing,
    getChartDevice: async () => mock.device,
    pinnedPiRequest: mock.request,
}));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => true }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => mock.base } }));
vi.mock('@capacitor/app', () => ({ App: { getState: async () => ({ isActive: mock.foreground }) } }));
import { reviewWeatherPositionSource, saveWeatherPositionSource } from '../services/weatherPositionClient';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    parseWeatherPositionSource,
    parseWeatherPositionProof,
    parseWeatherPositionStatus,
} from '../utils/weatherPosition';
const boat = '20000000-0000-4000-8000-000000000001',
    revision = '30000000-0000-4000-8000-000000000001';
const source = () => ({
    schema: 1 as const,
    relayId: 'fictional_relay_0001',
    selfKey: 'a'.repeat(64),
    sourceKey: 'b'.repeat(64),
    position: { lat: 0, lon: 0, at: Date.now() - 1000 },
    servedAt: Date.now(),
});
beforeEach(() => {
    setAuthIdentityScope('fictional-owner');
    mock.rpc.mockReset();
    mock.request.mockReset();
    mock.satellite = false;
    mock.foreground = true;
    mock.base = 'https://boat.synthetic.invalid';
    mock.pairing = { deviceId: 'fictional-pi', publicKeySpki: 'synthetic-key', pairedAt: '2026-10-16T00:00:00Z' };
});
describe('explicit account/pair/source-fenced weather position', () => {
    it('accepts measured Null Island and rejects unknown fields, parent/future/stale clocks, incomplete binding', () => {
        const now = Date.now(),
            s = source();
        expect(parseWeatherPositionSource(s, now)?.position.lat).toBe(0);
        for (const position of [
            { ...s.position, at: now + 1 },
            { ...s.position, at: now - 14000 },
            { ...s.position, at: null },
            { ...s.position, lat: '' },
        ])
            expect(parseWeatherPositionSource({ ...s, position }, now)).toBeNull();
        expect(parseWeatherPositionSource({ ...s, url: 'https://invalid' }, now)).toBeNull();
        expect(
            parseWeatherPositionProof(
                {
                    schema: 1,
                    revision,
                    selfKey: s.selfKey,
                    sourceKey: s.sourceKey,
                    ...s.position,
                    extra: { raw: 'bad' },
                },
                now,
            ),
        ).toBeNull();
        expect(
            parseWeatherPositionStatus({ registration: null, position: { revision, ...s.position, zone: 'UTC' } }, now),
        ).toBeNull();
    });
    it('uses only enrolled pinned fixed boat-LAN request, including Satellite Mode; never provider/WAN fallback', async () => {
        mock.satellite = true;
        mock.request.mockResolvedValue({ status: 200, data: JSON.stringify(source()) });
        expect((await reviewWeatherPositionSource())?.relayId).toBe('fictional_relay_0001');
        expect(mock.request).toHaveBeenCalledTimes(1);
        expect(mock.request.mock.calls[0][0]).toMatchObject({
            url: 'https://boat.synthetic.invalid/api/weather-watch/position-source',
            method: 'GET',
            responseType: 'text',
        });
        expect(mock.rpc).not.toHaveBeenCalled();
        mock.foreground = false;
        mock.request.mockClear();
        expect(await reviewWeatherPositionSource()).toBeNull();
        expect(mock.request).not.toHaveBeenCalled();
    });
    it('discards delayed source response after pair or account changes', async () => {
        let done!: (v: unknown) => void;
        mock.request.mockImplementation(() => new Promise((r) => (done = r)));
        const pending = reviewWeatherPositionSource();
        await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
        mock.pairing = { ...mock.pairing, pairedAt: '2026-10-17T00:00:00Z' };
        done({ status: 200, data: JSON.stringify(source()) });
        expect(await pending).toBeNull();
        mock.request.mockClear();
        const second = reviewWeatherPositionSource();
        await vi.waitFor(() => expect(mock.request).toHaveBeenCalled());
        setAuthIdentityScope('other-owner');
        done({ status: 200, data: JSON.stringify(source()) });
        expect(await second).toBeNull();
    });
    it('cloud source CAS sends only fixed reviewed hashes, is off until explicit action, and never auto-retries conflicts', async () => {
        const s = source(),
            scope = getAuthIdentityScope();
        expect(mock.rpc).not.toHaveBeenCalled();
        mock.rpc.mockResolvedValue({ data: { revision }, error: null });
        expect(await saveWeatherPositionSource(boat, null, s, true, scope)).toBe(revision);
        expect(mock.rpc).toHaveBeenCalledWith('configure_weather_position', {
            p_boat_id: boat,
            p_expected: null,
            p_relay_id: s.relayId,
            p_self_key: s.selfKey,
            p_source_key: s.sourceKey,
            p_enabled: true,
        });
        expect(JSON.stringify(mock.rpc.mock.calls[0][1])).not.toMatch(/latitude|longitude|position|token|url/);
        mock.rpc.mockReset();
        mock.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
        await expect(saveWeatherPositionSource(boat, revision, s, true, scope)).rejects.toThrow('Reload and review');
        expect(mock.rpc).toHaveBeenCalledTimes(1);
    });
    it('stopping sharing uses the reviewed registration, while stale intent/Satellite Mode never sends', async () => {
        const s = source(),
            scope = getAuthIdentityScope(),
            registration = { revision, relayId: s.relayId, selfKey: s.selfKey, sourceKey: s.sourceKey, enabled: true };
        mock.rpc.mockResolvedValue({ data: { revision }, error: null });
        await saveWeatherPositionSource(boat, revision, registration, false, scope);
        expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_expected: revision, p_enabled: false });
        mock.rpc.mockClear();
        mock.satellite = true;
        await expect(saveWeatherPositionSource(boat, revision, registration, false, scope)).rejects.toThrow();
        expect(mock.rpc).not.toHaveBeenCalled();
        mock.satellite = false;
        setAuthIdentityScope('other-owner');
        await expect(saveWeatherPositionSource(boat, null, s, true, scope)).rejects.toThrow();
        expect(mock.rpc).not.toHaveBeenCalled();
    });
});
