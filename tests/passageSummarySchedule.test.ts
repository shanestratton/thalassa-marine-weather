import { describe, expect, it } from 'vitest';
import {
    clampDepartureToNow,
    derivePassageSummarySchedule,
    routeDistanceNm,
    verifiedCruisingSpeedKt,
} from '../services/passageSummarySchedule';

describe('passageSummarySchedule', () => {
    it('moves a past departure to the next selectable slot but leaves a future one alone', () => {
        const now = new Date('2026-07-27T00:17:32.000Z');
        expect(clampDepartureToNow('2026-07-27T00:00:00.000Z', now)).toBe('2026-07-27T00:20:00.000Z');
        expect(clampDepartureToNow('2026-07-27T02:00:00.000Z', now)).toBe('2026-07-27T02:00:00.000Z');
    });

    it('uses the saved curve and vessel cruise speed for distance, duration, and ETA', () => {
        // Two 60-NM legs around a corner. The route must not collapse to the
        // shorter start→finish diagonal just because the card is summarising.
        const route = [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 0 },
            { lat: 1, lon: 1 },
        ];
        const now = new Date('2026-07-27T00:00:00.000Z');
        const schedule = derivePassageSummarySchedule({
            routeCoordinates: route,
            departureTime: '2026-07-27T01:00:00.000Z',
            cruisingSpeedKt: 6,
            now,
        });

        expect(routeDistanceNm(route)).toBeCloseTo(120, 0);
        expect(schedule.distanceNm).toBeCloseTo(120, 0);
        expect(schedule.durationHours).toBeCloseTo(20, 0);
        expect((Date.parse(schedule.eta!) - Date.parse(schedule.departureTime)) / 3_600_000).toBeCloseTo(20, 0);
    });

    it('recalculates ETA from a changed departure rather than trusting a stored arrival', () => {
        const route = [
            { lat: -27, lon: 153 },
            { lat: -27.2, lon: 153 },
        ];
        const now = new Date('2026-07-27T00:00:00.000Z');
        const first = derivePassageSummarySchedule({
            routeCoordinates: route,
            departureTime: '2026-07-27T01:00:00.000Z',
            cruisingSpeedKt: 6,
            now,
        });
        const later = derivePassageSummarySchedule({
            routeCoordinates: route,
            departureTime: '2026-07-27T05:00:00.000Z',
            cruisingSpeedKt: 6,
            now,
        });

        expect(Date.parse(later.eta!) - Date.parse(first.eta!)).toBe(4 * 3_600_000);
    });

    it('uses a safe default speed only for an invalid vessel profile value', () => {
        expect(verifiedCruisingSpeedKt(7.2)).toBe(7.2);
        expect(verifiedCruisingSpeedKt(0)).toBe(6);
        expect(verifiedCruisingSpeedKt(40)).toBe(6);
    });
});
