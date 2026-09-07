import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getState } = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock('../services/NmeaStore', () => ({
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
    NmeaStore: {
        getState,
        // The provider asks the store whether the feed is the boat's (socket or Pi over the LAN).
        isBoatFeed: () => getState()?.connectionStatus === 'connected',
        subscribe: vi.fn(() => () => {}),
    },
}));

import { NmeaGpsProvider } from '../services/NmeaGpsProvider';

const NOW = 1_750_000_000_000;

function state(ageMs: number, connectionStatus: 'connected' | 'disconnected' = 'connected') {
    return {
        connectionStatus,
        latitude: { value: -27.4, lastUpdated: NOW - ageMs, freshness: 'live' },
        longitude: { value: 153.1, lastUpdated: NOW - ageMs, freshness: 'live' },
        hdop: { value: 0.9 },
        satellites: { value: 11 },
        gpsFixQuality: 2,
        cog: { value: null },
        heading: { value: null },
        sog: { value: null },
    };
}

describe('NmeaGpsProvider feed freshness', () => {
    beforeEach(() => {
        getState.mockReset();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps a normal 5-second NMEA cadence live through scheduler jitter', () => {
        getState.mockReturnValue(state(6_000));

        expect(NmeaGpsProvider.getFeedStatus(NOW)).toBe('live');
        expect(NmeaGpsProvider.isActive()).toBe(true);
    });

    it('stops accepting a vessel position after two missed sample windows', () => {
        getState.mockReturnValue(state(13_001));

        expect(NmeaGpsProvider.getFeedStatus(NOW)).toBe('unavailable');
    });

    it('does not use a previously valid fix after the NMEA link disconnects', () => {
        getState.mockReturnValue(state(1_000, 'disconnected'));

        expect(NmeaGpsProvider.getFeedStatus(NOW)).toBe('unavailable');
    });
});
