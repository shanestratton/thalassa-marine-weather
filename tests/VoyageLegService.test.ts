/**
 * VoyageLegService — Unit tests for passage leg lifecycle.
 *
 * Tests the core flow: start leg → close leg → start next leg.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    startLeg,
    closeLeg,
    getActiveLeg,
    getLegsForVoyage,
    getCurrentLegNumber,
    getLegSummary,
    deleteLegsForVoyage,
} from '../services/VoyageLegService';

// Clear localStorage before each test
beforeEach(() => {
    localStorage.removeItem('thalassa_voyage_legs');
});

const VOYAGE_ID = 'test-voyage-001';

describe('VoyageLegService', () => {
    it('starts Leg 1 from departure port', () => {
        const leg = startLeg(VOYAGE_ID, 'Brisbane');

        expect(leg.leg_number).toBe(1);
        expect(leg.departure_port).toBe('Brisbane');
        expect(leg.arrival_port).toBeNull();
        expect(leg.status).toBe('active');
        expect(leg.voyage_id).toBe(VOYAGE_ID);
    });

    it('getActiveLeg returns the currently active leg', () => {
        startLeg(VOYAGE_ID, 'Brisbane');

        const active = getActiveLeg(VOYAGE_ID);
        expect(active).not.toBeNull();
        expect(active!.leg_number).toBe(1);
        expect(active!.status).toBe('active');
    });

    it('closeLeg marks leg as completed with arrival port', () => {
        startLeg(VOYAGE_ID, 'Brisbane');
        const closed = closeLeg(VOYAGE_ID, 'Nouméa', 750);

        expect(closed).not.toBeNull();
        expect(closed!.status).toBe('completed');
        expect(closed!.arrival_port).toBe('Nouméa');
        expect(closed!.distance_nm).toBe(750);
        expect(closed!.arrival_time).not.toBeNull();
    });

    it('after closing a leg, getActiveLeg returns null', () => {
        startLeg(VOYAGE_ID, 'Brisbane');
        closeLeg(VOYAGE_ID, 'Nouméa');

        expect(getActiveLeg(VOYAGE_ID)).toBeNull();
    });

    it('multi-leg passage: Brisbane → Nouméa → Suva', () => {
        // Leg 1: Brisbane → Nouméa
        startLeg(VOYAGE_ID, 'Brisbane');
        closeLeg(VOYAGE_ID, 'Nouméa', 750);

        // Leg 2: Nouméa → Suva
        startLeg(VOYAGE_ID, 'Nouméa');
        closeLeg(VOYAGE_ID, 'Suva', 680);

        const legs = getLegsForVoyage(VOYAGE_ID);
        expect(legs).toHaveLength(2);

        expect(legs[0].leg_number).toBe(1);
        expect(legs[0].departure_port).toBe('Brisbane');
        expect(legs[0].arrival_port).toBe('Nouméa');

        expect(legs[1].leg_number).toBe(2);
        expect(legs[1].departure_port).toBe('Nouméa');
        expect(legs[1].arrival_port).toBe('Suva');
    });

    it('getCurrentLegNumber returns highest leg number', () => {
        expect(getCurrentLegNumber(VOYAGE_ID)).toBe(0);

        startLeg(VOYAGE_ID, 'Brisbane');
        expect(getCurrentLegNumber(VOYAGE_ID)).toBe(1);

        closeLeg(VOYAGE_ID, 'Nouméa');
        startLeg(VOYAGE_ID, 'Nouméa');
        expect(getCurrentLegNumber(VOYAGE_ID)).toBe(2);
    });

    it('getLegSummary calculates duration', () => {
        const leg = startLeg(VOYAGE_ID, 'Brisbane');

        // Manually set departure time in the past for duration calc
        const legs = JSON.parse(localStorage.getItem('thalassa_voyage_legs') || '[]');
        const twelvHoursAgo = new Date(Date.now() - 12 * 3600000).toISOString();
        legs[0].departure_time = twelvHoursAgo;
        localStorage.setItem('thalassa_voyage_legs', JSON.stringify(legs));

        const closed = closeLeg(VOYAGE_ID, 'Nouméa', 750);
        expect(closed).not.toBeNull();

        const summary = getLegSummary(closed!);
        expect(summary.legNumber).toBe(1);
        expect(summary.route).toBe('Brisbane → Nouméa');
        expect(summary.durationHours).toBeGreaterThan(11);
        expect(summary.durationHours).toBeLessThan(13);
        expect(summary.distanceNm).toBe(750);
        expect(summary.status).toBe('completed');
    });

    it('deleteLegsForVoyage removes all legs', () => {
        startLeg(VOYAGE_ID, 'Brisbane');
        closeLeg(VOYAGE_ID, 'Nouméa');
        startLeg(VOYAGE_ID, 'Nouméa');

        expect(getLegsForVoyage(VOYAGE_ID).length).toBe(2);

        deleteLegsForVoyage(VOYAGE_ID);
        expect(getLegsForVoyage(VOYAGE_ID).length).toBe(0);
    });

    it('legs from different voyages are isolated', () => {
        const OTHER_VOYAGE = 'test-voyage-002';

        startLeg(VOYAGE_ID, 'Brisbane');
        startLeg(OTHER_VOYAGE, 'Sydney');

        expect(getLegsForVoyage(VOYAGE_ID)).toHaveLength(1);
        expect(getLegsForVoyage(OTHER_VOYAGE)).toHaveLength(1);
        expect(getLegsForVoyage(VOYAGE_ID)[0].departure_port).toBe('Brisbane');
        expect(getLegsForVoyage(OTHER_VOYAGE)[0].departure_port).toBe('Sydney');
    });
});
