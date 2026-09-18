import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';

const listener = vi.hoisted(() => ({
    status: 'disconnected',
    host: 'boat-gateway',
    sample: null as ((sample: NmeaSample) => void) | null,
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => listener.status,
        getSavedConfig: () => ({ host: listener.host, port: 10110 }),
        onSample: (cb: (sample: NmeaSample) => void) => {
            listener.sample = cb;
            return () => {
                listener.sample = null;
            };
        },
        onStatusChange: () => vi.fn(),
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { WIND_GUST_WINDOW_MS, WIND_HISTORY_WINDOW_MS, type WindHistorySummary } from '../utils/windHistory';

const now = 1_800_000_000_000;
function remote(over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot {
    return {
        source: 'pi',
        via: 'cloud',
        deviceLabel: 'calypso',
        reportedAt: Date.now(),
        windSampleAt: Date.now(),
        windSampleSource: 'n2k.42',
        windHistoryIdentity: 'boat-pi-1',
        lat: null,
        lon: null,
        sogKts: null,
        cogDeg: null,
        headingDeg: null,
        stwKts: null,
        twsKts: 12,
        twaDeg: null,
        twdDeg: null,
        awsKts: null,
        awaDeg: null,
        depthM: null,
        heelDeg: null,
        pitchDeg: null,
        waterTempC: null,
        rudderDeg: null,
        rpm: null,
        voltageV: null,
        ...over,
    };
}
function summary(over: Partial<WindHistorySummary> = {}): WindHistorySummary {
    return {
        asOf: now,
        since: now - 3_000_000,
        latestAt: now,
        sampleCount: 600,
        source: 'n2k.42',
        max1h: { kts: 30, at: now - 1_000_000 },
        gust10m: { kts: 24, at: now - 5_000 },
        ...over,
    };
}
function direct(tws: number, timestamp = Date.now()): void {
    listener.sample?.({ tws, timestamp } as NmeaSample);
}

describe('NmeaStore wind history is independent of a mounted instrument page', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        listener.status = 'disconnected';
        listener.host = 'boat-gateway';
        NmeaStore.stop();
        NmeaStore.clearRemote();
        setAuthIdentityScope('wind-owner');
        NmeaStore.start();
    });
    afterEach(() => {
        NmeaStore.stop();
        vi.useRealTimers();
    });

    it('collects before the page opens and retains peaks when its subscriber leaves and returns', () => {
        direct(25);
        vi.setSystemTime(now + 5_000);
        direct(12);
        const off = NmeaStore.subscribe(vi.fn());
        expect(NmeaStore.getWindHistory()?.max1h?.kts).toBe(25);
        off();
        vi.setSystemTime(now + 10_000);
        direct(10);
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 3, max1h: { kts: 25 } });
    });

    it('ages dropout windows exactly without new samples', () => {
        direct(25);
        vi.setSystemTime(now + 5_000);
        direct(12);
        expect(NmeaStore.getWindHistory(now + WIND_GUST_WINDOW_MS)?.gust10m?.kts).toBe(12);
        expect(NmeaStore.getWindHistory(now + WIND_HISTORY_WINDOW_MS)?.max1h?.kts).toBe(12);
        expect(NmeaStore.getWindHistory(now + WIND_HISTORY_WINDOW_MS + 5_000)).toBeNull();
    });

    it('does not re-stamp a cached wind value when a fresh Pi/GPS row arrives', () => {
        NmeaStore.ingestRemote(remote({ windSampleAt: undefined, twsKts: 40 }));
        expect(NmeaStore.getWindHistory()).toBeNull();
        NmeaStore.ingestRemote(remote({ twsKts: 0 }));
        vi.setSystemTime(now + 5_000);
        NmeaStore.ingestRemote(remote({ windSampleAt: now, twsKts: 0 }));
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 1, latestAt: now, max1h: { kts: 0 } });
        NmeaStore.ingestRemote(remote({ twsKts: 0 }));
        expect(NmeaStore.getWindHistory()?.sampleCount).toBe(2);
    });

    it('rejects expired or future original remote wind samples', () => {
        NmeaStore.ingestRemote(remote({ windSampleAt: now - 60_001 }));
        NmeaStore.ingestRemote(remote({ windSampleAt: now + 1_001 }));
        expect(NmeaStore.getWindHistory()).toBeNull();
    });

    it('requires the current leaf source for scalar peaks while a validated Pi summary remains usable', () => {
        for (const source of [undefined, '', 'sensor\u0000other', 'sensor\u0085other', 'x'.repeat(121)]) {
            NmeaStore.ingestRemote(remote({ windSampleSource: source, twsKts: 80 }));
            expect(NmeaStore.getWindHistory()).toBeNull();
        }
        NmeaStore.ingestRemote(remote({ windSampleSource: undefined, twsKts: 80, windHistory: summary() }));
        expect(NmeaStore.getWindHistory()).toMatchObject({
            sampleCount: 600,
            max1h: { kts: 30 },
            gust10m: { kts: 24 },
        });
    });

    it('preserves the same Pi across a LAN/cloud handover but fences a different boat', () => {
        NmeaStore.ingestRemote(remote({ via: 'lan', twsKts: 25 }));
        NmeaStore.clearRemote('lan');
        vi.setSystemTime(now + 20_000);
        NmeaStore.ingestRemote(remote({ via: 'cloud', twsKts: 12 }));
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 2, max1h: { kts: 25 } });
        NmeaStore.ingestRemote(remote({ windHistoryIdentity: 'another-boat', twsKts: 7 }));
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 1, max1h: { kts: 7 } });
    });

    it('fences phone feeds, changed direct gateways, sign-out and stop', () => {
        NmeaStore.ingestRemote(remote({ twsKts: 30 }));
        NmeaStore.ingestRemote(remote({ source: 'device', twsKts: 7 }));
        expect(NmeaStore.getWindHistory()?.max1h?.kts).toBe(7);
        direct(15);
        listener.host = 'different-gateway';
        direct(6);
        expect(NmeaStore.getWindHistory()?.max1h?.kts).toBe(6);
        setAuthIdentityScope(null);
        expect(NmeaStore.getWindHistory()).toBeNull();
        direct(9);
        NmeaStore.stop();
        expect(NmeaStore.getWindHistory()).toBeNull();
    });

    it('prefers fresh Pi history collected while the app was absent', () => {
        NmeaStore.ingestRemote(remote({ twsKts: 12, windHistory: summary() }));
        expect(NmeaStore.getWindHistory()).toMatchObject({
            sampleCount: 600,
            max1h: { kts: 30 },
            gust10m: { kts: 24 },
        });
        expect(NmeaStore.getWindHistory(now + 60_001)).toMatchObject({ sampleCount: 3, asOf: now, max1h: { kts: 30 } });
    });

    it('retires an expiring authoritative peak and falls back to still-known samples', () => {
        NmeaStore.ingestRemote(
            remote({ windHistory: summary({ gust10m: { kts: 24, at: now - WIND_GUST_WINDOW_MS + 1 } }) }),
        );
        expect(NmeaStore.getWindHistory()?.gust10m?.kts).toBe(24);
        expect(NmeaStore.getWindHistory(now + 1)?.gust10m?.kts).toBe(12);
    });

    it('does not let repeated/older Pi summaries overwrite a newer source-time summary', () => {
        NmeaStore.ingestRemote(remote({ windHistory: summary() }));
        NmeaStore.ingestRemote(remote({ windHistory: summary({ max1h: { kts: 50, at: now } }) }));
        expect(NmeaStore.getWindHistory()?.max1h?.kts).toBe(30);
    });

    it('clears history when the Pi reports a different physical wind sensor', () => {
        NmeaStore.ingestRemote(remote({ windHistory: summary() }));
        vi.setSystemTime(now + 1_000);
        NmeaStore.ingestRemote(
            remote({
                windHistory: summary({
                    source: 'n2k.77',
                    asOf: now + 1_000,
                    latestAt: now + 1_000,
                    max1h: { kts: 9, at: now + 1_000 },
                    gust10m: { kts: 9, at: now + 1_000 },
                }),
                windSampleSource: 'n2k.77',
                twsKts: 9,
            }),
        );
        expect(NmeaStore.getWindHistory()?.max1h?.kts).toBe(9);
        expect(NmeaStore.getWindHistory(now + 60_001)?.max1h?.kts).toBe(9);
    });

    it('does not mix a new wind leaf with the old sensor summary between Pi sampling cycles', () => {
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.42', windHistory: summary(), twsKts: 30 }));
        vi.setSystemTime(now + 1_000);
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.77', windHistory: summary(), twsKts: 7 }));
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 1, max1h: { kts: 7 }, gust10m: { kts: 7 } });
        NmeaStore.clearRemote('cloud');
        vi.setSystemTime(now + 2_000);
        NmeaStore.ingestRemote(remote({ via: 'lan', windSampleSource: 'n2k.77', windHistory: summary(), twsKts: 5 }));
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 2, max1h: { kts: 7 } });
    });

    it('a delayed previous sensor cannot replace a newer LAN sensor after handover to cloud', () => {
        NmeaStore.ingestRemote(remote({ via: 'lan', windSampleSource: 'n2k.42', windHistory: summary() }));
        vi.setSystemTime(now + 5_000);
        NmeaStore.ingestRemote(remote({ via: 'lan', windSampleSource: 'n2k.77', twsKts: 7 }));
        expect(NmeaStore.getWindHistory()?.max1h?.kts).toBe(7);
        NmeaStore.clearRemote('lan');
        vi.setSystemTime(now + 10_000);
        for (const oldAt of [now, now + 5_000]) {
            NmeaStore.ingestRemote(
                remote({
                    via: 'cloud',
                    windSampleSource: 'n2k.42',
                    windSampleAt: oldAt,
                    twsKts: 45,
                    windHistory: summary({
                        asOf: now + 10_000,
                        latestAt: oldAt,
                        max1h: { kts: 45, at: oldAt },
                        gust10m: { kts: 45, at: oldAt },
                    }),
                }),
            );
            expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 1, max1h: { kts: 7 } });
        }
        // A genuinely newer change back is accepted; the old sensor is not permanently banned.
        vi.setSystemTime(now + 15_000);
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.42', twsKts: 11 }));
        expect(NmeaStore.getWindHistory()).toMatchObject({ sampleCount: 1, max1h: { kts: 11 } });
    });

    it('retains a known hourly Pi peak after a gust expires and the Pi stops replying', () => {
        NmeaStore.ingestRemote(
            remote({
                twsKts: 12,
                windHistory: summary({
                    max1h: { kts: 40, at: now - 50 * 60_000 },
                    gust10m: { kts: 20, at: now - WIND_GUST_WINDOW_MS + 1_000 },
                }),
            }),
        );
        expect(NmeaStore.getWindHistory(now + 2_000)).toMatchObject({
            max1h: { kts: 40 },
            gust10m: { kts: 12 },
            asOf: now,
        });
        expect(NmeaStore.getWindHistory(now + 61_000)).toMatchObject({
            max1h: { kts: 40 },
            gust10m: { kts: 12 },
            asOf: now,
            sampleCount: 3,
        });
        expect(NmeaStore.getWindHistory(now + 10 * 60_000)?.max1h?.kts).toBe(20);
        setAuthIdentityScope('other-owner');
        expect(NmeaStore.getWindHistory()).toBeNull();
    });

    it('includes a newer wind leaf immediately instead of waiting for the next Pi summary cycle', () => {
        NmeaStore.ingestRemote(
            remote({
                windSampleSource: 'n2k.42',
                windSampleAt: now - 1_000,
                twsKts: 55,
                windHistory: summary({
                    asOf: now - 4_000,
                    latestAt: now - 4_000,
                    max1h: { kts: 31, at: now - 50 * 60_000 },
                    gust10m: { kts: 20, at: now - 5_000 },
                }),
            }),
        );
        expect(NmeaStore.getWindHistory()).toMatchObject({
            max1h: { kts: 55, at: now - 1_000 },
            gust10m: { kts: 55, at: now - 1_000 },
            since: now - 3_000_000,
            asOf: now - 1_000,
            latestAt: now - 1_000,
            sampleCount: 3,
        });
        expect(NmeaStore.getWindHistory(now + 2_000)?.asOf).toBe(now - 1_000);
    });

    it('keeps a peak observed between Pi polls when its next later summary missed that peak', () => {
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.42', windHistory: summary() }));
        vi.setSystemTime(now + 2_000);
        NmeaStore.ingestRemote(remote({ windSampleSource: 'n2k.42', windHistory: summary(), twsKts: 40 }));
        expect(NmeaStore.getWindHistory()?.gust10m).toEqual({ kts: 40, at: now + 2_000 });
        vi.setSystemTime(now + 5_000);
        NmeaStore.ingestRemote(
            remote({
                windSampleSource: 'n2k.42',
                windHistory: summary({ asOf: now + 5_000, latestAt: now + 5_000 }),
            }),
        );
        expect(NmeaStore.getWindHistory()).toMatchObject({
            max1h: { kts: 40, at: now + 2_000 },
            gust10m: { kts: 40, at: now + 2_000 },
            asOf: now + 5_000,
            latestAt: now + 5_000,
            sampleCount: 5,
        });
        expect(NmeaStore.getWindHistory(now + 10_000)?.asOf).toBe(now + 5_000);
        expect(NmeaStore.getWindHistory(now + 602_000)?.gust10m?.kts).toBe(12);
    });
});
