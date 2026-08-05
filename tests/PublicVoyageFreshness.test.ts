import { describe, expect, it } from 'vitest';
import {
    PUBLIC_AIS_MAX_AGE_MS,
    PUBLIC_POSITION_FRESH_MS,
    classifyNearbyVesselFreshness,
    formatPublicAge,
    isPublicPositionFresh,
    publicTimestampAgeMs,
} from '../src/publicVoyageFreshness';

const NOW = Date.parse('2026-08-04T10:00:00.000Z');
const isoAtAge = (ageMs: number) => new Date(NOW - ageMs).toISOString();

describe('public voyage freshness contracts', () => {
    it('mirrors the server ten-minute live-voyage bound', () => {
        expect(isPublicPositionFresh(isoAtAge(PUBLIC_POSITION_FRESH_MS - 1), NOW)).toBe(true);
        expect(isPublicPositionFresh(isoAtAge(PUBLIC_POSITION_FRESH_MS), NOW)).toBe(false);
        expect(isPublicPositionFresh('not-a-date', NOW)).toBe(false);
        expect(isPublicPositionFresh(new Date(NOW + 60_001).toISOString(), NOW)).toBe(false);
    });

    it('retains stale AIS as last-known only inside the server two-hour envelope', () => {
        expect(classifyNearbyVesselFreshness(isoAtAge(60_000), NOW, false)).toBe('fresh');
        expect(classifyNearbyVesselFreshness(isoAtAge(PUBLIC_POSITION_FRESH_MS), NOW, false)).toBe('last-known');
        expect(classifyNearbyVesselFreshness(isoAtAge(PUBLIC_AIS_MAX_AGE_MS - 1), NOW, false)).toBe('last-known');
        expect(classifyNearbyVesselFreshness(isoAtAge(PUBLIC_AIS_MAX_AGE_MS), NOW, false)).toBe('expired');
        expect(classifyNearbyVesselFreshness(null, NOW, false)).toBe('expired');
    });

    it('immediately reclassifies retained AIS when the dashboard connection is lost', () => {
        expect(classifyNearbyVesselFreshness(isoAtAge(1_000), NOW, true)).toBe('last-known');
    });

    it('keeps relative labels advancing from the supplied independent clock', () => {
        const updatedAt = new Date(NOW).toISOString();
        expect(formatPublicAge(updatedAt, NOW)).toBe('just now');
        expect(formatPublicAge(updatedAt, NOW + 2 * 60_000)).toBe('2 min ago');
        expect(publicTimestampAgeMs(updatedAt, NOW + 2 * 60_000)).toBe(2 * 60_000);
    });
});
