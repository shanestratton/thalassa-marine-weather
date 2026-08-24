/**
 * What separates a passage from a day sail (Shane + Claude, 2026-08-24).
 *
 * The rule under test: planned night hours underway (civil dusk→dawn,
 * computed at each point's OWN position and time), with a 100 nm backstop.
 * Distance-only misclassifies in both directions; the night is what changes
 * the seamanship. And the classifier is a VERDICT, never a gate.
 */
import { describe, expect, it } from 'vitest';
import {
    classifyCompletedVoyage,
    classifyPlannedRoute,
    escalationDue,
    isNightAt,
    PASSAGE_DISTANCE_NM,
    PASSAGE_NIGHT_HOURS,
} from '../utils/passageClass';

// Moreton Bay noon in August: UTC+10, sun well up.
const BRISBANE = { lat: -27.4, lon: 153.1 };
const AUG_NOON_UTC = Date.parse('2026-08-24T02:00:00Z'); // 12:00 AEST
const AUG_2200_LOCAL = Date.parse('2026-08-24T12:00:00Z'); // 22:00 AEST

describe('isNightAt', () => {
    it('knows Moreton Bay noon from Moreton Bay night', () => {
        expect(isNightAt(AUG_NOON_UTC, BRISBANE.lat, BRISBANE.lon)).toBe(false);
        expect(isNightAt(AUG_2200_LOCAL, BRISBANE.lat, BRISBANE.lon)).toBe(true);
    });

    it('never uses the device clock hour — position decides', () => {
        // 02:00 UTC is noon in Brisbane and 21:00 the previous evening in the
        // mid-Atlantic. The PDF service's `hour >= 6 && hour < 18` local test
        // cannot tell these apart; the classifier must.
        expect(isNightAt(AUG_NOON_UTC, 35, -40)).toBe(true);
    });

    it('survives high latitudes where twilight phases do not exist', () => {
        // Tromsø in late June: no civil dusk. SunCalc returns Invalid Date
        // for the phases; the altitude fallback answers instead of throwing.
        const midsummer = Date.parse('2026-06-24T11:00:00Z');
        expect(() => isNightAt(midsummer, 69.6, 18.9)).not.toThrow();
        expect(isNightAt(midsummer, 69.6, 18.9)).toBe(false);
    });
});

describe('classifyPlannedRoute', () => {
    const NM = 1 / 60; // one nm of latitude, in degrees

    it('calls a 20 nm morning harbour hop a day cruise', () => {
        const route = [BRISBANE, { lat: BRISBANE.lat - 20 * NM, lon: BRISBANE.lon }];
        const v = classifyPlannedRoute(route, Date.parse('2026-08-24T22:00:00Z'), 6); // 08:00 AEST
        expect(v.kind).toBe('day-cruise');
        expect(v.reasons).toHaveLength(0);
        expect(v.distanceNm).toBeCloseTo(20, 0);
    });

    it('calls a 90 nm overnighter a passage — distance under the backstop', () => {
        // Depart 16:00 AEST at 6 kn: 15 hours, most of them dark. THE case
        // distance-only misses.
        const route = [BRISBANE, { lat: BRISBANE.lat - 90 * NM, lon: BRISBANE.lon }];
        const v = classifyPlannedRoute(route, Date.parse('2026-08-24T06:00:00Z'), 6);
        expect(v.distanceNm).toBeLessThan(PASSAGE_DISTANCE_NM);
        expect(v.kind).toBe('passage');
        expect(v.nightHours).toBeGreaterThan(PASSAGE_NIGHT_HOURS);
        expect(v.reasons[0]).toContain('darkness');
    });

    it('calls a 120 nm daylight sprint a passage — the backstop', () => {
        // A fast cat at 20 kn: 6 daylight hours, zero dark. Still
        // passage-grade planning weight, caught by the backstop alone.
        const route = [BRISBANE, { lat: BRISBANE.lat - 120 * NM, lon: BRISBANE.lon }];
        const v = classifyPlannedRoute(route, Date.parse('2026-08-23T22:00:00Z'), 20); // 08:00 AEST
        expect(v.kind).toBe('passage');
        expect(v.nightHours).toBeLessThan(PASSAGE_NIGHT_HOURS);
        expect(v.reasons[0]).toContain('backstop');
    });

    it('does not cry passage over a grazed dusk', () => {
        // Home 40 min after civil dusk — a late day sail. The 1.0 h threshold
        // exists so this exact trip stays unremarkable; an alarm that fires
        // here is an alarm that gets ignored at sea.
        const route = [BRISBANE, { lat: BRISBANE.lat - 15 * NM, lon: BRISBANE.lon }];
        // Depart 15:30 AEST at 6 kn → 2.5 h → in around 18:00, dusk ~17:45.
        const v = classifyPlannedRoute(route, Date.parse('2026-08-24T05:30:00Z'), 6);
        expect(v.nightHours).toBeLessThan(PASSAGE_NIGHT_HOURS);
        expect(v.kind).toBe('day-cruise');
    });

    it('applies the 6 kn floor rather than trusting a zero speed', () => {
        const route = [BRISBANE, { lat: BRISBANE.lat - 30 * NM, lon: BRISBANE.lon }];
        const v = classifyPlannedRoute(route, Date.parse('2026-08-24T22:00:00Z'), 0);
        expect(Number.isFinite(v.nightHours)).toBe(true);
    });

    it('returns a quiet day-cruise verdict for degenerate input', () => {
        expect(classifyPlannedRoute([], Date.now()).kind).toBe('day-cruise');
        expect(classifyPlannedRoute([BRISBANE], Date.now()).kind).toBe('day-cruise');
    });
});

describe('classifyCompletedVoyage — the retroactive badge', () => {
    it('badges a logged trip that crossed the night, from summary fields alone', () => {
        // Zero schema change: this is exactly what VoyageSummary carries.
        const v = classifyCompletedVoyage({
            startedAt: '2026-08-23T06:00:00Z', // 16:00 AEST
            endedAt: '2026-08-23T22:00:00Z', // 08:00 AEST next morning
            totalDistanceNM: 85,
            firstLat: -27.4,
            firstLon: 153.1,
            lastLat: -26.0,
            lastLon: 153.3,
        });
        expect(v.kind).toBe('passage');
        expect(v.nightHours).toBeGreaterThan(5);
    });

    it('leaves the Sunday sail unbadged', () => {
        const v = classifyCompletedVoyage({
            startedAt: '2026-08-23T23:00:00Z', // 09:00 AEST
            endedAt: '2026-08-24T05:00:00Z', // 15:00 AEST
            totalDistanceNM: 18,
            firstLat: -27.4,
            firstLon: 153.1,
            lastLat: -27.3,
            lastLon: 153.2,
        });
        expect(v.kind).toBe('day-cruise');
        expect(v.reasons).toHaveLength(0);
    });

    it('still applies the backstop when fixes are missing', () => {
        const v = classifyCompletedVoyage({
            startedAt: null,
            endedAt: null,
            totalDistanceNM: 140,
            firstLat: null,
            firstLon: null,
            lastLat: null,
            lastLon: null,
        });
        expect(v.kind).toBe('passage');
        expect(v.nightHours).toBe(0);
    });
});

describe('escalationDue — the porous boundary', () => {
    it('stays quiet for a boat two hours out in full daylight', () => {
        const now = AUG_NOON_UTC;
        expect(escalationDue(now, now - 3 * 3_600_000, BRISBANE.lat, BRISBANE.lon)).toBe(false);
    });

    it('stays quiet for a sunset harbour lap — under two hours underway', () => {
        const eveningNow = Date.parse('2026-08-24T08:30:00Z'); // 18:30 AEST, past dusk
        expect(escalationDue(eveningNow, eveningNow - 1 * 3_600_000, BRISBANE.lat, BRISBANE.lon)).toBe(false);
    });

    it('fires for a long day sail within an hour of dusk', () => {
        // ~17:10 AEST in August Brisbane — dusk ~17:45. Five hours underway.
        const now = Date.parse('2026-08-24T07:10:00Z');
        expect(escalationDue(now, now - 5 * 3_600_000, BRISBANE.lat, BRISBANE.lon)).toBe(true);
    });

    it('fires for a boat already in the dark', () => {
        const now = Date.parse('2026-08-24T10:00:00Z'); // 20:00 AEST
        expect(escalationDue(now, now - 4 * 3_600_000, BRISBANE.lat, BRISBANE.lon)).toBe(true);
    });
});
