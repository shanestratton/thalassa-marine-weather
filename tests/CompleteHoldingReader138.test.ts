import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ chart: vi.fn(), environment: vi.fn() }));
vi.mock('../services/enc/readHoldingChart', () => ({ readHoldingChart: m.chart }));
vi.mock('../services/weather/readHoldingEnvironment', () => ({ readHoldingEnvironment: m.environment }));
import { readCompleteHoldingFacts } from '../services/routing/completeHoldingReader';
import type { HoldingEnvironmentRead, HoldingFieldRead } from '../services/weather/readHoldingEnvironment';
const T = Date.parse('2026-10-17T00:00:00Z');
const request = () => ({
    lifetimeKey: 'fictional-life',
    chartContentKey: 'old-point-window',
    boatId: 'fictional-boat',
    routeIdentity: 'fictional-route',
    lat: 0,
    lon: 0,
    fromMs: T,
    untilMs: T + 60000,
    nowMs: T,
    targetDatumId: '',
    targetDatumEpoch: '',
    use: 'holding' as const,
    protectedChart: true,
    holdingAlongNm: 1,
    gateAlongNm: 2,
    radiusM: 100,
});
const chart = () => ({
    bounds: [-0.1, -0.1, 0.1, 0.1],
    chartContentKey: 'full-cohort',
    aboardOnly: true,
    completeCircleAndApproach: true,
    minimumChartedDepthM: 5,
    datumId: 'LAT',
    datumEpoch: '',
    hazards: 'clear',
    permission: 'unknown',
    bottom: 'charted',
    bottomIsPointSample: false,
    notes: ['No permission or epoch invented.'],
});
const environment = (): HoldingEnvironmentRead => {
    const f: HoldingFieldRead = {
        source: 'fictional',
        maximum: 1,
        unit: 'kt',
        originalIssueMs: null,
        verifiedAtMs: T,
        validFromMs: T,
        validUntilMs: T + 3600000,
        completeAreaAndInterval: true,
    };
    return {
        wind: { ...f },
        gust: { ...f },
        waves: { ...f, unit: 'm' },
        currents: { ...f },
        completeLocalExposure: false,
        includesTidalStreams: false,
        notes: ['Tidal streams unknown.'],
    };
};
describe('real holding reader composition and deadlines', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.chart.mockResolvedValue(chart());
        m.environment.mockReturnValue(environment());
    });
    afterEach(() => vi.useRealTimers());
    it('returns real cohort/partial primitive facts even with missing independent navigation evidence', async () => {
        const r = await readCompleteHoldingFacts(
            request(),
            { lat: 0, lon: 0.001 },
            { signal: new AbortController().signal, assertCurrent: () => {} },
        );
        expect(r).toMatchObject({
            chartContentKey: 'full-cohort',
            datumId: 'LAT',
            datumEpoch: '',
            permission: 'unknown',
            weather: null,
        });
        expect(r.evidence.environment.currents.maximum).toBe(1);
        expect(m.chart).toHaveBeenCalledTimes(1);
    });
    it('does not promote genuine issue clocks into local exposure or tidal-stream proof', async () => {
        const e = environment();
        for (const field of [e.wind, e.gust, e.waves, e.currents]) field.originalIssueMs = T;
        m.environment.mockReturnValue(e);
        const r = await readCompleteHoldingFacts(request(), null, {
            signal: new AbortController().signal,
            assertCurrent: () => {},
        });
        expect(r.weather).toMatchObject({
            completeIntervalAndExposure: false,
            includesTidalStreams: false,
            maxCurrentKts: 1,
        });
    });
    it('bounds a pending read to 30 seconds and refuses its late result', async () => {
        vi.useFakeTimers();
        let resolve!: (value: unknown) => void;
        m.chart.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const promise = readCompleteHoldingFacts(request(), null, {
            signal: new AbortController().signal,
            assertCurrent: () => {},
        });
        const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(30001);
        await rejected;
        resolve(chart());
        await Promise.resolve();
        expect(m.environment).not.toHaveBeenCalled();
    });
});
