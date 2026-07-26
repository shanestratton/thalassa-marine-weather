import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getState } = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState,
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

    it('keeps a normal 5-second NMEA cadence usable after the 3-second visual-live tier', () => {
        getState.mockReturnValue(state(6_000));

        expect(NmeaGpsProvider.getFeedStatus(NOW)).toBe('stale');
        expect(NmeaGpsProvider.isActive()).toBe(true);
    });

    it('stops accepting a vessel position after two missed sample windows', () => {
        getState.mockReturnValue(state(12_001));

        expect(NmeaGpsProvider.getFeedStatus(NOW)).toBe('unavailable');
    });

    it('does not use a previously valid fix after the NMEA link disconnects', () => {
        getState.mockReturnValue(state(1_000, 'disconnected'));

        expect(NmeaGpsProvider.getFeedStatus(NOW)).toBe('unavailable');
    });
});
