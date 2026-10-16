import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ currents: vi.fn(), waves: vi.fn(), cyclone: vi.fn(), tracks: vi.fn() }));
vi.mock('../services/OceanCurrentService', () => ({ OceanCurrentService: { fetchCurrents: mocks.currents } }));
vi.mock('../services/weather/waveField', () => ({ fetchWaveField: mocks.waves }));
vi.mock('../services/cycloneAvoidance', () => ({ buildCycloneExclusionFromCyclones: mocks.cyclone }));
vi.mock('../services/weather/CycloneTrackingService', () => ({ fetchActiveCyclones: mocks.tracks }));
import { loadIsochroneEnvironment, isochroneEnvironmentAt } from '../services/routing/isochroneEnvironment';
import * as regional from '../services/weather/api/currentRegionalLoader';
import { decodeCurrentRegionalAsset } from '../services/weather/api/currentRegionalContract';
import { currentRegionalFixture } from './helpers/currentRegionalFixture';
const departureTime = '2026-10-17T12:00:00Z';
const options = {
    origin: { lat: 0, lon: 0 },
    destination: { lat: 0, lon: 3 },
    departureTime,
    speedKts: 6,
    currentNrtEnabled: true,
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.currents.mockResolvedValue({ availability: 'available', vectors: [{ lat: 0, lon: 0, u: 1, v: 0 }] });
    mocks.waves.mockResolvedValue({
        referenceTimeIso: departureTime,
        totalHours: 3,
        samples: [{ lat: 0, lon: 0, heightM: [1, 2, 3], periodS: [8, 8, 8], directionFromDeg: [0, 0, 0] }],
    });
    mocks.tracks.mockResolvedValue([]);
    mocks.cyclone.mockReturnValue({ isExcluded: (_lat: number, _lon: number, hours: number) => hours >= 2 });
});
describe('shared isochrone environment', () => {
    it('wires verified regional forecasts into the route and Worker snapshot without a snapshot fallback', async () => {
        const raw = currentRegionalFixture('t-45-90', Date.parse(departureTime));
        const series = decodeCurrentRegionalAsset(raw.bytes, raw.manifest, 'CMEMS');
        const loader = vi.spyOn(regional, 'loadRegionalCurrentSeries').mockResolvedValueOnce(series);
        try {
            const env = await loadIsochroneEnvironment(options);
            expect(mocks.currents).not.toHaveBeenCalled();
            expect(env.currentField?.getCurrent(0.5, 0.5, 0.5)?.speed).toBeCloseTo(1.5 * 1.9438444924406);
            expect(env.snapshot.currentVectors).toBeNull();
            expect(env.snapshot.currentSeries).toBe(series);
            expect(env.snapshot.currentComponents).toBe('ocean');
            expect(env.notes.join(' ')).toMatch(/CMEMS time-varying ocean currents/);
        } finally {
            loader.mockRestore();
        }
    });
    it('does not silently substitute a CMEMS snapshot for a missing requested second model or tide', async () => {
        expect((await loadIsochroneEnvironment({ ...options, currentModel: 'RTOFS' })).currentField).toBeNull();
        expect((await loadIsochroneEnvironment({ ...options, includeModelTide: true })).currentField).toBeNull();
        expect(mocks.currents).not.toHaveBeenCalled();
    });
    it('loads all fields once and samples waves at planned departure rather than wall clock', async () => {
        const env = await loadIsochroneEnvironment(options);
        expect(mocks.currents).toHaveBeenCalledOnce();
        expect(mocks.waves).toHaveBeenCalledOnce();
        expect(mocks.cyclone).toHaveBeenCalledOnce();
        expect(mocks.currents.mock.calls[0].slice(1)).toEqual([90, expect.any(Number), 6, true]);
        expect(env.currentField?.getCurrent(0, 0, 0)?.speed).toBeCloseTo(1.94);
        expect(env.waveField?.getWave(0, 0, 1)?.heightM).toBe(2);
        expect(env.exclusionField?.isExcluded(0, 0, 2)).toBe(true);
        expect(env.snapshot).toEqual({
            departureMs: Date.parse(departureTime),
            currentVectors: [{ lat: 0, lon: 0, u: 1, v: 0 }],
            waves: await mocks.waves.mock.results[0].value,
            cyclones: [],
        });
        expect(env.notes.join(' ')).toMatch(/one surface-current snapshot/);
    });
    it('keeps independent fields when one provider fails and names the omission', async () => {
        mocks.currents.mockRejectedValue(new Error('provider offline'));
        const env = await loadIsochroneEnvironment(options);
        expect(env.currentField).toBeNull();
        expect(env.waveField).not.toBeNull();
        expect(env.exclusionField).not.toBeNull();
        expect(env.notes.join(' ')).toMatch(/Ocean-current data unavailable/);
    });
    it('does not start discretionary downloads in Satellite Mode', async () => {
        const env = await loadIsochroneEnvironment({ ...options, satelliteMode: true });
        expect(mocks.currents).not.toHaveBeenCalled();
        expect(mocks.waves).not.toHaveBeenCalled();
        expect(mocks.cyclone).not.toHaveBeenCalled();
        expect(env.notes.join(' ')).toMatch(/not downloaded/);
    });
    it('does not expand a date-line hop into an accidental worldwide current/wave request', async () => {
        const env = await loadIsochroneEnvironment({
            ...options,
            origin: { lat: 0, lon: 179 },
            destination: { lat: 0, lon: -179 },
        });
        expect(mocks.currents).not.toHaveBeenCalled();
        expect(mocks.waves).not.toHaveBeenCalled();
        expect(mocks.cyclone).toHaveBeenCalledWith([], departureTime, undefined);
        expect(env.currentField).toBeNull();
    });
    it('reuses the snapshot for later legs with original wave and cyclone timestamps', async () => {
        const env = await loadIsochroneEnvironment(options);
        const leg = isochroneEnvironmentAt(env, '2026-10-17T13:00:00Z');
        expect(leg.waveField?.getWave(0, 0, 1)?.heightM).toBe(3);
        expect(leg.exclusionField?.isExcluded(0, 0, 1)).toBe(true);
        expect(mocks.waves).toHaveBeenCalledOnce();
    });
    it('rebases time-varying currents and nested later legs exactly once', async () => {
        const env = await loadIsochroneEnvironment(options);
        const current = vi.fn((_lat: number, _lon: number, hours: number) => ({ speed: hours, direction: 90 }));
        env.currentField = { getCurrent: current };
        const leg = isochroneEnvironmentAt(env, '2026-10-17T13:00:00Z');
        expect(leg.currentField?.getCurrent(0, 0, 0.5)?.speed).toBe(1.5);
        const next = isochroneEnvironmentAt(leg, '2026-10-17T13:30:00Z');
        expect(next.currentField?.getCurrent(0, 0, 0.5)?.speed).toBe(2);
        expect(next.waveField?.getWave(0, 0, 0.5)?.heightM).toBe(3);
        expect(next.exclusionField?.isExcluded(0, 0, 0.5)).toBe(true);
        expect(next.departureMs).toBe(Date.parse('2026-10-17T13:30:00Z'));
        expect(mocks.currents).toHaveBeenCalledOnce();
    });
    it('does not retain apparently usable fields when the next leg clock is invalid', async () => {
        const env = isochroneEnvironmentAt(await loadIsochroneEnvironment(options), 'invalid');
        expect([env.currentField, env.waveField, env.exclusionField]).toEqual([null, null, null]);
        expect(env.notes.join(' ')).toMatch(/later-leg departure time is invalid/);
    });
});
