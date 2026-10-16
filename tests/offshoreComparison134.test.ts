import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOffshoreJob, type OffshoreJob, type OffshoreCandidate } from '../services/routing/offshoreProtocol';
import { runOffshoreJob, offshoreWindFields } from '../services/routing/offshoreJob';
import { runOffshoreHosted } from '../services/routing/offshoreWorkerHost';
import {
    compareOffshoreModels,
    clearOffshoreComparisonMemo,
    offshoreComparisonSummary,
    offshoreComparisonLine,
    OFFSHORE_COMPARISON_MODELS,
} from '../services/routing/offshoreModelComparison';
import type { RouteWorkerReply } from '../services/routing/routeJob';
import type { CurrentSeries } from '../services/weather/currentSeries';

function currentSeriesForJob(input: OffshoreJob): CurrentSeries {
    const runMs = Date.parse(input.departureTime);
    return {
        schema: 1,
        model: 'CMEMS',
        dataset: 'generated-public-current',
        generation: 'fixture20261017',
        sourceSha256: 'a'.repeat(64),
        runMs,
        expiresMs: runMs + 120 * 3_600_000,
        units: 'm/s',
        vectorBasis: 'true-east-north',
        depthM: 0,
        tiles: [
            {
                id: 'synthetic-ocean',
                sourceSha256: 'a'.repeat(64),
                north: 2,
                south: -2,
                west: -32,
                east: -28,
                width: 2,
                height: 2,
                ocean: {
                    cadenceHours: 1,
                    times: Array.from({ length: 24 }, (_, i) => runMs + i * 3_600_000),
                    u: Array.from({ length: 24 }, () => new Float32Array(4).fill(1)),
                    v: Array.from({ length: 24 }, () => new Float32Array(4)),
                    known: Array.from({ length: 24 }, () => new Uint8Array(4).fill(1)),
                },
            },
        ],
    };
}

function job(): OffshoreJob {
    const frame = (value: number) => new Float32Array(9).fill(value);
    return {
        origin: { lat: 0, lon: -30 },
        destination: { lat: 0, lon: -29.8 },
        departureTime: '2026-10-17T00:00:00Z',
        polar: {
            angles: [40, 90, 180],
            windSpeeds: [5, 20],
            matrix: [
                [6, 7],
                [6, 7],
                [6, 7],
            ],
        },
        wind: {
            u: Array.from({ length: 24 }, () => frame(5)),
            v: Array.from({ length: 24 }, () => frame(0)),
            speed: Array.from({ length: 24 }, () => frame(5)),
            gust: Array.from({ length: 24 }, () => frame(9)),
            width: 3,
            height: 3,
            lats: [-2, 0, 2],
            lons: [-32, -30, -28],
            north: 2,
            south: -2,
            west: -32,
            east: -28,
            totalHours: 24,
            refTime: '2026-10-17T00:00:00Z',
        },
        bathymetry: {
            south: -2,
            north: 2,
            west: -32,
            east: -28,
            latStep: 2,
            lonStep: 2,
            rows: 3,
            cols: 3,
            data: frame(-2000),
        },
        environment: {
            departureMs: Date.parse('2026-10-17T00:00:00Z'),
            currentVectors: null,
            waves: null,
            cyclones: null,
        },
        config: { timeStepHours: 1, maxHours: 24, bearingCount: 12, powerVessel: true, motoringSpeed: 6 },
        deadlineMs: Date.now() + 60_000,
    };
}
function candidate(): OffshoreCandidate {
    return {
        verification: 'unverified-public-data',
        maxWindKts: 12,
        maxGustKts: null,
        upwindPercent: null,
        result: {
            route: [],
            isochrones: [],
            routeCoordinates: [
                [-30, 0],
                [-29, 0],
            ],
            shallowFlags: [false, false],
            totalDistanceNM: 60,
            totalDurationHours: 10,
            arrivalTime: '2026-10-17T10:00:00Z',
        },
    };
}
class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent<RouteWorkerReply>) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
        FakeWorker.instances.push(this);
    }
    emit(data: RouteWorkerReply) {
        this.onmessage?.({ data } as MessageEvent<RouteWorkerReply>);
    }
}
beforeEach(() => {
    clearOffshoreComparisonMemo();
    FakeWorker.instances = [];
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('public-only offshore Worker boundary', () => {
    it('uses a verified forecast DTO in the actual kernel and strips unknown nested inputs', async () => {
        const baseline = (await runOffshoreJob(job()))!;
        const input = job();
        input.environment.currentSeries = currentSeriesForJob(input);
        Object.assign(input.environment.currentSeries, { licensedChart: 'private' });
        Object.assign(input.environment.currentSeries.tiles[0].ocean, { boatHistory: 'private' });
        const dto = prepareOffshoreJob(input);
        expect(dto.environment.currentSeries).not.toHaveProperty('licensedChart');
        expect(dto.environment.currentSeries!.tiles[0].ocean).not.toHaveProperty('boatHistory');
        const actual = (await runOffshoreJob(dto))!;
        expect(actual.result.totalDurationHours).toBeLessThan(baseline.result.totalDurationHours);
        expect(actual.verification).toBe('unverified-public-data');
    });
    it('rejects mixed legacy snapshots, forecast components and masked NaN before Worker creation', () => {
        const input = job();
        input.environment.currentSeries = currentSeriesForJob(input);
        input.environment.currentVectors = [{ lat: 0, lon: -30, u: 0, v: 0, speedKts: 0, directionDeg: 0 }];
        expect(() => prepareOffshoreJob(input)).toThrow('mixed snapshot');
        input.environment.currentVectors = null;
        input.environment.currentSeries.tiles[0].ocean.u[0][0] = NaN;
        expect(() => prepareOffshoreJob(input)).toThrow('nonfinite');
    });
    it('keeps the interpolation edge outside the declared forecast domain unknown', () => {
        const fields = offshoreWindFields(job());
        expect(fields.wind.getWind(2, -30, 0)).not.toBeNull();
        expect(fields.wind.getWind(2.01, -30, 0)).toBeNull();
        expect(fields.wind.getWind(0, -27.99, 0)).toBeNull();
    });
    it('strips unknown data and functions, preserving missing wave cells as NaN', () => {
        const input = job();
        Object.assign(input, { licensedChart: { feature: 'private' } });
        Object.assign(input.wind, { chartCells: [1] });
        Object.assign(input.config, { shouldContinue: () => true });
        input.environment.waves = {
            referenceTimeIso: input.departureTime,
            totalHours: 1,
            samples: [{ lat: 0, lon: -30, heightM: [NaN], periodS: [NaN], directionFromDeg: [NaN] }],
        };
        const output = prepareOffshoreJob(input);
        expect(Object.keys(output)).not.toContain('licensedChart');
        expect(Object.keys(output.wind)).not.toContain('chartCells');
        expect(output.config).not.toHaveProperty('shouldContinue');
        expect(Number.isNaN(output.environment.waves!.samples[0].heightM[0])).toBe(true);
    });
    it('rejects invalid or oversized relief before creating any Worker', async () => {
        vi.stubGlobal('Worker', FakeWorker);
        const input = job();
        input.bathymetry.rows = 9_000_000;
        await expect(runOffshoreHosted(input)).rejects.toThrow('relief dimensions');
        expect(FakeWorker.instances).toHaveLength(0);
    });
    it('does not clamp an expired forecast into the future or invent wind in missing cells', () => {
        const input = job();
        input.departureTime = '2026-10-19T00:00:00Z';
        expect(offshoreWindFields(input).wind.getWind(0, -30, 0)).toBeNull();
        input.departureTime = input.wind.refTime!;
        input.wind.u[0].fill(NaN);
        expect(offshoreWindFields(input).wind.getWind(0, -30, 0)).toBeNull();
    });
    it('uses the actual shared kernel, preserves modeled propulsion and labels its result unverified', async () => {
        const result = await runOffshoreJob(job());
        expect(result?.verification).toBe('unverified-public-data');
        expect(result!.result.sailingStats?.motorHours).toBeGreaterThan(0);
        expect(result!.result.isochrones).toEqual([]);
        expect(result!.maxGustKts).toBeCloseTo(17.5, 0);
        expect(result!.result.comfort?.coverage).toBe('unavailable');
    });
    it('rejects actual gust cap exceedance even when the old estimated gust factor is lower', async () => {
        const input = job();
        input.wind.gust!.forEach((frame) => frame.fill(20));
        input.config.comfortParams = { maxGustKts: 30 };
        expect(await runOffshoreJob(input)).toBeNull();
    });
    it('never computes synchronously when Workers are unavailable', async () => {
        vi.stubGlobal('Worker', undefined);
        await expect(runOffshoreHosted(job())).rejects.toThrow('Worker unavailable');
    });
    it('handshakes, posts one isolated job and terminates after its matching result', async () => {
        vi.stubGlobal('Worker', FakeWorker);
        const promise = runOffshoreHosted(job());
        const worker = FakeWorker.instances[0];
        expect(worker.postMessage).not.toHaveBeenCalled();
        worker.emit({ type: 'ready' });
        const message = worker.postMessage.mock.calls[0][0];
        expect(message.type).toBe('offshore');
        worker.emit({ type: 'offshore', id: message.id + 1, candidate: candidate() });
        expect(worker.terminate).not.toHaveBeenCalled();
        worker.emit({ type: 'offshore', id: message.id, candidate: candidate() });
        expect(await promise).toMatchObject({ verification: 'unverified-public-data' });
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
    it('terminates a stale generation and rejects a late result', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('Worker', FakeWorker);
        let current = true;
        const promise = runOffshoreHosted(job(), { isCurrent: () => current });
        const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        current = false;
        await vi.advanceTimersByTimeAsync(100);
        await rejection;
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    });
    it('times out a Worker which never becomes ready', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('Worker', FakeWorker);
        const promise = runOffshoreHosted(job());
        const rejection = expect(promise).rejects.toThrow('did not start');
        await vi.advanceTimersByTimeAsync(10_000);
        await rejection;
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    });
});

describe('model liveness, bounded memo and non-navigable output', () => {
    const options = () => {
        const input = job();
        return {
            base: input,
            bounds: { north: 2, south: -2, west: -32, east: -28 },
            commercialEnabled: true,
            loadGrid: vi.fn(async () => input.wind),
            run: vi.fn(async () => candidate()),
        };
    };
    it('offers only four global domains and never assumes a paid tier makes a model available', async () => {
        const opts = options();
        opts.loadGrid.mockResolvedValue(null as never);
        expect(OFFSHORE_COMPARISON_MODELS.map((model) => model.domain)).toEqual([
            'ecmwf_ifs',
            'gfs_global',
            'dwd_icon',
            'gem_global',
        ]);
        const rows = await compareOffshoreModels(opts);
        expect(rows.every((row) => row.status === 'unavailable')).toBe(true);
        expect(opts.run).not.toHaveBeenCalled();
        expect(offshoreComparisonSummary(rows)).toBeNull();
    });
    it('uses two lanes, reuses grids for 30 minutes, and requires two results for spread', async () => {
        const opts = options();
        let running = 0,
            maxRunning = 0;
        opts.run.mockImplementation(async () => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await Promise.resolve();
            running--;
            return candidate();
        });
        const rows = await compareOffshoreModels(opts);
        expect(maxRunning).toBeLessThanOrEqual(2);
        expect(opts.loadGrid).toHaveBeenCalledTimes(4);
        expect(offshoreComparisonSummary(rows)).toMatchObject({ modelCount: 4, etaSpreadHours: 0 });
        expect(offshoreComparisonSummary(rows.slice(0, 1))).toBeNull();
        expect(offshoreComparisonLine(rows[0])?.properties).toMatchObject({
            verification: 'unverified-public-data',
            selectable: false,
        });
        await compareOffshoreModels(opts);
        expect(opts.loadGrid).toHaveBeenCalledTimes(4);
        clearOffshoreComparisonMemo();
        await compareOffshoreModels(opts);
        expect(opts.loadGrid).toHaveBeenCalledTimes(8);
    });
    it('does not overwrite anything when aborted and rejects nonfinite provider data', async () => {
        const opts = options();
        opts.base.wind.u.forEach((frame) => frame.fill(NaN));
        const rows = await compareOffshoreModels(opts);
        expect(rows.every((row) => row.status === 'unavailable')).toBe(true);
        expect(opts.run).not.toHaveBeenCalled();
        const onRow = vi.fn();
        const controller = new AbortController();
        controller.abort();
        await compareOffshoreModels({ ...options(), signal: controller.signal, onRow });
        expect(onRow).not.toHaveBeenCalled();
    });
    it('returns promptly when a forecast load becomes stale, leaving late network completion ignored', async () => {
        vi.useFakeTimers();
        const opts = options();
        opts.loadGrid.mockImplementation(() => new Promise(() => {}));
        let current = true;
        const onRow = vi.fn();
        const promise = compareOffshoreModels({ ...opts, isCurrent: () => current, onRow });
        expect(opts.loadGrid).toHaveBeenCalledTimes(2);
        current = false;
        await vi.advanceTimersByTimeAsync(100);
        expect((await promise).every((row) => row.status === 'unavailable')).toBe(true);
        expect(opts.run).not.toHaveBeenCalled();
        expect(onRow).toHaveBeenCalledTimes(2);
    });
    it('includes preparation time in the caller deadline instead of restarting the 60-second clock', async () => {
        vi.useFakeTimers();
        const opts = options();
        opts.loadGrid.mockImplementation(() => new Promise(() => {}));
        const promise = compareOffshoreModels({ ...opts, deadlineMs: Date.now() + 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await promise).every((row) => row.status === 'unavailable')).toBe(true);
        expect(opts.run).not.toHaveBeenCalled();
        expect(opts.loadGrid).toHaveBeenCalledTimes(2);
    });
    it('bounds all retained model grids together, including the grids kept for final verification', async () => {
        const opts = options();
        const frame = new Float32Array(1024 * 1024).fill(5);
        opts.loadGrid.mockResolvedValue({
            ...opts.base.wind,
            totalHours: 1,
            u: [frame],
            v: [frame],
            speed: [frame],
            gust: [frame],
        });
        const rows = await compareOffshoreModels(opts);
        expect(rows.filter((row) => row.status === 'candidate')).toHaveLength(2);
        expect(rows.filter((row) => row.message?.includes('memory limit'))).toHaveLength(2);
        expect(opts.run).toHaveBeenCalledTimes(2);
    });
    it('draws a dateline crossing on the adjacent world copy while preserving original verifier coordinates', () => {
        const value = candidate();
        value.result.routeCoordinates = [
            [179.9, -17],
            [-179.9, -17],
        ];
        const line = offshoreComparisonLine({
            model: OFFSHORE_COMPARISON_MODELS[0],
            status: 'candidate',
            candidate: value,
        });
        expect(line!.geometry.coordinates[1][0]).toBeCloseTo(180.1);
        expect(value.result.routeCoordinates[1][0]).toBe(-179.9);
        expect(line!.properties?.selectable).toBe(false);
    });
});
