import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => 'disconnected',
        onSample: () => () => undefined,
        onStatusChange: () => () => undefined,
        getSavedConfig: () => null,
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
import { NmeaStore } from '../services/NmeaStore';
import { directSignalKSnapshot } from '../services/signalk/snapshot';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const NOW = 1_800_000_000_000;
const doc = {
    navigation: {
        headingTrue: { value: 1, timestamp: new Date(NOW - 5000).toISOString(), $source: 'fixture' },
        speedOverGround: { value: 2, timestamp: new Date(NOW - 1000).toISOString(), $source: 'fixture' },
    },
    environment: {
        wind: { directionTrue: { value: 1, timestamp: new Date(NOW - 5000).toISOString(), $source: 'fixture' } },
    },
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    NmeaStore.stop();
    NmeaStore.clearRemote();
    setAuthIdentityScope('fictional');
    NmeaStore.start();
});
afterEach(() => {
    NmeaStore.stop();
    NmeaStore.clearRemote();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('real NmeaStore direct source integration', () => {
    it('never restamps an existing gauge or wind direction from unrelated fresh snapshots', async () => {
        NmeaStore.ingestRemote(directSignalKSnapshot(doc, 'fictional', NOW));
        expect(NmeaStore.getState().heading.lastUpdated).toBe(NOW - 5000);
        expect(NmeaStore.getState().twd.lastUpdated).toBe(NOW - 5000);
        expect(NmeaStore.isBoatFeed()).toBe(false);
        expect(NmeaStore.hasGpsFix()).toBe(false);
        await vi.advanceTimersByTimeAsync(3000);
        NmeaStore.ingestRemote(directSignalKSnapshot(doc, 'fictional', NOW + 3000));
        expect(NmeaStore.getState().heading.lastUpdated).toBe(NOW - 5000);
        await vi.advanceTimersByTimeAsync(6000);
        expect(NmeaStore.getState().heading.value).toBeNull();
        expect(NmeaStore.getState().twd.value).toBeNull();
    });
    it('clears a null direct leaf immediately and never gains boat-feed navigation permission', () => {
        const s = directSignalKSnapshot(doc, 'fictional', NOW);
        NmeaStore.ingestRemote(s);
        NmeaStore.ingestRemote({ ...s, sogKts: null });
        expect(NmeaStore.getState().sog.value).toBeNull();
        expect(NmeaStore.isBoatFeed()).toBe(false);
    });
    it('keeps Pi LAN priority, keeps active direct reader ahead of cloud, and clears only its lane', () => {
        const s = directSignalKSnapshot(doc, 'fictional', NOW);
        NmeaStore.ingestRemote({ ...s, source: 'pi', via: 'lan' });
        expect(NmeaStore.ingestRemote(s)).toBe(false);
        NmeaStore.clearRemote('signalk');
        expect(NmeaStore.getState().remote?.via).toBe('lan');
        NmeaStore.clearRemote();
        NmeaStore.ingestRemote(s);
        expect(NmeaStore.ingestRemote({ ...s, source: 'pi', via: 'cloud' })).toBe(false);
        expect(NmeaStore.getState().remote?.via).toBe('signalk');
    });
    it('account switch retires direct evidence and measurements synchronously', () => {
        NmeaStore.ingestRemote(directSignalKSnapshot(doc, 'fictional', NOW));
        setAuthIdentityScope('fictional-other');
        expect(NmeaStore.getState().instrumentEvidence).toBeUndefined();
        expect(NmeaStore.getState().sog.value).toBeNull();
    });
});
