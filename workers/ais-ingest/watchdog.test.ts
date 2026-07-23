import { describe, expect, it } from 'vitest';
import { parseWatchdogPosition, shouldTriggerGeofenceAlert } from './watchdog';

describe('parseWatchdogPosition', () => {
    it('accepts a finite, timestamped PostGIS watchdog snapshot', () => {
        expect(
            parseWatchdogPosition({
                distance_m: 51.25,
                lat: -27.4698,
                lon: 153.0251,
                updated_at: '2026-07-24T00:00:00.000Z',
            }),
        ).toEqual({ distanceM: 51.25, lat: -27.4698, lon: 153.0251 });
    });

    it.each([
        null,
        [],
        { distance_m: -1, lat: -27, lon: 153, updated_at: '2026-07-24T00:00:00.000Z' },
        { distance_m: 51, lat: 91, lon: 153, updated_at: '2026-07-24T00:00:00.000Z' },
        { distance_m: 51, lat: -27, lon: 181, updated_at: '2026-07-24T00:00:00.000Z' },
        { distance_m: 51, lat: -27, lon: 153, updated_at: 'not-a-date' },
        { distance_m: '51', lat: -27, lon: 153, updated_at: '2026-07-24T00:00:00.000Z' },
    ])('rejects malformed or unsafe watchdog snapshots', (value) => {
        expect(parseWatchdogPosition(value)).toBeNull();
    });
});

describe('shouldTriggerGeofenceAlert', () => {
    it('triggers once while a vessel remains outside', () => {
        const alerted = new Set<string>();

        expect(shouldTriggerGeofenceAlert(alerted, 'owner-a:123456789', 101, 100)).toBe(true);
        alerted.add('owner-a:123456789');
        expect(shouldTriggerGeofenceAlert(alerted, 'owner-a:123456789', 250, 100)).toBe(false);
    });

    it('re-arms only after the vessel returns inside the tripwire', () => {
        const key = 'owner-a:123456789';
        const alerted = new Set([key]);

        expect(shouldTriggerGeofenceAlert(alerted, key, 100, 100)).toBe(false);
        expect(alerted.has(key)).toBe(false);
        expect(shouldTriggerGeofenceAlert(alerted, key, 101, 100)).toBe(true);
    });

    it('keeps separate alert episodes for separate owners of the same MMSI', () => {
        const alerted = new Set(['owner-a:123456789']);

        expect(shouldTriggerGeofenceAlert(alerted, 'owner-a:123456789', 200, 100)).toBe(false);
        expect(shouldTriggerGeofenceAlert(alerted, 'owner-b:123456789', 200, 100)).toBe(true);
    });

    it.each([
        [Number.NaN, 100],
        [Number.POSITIVE_INFINITY, 100],
        [-1, 100],
        [200, Number.NaN],
        [200, Number.POSITIVE_INFINITY],
        [200, 0],
        [200, -1],
    ])('rejects invalid distance/radius input (%s, %s)', (distanceM, radiusM) => {
        const key = 'owner-a:123456789';
        const alerted = new Set([key]);

        expect(shouldTriggerGeofenceAlert(alerted, key, distanceM, radiusM)).toBe(false);
        expect(alerted.has(key)).toBe(true);
    });
});
