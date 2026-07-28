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

    it('lists the intended track in a form that can be read aloud', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('INTENDED TRACK');
        expect(plan).toContain('1. 27.14S 153.09E');
        expect(plan).toContain('2. 23.90S 152.40E');
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
    it('uses hemispheres, not signs', () => {
        expect(floatPlanCoord({ lat: -27.142, lon: 153.093 })).toBe('27.14S 153.09E');
        expect(floatPlanCoord({ lat: 41.5, lon: -71.31 })).toBe('41.50N 71.31W');
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
