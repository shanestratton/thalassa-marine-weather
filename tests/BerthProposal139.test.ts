import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types/settings';
import type { AutoroutingTrialRequest } from '../types/autorouting';
import { cumulativeLegs } from '../services/isochrone/geodesy';
import type { IsochroneNode } from '../services/isochrone/types';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const h = vi.hoisted(() => ({
    settings: {} as UserSettings,
    boat: 'fictional-boat',
    trial: true,
    revision: 0,
    model: 'ecmwf',
    pair: null,
    lan: null,
    prepare: vi.fn(),
    short: vi.fn(),
    ocean: vi.fn(),
    validate: vi.fn(),
    released: [vi.fn(), vi.fn()],
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: h.settings, activeVesselId: h.boat }) },
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => h.pair,
    getPiEquipmentReadRevision: () => h.revision,
}));
vi.mock('../services/enc/piCellSync', () => ({ boatLanBaseNow: () => h.lan }));
vi.mock('../services/autorouteTrialSwitch', () => ({
    isAutorouteTrialOn: () => h.trial,
    AUTO_ROUTE_TRIAL_OFF: 'Auto trial is off.',
}));
vi.mock('../stores/WindStore', () => ({ WindStore: { getState: () => ({ model: h.model }) } }));
vi.mock('../services/routing/isochronePolicy', () => ({
    isochroneRoutingContext: (_clock: string, settings: UserSettings) => JSON.stringify(settings),
}));
vi.mock('../services/routing/berthPortals', () => ({ prepareBerthPortalLeases: h.prepare }));
vi.mock('../services/autoroutingThalassa', () => ({ calculateThalassaProposal: h.short }));
vi.mock('../services/routing/constrainedPassage', () => ({ computeConstrainedPassage: h.ocean }));
vi.mock('../services/isochrone/landAvoidance', () => ({ validateRouteSegments: h.validate }));
import { calculateBerthProposal } from '../services/routing/berthProposal';
const request = (): AutoroutingTrialRequest => ({
    departure: { lat: 0, lon: 0 },
    destination: { lat: 0, lon: 5 },
    draftM: 2,
    speedKts: 6,
    departureMs: Date.now(),
    vesselProfile: {
        length: { status: 'measured', valueM: 12 },
        beam: { status: 'measured', valueM: 4 },
        airDraft: { status: 'measured', valueM: 15 },
        draftStatus: 'measured',
    },
});
beforeEach(() => {
    setAuthIdentityScope('fictional-berth-owner');
    h.boat = 'fictional-boat';
    h.trial = true;
    h.revision = 0;
    h.model = 'ecmwf';
    h.settings = { vessel: { draft: 2 * 3.28084 }, comfortParams: {}, satelliteMode: false } as UserSettings;
    h.released.forEach((fn) => fn.mockReset());
    h.prepare.mockReset().mockImplementation(async () =>
        [0, 1].map((end) => {
            let released = false;
            return {
                candidates: [
                    {
                        id: 'fictional-' + end,
                        at: { lat: 0, lon: end ? 4.8 : 0.2 },
                        depthM: 50,
                        sourceKey: 'fictional-cohort-' + end,
                    },
                ],
                current: () => !released,
                release: () => {
                    if (!released) {
                        released = true;
                        h.released[end]();
                    }
                },
            };
        }),
    );
    h.short.mockReset().mockImplementation(async (req: AutoroutingTrialRequest) => ({
        id: 'fictional-approach',
        provider: 'Thalassa',
        coordinates: [
            [req.departure.lon, req.departure.lat],
            [(req.departure.lon + req.destination.lon) / 2, 0],
            [req.destination.lon, req.destination.lat],
        ],
        warnings: ['Fictional chart approach; survey caveat retained.'],
        createdAt: new Date().toISOString(),
        engine: {
            stateMask: ['green', 'green'],
            cautionMask: [false, false],
            cellsUsed: ['US5TEST1'],
            distanceNM: 12,
            elapsedMs: 1,
            backstop: 'verified',
        },
    }));
    h.ocean.mockReset().mockImplementation(async (input) => {
        const points = [input.origin, { lat: 0, lon: 2.5 }, input.destination],
            clock = cumulativeLegs(points, 6),
            tail = clock.at(-1)!;
        const route = points.map((p, i) => ({
            ...p,
            timeHours: clock[i].hours,
            distance: clock[i].nm,
            bearing: 90,
            speed: 6,
            tws: 10,
            twa: 90,
            parentIndex: null,
            propulsion: 'sail',
            tackSide: 'starboard',
        }));
        return {
            result: {
                route,
                routeCoordinates: route.map((p) => [p.lon, p.lat]),
                shallowFlags: route.map(() => false),
                isochrones: [],
                totalDistanceNM: tail.nm,
                totalDurationHours: tail.hours,
                arrivalTime: new Date(Date.parse(input.departureTime) + tail.hours * 3600000).toISOString(),
            },
            polarLabel: 'Fictional selected boat polar',
        };
    });
    h.validate.mockReset().mockImplementation(async (route, options) => {
        options.onVerificationOutcome({ status: 'verified' });
        return route;
    });
});
describe('production berth adapter with synthetic transports only', () => {
    it('retains short-Auto checks and requests a true offshore solve while preserving all final terminals', async () => {
        const r = request(),
            proposal = await calculateBerthProposal(r);
        expect(h.short).toHaveBeenCalledTimes(2);
        expect(h.ocean).toHaveBeenCalledOnce();
        expect(h.validate).toHaveBeenCalledOnce();
        const ocean = h.ocean.mock.calls[0][0];
        expect(ocean.offshoreOnly).toBe(true);
        expect(ocean.vias).toEqual([]);
        const departureHours = cumulativeLegs(
            [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 0.2 },
            ],
            6,
        ).at(-1)!.hours;
        expect(Date.parse(ocean.departureTime) - r.departureMs!).toBeCloseTo(departureHours * 3600000, 0);
        expect(proposal.coordinates[0]).toEqual([0, 0]);
        expect(proposal.coordinates.at(-1)).toEqual([5, 0]);
        expect(proposal.engine?.berth?.sourceKeys).toEqual(['fictional-cohort-0', 'fictional-cohort-1']);
        expect(proposal.warnings.join(' ')).toContain('survey caveat retained');
        expect(proposal.warnings.join(' ')).toContain('propulsion are unresolved');
        expect(proposal.polarLabel).toBe('Fictional selected boat polar');
        h.released.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
    });
    it('refuses new automatic approaches when opt-in is off or measured boat draft changed, before chart preparation', async () => {
        h.trial = false;
        await expect(calculateBerthProposal(request())).rejects.toThrow('Auto trial is off');
        expect(h.prepare).not.toHaveBeenCalled();
        h.trial = true;
        h.settings.vessel!.draft = 3 * 3.28084;
        await expect(calculateBerthProposal(request())).rejects.toThrow('current measured boat draft');
        expect(h.prepare).not.toHaveBeenCalled();
    });
    it('pair re-enrolment during the middle solve retires the whole request without running the arrival or final verifier', async () => {
        const run = h.ocean.getMockImplementation()!;
        h.ocean.mockImplementation(async (input) => {
            const out = await run(input);
            h.revision++;
            return out;
        });
        await expect(calculateBerthProposal(request())).rejects.toThrow('changed or expired');
        expect(h.short).toHaveBeenCalledOnce();
        expect(h.validate).not.toHaveBeenCalled();
        h.released.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
    });
    it('does not accept missing final verification or changed final geometry', async () => {
        h.validate.mockImplementation(async (route) => route);
        await expect(calculateBerthProposal(request())).rejects.toThrow('did not pass');
        h.validate.mockImplementation(async (route, options) => {
            options.onVerificationOutcome({ status: 'verified' });
            return route.map((p: IsochroneNode, i: number) => (i === 1 ? { ...p, lat: 0.001 } : p));
        });
        await expect(calculateBerthProposal(request())).rejects.toThrow('did not pass');
    });
});

describe('berth proposal area-policy refusal and current caveats', () => {
    it.each(['route-exclusion', 'exclusion-unavailable'])(
        'keeps a structured approach %s and does not try an offshore bypass',
        async (code) => {
            h.short.mockRejectedValueOnce(Object.assign(Error('held'), { code }));
            await expect(calculateBerthProposal(request())).rejects.toMatchObject({ code });
            expect(h.ocean).not.toHaveBeenCalled();
            expect(h.validate).not.toHaveBeenCalled();
            h.released.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
        },
    );
    it.each(['route-exclusion', 'exclusion-unavailable'])('keeps the whole-joined-line validator %s', async (code) => {
        h.validate.mockRejectedValueOnce(Object.assign(Error('held'), { code }));
        await expect(calculateBerthProposal(request())).rejects.toMatchObject({ code });
        h.released.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
    });
    it('preserves final current area caveats in accepted berth warnings', async () => {
        h.validate.mockImplementationOnce(async (route, options) => {
            options.onRouteAreaCaveats(['Indicative park fixture; check current local rules.']);
            options.onVerificationOutcome({ status: 'verified' });
            return route;
        });
        const output = await calculateBerthProposal(request());
        expect(output.warnings).toContain('Indicative park fixture; check current local rules.');
        expect(h.validate.mock.calls.at(-1)?.[1].signal).toBeInstanceOf(AbortSignal);
    });
});

it('berth proposal holds an actual auth A/B/A key retirement at the validator return seam', async () => {
    const { getAuthIdentityScope, setAuthIdentityScope } = await import('../services/authIdentityScope');
    const original = getAuthIdentityScope().userId;
    const validate = h.validate;
    validate.mockImplementationOnce(async (route, options) => {
        setAuthIdentityScope('fictional-other-policy-owner');
        setAuthIdentityScope(original);
        options?.onVerificationOutcome?.({ status: 'verified' });
        return route;
    });
    try {
        await expect(calculateBerthProposal(request())).rejects.toMatchObject({ code: 'exclusion-unavailable' });
    } finally {
        setAuthIdentityScope(original);
    }
});
