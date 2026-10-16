/** Fictional issued-source dependency; actual strict worker/grid and final
 * orchestration run here. Actual acquisition/rights and Pi receipts have their
 * own non-activated contract tests. No live source permission is asserted. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { TideGatedSourcePermit } from '../services/routing/tideGatedSources';
import type { RouteJob, RouteJobOutput } from '../services/routing/routeJob';
const h = vi.hoisted(() => ({
    prepare: vi.fn(),
    sourceCurrent: true,
    contextCurrent: true,
    sourceRelease: vi.fn(),
    contextRelease: vi.fn(),
    recheck: vi.fn(),
    readContext: vi.fn(),
    host: vi.fn(),
    output: null as RouteJobOutput | null,
}));
vi.mock('../services/routing/tideGatedSources', () => ({
    prepareTideGatedSources: h.prepare,
    checkTideGatedSourcePermit: () => h.sourceCurrent,
    recheckTideGatedSourcePermit: h.recheck,
}));
vi.mock('../services/routing/routingExclusions', () => ({ readCurrentRoutingExclusions: h.readContext }));
vi.mock('../services/routing/routeWorkerHost', () => ({ runRouteJobHosted: h.host }));
import {
    planTideGatedShortcut,
    finalizeTideShortcutPreview,
    retireTideShortcutPreview,
} from '../services/routing/tideGatedPlanning';
import { runRouteJob } from '../services/routing/routeJob';
import { tideGatedBounds } from '../services/engine/tideGatedSearch';
const T = Date.parse('2026-10-17T01:00:23.456Z');
const input = () => ({
    from: { lat: 0, lon: -0.0015 },
    to: { lat: 0, lon: 0.0015 },
    draftM: 2,
    safetyM: 0.5,
    airDraftM: null,
    requiredM: 2.5,
    speedKts: 6,
    departureMs: T,
    uncertaintyMs: 60000,
    lifetimeKey: 'fictional-request',
});
const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
const rect = (w: number, s: number, e: number, n: number, properties = {}): Feature<Polygon> => ({
    type: 'Feature',
    properties: { acronym: 'DEPARE', ...properties },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
function permit(): TideGatedSourcePermit {
    const r = input();
    return {
        request: {
            enabled: true,
            ...r,
            expiresAtMs: T + 300000,
            maxJourneyMs: 900000,
            areas: [
                {
                    id: 'fictional-bank',
                    geometry: rect(-0.001, -0.002, 0.001, 0.002).geometry,
                    coverage: [-0.01, -0.01, 0.01, 0.01],
                    station: { lat: 0, lon: 0 },
                    maxDistanceKm: 15,
                    chartedDepthM: 1,
                    windows: [{ fromMs: T - 3600000, untilMs: T + 3600000, minLowM: 2 }],
                },
            ],
        },
        bounds: tideGatedBounds(r.from, r.to)!,
        layers: {
            DEPARE: fc(
                rect(-0.2, -0.2, -0.00035, 0.2, { DRVAL1: 5, DRVAL2: 10 }),
                rect(0.00035, -0.2, 0.2, 0.2, { DRVAL1: 5, DRVAL2: 10 }),
                rect(-0.00035, 0.0009, 0.00035, 0.2, { DRVAL1: 5, DRVAL2: 10 }),
                rect(-0.00035, -0.2, 0.00035, -0.0009, { DRVAL1: 5, DRVAL2: 10 }),
                rect(-0.00035, -0.0009, 0.00035, 0.0009, { DRVAL1: 1, DRVAL2: 2 }),
            ),
        },
        chartContentKey: 'FICTIONAL@1',
        aboardOnly: true,
        sourceSummary: 'Entirely fictional reviewed source',
    };
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(T + 1000);
    h.sourceCurrent = true;
    h.contextCurrent = true;
    h.prepare.mockReset();
    h.recheck.mockReset();
    h.readContext.mockReset();
    h.host.mockReset();
    h.sourceRelease.mockReset();
    h.contextRelease.mockReset();
    h.prepare.mockImplementation(async () => ({ kind: 'ready', permit: permit(), release: h.sourceRelease }));
    h.recheck.mockResolvedValue(true);
    h.readContext.mockImplementation(async () => ({
        manual: undefined,
        marineParks: undefined,
        advisories: [],
        isCurrent: () => h.contextCurrent,
        release: h.contextRelease,
    }));
    h.host.mockImplementation(async (job: RouteJob) => {
        h.output = runRouteJob(job);
        return { output: h.output, where: 'main', waitMs: 0, handoffMs: 0, backMs: 0 };
    });
});
afterEach(() => {
    retireTideShortcutPreview();
    vi.restoreAllMocks();
});
describe('current source + actual worker + private preview lifetime', () => {
    it('uses the real shared context, then privately rereads an exact amber worker candidate', async () => {
        const r = await planTideGatedShortcut(input(), options());
        expect(r.kind).toBe('preview');
        if (r.kind !== 'preview') return;
        expect(h.readContext).toHaveBeenCalledWith({
            bbox: tideGatedBounds(input().from, input().to),
            signal: expect.any(AbortSignal),
        });
        expect(r.result.tideShortcut?.kind).toBe('preview');
        expect(r.result._tideCandidatePath).toBeUndefined();
        expect(h.sourceRelease).not.toHaveBeenCalled();
        expect(h.contextRelease).not.toHaveBeenCalled();
        expect(await finalizeTideShortcutPreview(r.result)).toBe(true);
        expect(await finalizeTideShortcutPreview({ ...r.result })).toBe(false);
        expect(await finalizeTideShortcutPreview(JSON.parse(JSON.stringify(r.result)))).toBe(false);
        retireTideShortcutPreview(r.result);
        expect(h.sourceRelease).toHaveBeenCalledOnce();
        expect(h.contextRelease).toHaveBeenCalledOnce();
    });
    it('does not call a worker or read private polygons for a source held without rights', async () => {
        h.prepare.mockResolvedValueOnce({
            kind: 'held',
            reason: 'Original rights/datum proof missing.',
            release: h.sourceRelease,
        });
        expect((await planTideGatedShortcut(input(), options())).kind).toBe('held');
        expect(h.readContext).not.toHaveBeenCalled();
        expect(h.host).not.toHaveBeenCalled();
    });
    it('a corrupt hard policy is a refusal, never an empty substitute', async () => {
        h.readContext.mockRejectedValueOnce(new Error('The enabled private no-go file is corrupt.'));
        await expect(planTideGatedShortcut(input(), options())).rejects.toThrow(/no-go file is corrupt/);
        expect(h.host).not.toHaveBeenCalled();
        expect(h.sourceRelease).toHaveBeenCalledOnce();
    });
    it.each(['source', 'policy'])('holds a late %s transition after worker completion', async (kind) => {
        h.host.mockImplementationOnce(async (job: RouteJob) => {
            const output = runRouteJob(job);
            if (kind === 'source') h.sourceCurrent = false;
            else h.contextCurrent = false;
            return { output, where: 'main', waitMs: 0, handoffMs: 0, backMs: 0 };
        });
        await expect(planTideGatedShortcut(input(), options())).rejects.toThrow(/retired/);
        expect(h.sourceRelease).toHaveBeenCalledOnce();
        expect(h.contextRelease).toHaveBeenCalledOnce();
    });
    it('a current manual polygon cannot be bypassed by the separate tide reader path', async () => {
        h.readContext.mockResolvedValueOnce({
            manual: fc(rect(-0.0005, -0.005, 0.0005, 0.005)),
            advisories: [],
            isCurrent: () => true,
            release: h.contextRelease,
        });
        expect((await planTideGatedShortcut(input(), options())).kind).toBe('held');
        expect(h.sourceRelease).toHaveBeenCalledOnce();
        expect(h.contextRelease).toHaveBeenCalledOnce();
    });
    it.each(['flow', 'opposing', 'unknown'] as const)(
        'carries original %s traffic-lane context through the actual worker and final private audit',
        async (kind) => {
            const source = permit();
            source.layers.TSSLPT = fc(
                rect(-0.01, -0.01, 0.01, 0.01, {
                    acronym: 'TSSLPT',
                    ...(kind === 'unknown' ? {} : { ORIENT: kind === 'flow' ? 90 : 270 }),
                }),
            );
            h.prepare.mockResolvedValueOnce({ kind: 'ready', permit: source, release: h.sourceRelease });
            const result = await planTideGatedShortcut(input(), options());
            expect(result.kind).toBe(kind === 'opposing' ? 'held' : 'preview');
            if (result.kind !== 'preview') return;
            expect(result.result.trafficLaneGuidance).toBe(kind === 'flow' ? 'charted-flow' : 'orientation-unknown');
            expect(await finalizeTideShortcutPreview(result.result)).toBe(true);
            expect(
                result.result.tideShortcut?.kind === 'preview' && result.result.tideShortcut.sourceSummary,
            ).toContain(kind === 'flow' ? 'no right-of-way' : 'unknown or conflicting orientation');
        },
    );
    it('retains actual current area-source caveats in the temporary preview disclosure', async () => {
        h.readContext.mockResolvedValueOnce({
            manual: undefined,
            marineParks: undefined,
            advisories: [
                'No verified marine park dataset is retained; marine park caution is unavailable.',
                'Injected chart coordinates 153.5 -27.5 must never become persisted caveats.',
            ],
            isCurrent: () => true,
            release: h.contextRelease,
        });
        const result = await planTideGatedShortcut(input(), options());
        expect(result.kind).toBe('preview');
        if (result.kind !== 'preview') return;
        expect(result.result.routeAreaCaveats).toEqual([
            'No verified marine park dataset is retained; marine park caution is unavailable.',
        ]);
        expect(result.result.tideShortcut?.kind === 'preview' && result.result.tideShortcut.sourceSummary).toContain(
            'No verified marine park dataset is retained; marine park caution is unavailable.',
        );
        expect(JSON.stringify(result.result)).not.toContain('Injected chart coordinates');
    });
    it('does not publish geometry mutated while the original source reread awaited', async () => {
        h.recheck.mockImplementationOnce(async () => {
            if (h.output?.result && 'polyline' in h.output.result) h.output.result.polyline[1][0] += 0.00001;
            return true;
        });
        expect((await planTideGatedShortcut(input(), options())).kind).toBe('held');
        expect(h.sourceRelease).toHaveBeenCalledOnce();
    });
    it.each(['geometry', 'distance', 'view', 'expiry'])(
        'a %s change cannot survive final display acceptance',
        async (kind) => {
            const r = await planTideGatedShortcut(input(), options());
            expect(r.kind).toBe('preview');
            if (r.kind !== 'preview') return;
            if (kind === 'geometry') r.result.polyline[1][0] += 0.00001;
            if (kind === 'distance') r.result.distanceNM += 0.1;
            if (kind === 'view') r.result.tideShortcut = { ...r.result.tideShortcut! };
            if (kind === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(T + 300000);
            expect(await finalizeTideShortcutPreview(r.result)).toBe(false);
            expect(h.sourceRelease).toHaveBeenCalledOnce();
        },
    );
    it('a clock change during final acceptance retires the private preview', async () => {
        const r = await planTideGatedShortcut(input(), options());
        expect(r.kind).toBe('preview');
        if (r.kind !== 'preview') return;
        h.recheck.mockImplementationOnce(async () => {
            r.result.distanceNM += 0.01;
            return true;
        });
        expect(await finalizeTideShortcutPreview(r.result)).toBe(false);
        expect(h.sourceRelease).toHaveBeenCalledOnce();
    });
    it('keeps the real context lease until an outstanding stopped worker actually settles', async () => {
        let settle!: (value: unknown) => void;
        h.host.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    settle = resolve;
                }),
        );
        const controller = new AbortController(),
            pending = planTideGatedShortcut(input(), { ...options(), signal: controller.signal });
        await vi.waitFor(() => expect(h.host).toHaveBeenCalledOnce());
        controller.abort();
        expect(h.contextRelease).not.toHaveBeenCalled();
        settle({ output: { result: null, timings: {} }, where: 'main', waitMs: 0, handoffMs: 0, backMs: 0 });
        await expect(pending).rejects.toThrow();
        expect(h.contextRelease).toHaveBeenCalledOnce();
        expect(h.sourceRelease).toHaveBeenCalledOnce();
    });
});
