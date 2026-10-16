import { describe, expect, it, vi } from 'vitest';
import { computeVerifiedIsochroneChain, type ConstrainedLegRequest } from '../services/routing/isochroneChain';
import type { IsochroneResult } from '../services/isochrone/types';
const start = Date.parse('2026-10-17T12:00:00Z');
function leg(request: ConstrainedLegRequest, hours = 0.34): IsochroneResult {
    const route = [request.origin, request.destination].map((p, i) => ({
        ...p,
        timeHours: i * hours,
        distance: i * 2.04,
        speed: 6,
        bearing: 90,
        tws: 10,
        twa: 90,
        parentIndex: null,
    }));
    return {
        route,
        routeCoordinates: route.map((p) => [p.lon, p.lat]),
        shallowFlags: [false, false],
        isochrones: [],
        totalDurationHours: Math.round(hours * 10) / 10,
        totalDistanceNM: 2,
        arrivalTime: new Date(Date.parse(request.departureTime) + hours * 3600000).toISOString(),
    };
}
function setup() {
    const computeLeg = vi.fn(async (request: ConstrainedLegRequest) => leg(request));
    const verify = vi.fn(async (result: IsochroneResult) => ({ result, verified: true }));
    return {
        origin: { lat: 0, lon: 0 },
        destination: { lat: 0, lon: 2 },
        vias: [{ lat: 0, lon: 1 }],
        departureTime: new Date(start).toISOString(),
        deadlineMs: Date.now() + 5000,
        computeLeg,
        verify,
    };
}
describe('one verified waypoint route and one clock', () => {
    it('routes every ordered leg and rebases the next forecast from precise node time, not rounded summaries', async () => {
        const input = setup(),
            result = await computeVerifiedIsochroneChain(input);
        expect(input.computeLeg).toHaveBeenCalledTimes(2);
        expect(input.computeLeg.mock.calls[1][0]).toMatchObject({
            offsetHours: 0.34,
            departureTime: new Date(start + 0.34 * 3600000).toISOString(),
            origin: { lat: 0, lon: 1 },
        });
        expect(result.route.map((p) => p.timeHours)).toEqual([0, 0.34, 0.68]);
        expect(result.route.map((p) => p.distance)).toEqual([0, 2.04, 4.08]);
        expect(result.arrivalTime).toBe(new Date(start + 0.68 * 3600000).toISOString());
        expect(input.verify).toHaveBeenCalledOnce();
    });
    it('never returns an incomplete leg or lets final smoothing erase an accepted pin', async () => {
        const input = setup();
        input.computeLeg.mockImplementationOnce(async (request) => {
            const value = leg(request);
            value.route[1].lon = 0.9;
            value.routeCoordinates[1][0] = 0.9;
            return value;
        });
        await expect(computeVerifiedIsochroneChain(input)).rejects.toThrow('required waypoint leg');
        expect(input.verify).not.toHaveBeenCalled();
        const second = setup();
        second.verify.mockImplementation(async (result) => ({
            ...result,
            result: {
                ...result,
                route: [result.route[0], result.route.at(-1)!],
                routeCoordinates: [result.routeCoordinates[0], result.routeCoordinates.at(-1)!],
            },
            verified: true,
        }));
        await expect(computeVerifiedIsochroneChain(second)).rejects.toThrow('changed a required point');
    });
    it('rejects a final changed clock even when its coordinates retain the pins', async () => {
        const input = setup();
        input.verify.mockImplementation(async (result) => ({
            result: { ...result, arrivalTime: new Date(start).toISOString() },
            verified: true,
        }));
        await expect(computeVerifiedIsochroneChain(input)).rejects.toThrow('changed a required point');
    });
    it('transfers the same side check to each engine leg and refuses a forbidden final crossing', async () => {
        const input = { ...setup(), vias: [{ lat: 0, lon: 1, leaveSide: 'port' as const, standOffM: 50 }] };
        input.computeLeg.mockImplementation(async (request) => {
            expect(request.segmentAllowed({ lat: 0.1, lon: 0 }, { lat: 0.1, lon: 2 })).toBe(false);
            expect(request.segmentAllowed({ lat: -0.1, lon: 0 }, { lat: -0.1, lon: 2 })).toBe(true);
            return leg(request);
        });
        const result = await computeVerifiedIsochroneChain(input);
        expect(result.route[1].lat).toBeLessThan(0);
    });
    it('shares one deadline and abort lifetime; no partial successful first leg escapes', async () => {
        const input = { ...setup(), deadlineMs: Date.now() + 30 };
        let signal: AbortSignal | undefined;
        input.computeLeg.mockImplementationOnce(async (request) => {
            signal = request.signal;
            return new Promise(() => {});
        });
        await expect(computeVerifiedIsochroneChain(input)).rejects.toThrow('deadline');
        expect(signal?.aborted).toBe(true);
        expect(input.verify).not.toHaveBeenCalled();
        const cancelled = { ...setup(), shouldContinue: () => false };
        await expect(computeVerifiedIsochroneChain(cancelled)).rejects.toThrow('cancelled');
        expect(cancelled.computeLeg).not.toHaveBeenCalled();
    });
    it('refuses the whole graph at its fixed aggregate frontier cap', async () => {
        const input = setup();
        input.computeLeg.mockImplementation(async (request) => {
            const value = leg(request);
            value.isochrones = [{ timeHours: 0, nodes: Array(50001).fill(value.route[0]) }];
            return value;
        });
        await expect(computeVerifiedIsochroneChain(input)).rejects.toThrow('bounded memory');
        expect(input.verify).not.toHaveBeenCalled();
    });
});
