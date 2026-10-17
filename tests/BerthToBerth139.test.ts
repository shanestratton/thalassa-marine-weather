import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    computeBerthToBerth,
    type BerthPoint,
    type BerthLegRequest,
    type BerthApproach,
    type BerthPortalLease,
} from '../services/routing/berthToBerth';
import type { IsochroneResult } from '../services/isochrone/types';
import { cumulativeLegs } from '../services/isochrone/geodesy';

const origin = { lat: 0, lon: 0 },
    destination = { lat: 0, lon: 5 },
    departure = '2026-10-17T00:00:00.000Z';
function leg(points: BerthPoint[], hours: number, clock = departure): IsochroneResult {
    const distances = cumulativeLegs(points, 6),
        total = distances.at(-1)!.nm;
    const route = points.map((p, i) => ({
        ...p,
        timeHours: (i * hours) / (points.length - 1),
        distance: distances[i].nm,
        bearing: 90,
        speed: 6,
        tws: 10,
        twa: 90,
        parentIndex: null,
        propulsion: 'unknown' as const,
        tackSide: null,
    }));
    return {
        route,
        routeCoordinates: points.map((p) => [p.lon, p.lat]),
        shallowFlags: points.map(() => false),
        isochrones: [],
        totalDistanceNM: total,
        totalDurationHours: hours,
        arrivalTime: new Date(Date.parse(clock) + hours * 3600000).toISOString(),
        motorHours: null,
    };
}
function fixture() {
    let live = true,
        charts = true;
    const releases = [vi.fn(), vi.fn()],
        requests: BerthLegRequest[] = [];
    const portals = vi.fn(
        async (which: 'departure' | 'arrival'): Promise<BerthPortalLease> => ({
            candidates: [
                {
                    id: which,
                    at: { lat: 0, lon: which === 'departure' ? 0.2 : 4.8 },
                    depthM: 20,
                    sourceKey: 'fictional-current-chart-' + which,
                },
            ],
            current: () => charts,
            release: releases[which === 'departure' ? 0 : 1],
        }),
    );
    const approach = vi.fn(async (req: BerthLegRequest): Promise<BerthApproach> => {
        requests.push(req);
        const result = leg(
            [req.origin, { lat: 0, lon: (req.origin.lon + req.destination.lon) / 2 }, req.destination],
            req.offsetHours ? 2.334567 : 2.034567,
            req.departureTime,
        );
        return {
            result,
            states: ['green', 'green'],
            disclosure: {
                stateMask: ['green', 'green'],
                cellsUsed: ['US5TEST1'],
                distanceNM: result.totalDistanceNM,
                elapsedMs: 1,
                backstop: 'verified',
            },
            warnings: ['Fictional chart; approach propulsion unknown.'],
        };
    });
    const offshore = vi.fn(async (req: BerthLegRequest) => {
        requests.push(req);
        return leg([req.origin, { lat: 0, lon: 2.5 }, req.destination], 50.765432, req.departureTime);
    });
    const verify = vi.fn(async (result: IsochroneResult) => ({ verified: true, result }));
    const input = {
        origin,
        destination,
        departureTime: departure,
        draftM: 2,
        deadlineMs: Date.now() + 90000,
        current: () => live,
        portals,
        approach,
        offshore,
        verify,
    };
    return {
        input,
        requests,
        releases,
        portals,
        approach,
        offshore,
        verify,
        retire: () => {
            live = false;
        },
        retireCharts: () => {
            charts = false;
        },
    };
}
afterEach(() => vi.restoreAllMocks());
describe('one bounded berth/inshore/offshore request', () => {
    it('joins a fictional 300 NM route without smoothing approaches and advances exact unrounded forecast clocks', async () => {
        const f = fixture(),
            out = await computeBerthToBerth(f.input);
        expect(f.requests.map((r) => r.offsetHours)).toEqual([0, 2.034567, 2.034567 + 50.765432]);
        expect(Date.parse(f.requests[1].departureTime) - Date.parse(departure)).toBeCloseTo(2.034567 * 3600000, 0);
        expect(out.result.routeCoordinates).toEqual([
            [0, 0],
            [0.1, 0],
            [0.2, 0],
            [2.5, 0],
            [4.8, 0],
            [4.9, 0],
            [5, 0],
        ]);
        expect(out.states).toEqual(['green', 'green', 'offshore', 'offshore', 'green', 'green']);
        expect(out.result.route.at(-1)!.timeHours).toBeCloseTo(2.034567 + 50.765432 + 2.334567, 10);
        expect(f.verify).toHaveBeenCalledOnce();
        f.releases.forEach((r) => expect(r).toHaveBeenCalledOnce());
    });
    it('refuses an overall request beyond 1200 NM before chart or forecast IO', async () => {
        const f = fixture();
        await expect(computeBerthToBerth({ ...f.input, destination: { lat: 0, lon: 25 } })).rejects.toThrow('1200');
        expect(f.portals).not.toHaveBeenCalled();
        expect(f.offshore).not.toHaveBeenCalled();
    });
    it.each(['depth', 'range', 'cohort'] as const)(
        'refuses an unknown or oversized portal %s without treating candidate geometry as clearance',
        async (kind) => {
            const f = fixture(),
                read = f.input.portals;
            f.input.portals = vi.fn(async (which) => {
                const lease = await read(which);
                if (kind === 'depth') lease.candidates[0].depthM = NaN;
                if (kind === 'range') lease.candidates[0].at.lon = 2;
                if (kind === 'cohort') lease.candidates = Array.from({ length: 5 }, () => lease.candidates[0]);
                return lease;
            });
            await expect(computeBerthToBerth(f.input)).rejects.toThrow('portal');
            expect(f.approach).not.toHaveBeenCalled();
            expect(f.releases[0]).toHaveBeenCalledOnce();
        },
    );
    it('refuses missing masks instead of publishing a partly checked approach', async () => {
        const f = fixture(),
            run = f.approach.getMockImplementation()!;
        f.approach.mockImplementation(async (req) => {
            const r = await run(req);
            r.states = [];
            return r;
        });
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('masks');
        expect(f.offshore).not.toHaveBeenCalled();
    });
    it('rejects a 180 degree departure seam rather than silently reconnecting it', async () => {
        const f = fixture();
        f.offshore.mockImplementation(async (req) =>
            leg([req.origin, { lat: 0, lon: -0.5 }, req.destination], 50, req.departureTime),
        );
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('double-back');
        expect(f.verify).not.toHaveBeenCalled();
    });
    it('refuses a sub-metre portal offset instead of hiding a connector when concatenating', async () => {
        const f = fixture(),
            run = f.offshore.getMockImplementation()!;
        f.offshore.mockImplementation(async (req) => {
            const result = await run(req);
            result.route[0].lon += 0.000001;
            result.routeCoordinates[0][0] = result.route[0].lon;
            return result;
        });
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('shared portals');
        expect(f.verify).not.toHaveBeenCalled();
    });
    it('rejects whole-line verifier mutation of an accepted inshore interior', async () => {
        const f = fixture();
        f.verify.mockImplementation(async (candidate) => {
            const result = structuredClone(candidate);
            result.route[1].lat = 0.0001;
            result.routeCoordinates[1][1] = 0.0001;
            return { verified: true, result };
        });
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('exact joined');
    });
    it('rejects an in-place interior mutation even when the verifier returns its input', async () => {
        const f = fixture();
        f.verify.mockImplementation(async (candidate) => {
            candidate.route[1].lat = 0.0001;
            candidate.routeCoordinates[1][1] = 0.0001;
            return { verified: true, result: candidate };
        });
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('exact joined');
    });
    it.each(['clock', 'distance'] as const)(
        'rejects coherent in-place %s changes on unchanged geometry',
        async (kind) => {
            const f = fixture();
            f.verify.mockImplementation(async (candidate) => {
                for (const node of candidate.route) {
                    if (kind === 'clock') node.timeHours *= 2;
                    else node.distance *= 2;
                }
                if (kind === 'clock') {
                    candidate.totalDurationHours = Math.round(candidate.route.at(-1)!.timeHours * 10) / 10;
                    candidate.arrivalTime = new Date(
                        Date.parse(departure) + candidate.route.at(-1)!.timeHours * 3600000,
                    ).toISOString();
                } else candidate.totalDistanceNM = Math.round(candidate.route.at(-1)!.distance * 10) / 10;
                return { verified: true, result: candidate };
            });
            await expect(computeBerthToBerth(f.input)).rejects.toThrow('exact joined');
        },
    );
    it('retirements during the offshore await prevent arrival IO and final adoption', async () => {
        const f = fixture(),
            run = f.offshore.getMockImplementation()!;
        f.offshore.mockImplementation(async (req) => {
            const r = await run(req);
            f.retireCharts();
            return r;
        });
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('source changed');
        expect(f.approach).toHaveBeenCalledOnce();
        expect(f.verify).not.toHaveBeenCalled();
        f.releases.forEach((r) => expect(r).toHaveBeenCalledOnce());
    });
    it('enforces its 90 s monotonic bound even if the wall clock has not advanced', async () => {
        const f = fixture();
        let monotonic = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
        const read = f.input.portals;
        f.input.portals = vi.fn(async (which) => {
            const lease = await read(which);
            monotonic = 90001;
            return lease;
        });
        await expect(computeBerthToBerth(f.input)).rejects.toThrow('retired');
        expect(f.approach).not.toHaveBeenCalled();
        expect(f.releases[0]).toHaveBeenCalledOnce();
    });
    it('does not retain a late chart lease after external cancellation', async () => {
        const f = fixture(),
            controller = new AbortController();
        let finish!: (lease: BerthPortalLease) => void;
        f.input.portals = vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = computeBerthToBerth({ ...f.input, signal: controller.signal });
        controller.abort();
        finish({ candidates: [], current: () => true, release: f.releases[0] });
        await expect(pending).rejects.toThrow('retired');
        expect(f.releases[0]).toHaveBeenCalledOnce();
        expect(f.approach).not.toHaveBeenCalled();
    });
});
