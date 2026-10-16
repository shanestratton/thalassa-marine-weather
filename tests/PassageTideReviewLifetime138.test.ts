import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    chart: vi.fn(),
    sources: vi.fn(),
    version: 1,
    epoch: 0,
    settings: { activeVesselId: 'boat-a', settings: { vessel: { draft: 2 }, satelliteMode: false } },
    wind: { grid: {}, field: null, model: 'model', localGribPath: null, isGlobalMode: false },
    chartListeners: new Set<() => void>(),
    settingsListeners: new Set<() => void>(),
    sourceListeners: new Set<() => void>(),
    windListeners: new Set<() => void>(),
}));
vi.mock('../services/enc/readPassageTideContext', () => ({
    readPassageTideContext: mocks.chart,
    unavailablePassageTideContext: (note: string) => ({
        ...chart(),
        contentKey: null,
        completeInventory: false,
        pointDepthM: null,
        notes: [note],
    }),
}));
vi.mock('../services/tides/passageTideSources', () => ({ loadPassageTideSources: mocks.sources }));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => mocks.version,
    subscribe: (fn: () => void) => {
        mocks.chartListeners.add(fn);
        return () => mocks.chartListeners.delete(fn);
    },
}));
vi.mock('../services/tides/offlineTideStore', () => ({
    savedTideTablesEpoch: () => mocks.epoch,
    subscribeSavedTideTables: (fn: () => void) => {
        mocks.sourceListeners.add(fn);
        return () => mocks.sourceListeners.delete(fn);
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => mocks.settings,
        subscribe: (fn: () => void) => {
            mocks.settingsListeners.add(fn);
            return () => mocks.settingsListeners.delete(fn);
        },
    },
}));
vi.mock('../stores/WindStore', () => ({
    WindStore: {
        getState: () => mocks.wind,
        subscribe: (fn: () => void) => {
            mocks.windListeners.add(fn);
            return () => mocks.windListeners.delete(fn);
        },
    },
}));
import { loadPassageTideReview } from '../services/routing/passageTideReview';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const input = () => ({
    points: [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.1 },
    ],
    pointIndex: 1,
    identity: 'exact-route-timing',
    departureMs: Date.now() + 60000,
    speedKts: 6,
    mode: 'aboard' as const,
});
const chart = () => ({
    chartVersion: 1,
    contentKey: 'PRIVATE-CELL@1',
    completeInventory: true,
    aboardOnly: true,
    soundingDatum: 'LAT',
    soundingDatumEpoch: null,
    pointDepthM: 3,
    holdingText: 'Nearby chart sample as sand: check actual holding.',
    holdingPointSample: true,
    bridges: [],
    notes: [],
});
describe('actual passage review lifetime coordinator', () => {
    it('keeps source information usable when a malformed chart must be withheld', async () => {
        mocks.chart.mockRejectedValueOnce(new Error('Malformed chart geometry.'));
        const session = await loadPassageTideReview(input(), {
            signal: new AbortController().signal,
            isCurrent: () => true,
            onRetire: () => {},
        });
        expect(session.report.chart.completeInventory).toBe(false);
        expect(session.report.chart.notes).toContain('Malformed chart geometry.');
        expect(mocks.sources).toHaveBeenCalled();
        session.dispose();
    });
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('review-owner');
        mocks.settings.activeVesselId = 'boat-a';
        mocks.version = 1;
        mocks.epoch = 0;
        mocks.chartListeners.clear();
        mocks.sourceListeners.clear();
        mocks.settingsListeners.clear();
        mocks.windListeners.clear();
        mocks.chart.mockResolvedValue(chart());
        mocks.sources.mockResolvedValue({ stations: [], notes: [], navigationSeries: [] });
    });
    it('computes exact constant-speed ETA, keeps true missing evidence unknown, and releases listeners on close', async () => {
        const request = input(),
            retired = vi.fn();
        const session = await loadPassageTideReview(request, {
            signal: new AbortController().signal,
            isCurrent: () => true,
            onRetire: retired,
        });
        expect(session.report.atMs - request.departureMs).toBeGreaterThan(3600000);
        const wait = await session.reviewWait(0, 30, 100, {
            draftM: 2,
            ukcM: 0.5,
            maxWindKts: 15,
            maxGustKts: 20,
            maxWaveM: 1,
        });
        expect(wait).toMatchObject({ kind: 'unavailable' });
        expect(wait.kind === 'unavailable' && wait.reason).toContain('station-to-cell datum/epoch tie');
        expect(
            await session.acceptWait(
                { kind: 'proposed-wait' },
                { points: request.points, editEpoch: 1, beforeIndex: 1, holdingIndex: 0, isCurrent: () => true },
            ),
        ).toBeNull();
        expect(session.isCurrent()).toBe(true);
        session.dispose();
        expect(session.isCurrent()).toBe(false);
        expect(retired).toHaveBeenCalledTimes(1);
        expect(
            mocks.chartListeners.size +
                mocks.settingsListeners.size +
                mocks.sourceListeners.size +
                mocks.windListeners.size,
        ).toBe(0);
    });
    it.each(['boat', 'chart', 'saved-source', 'weather', 'owner'] as const)(
        'retires immediately on %s transition, including A/B/A',
        async (kind) => {
            const session = await loadPassageTideReview(input(), {
                signal: new AbortController().signal,
                isCurrent: () => true,
                onRetire: () => {},
            });
            if (kind === 'boat') {
                mocks.settings.activeVesselId = 'boat-b';
                mocks.settingsListeners.forEach((fn) => fn());
                mocks.settings.activeVesselId = 'boat-a';
            }
            if (kind === 'chart') {
                mocks.version++;
                mocks.chartListeners.forEach((fn) => fn());
            }
            if (kind === 'saved-source') {
                mocks.epoch++;
                mocks.sourceListeners.forEach((fn) => fn());
            }
            if (kind === 'weather') {
                mocks.wind.grid = {};
                mocks.windListeners.forEach((fn) => fn());
            }
            if (kind === 'owner') {
                setAuthIdentityScope('other');
                setAuthIdentityScope('review-owner');
            }
            expect(session.isCurrent()).toBe(false);
        },
    );
    it('does not publish a late private chart/source result after route close', async () => {
        let resolve!: (v: unknown) => void;
        mocks.sources.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const controller = new AbortController();
        const pending = loadPassageTideReview(input(), {
            signal: controller.signal,
            isCurrent: () => true,
            onRetire: () => {},
        });
        const refused = expect(pending).rejects.toThrow('stopped');
        await vi.waitFor(() => expect(mocks.sources).toHaveBeenCalled());
        controller.abort();
        resolve({ stations: [], notes: ['PRIVATE-LATE'], navigationSeries: [] });
        await refused;
        expect(mocks.chartListeners.size).toBe(0);
    });
    it('bounds a hung source read to30 seconds and retires loaded reports at five minutes', async () => {
        vi.useFakeTimers();
        try {
            mocks.sources.mockReturnValue(new Promise(() => {}));
            const pending = loadPassageTideReview(input(), {
                signal: new AbortController().signal,
                isCurrent: () => true,
                onRetire: () => {},
            });
            const refused = expect(pending).rejects.toThrow('30 seconds');
            await vi.advanceTimersByTimeAsync(30001);
            await refused;
            mocks.sources.mockResolvedValue({ stations: [], notes: [], navigationSeries: [] });
            const session = await loadPassageTideReview(input(), {
                signal: new AbortController().signal,
                isCurrent: () => true,
                onRetire: () => {},
            });
            await vi.advanceTimersByTimeAsync(300001);
            expect(session.isCurrent()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
