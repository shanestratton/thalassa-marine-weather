import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
    rpc: vi.fn(),
    satellite: false,
    position: undefined as undefined | { lat: number; lon: number; at: number },
}));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.satellite }));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: () => ({ instrumentEvidence: { position: mock.position } }) },
}));
import { fetchWeatherWatchStatus, parseWeatherWatchStatus, saveWeatherWatch } from '../services/weatherWatchClient';
import { defaultWeatherWatch } from '../utils/weatherWatch';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { authorizedRouteSamples, currentBoatWeatherSample } from '../services/weatherWatchSamples';
import { pinWeatherBriefing, takeWeatherBriefingPin } from '../services/briefing/briefingPin';
const boat = '20000000-0000-4000-8000-000000000001',
    revision = '30000000-0000-4000-8000-000000000001';
const cap = () => ({
    functionVersion: 1,
    deliveryVersion: 1,
    scheduled: true,
    entitlementUntil: Date.now() + 3_600_000,
    succeededAt: Date.now(),
});
const status = () => ({
    schema: 1,
    profile: { revision, preferences: defaultWeatherWatch() },
    capabilities: { morning: cap(), rain: cap(), storm: cap(), gust: cap() },
});
beforeEach(() => {
    setAuthIdentityScope('fixture-owner');
    mock.rpc.mockReset();
    mock.satellite = false;
    mock.position = undefined;
    takeWeatherBriefingPin();
});
describe('weather watch client/account boundary', () => {
    it('requires every typed capability half and rejects malformed current configuration', () => {
        expect(parseWeatherWatchStatus(status(), Date.now())?.profile?.revision).toBe(revision);
        const bad = status();
        bad.capabilities.rain.scheduled = 'true' as unknown as boolean;
        expect(parseWeatherWatchStatus(bad, Date.now())).toBeNull();
        expect(
            parseWeatherWatchStatus(
                {
                    ...status(),
                    profile: { revision, preferences: { ...defaultWeatherWatch(), rawChart: { depth: 3 } } },
                },
                Date.now(),
            ),
        ).toBeNull();
    });
    it('drops a late account-A status after a switch; Satellite Mode makes zero WAN calls', async () => {
        let done!: (v: unknown) => void;
        mock.rpc.mockReturnValue(
            new Promise((r) => {
                done = r;
            }),
        );
        const pending = fetchWeatherWatchStatus(boat);
        setAuthIdentityScope('different-owner');
        done({ data: status(), error: null });
        expect(await pending).toBeNull();
        mock.rpc.mockClear();
        mock.satellite = true;
        expect(await fetchWeatherWatchStatus(boat)).toBeNull();
        expect(mock.rpc).not.toHaveBeenCalled();
    });
    it('uses an exact reviewed revision and refuses stale intent before a request', async () => {
        const scope = getAuthIdentityScope();
        mock.rpc.mockResolvedValue({ data: { revision }, error: null });
        expect(await saveWeatherWatch(boat, null, defaultWeatherWatch(), scope)).toBe(revision);
        expect(mock.rpc).toHaveBeenCalledWith('configure_weather_watch', {
            p_boat_id: boat,
            p_expected: null,
            p_preferences: defaultWeatherWatch(),
        });
        setAuthIdentityScope('different-owner');
        mock.rpc.mockClear();
        await expect(saveWeatherWatch(boat, revision, defaultWeatherWatch(), scope)).rejects.toThrow('unavailable');
        expect(mock.rpc).not.toHaveBeenCalled();
    });
    it('does not silently retry or overwrite a competing phone', async () => {
        mock.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
        await expect(saveWeatherWatch(boat, revision, defaultWeatherWatch(), getAuthIdentityScope())).rejects.toThrow(
            'Reload and review',
        );
        expect(mock.rpc).toHaveBeenCalledTimes(1);
    });
});
describe('explicit source-only registrations and briefing handoff', () => {
    it('preserves the original boat clock and refuses a stale/future or absent instrument position', async () => {
        const now = Date.now();
        mock.position = { lat: 0, lon: 0, at: now - 2000 };
        expect(await currentBoatWeatherSample(now)).toMatchObject({
            sourceAt: now - 2000,
            expiresAt: now - 2000 + 900_000,
            lat: 0,
            lon: 0,
        });
        mock.position.at = now - 13_001;
        expect(await currentBoatWeatherSample(now)).toBeNull();
        mock.position.at = now + 1;
        expect(await currentBoatWeatherSample(now)).toBeNull();
        mock.position = undefined;
        expect(await currentBoatWeatherSample(now)).toBeNull();
    });
    it('copies only a bounded coordinate sample; chart facts and full route ids cannot cross the seam', async () => {
        const line = Array.from({ length: 30 }, (_, i) => ({
            lat: i / 100,
            lon: 179 + i / 100,
            chartDepth: 4,
            licensedCell: 'PRIVATE',
            grade: 'go',
        }));
        const samples = await authorizedRouteSamples(line, Date.now());
        expect(samples).toHaveLength(8);
        expect(samples[0]).toMatchObject({ lat: line[0].lat, lon: line[0].lon });
        expect(samples.at(-1)).toMatchObject({ lat: line.at(-1)!.lat, lon: line.at(-1)!.lon });
        expect(JSON.stringify(samples)).not.toMatch(/chartDepth|licensedCell|PRIVATE|grade/);
        await expect(
            authorizedRouteSamples(
                [
                    { lat: 91, lon: 0 },
                    { lat: 0, lon: 0 },
                ],
                Date.now(),
            ),
        ).rejects.toThrow('Invalid route');
    });
    it('accepts only a fresh typed morning handoff; account change retires it', () => {
        const now = Date.now(),
            data = {
                weather_watch: 1,
                feature: 'morning',
                boat_id: boat,
                revision,
                expires: new Date(now + 600_000).toISOString(),
            };
        expect(pinWeatherBriefing({ ...data, feature: 'rain' }, getAuthIdentityScope(), now)).toBe(false);
        expect(pinWeatherBriefing({ ...data, boat_id: 'https://bad.invalid' }, getAuthIdentityScope(), now)).toBe(
            false,
        );
        expect(pinWeatherBriefing(data, getAuthIdentityScope(), now)).toBe(true);
        expect(takeWeatherBriefingPin(now)?.boatId).toBe(boat);
        expect(pinWeatherBriefing(data, getAuthIdentityScope(), now)).toBe(true);
        setAuthIdentityScope('different-owner');
        expect(takeWeatherBriefingPin(now)).toBeNull();
    });
});
