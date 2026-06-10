/**
 * Tests for the GPS-follow decision logic behind the Glass page's live
 * position follower: 5 s checks, 0.5 NM display updates, 30 NM weather
 * refetches — with the weather baseline measured from the LAST REAL FETCH
 * point, not the creeping display position.
 */

import { describe, it, expect } from 'vitest';
import { decideFollowAction, haversineNM, NAME_UPDATE_NM, WEATHER_REFRESH_NM } from '../utils/gpsFollow';

// 1 degree of latitude ≈ 60 NM — handy for building distances.
const at = (lat: number, lon = 153) => ({ lat, lon });

describe('haversineNM', () => {
    it('1 degree of latitude ≈ 60 NM', () => {
        expect(haversineNM(-27, 153, -28, 153)).toBeCloseTo(60, 0);
    });

    it('zero distance for identical points', () => {
        expect(haversineNM(-27.5, 153.1, -27.5, 153.1)).toBe(0);
    });
});

describe('decideFollowAction', () => {
    it('does nothing when stationary with a friendly name', () => {
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27),
                position: at(-27),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('none');
    });

    it('renames at the boot prettify case — placeholder name, zero drift', () => {
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27),
                position: at(-27),
                displayedNameIsPlaceholder: true,
            }),
        ).toBe('rename');
    });

    it('renames once displayed drift exceeds the name threshold', () => {
        // 0.6 NM south of the displayed point (0.01° = 0.6 NM)
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27),
                position: at(-27 - 0.01),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('rename');
    });

    it('stays quiet under the name threshold', () => {
        // ~0.3 NM — below NAME_UPDATE_NM
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27),
                position: at(-27 - 0.005),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('none');
    });

    it('refetches weather beyond 30 NM from the FETCH point', () => {
        // 36 NM from the weather point (0.6°)
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27),
                position: at(-27.6),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('refetch');
    });

    it('creeping renames cannot dodge the weather refresh — baseline is the fetch point', () => {
        // The display has crept 29 NM via successive renames; the boat is
        // now 31 NM from the FETCH point but only ~2 NM from the display.
        // Measured against the display this would be a mere rename; the
        // fetch-point baseline correctly forces a refetch.
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27 - 29 / 60),
                position: at(-27 - 31 / 60),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('refetch');
    });

    it('refetch wins over the placeholder rename when both apply', () => {
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: at(-27),
                position: at(-28), // 60 NM
                displayedNameIsPlaceholder: true,
            }),
        ).toBe('refetch');
    });

    it('no-ops safely with missing baselines (weather not loaded yet)', () => {
        expect(
            decideFollowAction({
                weatherPoint: null,
                displayed: at(-27),
                position: at(-28),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('none');
        expect(
            decideFollowAction({
                weatherPoint: at(-27),
                displayed: null,
                position: at(-28),
                displayedNameIsPlaceholder: false,
            }),
        ).toBe('none');
    });

    it('thresholds are what the spec says', () => {
        expect(NAME_UPDATE_NM).toBe(0.5);
        expect(WEATHER_REFRESH_NM).toBe(30);
    });
});
