import { describe, expect, it } from 'vitest';
import { composeArrivalMessage, composeFloatPlan, floatPlanCoord } from '../services/floatPlan';
import type { VesselProfile } from '../types/vessel';

const VESSEL: Partial<VesselProfile> = {
    name: 'Serene Summer',
    type: 'sail',
    model: 'Tayana 55',
    hullType: 'monohull',
    length: 55,
    hullColor: 'white',
    registration: 'MQ258Q',
    mmsi: '501240101',
    callSign: 'VK4AFY',
    epirbHexId: '1D0E7A2B3C4D5E6',
    liferaftCapacity: 6,
    liferaftServiceDate: '2026-03-14',
    flaresExpiry: '2027-06-30',
};

const DEPART = new Date('2026-07-31T22:00:00Z').getTime();
const ETA = DEPART + 30 * 3_600_000;
const OVERDUE = ETA + 4 * 3_600_000;

const base = {
    vessel: VESSEL,
    route: {
        from: 'Newport',
        to: 'Lady Musgrave',
        distanceNM: 178.4,
        waypoints: [
            { lat: -27.14, lon: 153.09 },
            { lat: -23.9, lon: 152.4 },
        ],
    },
    departureMs: DEPART,
    etaMs: ETA,
    overdueMs: OVERDUE,
    personsOnBoard: 3,
    whoToCall: 'Marine Rescue Bundaberg — 07 4159 4600',
};

describe('composeFloatPlan', () => {
    it('leads with the vessel and carries its identifying marks', () => {
        const plan = composeFloatPlan(base);
        expect(plan.startsWith('FLOAT PLAN — Serene Summer')).toBe(true);
        expect(plan).toContain('Tayana 55');
        expect(plan).toContain('Rego MQ258Q');
        expect(plan).toContain('MMSI 501240101');
        expect(plan).toContain('Call sign VK4AFY');
        expect(plan).toContain('white hull');
    });

    it('always carries the overdue block — that is the point of the document', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('IF YOU HAVE NOT HEARD FROM US');
        expect(plan).toContain('Marine Rescue Bundaberg');
    });

    it('still tells the shore contact when to worry with no number given', () => {
        // A bare overdue time beats nothing: it says when to start ringing.
        const plan = composeFloatPlan({ ...base, whoToCall: undefined });
        expect(plan).toContain('IF YOU HAVE NOT HEARD FROM US');
        expect(plan).toContain('your local marine rescue or water police');
    });

    it('carries the SAR gear a coordinator actually asks for', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('EPIRB hex 1D0E7A2B3C4D5E6');
        expect(plan).toContain('Liferaft 6 person, serviced 2026-03-14');
        expect(plan).toContain('Flares expire 2027-06-30');
        expect(plan).toContain('3 on board');
    });

    it('omits whole sections rather than printing empty headings', () => {
        // A half-filled profile must not produce a document littered with
        // blank SAFETY/PEOPLE headings — it reads as though data was lost.
        const plan = composeFloatPlan({
            vessel: { name: 'Tinny', type: 'power' },
            route: {},
            departureMs: DEPART,
            overdueMs: OVERDUE,
        });
        expect(plan).not.toContain('SAFETY');
        expect(plan).not.toContain('PEOPLE');
        expect(plan).not.toContain('INTENDED TRACK');
        // But the alarm block survives a bare profile.
        expect(plan).toContain('IF YOU HAVE NOT HEARD FROM US');
    });

    it('lists the intended track in degrees + decimal minutes with end tags', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('INTENDED TRACK');
        // 27.14° = 27°08.4'; marine radio speaks deg + decimal minutes.
        expect(plan).toContain("1. 27°08.4'S 153°05.4'E (depart)");
        expect(plan).toContain("2. 23°54.0'S 152°24.0'E (destination)");
    });

    it('puts the overdue block first — before vessel paint colour', () => {
        const plan = composeFloatPlan(base);
        expect(plan.indexOf('IF YOU HAVE NOT HEARD FROM US')).toBeLessThan(plan.indexOf('VESSEL'));
    });

    it('thins a dense track to departure, major turns, and destination', () => {
        // A 20-point rhumb line with ONE real 90° dogleg: the wall of
        // coordinates collapses to the three positions that matter.
        const leg1 = Array.from({ length: 10 }, (_, i) => ({ lat: -27 - i * 0.05, lon: 153 }));
        const leg2 = Array.from({ length: 10 }, (_, i) => ({ lat: -27.45, lon: 153.05 + i * 0.05 }));
        const plan = composeFloatPlan({ ...base, route: { ...base.route, waypoints: [...leg1, ...leg2] } });
        const trackLines = plan.split('\n').filter((l) => /^\s+\d+\./.test(l));
        expect(trackLines.length).toBeLessThanOrEqual(12);
        expect(plan).toContain('(depart)');
        expect(plan).toContain('(destination)');
        expect(plan).toContain('full route is aboard');
        // The dogleg corner survives thinning.
        expect(plan).toContain("27°27.0'S 153°00.0'E");
    });

    it('computes passage distance from the waypoints when not supplied', () => {
        const plan = composeFloatPlan({
            ...base,
            route: { ...base.route, distanceNM: undefined },
        });
        // 27.14S,153.09E → 23.90S,152.40E ≈ 197 NM great-circle.
        expect(plan).toMatch(/Distance {2}19[0-9] NM/);
    });

    it('an explicitly supplied distance wins over the computed one', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('Distance  178 NM');
    });

    it('carries free-text safety notes into the SAFETY section', () => {
        const plan = composeFloatPlan({
            ...base,
            vessel: { ...base.vessel, safetyNotes: 'PLB ×2, drogue, grab bag' },
        });
        expect(plan).toContain('PLB ×2, drogue, grab bag');
    });

    it('never leaves a dangling separator when identity fields are missing', () => {
        const plan = composeFloatPlan({
            ...base,
            vessel: { name: 'Serene Summer', type: 'sail', mmsi: '501240101' },
        });
        expect(plan).toContain('MMSI 501240101');
        expect(plan).not.toMatch(/·\s*·/);
        expect(plan).not.toMatch(/·\s*$/m);
    });

    it('handles an unnamed vessel without printing "undefined"', () => {
        const plan = composeFloatPlan({ ...base, vessel: null });
        expect(plan).toContain('FLOAT PLAN — Unnamed vessel');
        expect(plan).not.toContain('undefined');
    });

    it('says "not set" rather than printing an invalid date', () => {
        const plan = composeFloatPlan({ ...base, departureMs: Number.NaN, overdueMs: Number.NaN });
        expect(plan).toContain('Depart    not set');
        expect(plan).not.toContain('Invalid Date');
    });
});

describe('floatPlanCoord', () => {
    it('uses degrees + decimal minutes with hemispheres, not signed decimals', () => {
        expect(floatPlanCoord({ lat: -27.142, lon: 153.093 })).toBe("27°08.5'S 153°05.6'E");
        expect(floatPlanCoord({ lat: 41.5, lon: -71.31 })).toBe("41°30.0'N 71°18.6'W");
    });
});

describe('composeArrivalMessage', () => {
    it('stands the shore contact down explicitly', () => {
        // "We're in" is ambiguous at 0200. "Stand down" is not.
        const msg = composeArrivalMessage({
            vesselName: 'Serene Summer',
            destination: 'Lady Musgrave',
            arrivedMs: ETA,
        });
        expect(msg).toContain('Serene Summer arrived safely at Lady Musgrave');
        expect(msg).toContain('Stand down');
    });

    it('still reads correctly with no destination or name', () => {
        const msg = composeArrivalMessage({ arrivedMs: ETA });
        expect(msg).toContain('We arrived safely');
        expect(msg).not.toContain('undefined');
        expect(msg).not.toContain(' at ,');
    });
});
