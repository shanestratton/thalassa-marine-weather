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
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
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
        startLeg(VOYAGE_ID, 'Brisbane');
        closeLeg(VOYAGE_ID, 'Nouméa', 750);
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
        startLeg(VOYAGE_ID, 'Brisbane');

        const key = authScopedStorageKey('thalassa_voyage_legs');
        const legs = JSON.parse(localStorage.getItem(key) || '[]');
        const twelveHoursAgo = new Date(Date.now() - 12 * 3_600_000).toISOString();
        legs[0].departure_time = twelveHoursAgo;
        localStorage.setItem(key, JSON.stringify(legs));

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
        const otherVoyage = 'test-voyage-002';

        startLeg(VOYAGE_ID, 'Brisbane');
        startLeg(otherVoyage, 'Sydney');

        expect(getLegsForVoyage(VOYAGE_ID)).toHaveLength(1);
        expect(getLegsForVoyage(otherVoyage)).toHaveLength(1);
        expect(getLegsForVoyage(VOYAGE_ID)[0].departure_port).toBe('Brisbane');
        expect(getLegsForVoyage(otherVoyage)[0].departure_port).toBe('Sydney');
    });

    it('keeps local voyage legs private to the account that created them', () => {
        const accountALeg = startLeg(VOYAGE_ID, 'Brisbane');

        setAuthIdentityScope('account-b');
        expect(getLegsForVoyage(VOYAGE_ID)).toEqual([]);
        const accountBLeg = startLeg(VOYAGE_ID, 'Sydney');

        setAuthIdentityScope('account-a');
        expect(getActiveLeg(VOYAGE_ID)?.id).toBe(accountALeg.id);

        setAuthIdentityScope('account-b');
        expect(getActiveLeg(VOYAGE_ID)?.id).toBe(accountBLeg.id);
    });

    it('does not adopt unattributable legacy voyage legs', () => {
        localStorage.setItem(
            'thalassa_voyage_legs',
            JSON.stringify([{ id: 'legacy-leg', voyage_id: VOYAGE_ID, leg_number: 1, status: 'active' }]),
        );

        expect(getLegsForVoyage(VOYAGE_ID)).toEqual([]);
    });
});
