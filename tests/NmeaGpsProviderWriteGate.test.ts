import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getState, subscribe, subscribers } = vi.hoisted(() => {
    const subscribers: ((s: unknown) => void)[] = [];
    return {
        subscribers,
        getState: vi.fn(),
        subscribe: vi.fn((cb: (s: unknown) => void) => {
            subscribers.push(cb);
            return () => {
                const i = subscribers.indexOf(cb);
                if (i >= 0) subscribers.splice(i, 1);
            };
        }),
    };
});

vi.mock('../services/NmeaStore', () => ({
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
    NmeaStore: { getState, subscribe, isBoatFeed: () => getState()?.connectionStatus === 'connected' },
}));

import { NmeaGpsProvider } from '../services/NmeaGpsProvider';

const NOW = 1_750_000_000_000;

/** The store's own freshness rule, so the harness cannot flatter the gate by
 *  reporting 'live' for a fix that is anything but. */
function freshnessFor(ageMs: number): 'live' | 'stale' | 'dead' {
    if (ageMs <= 6_500) return 'live';
    if (ageMs <= 13_000) return 'stale';
    return 'dead';
}

/** A store snapshot with independently aged coordinates. */
function snapshot(latAgeMs: number, lonAgeMs = latAgeMs) {
    return {
        connectionStatus: 'connected' as const,
        latitude: { value: -27.195, lastUpdated: NOW - latAgeMs, freshness: freshnessFor(latAgeMs) },
        longitude: { value: 153.105, lastUpdated: NOW - lonAgeMs, freshness: freshnessFor(lonAgeMs) },
        hdop: { value: 0.9 },
        satellites: { value: 11 },
        gpsFixQuality: 2,
        cog: { value: null },
        heading: { value: null },
        sog: { value: null },
    };
}

/** Push a state through the real onStoreUpdate via the captured subscriber. */
function push(s: ReturnType<typeof snapshot>) {
    getState.mockReturnValue(s);
    for (const cb of subscribers) cb(s);
}

describe('NmeaGpsProvider write gate', () => {
    beforeEach(() => {
        subscribers.length = 0;
        getState.mockReset();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        NmeaGpsProvider.stop?.();
        NmeaGpsProvider.start();
    });

    afterEach(() => {
        NmeaGpsProvider.stop?.();
        vi.restoreAllMocks();
    });

    it('caches a fix inside the live window', () => {
        push(snapshot(5_000));
        expect(NmeaGpsProvider.getPosition()?.latitude).toBeCloseTo(-27.195, 3);
    });

    it('CACHES a usable-but-stale fix instead of falling through to the phone', () => {
        // The regression this guards. The stream publishes every 5 s and 'live'
        // expires at 6.5 s, leaving 1.5 s of headroom. One late publish used to
        // make this return early and stop caching, so log entries fell through
        // to the phone GPS while the Instrument Panel — reading NmeaStore
        // directly, valid to 13 s — still showed the boat's own GPS. Same
        // device, same second, two different positions.
        push(snapshot(8_000));
        expect(NmeaGpsProvider.getPosition()).not.toBeNull();
        expect(NmeaGpsProvider.getPosition()?.latitude).toBeCloseTo(-27.195, 3);
    });

    it('still refuses a fix past the usable window', () => {
        push(snapshot(13_001));
        expect(NmeaGpsProvider.getPosition()).toBeNull();
    });

    it('does not let a fresh latitude mask a stale longitude', () => {
        // End-to-end invariant, and note WHERE it is enforced: getFeedStatus()
        // has always used the OLDER of the two stamps, so getPosition() would
        // have withheld this anyway. What changed is that the WRITER no longer
        // caches it in the first place — before, a fresh latitude let a
        // half-minute-old longitude be stored as current, and only the reader's
        // gate stood between that and a consumer. Both halves now agree, so
        // this passes for the right reason rather than by luck.
        push(snapshot(1_000, 30_000));
        expect(NmeaGpsProvider.getPosition()).toBeNull();
    });

    it('stamps the fix with the OLDER coordinate, not the newer one', () => {
        push(snapshot(1_000, 9_000));
        // Accepted (9 s is inside the usable window) but dated honestly, so
        // anything downstream ages it from the weaker coordinate.
        expect(NmeaGpsProvider.getPosition()?.timestamp).toBe(NOW - 9_000);
    });

    it('ignores a snapshot missing either coordinate', () => {
        const s = snapshot(1_000);
        push({ ...s, longitude: { ...s.longitude, value: null as unknown as number } });
        expect(NmeaGpsProvider.getPosition()).toBeNull();
    });
});
