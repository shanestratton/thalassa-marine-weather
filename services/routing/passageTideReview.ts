/** One explicit bounded, in-memory review. Current source adapters provide
 * information, never independent navigation rights or missing datum ties. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { getVersion, subscribe as subscribeCharts } from '../enc/EncCellMetadata';
import {
    readPassageTideContext,
    unavailablePassageTideContext,
    type PassageTideChartContext,
} from '../enc/readPassageTideContext';
import { savedTideTablesEpoch, subscribeSavedTideTables } from '../tides/offlineTideStore';
import {
    loadPassageTideSources,
    type PassageStationPrediction,
    type PassageTideSourceMode,
} from '../tides/passageTideSources';
import { prepareAlongRoute } from './alongRoutePlaces';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindStore } from '../../stores/WindStore';
import { haversineNm } from '../isochrone/geodesy';
import { reviewWaterInterval } from '../tides/reviewedWaterInterval';
import {
    reviewTideWait,
    type TideWaitAssessment,
    type TideWaitRequest,
    type HoldingLimits,
    type CompleteHoldingReader,
} from './tideWaitReview';
import { preparePointOnlyWaitIntent, type PointOnlyWaitIntent } from './passageTideWaitAcceptance';
import type { TraceRoutePoint } from './traceRoutePoint';

export interface PassageTideReviewInput {
    points: readonly { lat: number; lon: number }[];
    pointIndex: number;
    identity: string;
    departureMs: number;
    speedKts: number;
    mode: PassageTideSourceMode;
}
export interface PassageTideReviewReport {
    identity: string;
    pointIndex: number;
    point: { lat: number; lon: number };
    atMs: number;
    loadedAtMs: number;
    expiresAtMs: number;
    mode: PassageTideSourceMode;
    chart: PassageTideChartContext;
    stations: PassageStationPrediction[];
    notes: string[];
}
export interface PassageTideReviewSession {
    report: PassageTideReviewReport;
    isCurrent: () => boolean;
    dispose: () => void;
    reviewWait: (
        holdingIndex: number,
        minutes: number,
        radiusM: number,
        limits: HoldingLimits,
    ) => Promise<TideWaitAssessment>;
    acceptWait: (
        draft: unknown,
        target: {
            points: TraceRoutePoint[];
            editEpoch: number;
            beforeIndex: number;
            holdingIndex: number;
            isCurrent: () => boolean;
        },
    ) => Promise<PointOnlyWaitIntent | null>;
}
const policy = () => {
    const s = useSettingsStore.getState();
    return JSON.stringify([s.activeVesselId, s.settings.vessel, s.settings.satelliteMode]);
};
let reviewGeneration = 0;
export async function loadPassageTideReview(
    input: PassageTideReviewInput,
    options: { signal: AbortSignal; isCurrent: () => boolean; onRetire: () => void },
): Promise<PassageTideReviewSession> {
    const scope = getAuthIdentityScope(),
        chartVersion = getVersion(),
        sourceEpoch = savedTideTablesEpoch(),
        settingsKey = policy(),
        wind = { ...WindStore.getState() },
        controller = new AbortController(),
        points = input.points.map((p) => ({ lat: p.lat, lon: p.lon })),
        loadedAtMs = Date.now();
    const lifetimeKey = `${scope.key}/${scope.generation}/passage-tide/${++reviewGeneration}`;
    let retired = false,
        expiresAtMs = loadedAtMs + 30000;
    const off: (() => void)[] = [];
    const dispose = () => {
        if (retired) return;
        retired = true;
        controller.abort();
        clearTimeout(timer);
        off.splice(0).forEach((fn) => fn());
        options.signal.removeEventListener('abort', dispose);
        options.onRetire();
    };
    const current = () =>
        !retired &&
        !controller.signal.aborted &&
        !options.signal.aborted &&
        Date.now() >= loadedAtMs &&
        Date.now() < expiresAtMs &&
        isAuthIdentityScopeCurrent(scope) &&
        getVersion() === chartVersion &&
        savedTideTablesEpoch() === sourceEpoch &&
        policy() === settingsKey &&
        options.isCurrent() &&
        WindStore.getState().grid === wind.grid &&
        WindStore.getState().field === wind.field &&
        WindStore.getState().model === wind.model &&
        WindStore.getState().isGlobalMode === wind.isGlobalMode &&
        WindStore.getState().localGribPath === wind.localGribPath;
    const guard = () => {
        if (!current()) throw new DOMException('Tide review changed or expired; load again.', 'AbortError');
    };
    const chartAt = async (point: { lat: number; lon: number }, route: ReturnType<typeof prepareAlongRoute>) => {
        try {
            return await readPassageTideContext(point, route, guard);
        } catch (error) {
            guard();
            return unavailablePassageTideContext(
                error instanceof Error ? error.message : 'Local chart review unavailable.',
                chartVersion,
            );
        }
    };
    const changed = () => {
        if (!current()) dispose();
    };
    let timer = setTimeout(dispose, 30000);
    off.push(
        subscribeAuthIdentityScope(dispose),
        subscribeCharts(changed),
        subscribeSavedTideTables(dispose),
        useSettingsStore.subscribe(changed),
        WindStore.subscribe(changed),
    );
    options.signal.addEventListener('abort', dispose, { once: true });
    let stoppedListener: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        stoppedListener = () => reject(new DOMException('Tide review stopped or exceeded 30 seconds.', 'AbortError'));
        controller.signal.addEventListener('abort', stoppedListener, { once: true });
    });
    const work = async (): Promise<PassageTideReviewSession> => {
        guard();
        const route = prepareAlongRoute(points);
        if (
            !Number.isSafeInteger(input.pointIndex) ||
            input.pointIndex < 0 ||
            input.pointIndex >= points.length ||
            !Number.isFinite(input.speedKts) ||
            input.speedKts <= 0 ||
            input.speedKts > 100 ||
            !Number.isFinite(input.departureMs) ||
            !['aboard', 'official', 'nearby'].includes(input.mode)
        )
            throw Error('Choose a route point, departure and planned speed between 0 and 100 knots.');
        const point = points[input.pointIndex];
        let alongNm = 0;
        for (let i = 1; i <= input.pointIndex; i++)
            alongNm += haversineNm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
        const atMs = input.departureMs + (alongNm / input.speedKts) * 3600000;
        const chart = await chartAt(point, route);
        guard();
        const sources = await loadPassageTideSources(point, atMs, input.mode, {
            signal: controller.signal,
            assertCurrent: guard,
        });
        guard();
        expiresAtMs = Math.min(
            Date.now() + 300000,
            ...sources.stations.map((s) =>
                s.kind === 'sampled-prediction' && s.receivedAtMs !== null ? s.receivedAtMs + 6 * 3600000 : Infinity,
            ),
        );
        clearTimeout(timer);
        timer = setTimeout(dispose, Math.max(0, expiresAtMs - Date.now()));
        const report: PassageTideReviewReport = Object.freeze({
            identity: input.identity,
            pointIndex: input.pointIndex,
            point,
            atMs,
            loadedAtMs,
            expiresAtMs,
            mode: input.mode,
            chart,
            stations: sources.stations,
            notes: sources.notes,
        });
        const waits = new WeakMap<
            object,
            { request: TideWaitRequest; limits: HoldingLimits; water: unknown; holdingIndex: number }
        >();
        // Actual complete circle/approach and interval exposure evidence does
        // not exist in the point reader. Never promote its advisory fields.
        const holdingReader: CompleteHoldingReader = async () => null;
        return {
            report,
            isCurrent: current,
            dispose,
            reviewWait: async (holdingIndex, minutes, radiusM, limits) => {
                guard();
                if (
                    !Number.isSafeInteger(holdingIndex) ||
                    holdingIndex < 0 ||
                    holdingIndex >= input.pointIndex ||
                    !Number.isFinite(minutes) ||
                    minutes < 1 ||
                    minutes > 1440 ||
                    !Number.isFinite(radiusM) ||
                    radiusM < 10 ||
                    radiusM > 500
                )
                    return {
                        kind: 'unavailable',
                        reason: 'Choose an earlier route point, a 1–1440 minute wait and a 10–500 m holding radius.',
                    };
                const holding = points[holdingIndex],
                    holdingChart = await chartAt(holding, route);
                guard();
                let holdingAlongNm = 0;
                for (let i = 1; i <= holdingIndex; i++)
                    holdingAlongNm += haversineNm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
                const fromMs = input.departureMs + (holdingAlongNm / input.speedKts) * 3600000;
                const context = {
                    lifetimeKey,
                    lat: holding.lat,
                    lon: holding.lon,
                    fromMs,
                    untilMs: fromMs + minutes * 60000,
                    nowMs: Date.now(),
                    chartContentKey: holdingChart.contentKey ?? '',
                    targetDatumId: holdingChart.soundingDatum ?? '',
                    targetDatumEpoch: holdingChart.soundingDatumEpoch ?? '',
                    use: 'holding' as const,
                    protectedChart: holdingChart.aboardOnly,
                };
                // Existing official/saved inputs are events; WorldTides has no
                // navigation permission. No current adapter supplies a bound
                // reviewed original sample product or station-to-cell epoch tie.
                const water = await reviewWaterInterval(sources.navigationSeries, context, {
                    signal: controller.signal,
                    assertCurrent: guard,
                });
                guard();
                const request = {
                    ...context,
                    boatId: useSettingsStore.getState().activeVesselId ?? '',
                    routeIdentity: route.identity,
                    holdingAlongNm,
                    gateAlongNm: alongNm,
                    radiusM,
                };
                const review = await reviewTideWait(
                    request,
                    limits,
                    water,
                    { signal: controller.signal, assertCurrent: guard },
                    holdingReader,
                );
                guard();
                if (review.kind === 'proposed-wait')
                    waits.set(review, { request, limits: { ...limits }, water, holdingIndex });
                return review.kind === 'unavailable'
                    ? {
                          kind: 'unavailable',
                          reason: [
                              'Checked wait unavailable: no navigation-qualified original tide interval and station-to-cell datum/epoch tie.',
                              holdingChart.holdingText,
                              'Complete circle/approach depth, anchoring permission and full-interval weather/exposure are not proved by these chart samples.',
                              'The route and its existing checks have not changed.',
                          ].join(' '),
                      }
                    : review;
            },
            acceptWait: async (draft, target) => {
                guard();
                if (!draft || typeof draft !== 'object') return null;
                const checked = waits.get(draft);
                if (
                    !checked ||
                    target.holdingIndex !== checked.holdingIndex ||
                    target.beforeIndex !== input.pointIndex ||
                    target.points.length !== points.length ||
                    target.points.some((p, i) => p.lat !== points[i].lat || p.lon !== points[i].lon)
                )
                    return null;
                return preparePointOnlyWaitIntent(
                    draft,
                    { ...checked.request, nowMs: Date.now() },
                    checked.limits,
                    checked.water,
                    { signal: controller.signal, assertCurrent: guard },
                    holdingReader,
                    target,
                );
            },
        };
    };
    try {
        return await Promise.race([work(), stopped]);
    } catch (error) {
        dispose();
        throw error;
    } finally {
        if (stoppedListener) controller.signal.removeEventListener('abort', stoppedListener);
    }
}
