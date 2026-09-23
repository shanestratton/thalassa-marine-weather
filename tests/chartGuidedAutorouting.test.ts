import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/autoroutingTrial', () => ({ calculateAutoroutingTrial: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({ getCell: vi.fn() }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: vi.fn() }));
import {
    createChartGuidedTrialCalculator,
    CHART_GUIDANCE_LOAD_TIMEOUT_MS,
    CHART_GUIDANCE_PROVIDER_TIMEOUT_MS,
    CHART_GUIDANCE_TOTAL_TIMEOUT_MS,
    type ChartGuidedTrialDependencies,
} from '../services/chartGuidedAutorouting';
import { NEWPORT_CHANNEL_TRACK_POLICY } from '../services/newportChannelTrackPolicy';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../types/autorouting';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import { encCell } from './helpers/encCells';

const NOW = Date.parse('2026-09-13T01:00:00Z');
const CELL = 'OC-61-10RCS5';
const north: [number, number] = [153.095128, -27.1675],
    south: [number, number] = [153.093142, -27.201389];
const offsetPoint = (t: number): [number, number] => [
    north[0] + (south[0] - north[0]) * t + 0.00053,
    north[1] + (south[1] - north[1]) * t,
];
const departure = offsetPoint(-0.1),
    destination = offsetPoint(1.1);
const input = (): AutoroutingTrialRequest => ({
    departure: { lon: departure[0], lat: departure[1] },
    destination: { lon: destination[0], lat: destination[1] },
    draftM: 2.4,
    speedKts: 6.5,
});
const original = (): AutoroutingTrialRoute => ({
    id: 'original',
    provider: 'SevenCs',
    coordinates: [departure, destination],
    createdAt: '2026-09-13T00:59:59Z',
    warnings: ['Original specific finding', 'Shared warning'],
    source: { rtz: '<original/>', geoJson: '{"original":true}' },
});
const guided = (): AutoroutingTrialRoute => ({
    id: 'guided',
    provider: 'SevenCs',
    coordinates: [departure, north, south, destination],
    createdAt: '2026-09-13T01:00:00Z',
    warnings: ['Guided specific finding', 'Shared warning'],
    source: { rtz: '<guided/>', geoJson: '{"guided":true}' },
});
const metadata = (): EncCell => ({
    id: CELL,
    edition: 1,
    issued: '2022-03-07',
    sourceHO: 'OC',
    usage: 'navigation',
    importedAt: '2026-09-12T00:00:00Z',
    geojsonPath: `enc/${CELL}.json`,
    bbox: [153.083335, -27.221665, 153.111665, -27.166665],
    hazardCount: 100,
});
const blob = (): EncConversionResult =>
    ({ ...structuredClone(encCell(CELL)), ...metadata(), cellId: CELL }) as EncConversionResult;
const harness = () => {
    const first = original(),
        second = guided(),
        cell = metadata(),
        chart = blob();
    const calculate = vi
        .fn<ChartGuidedTrialDependencies['calculate']>()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(second);
    const getCell = vi.fn<ChartGuidedTrialDependencies['getCell']>().mockImplementation(() => cell);
    const loadCell = vi.fn<ChartGuidedTrialDependencies['loadCell']>().mockImplementation(async () => chart);
    const policy = structuredClone(NEWPORT_CHANNEL_TRACK_POLICY);
    const dependencies = { calculate, getCell, loadCell, policy, now: () => Date.now() };
    return {
        first,
        second,
        cell,
        chart,
        calculate,
        getCell,
        loadCell,
        policy,
        dependencies,
        run: createChartGuidedTrialCalculator({ channelGuidance: true, dependencies }),
    };
};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
};
const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAuthIdentityScope('guidance-user');
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('one-shot reviewed channel-track recalculation', () => {
    it('uses an ordinary initial request then ordered documented constraints exactly once', async () => {
        const h = harness(),
            request = input(),
            before = structuredClone(request);
        const result = await h.run(request);
        expect(h.calculate).toHaveBeenCalledTimes(2);
        expect(h.calculate.mock.calls[0][0]).toEqual(request);
        const constraints = h.calculate.mock.calls[1][0].chartTrackConstraints!;
        expect(constraints).toHaveLength(2);
        expect(constraints[0].lon).toBeCloseTo(north[0], 7);
        expect(constraints[0].lat).toBeCloseTo(north[1], 7);
        expect(constraints[1].lon).toBeCloseTo(south[0], 7);
        expect(constraints[1].lat).toBeCloseTo(south[1], 7);
        expect(request).toEqual(before);
        expect(result.id).toBe('guided');
        expect(h.loadCell.mock.calls).toEqual([[CELL], [CELL, false]]);
    });

    it('keeps exact chosen source and all warnings, clearly labelling initial-only diagnostics', async () => {
        const h = harness(),
            firstBefore = structuredClone(h.first),
            secondBefore = structuredClone(h.second);
        const result = await h.run(input());
        expect(result.source).toEqual(h.second.source);
        expect(result.createdAt).toBe(h.second.createdAt);
        expect(result.warnings).toContain('Guided specific finding');
        expect(result.warnings.filter((w) => w === 'Shared warning')).toHaveLength(1);
        expect(result.warnings).toContain('Initial proposal also reported: Original specific finding');
        expect(result.warnings.some((w) => w.includes('geometrically checked'))).toBe(true);
        expect(h.first).toEqual(firstBefore);
        expect(h.second).toEqual(secondBefore);
        expect(result.coordinates).not.toBe(h.second.coordinates);
    });

    it('preserves chosen structured checks without aliasing and retains initial-only structured findings', async () => {
        const h = harness();
        h.first.providerCheck = {
            status: 'unsafe',
            findings: [{ featureIndex: 1, severity: 'danger', message: 'Initial submerged obstruction' }],
        };
        h.second.providerCheck = {
            status: 'caution',
            findings: [{ featureIndex: 4, severity: 'caution', message: 'Guided route caution' }],
        };
        const result = await h.run(input());
        expect(result.providerCheck).toEqual(h.second.providerCheck);
        expect(result.providerCheck).not.toBe(h.second.providerCheck);
        expect(result.providerCheck!.findings[0]).not.toBe(h.second.providerCheck.findings[0]);
        expect(result.warnings).toContain('Initial proposal also reported: Initial submerged obstruction');
        expect(result.warnings.join(' ')).toContain('initial proposal was reported unsafe');
        result.providerCheck!.findings[0].message = 'consumer mutation';
        expect(h.second.providerCheck.findings[0].message).toBe('Guided route caution');
    });

    it('retains the initial unsafe structured verdict exactly when guided geometry is rejected', async () => {
        const h = harness();
        h.first.providerCheck = {
            status: 'unsafe',
            findings: [{ featureIndex: 1, severity: 'danger', message: 'Initial obstruction' }],
        };
        h.second.coordinates = [...h.first.coordinates];
        const result = await h.run(input());
        expect(result.providerCheck).toEqual(h.first.providerCheck);
        expect(result.providerCheck).not.toBe(h.first.providerCheck);
        expect(result.providerCheck!.findings[0]).not.toBe(h.first.providerCheck.findings[0]);
    });

    it.each([undefined, false])(
        'does no chart I/O or second request unless capability is explicit true (%s)',
        async (channelGuidance) => {
            const h = harness();
            const result = await createChartGuidedTrialCalculator({ channelGuidance, dependencies: h.dependencies })(
                input(),
            );
            expect(result).toEqual(h.first);
            expect(h.calculate).toHaveBeenCalledTimes(1);
            expect(h.loadCell).not.toHaveBeenCalled();
            expect(h.getCell).not.toHaveBeenCalled();
        },
    );

    it('does not recursively guide an already constrained request', async () => {
        const h = harness();
        const result = await h.run({ ...input(), chartTrackConstraints: [{ lon: north[0], lat: north[1] }] });
        expect(h.calculate).toHaveBeenCalledTimes(1);
        expect(h.getCell).not.toHaveBeenCalled();
        expect(result).toEqual(h.first);
    });

    it('does not load Newport charts for a proposal elsewhere', async () => {
        const h = harness();
        h.first.coordinates = [
            [151, -33],
            [151.1, -33.1],
        ];
        const result = await h.run(input());
        expect(h.calculate).toHaveBeenCalledTimes(1);
        expect(h.getCell).not.toHaveBeenCalled();
        expect(result).toEqual(h.first);
    });

    it('does not redirect a crossing onto the track', async () => {
        const h = harness();
        h.first.coordinates = [
            [153.09, -27.18],
            [153.1, -27.18],
        ];
        const result = await h.run(input());
        expect(h.calculate).toHaveBeenCalledTimes(1);
        expect(result).toEqual(h.first);
    });

    it('retains the original, with a notice, if chart proof is missing', async () => {
        const h = harness();
        h.getCell.mockReturnValue(null);
        const result = await h.run(input());
        expect(result.coordinates).toEqual(h.first.coordinates);
        expect(result.source).toEqual(h.first.source);
        expect(result.warnings.join(' ')).toMatch(/guidance unavailable.*original proposal is unchanged/);
        expect(h.loadCell).not.toHaveBeenCalled();
        expect(h.calculate).toHaveBeenCalledTimes(1);
    });

    it('retains the original when the review lease has expired', async () => {
        const h = harness();
        h.policy.validUntil = '2026-09-12T23:59:59Z';
        const result = await h.run(input());
        expect(result.id).toBe('original');
        expect(h.calculate).toHaveBeenCalledTimes(1);
    });

    it.each(['moved source', 'missed constraints', 'off-corridor excursion', 'reversed traversal', 'changed endpoint'])(
        'rejects a guided result with %s',
        async (kind) => {
            const h = harness();
            if (kind === 'moved source') {
                h.loadCell
                    .mockImplementationOnce(async () => h.chart)
                    .mockImplementationOnce(async () => ({ ...h.chart, edition: 2 }));
            }
            if (kind === 'missed constraints') h.second.coordinates = [...h.first.coordinates];
            if (kind === 'off-corridor excursion')
                h.second.coordinates = [departure, north, offsetPoint(0.5), south, destination];
            if (kind === 'reversed traversal') h.second.coordinates = [departure, south, north, destination];
            if (kind === 'changed endpoint') h.second.coordinates[0] = [departure[0] + 0.001, departure[1]];
            const result = await h.run(input());
            expect(result.id).toBe('original');
            expect(result.source).toEqual(h.first.source);
            expect(result.coordinates).toEqual(h.first.coordinates);
            expect(result.warnings.join(' ')).toMatch(/not verified.*original proposal is unchanged/);
            expect(h.calculate).toHaveBeenCalledTimes(2);
        },
    );

    it('does not leak provider error text or retry a rejected guided call', async () => {
        const h = harness();
        h.calculate
            .mockReset()
            .mockResolvedValueOnce(h.first)
            .mockRejectedValueOnce(new Error('secret-token-provider-detail'));
        const result = await h.run(input());
        expect(result.id).toBe('original');
        expect(JSON.stringify(result)).not.toContain('secret-token');
        expect(h.calculate).toHaveBeenCalledTimes(2);
    });

    it('stops a hanging chart read at its bound and ignores its late result', async () => {
        const h = harness(),
            pending = deferred<EncConversionResult | null>();
        h.loadCell.mockReturnValueOnce(pending.promise);
        const resultPromise = h.run(input());
        await flush();
        await vi.advanceTimersByTimeAsync(CHART_GUIDANCE_LOAD_TIMEOUT_MS);
        const result = await resultPromise;
        expect(result.id).toBe('original');
        pending.resolve(h.chart);
        await flush();
        expect(h.calculate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds a hanging guided call, aborts it, and retains only the initial proposal', async () => {
        const h = harness(),
            pending = deferred<AutoroutingTrialRoute>();
        h.calculate.mockReset().mockResolvedValueOnce(h.first).mockReturnValueOnce(pending.promise);
        const resultPromise = h.run(input());
        await flush();
        expect(h.calculate).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(CHART_GUIDANCE_PROVIDER_TIMEOUT_MS);
        const result = await resultPromise;
        expect(result.id).toBe('original');
        expect(h.calculate.mock.calls[1][1]?.aborted).toBe(true);
        pending.resolve(h.second);
        await flush();
        expect(h.loadCell).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('uses a shorter caller deadline for optional guidance and falls back to the original', async () => {
        const h = harness(),
            pending = deferred<AutoroutingTrialRoute>();
        h.calculate.mockReset().mockResolvedValueOnce(h.first).mockReturnValueOnce(pending.promise);
        const run = createChartGuidedTrialCalculator({
            channelGuidance: true,
            dependencies: h.dependencies,
            deadlineAtMs: NOW + 5_000,
        });
        const resultPromise = run(input());
        await flush();
        expect(h.calculate).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await resultPromise).id).toBe('original');
        expect(h.calculate.mock.calls[1][1]?.aborted).toBe(true);
        pending.resolve(h.second);
        await flush();
        expect(h.loadCell).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reserves the total 75s budget instead of allowing another full45s after a slow first result', async () => {
        const h = harness(),
            first = deferred<AutoroutingTrialRoute>(),
            second = deferred<AutoroutingTrialRoute>();
        h.calculate.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const resultPromise = h.run(input());
        await vi.advanceTimersByTimeAsync(40_000);
        first.resolve(h.first);
        await flush();
        expect(h.calculate).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(CHART_GUIDANCE_TOTAL_TIMEOUT_MS - 40_000);
        expect((await resultPromise).id).toBe('original');
        expect(h.calculate.mock.calls[1][1]?.aborted).toBe(true);
        second.resolve(h.second);
        await flush();
        expect(h.loadCell).toHaveBeenCalledTimes(1);
    });

    it('does not accept moved endpoints merely because they remain inside20m corridor tolerance', async () => {
        const h = harness();
        h.second.coordinates[0] = [departure[0] + 0.00005, departure[1]];
        const result = await h.run(input());
        expect(result.id).toBe('original');
        expect(result.warnings.join(' ')).toMatch(/not verified/);
    });

    it('supports factory-scoped progress callbacks without needing a third argument', async () => {
        const h = harness(),
            onProgress = vi.fn();
        await createChartGuidedTrialCalculator({ channelGuidance: true, dependencies: h.dependencies, onProgress })(
            input(),
        );
        expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Recalculating once'));
    });

    it('rejects an initial failure rather than inventing a fallback proposal', async () => {
        const h = harness();
        h.calculate.mockReset().mockRejectedValue(new Error('ordinary initial failure'));
        await expect(h.run(input())).rejects.toThrow('ordinary initial failure');
        expect(h.loadCell).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['caller cancel', 'account switch'])(
        'never returns an old proposal or starts another call after %s',
        async (kind) => {
            const h = harness(),
                pending = deferred<EncConversionResult | null>(),
                controller = new AbortController();
            const scheduled = vi.spyOn(globalThis, 'setTimeout');
            const cleared = vi.spyOn(globalThis, 'clearTimeout');
            h.loadCell.mockReturnValueOnce(pending.promise);
            const resultPromise = h.run(input(), controller.signal);
            const rejection = expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
            await flush();
            const wrapperTimers = scheduled.mock.results.map((result) => result.value);
            if (kind === 'caller cancel') controller.abort();
            else setAuthIdentityScope('different-guidance-user');
            await rejection;
            pending.resolve(h.chart);
            await flush();
            expect(h.calculate).toHaveBeenCalledTimes(1);
            // Other auth subscribers may schedule their own work on a fence.
            // Assert OUR pending timers are cleared, rather than counting theirs.
            for (const timer of wrapperTimers) expect(cleared).toHaveBeenCalledWith(timer);
        },
    );

    it('rejects cancellation from the progress callback before dispatching guided coordinates', async () => {
        const h = harness(),
            controller = new AbortController();
        await expect(
            h.run(input(), controller.signal, (message) => {
                if (message.includes('Recalculating')) controller.abort();
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(h.calculate).toHaveBeenCalledTimes(1);
    });

    it('rechecks registration after asynchronous chart loading', async () => {
        const h = harness();
        h.loadCell.mockImplementationOnce(async () => {
            h.cell.importedAt = 'changed';
            return h.chart;
        });
        const result = await h.run(input());
        expect(result.id).toBe('original');
        expect(h.calculate).toHaveBeenCalledTimes(1);
    });

    it.each(['registration', 'policy', 'lease'])('rechecks %s after provider recalculation', async (kind) => {
        const h = harness();
        h.calculate
            .mockReset()
            .mockResolvedValueOnce(h.first)
            .mockImplementationOnce(async () => {
                if (kind === 'registration') h.cell.personalManifestVersion = 99;
                if (kind === 'policy') h.policy.sourceRevision = 'changed';
                if (kind === 'lease') vi.setSystemTime(Date.parse(h.policy.validUntil));
                return h.second;
            });
        const result = await h.run(input());
        expect(result.id).toBe('original');
        expect(result.source).toEqual(h.first.source);
    });

    it('snapshots request coordinates before any asynchronous work', async () => {
        const h = harness(),
            pending = deferred<AutoroutingTrialRoute>(),
            request = input();
        h.calculate.mockReset().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(h.second);
        const resultPromise = h.run(request);
        request.departure.lon = 1;
        request.destination.lat = 2;
        pending.resolve(h.first);
        await resultPromise;
        expect(h.calculate.mock.calls[0][0].departure.lon).toBe(departure[0]);
        expect(h.calculate.mock.calls[1][0].departure.lon).toBe(departure[0]);
        expect(h.calculate.mock.calls[1][0].destination.lat).toBe(destination[1]);
    });

    it.each(['guided/caller', 'guided/account', 'final-chart/caller', 'final-chart/account'])(
        'rejects cancellation or account changes during %s',
        async (mode) => {
            const h = harness(),
                controller = new AbortController();
            const pendingRoute = deferred<AutoroutingTrialRoute>(),
                pendingChart = deferred<EncConversionResult | null>();
            if (mode.startsWith('guided/'))
                h.calculate.mockReset().mockResolvedValueOnce(h.first).mockReturnValueOnce(pendingRoute.promise);
            else h.loadCell.mockResolvedValueOnce(h.chart).mockReturnValueOnce(pendingChart.promise);
            const work = h.run(input(), controller.signal);
            const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
            await flush();
            expect(h.calculate).toHaveBeenCalledTimes(2);
            if (mode.endsWith('/caller')) controller.abort();
            else setAuthIdentityScope('another-user-late-stage');
            await rejected;
            pendingRoute.resolve(h.second);
            pendingChart.resolve(h.chart);
            await flush();
            expect(h.calculate).toHaveBeenCalledTimes(2);
        },
    );

    it('snapshots existing explicit constraints and never refines them recursively', async () => {
        const h = harness(),
            pending = deferred<AutoroutingTrialRoute>(),
            request = input();
        const constraint = { lon: north[0], lat: north[1] };
        request.chartTrackConstraints = [constraint];
        h.calculate.mockReset().mockReturnValueOnce(pending.promise);
        const work = h.run(request);
        constraint.lon = 0;
        pending.resolve(h.first);
        await work;
        expect(h.calculate).toHaveBeenCalledTimes(1);
        expect(h.calculate.mock.calls[0][0].chartTrackConstraints).toEqual([{ lon: north[0], lat: north[1] }]);
        expect(h.loadCell).not.toHaveBeenCalled();
    });
});
