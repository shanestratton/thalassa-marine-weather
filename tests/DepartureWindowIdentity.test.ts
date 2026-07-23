import { beforeEach, describe, expect, it, vi } from 'vitest';

const departureWindowMocks = vi.hoisted(() => ({
    computeIsochrones: vi.fn(),
}));

vi.mock('../services/IsochroneRouter', () => ({
    computeIsochrones: departureWindowMocks.computeIsochrones,
}));

import { planDepartureWindow } from '../services/departureWindow';
import type { DepartureWindowOptions } from '../services/departureWindow';

const result = {
    route: [
        { timeHours: 0, tws: 12 },
        { timeHours: 12, tws: 18 },
    ],
    totalDurationHours: 12,
    totalDistanceNM: 72,
    arrivalTime: '2026-07-24T00:00:00.000Z',
};

const args = [
    { lat: -27.47, lon: 153.03 },
    { lat: -16.92, lon: 145.77 },
    { cruisingSpeed: 6, draft: 5 },
    {},
    {},
    null,
    null,
    null,
    null,
    undefined,
    '2026-07-23T00:00:00.000Z',
] as const;

const runWindow = (options: DepartureWindowOptions) =>
    planDepartureWindow(
        args[0],
        args[1],
        args[2] as never,
        args[3] as never,
        args[4] as never,
        args[5],
        args[6],
        args[7],
        args[8],
        args[9],
        args[10],
        options,
    );

beforeEach(() => {
    vi.clearAllMocks();
    departureWindowMocks.computeIsochrones.mockResolvedValue(result);
});

describe('departure-window operation ownership', () => {
    it('reports progress only to its caller instead of broadcasting route data globally', async () => {
        const onProgress = vi.fn();
        const dispatchEvent = vi.spyOn(window, 'dispatchEvent');

        await runWindow({
            maxScenarios: 1,
            onProgress,
        });

        expect(onProgress).toHaveBeenCalledWith({
            completed: 1,
            total: 1,
            scenarios: [expect.objectContaining({ departureTime: '2026-07-23T00:00:00.000Z' })],
        });
        expect(dispatchEvent).not.toHaveBeenCalled();
    });

    it('does not publish a completed scenario after its owner becomes stale', async () => {
        let resolveCompute!: (value: typeof result) => void;
        departureWindowMocks.computeIsochrones.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveCompute = resolve;
            }),
        );
        let current = true;
        const onProgress = vi.fn();
        const planning = runWindow({
            maxScenarios: 1,
            shouldContinue: () => current,
            onProgress,
        });
        await vi.waitFor(() => expect(departureWindowMocks.computeIsochrones).toHaveBeenCalledOnce());

        current = false;
        resolveCompute(result);

        await expect(planning).resolves.toEqual([]);
        expect(onProgress).not.toHaveBeenCalled();
    });
});
