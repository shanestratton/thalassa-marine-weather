import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
}));
vi.mock('../services/HazardQueryService', () => ({ queryChartLookahead: mocks.query }));
vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: { acquire: mocks.acquire, release: mocks.release, releaseEventually: vi.fn() },
}));
vi.mock('../services/AnchorSafetyNotificationService', () => ({
    AnchorSafetyNotificationService: { scheduleSafetyAlert: mocks.schedule, cancelSafetyAlert: mocks.cancel },
}));
import { runChartLookahead, stopChartLookahead, ChartLookaheadWatch } from '../services/underway/ChartLookaheadWatch';
import { UnderwayAlarmStore } from '../services/underway/underwayAlarmStore';
import type { UnderwayInputs } from '../services/underway/UnderwayAlarmWatch';
const at = Date.UTC(2026, 9, 16);
const input = (time = at, key = 'route'): UnderwayInputs =>
    ({
        nowMs: time,
        prefs: {
            offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
            shoal: { enabled: true },
            watchCheck: { enabled: false, intervalMin: 15 },
        },
        following: {
            key,
            route: [
                { lat: 30, lon: -150 },
                { lat: 31, lon: -150 },
            ],
        },
        fix: { lat: 30.2, lon: -150, at: time },
        sogKn: 6,
        cogDeg: 0,
        atAnchor: false,
        zone: null,
        depth: { boatFeed: false, depthM: null, reference: null, freshness: 'dead', readingAt: 0 },
        draftM: 2,
        draftAssumed: false,
        marginM: 0.5,
    }) as UnderwayInputs;
const hit = { kind: 'depth', etaMs: at + 30000, distanceNm: 0.05, chartDepthM: 1, tideM: 0 };
beforeEach(async () => {
    ChartLookaheadWatch.resetForTests();
    await ChartLookaheadWatch.whenIdle();
    UnderwayAlarmStore.clear();
    vi.clearAllMocks();
    mocks.acquire.mockResolvedValue('lookahead-lease');
    mocks.release.mockResolvedValue(undefined);
    mocks.schedule.mockResolvedValue(true);
    mocks.cancel.mockResolvedValue(true);
});
describe('chart-ahead alarms use complete current evidence', () => {
    it('raises a separate audio lease/native kind and acknowledges until a clear pass re-arms it', async () => {
        mocks.query.mockResolvedValue({ hit, coverage: 'charted' });
        await runChartLookahead(input());
        await ChartLookaheadWatch.whenIdle();
        expect(UnderwayAlarmStore.getCards()[0]?.kind).toBe('chart-ahead');
        expect(mocks.acquire).toHaveBeenCalledWith('chart-ahead-watch');
        expect(mocks.schedule.mock.calls[0][0]).toBe('chart-ahead');
        UnderwayAlarmStore.acknowledge('chart-ahead');
        await ChartLookaheadWatch.whenIdle();
        expect(UnderwayAlarmStore.getCards()).toEqual([]);
        expect(mocks.release).toHaveBeenCalledWith('lookahead-lease');
        await runChartLookahead(input(at + 5000));
        expect(UnderwayAlarmStore.getCards()).toEqual([]);
        mocks.query.mockResolvedValue({ hit: null, coverage: 'charted' });
        await runChartLookahead(input(at + 10000));
        mocks.query.mockResolvedValue({ hit, coverage: 'charted' });
        await runChartLookahead(input(at + 15000));
        expect(UnderwayAlarmStore.getCards()[0]?.kind).toBe('chart-ahead');
    });
    it('retains a sounding alarm through partial or failed chart coverage', async () => {
        mocks.query
            .mockResolvedValueOnce({ hit, coverage: 'charted' })
            .mockResolvedValueOnce({ hit: null, coverage: 'partial' })
            .mockRejectedValueOnce(new Error('offline'));
        await runChartLookahead(input());
        await runChartLookahead(input(at + 5000));
        await runChartLookahead(input(at + 10000));
        expect(UnderwayAlarmStore.getCards()[0]?.kind).toBe('chart-ahead');
        expect(UnderwayAlarmStore.getNotices().join(' ')).toContain('unavailable');
    });
    it('a delayed query cannot sound after the route is stopped', async () => {
        let resolve!: (value: unknown) => void;
        mocks.query.mockImplementation(() => new Promise((r) => (resolve = r)));
        const pending = runChartLookahead(input());
        stopChartLookahead();
        resolve({ hit, coverage: 'charted' });
        await pending;
        await ChartLookaheadWatch.whenIdle();
        expect(UnderwayAlarmStore.getCards()).toEqual([]);
        expect(mocks.acquire).not.toHaveBeenCalled();
    });
    it('loss of fresh position invalidates a query and never paints clear water', async () => {
        let resolve!: (value: unknown) => void;
        mocks.query.mockImplementation(() => new Promise((r) => (resolve = r)));
        const pending = runChartLookahead(input());
        await runChartLookahead({ ...input(at + 5000), fix: null });
        resolve({ hit, coverage: 'charted' });
        await pending;
        expect(UnderwayAlarmStore.getCards()).toEqual([]);
        expect(UnderwayAlarmStore.getNotices().join(' ')).toContain('no fresh');
    });
    it('runs once per five seconds and never overlaps reads', async () => {
        let resolve!: (value: unknown) => void;
        mocks.query.mockImplementation(() => new Promise((r) => (resolve = r)));
        const pending = runChartLookahead(input());
        await runChartLookahead(input(at + 10000));
        expect(mocks.query).toHaveBeenCalledTimes(1);
        resolve({ hit: null, coverage: 'charted' });
        await pending;
        await runChartLookahead(input(at + 1000));
        expect(mocks.query).toHaveBeenCalledTimes(1);
    });
    it.each(['draft', 'UKC', 'geometry'])(
        'invalidates an in-flight answer when %s changes under the same route key',
        async (change) => {
            let resolve!: (value: unknown) => void;
            mocks.query
                .mockImplementationOnce(
                    () =>
                        new Promise((done) => {
                            resolve = done;
                        }),
                )
                .mockResolvedValue({ hit: null, coverage: 'charted' });
            const current = input();
            const pending = runChartLookahead(current);
            const changed = { ...current, nowMs: at + 1000, fix: { ...current.fix!, at: at + 1000 } };
            if (change === 'draft') changed.draftM = 3;
            else if (change === 'UKC') changed.marginM = 1;
            else changed.following!.route[1].lon = -149; // Same key AND the same array, edited in place.
            await runChartLookahead(changed);
            expect(mocks.query).toHaveBeenCalledOnce(); // Old read stays bounded; no overlap.
            resolve({ hit, coverage: 'charted' });
            await pending;
            await ChartLookaheadWatch.whenIdle();
            expect(UnderwayAlarmStore.getCards()).toEqual([]);
            expect(mocks.acquire).not.toHaveBeenCalled();
            // A changed context is checked as soon as the old query finishes,
            // without waiting out the previous context's five-second cadence.
            await runChartLookahead({ ...changed, nowMs: at + 1001 });
            expect(mocks.query).toHaveBeenCalledTimes(2);
            expect(mocks.query.mock.calls[1].slice(1)).toEqual([changed.draftM, changed.marginM]);
        },
    );
    it('a clearance change requires a fresh acknowledgement even if the route key is unchanged', async () => {
        mocks.query.mockResolvedValue({ hit, coverage: 'charted' });
        await runChartLookahead(input());
        UnderwayAlarmStore.acknowledge('chart-ahead');
        expect(UnderwayAlarmStore.getCards()).toEqual([]);
        await runChartLookahead({ ...input(at + 1000), marginM: 1 });
        expect(UnderwayAlarmStore.getCards()[0]?.kind).toBe('chart-ahead');
    });
});
