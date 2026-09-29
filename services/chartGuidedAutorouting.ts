/** At most one documented MustGo recalculation, never local post-snapping.
 * Caller must pass the advertised capability explicitly. No route stores,
 * chart registrations, canvas changes, navigation activation or publication. */
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../types/autorouting';
import { calculateAutoroutingTrial } from './autoroutingTrial';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import { getCell } from './enc/EncCellMetadata';
import { loadCellGeoJSON } from './enc/EncCellStore';
import type { EncCell, EncConversionResult } from './enc/types';
import {
    createNewportChannelTrackCandidate,
    selectChannelTrackGuidance,
    validateChannelTrackGuidanceResponse,
    NEWPORT_CHANNEL_TRACK_CHART,
    type ReviewedChannelTrackPolicy,
} from './channelTrackGuidance';
import { NEWPORT_CHANNEL_TRACK_POLICY } from './newportChannelTrackPolicy';

export const CHART_GUIDANCE_LOAD_TIMEOUT_MS = 10_000;
export const CHART_GUIDANCE_PROVIDER_TIMEOUT_MS = 45_000;
export const CHART_GUIDANCE_TOTAL_TIMEOUT_MS = 75_000;
export const CHART_GUIDANCE_ENDPOINT_TOLERANCE_M = 2;
const UNAVAILABLE =
    'Channel-track guidance unavailable: the original proposal is unchanged. Review charted tracks independently.';
const REJECTED =
    'Channel-track guidance was not verified: the original proposal is unchanged. No guided route was substituted.';
const APPLIED =
    'Reviewed Newport chart-track constraints applied and geometrically checked. This is still an unsaved trial, not navigation clearance; review all chart and provider warnings.';
const CANCELLED = 'The trial request was cancelled or the account changed.';
const TIMEOUT = 'The trial request timed out. Please try again.';
type Progress = (message: string) => void;

export interface ChartGuidedTrialDependencies {
    calculate: typeof calculateAutoroutingTrial;
    getCell: (id: string) => EncCell | null;
    loadCell: (id: string, remoteFallback?: boolean) => Promise<EncConversionResult | null>;
    policy: ReviewedChannelTrackPolicy;
    now: () => number;
}
export interface ChartGuidedTrialOptions {
    /** Unknown/false behaves exactly like the ordinary provider calculation. */
    channelGuidance?: boolean;
    onProgress?: Progress;
    /** Optional caller-owned deadline, e.g. reserve time inside the canal's
     * overall budget. It may shorten, never extend, this wrapper's 75s bound. */
    deadlineAtMs?: number;
    dependencies?: Partial<ChartGuidedTrialDependencies>;
}
const defaults: ChartGuidedTrialDependencies = {
    calculate: calculateAutoroutingTrial,
    getCell,
    loadCell: loadCellGeoJSON,
    policy: NEWPORT_CHANNEL_TRACK_POLICY,
    now: Date.now,
};
const abortError = () => new DOMException(CANCELLED, 'AbortError');
const clone = (route: AutoroutingTrialRoute): AutoroutingTrialRoute => ({
    ...route,
    coordinates: route.coordinates.map(([lon, lat]) => [lon, lat]),
    warnings: [...route.warnings],
    ...(route.source ? { source: { ...route.source } } : {}),
    ...(route.canalDeparture ? { canalDeparture: { ...route.canalDeparture } } : {}),
    ...(route.vesselProfile ? { vesselProfile: structuredClone(route.vesselProfile) } : {}),
    ...(route.providerCheck
        ? {
              providerCheck: structuredClone(route.providerCheck),
          }
        : {}),
});
const withNotice = (route: AutoroutingTrialRoute, notice: string): AutoroutingTrialRoute => {
    const result = clone(route);
    if (!result.warnings.includes(notice)) result.warnings.push(notice);
    return result;
};
const metadataKey = (cell: EncCell | null): string => JSON.stringify(cell);
const distanceM = (a: readonly number[], b: readonly number[]) =>
    Math.hypot((a[0] - b[0]) * 111_320 * Math.cos(((a[1] + b[1]) * Math.PI) / 360), (a[1] - b[1]) * 110_540);
const endpointsMatch = (
    route: AutoroutingTrialRoute,
    request: AutoroutingTrialRequest,
    initial: AutoroutingTrialRoute,
) =>
    [
        [route.coordinates[0], [request.departure.lon, request.departure.lat]],
        [route.coordinates.at(-1)!, [request.destination.lon, request.destination.lat]],
        [route.coordinates[0], initial.coordinates[0]],
        [route.coordinates.at(-1)!, initial.coordinates.at(-1)!],
    ].every(([a, b]) => a && b && distanceM(a, b) <= CHART_GUIDANCE_ENDPOINT_TOLERANCE_M);

/** Cheap applicability filter only; never permission to route on a chart. */
function nearPolicy(route: AutoroutingTrialRoute, policy: ReviewedChannelTrackPolicy): boolean {
    const xs = policy.span.map(([x]) => x),
        ys = policy.span.map(([, y]) => y);
    const west = Math.min(...xs) - 0.003,
        east = Math.max(...xs) + 0.003;
    const south = Math.min(...ys) - 0.003,
        north = Math.max(...ys) + 0.003;
    return route.coordinates.some((p, i) => {
        if (!i) return false;
        const a = route.coordinates[i - 1];
        return (
            Math.max(a[0], p[0]) >= west &&
            Math.min(a[0], p[0]) <= east &&
            Math.max(a[1], p[1]) >= south &&
            Math.min(a[1], p[1]) <= north
        );
    });
}

/** Factory captures capability/options, not authentication. Each invocation
 * independently fences the SAME account across initial call, chart I/O, the
 * optional second call and final source recheck. Suitable for injection into
 * calculateWithCanalDeparture BEFORE it joins the unchanged local prefix. */
export function createChartGuidedTrialCalculator(options: ChartGuidedTrialOptions = {}) {
    return (request: AutoroutingTrialRequest, signal?: AbortSignal, onProgress?: Progress) =>
        calculateChartGuidedTrial(request, signal, onProgress ?? options.onProgress, options);
}

export async function calculateChartGuidedTrial(
    request: AutoroutingTrialRequest,
    signal?: AbortSignal,
    onProgress?: Progress,
    options: ChartGuidedTrialOptions = {},
): Promise<AutoroutingTrialRoute> {
    const deps = { ...defaults, ...options.dependencies };
    const input: AutoroutingTrialRequest = {
        ...request,
        departure: { ...request.departure },
        destination: { ...request.destination },
        ...(request.vesselProfile ? { vesselProfile: structuredClone(request.vesselProfile) } : {}),
        ...(request.chartTrackConstraints
            ? { chartTrackConstraints: request.chartTrackConstraints.map((p) => ({ ...p })) }
            : {}),
    };
    const scope = getAuthIdentityScope();
    const controller = new AbortController();
    let timedOut = false;
    const checkAccount = () => {
        if (signal?.aborted || !isAuthIdentityScopeCurrent(scope)) throw abortError();
    };
    checkAccount();
    if (!scope.userId) throw new Error('Sign in to use the autorouting trial.');
    const startedAt = deps.now();
    const deadlineAt = Math.min(startedAt + CHART_GUIDANCE_TOTAL_TIMEOUT_MS, options.deadlineAtMs ?? Infinity);
    if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) || deadlineAt <= startedAt)
        throw new Error(TIMEOUT);
    const check = () => {
        checkAccount();
        if (controller.signal.aborted) throw timedOut ? new Error(TIMEOUT) : abortError();
    };
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(timedOut ? new Error(TIMEOUT) : abortError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const unsubscribe = subscribeAuthIdentityScope(() => {
        if (!isAuthIdentityScopeCurrent(scope)) cancel();
    });
    const totalTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, deadlineAt - startedAt);
    const bounded = async <T>(job: () => Promise<T>, ms: number, cancelOnTimeout = false): Promise<T> => {
        check();
        const remaining = deadlineAt - deps.now();
        if (remaining <= 0) throw new Error(TIMEOUT);
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => {
                    if (cancelOnTimeout) {
                        timedOut = true;
                        controller.abort();
                    }
                    reject(new Error(TIMEOUT));
                },
                Math.min(ms, remaining),
            );
        });
        try {
            const value = await Promise.race([
                Promise.resolve().then(() => {
                    check();
                    return job();
                }),
                timeout,
                aborted,
            ]);
            check();
            return value;
        } finally {
            clearTimeout(timer!);
        }
    };
    const progress = (message: string) => {
        check();
        onProgress?.(message);
        check();
    };
    try {
        const initial = clone(
            await bounded(() => deps.calculate(input, controller.signal), CHART_GUIDANCE_PROVIDER_TIMEOUT_MS, true),
        );
        if (
            options.channelGuidance !== true ||
            input.chartTrackConstraints !== undefined ||
            !nearPolicy(initial, deps.policy)
        )
            return initial;
        const fallback = (notice: string) => {
            checkAccount();
            return withNotice(initial, notice);
        };
        try {
            // A retired policy never yields a candidate: say so at once, with
            // no "checking" message and no chart load.
            if (deps.policy.retirement !== undefined) return fallback(UNAVAILABLE);
            progress('Checking reviewed Newport chart-track evidence…');
            const policySnapshot = structuredClone(deps.policy),
                policyKey = JSON.stringify(deps.policy);
            const before = deps.getCell(NEWPORT_CHANNEL_TRACK_CHART.cellId);
            if (
                !before ||
                before.id !== NEWPORT_CHANNEL_TRACK_CHART.cellId ||
                before.edition !== NEWPORT_CHANNEL_TRACK_CHART.edition ||
                before.issued !== NEWPORT_CHANNEL_TRACK_CHART.issued ||
                (before.usage !== undefined && before.usage !== 'navigation')
            )
                return fallback(UNAVAILABLE);
            const registration = metadataKey(before);
            const chart = await bounded(() => deps.loadCell(before.id), CHART_GUIDANCE_LOAD_TIMEOUT_MS);
            if (registration !== metadataKey(deps.getCell(before.id)) || policyKey !== JSON.stringify(deps.policy))
                return fallback(UNAVAILABLE);
            const candidate = createNewportChannelTrackCandidate({
                metadata: before,
                chart,
                policy: policySnapshot,
                now: deps.now(),
            });
            if (!candidate) return fallback(UNAVAILABLE);
            const guidance = selectChannelTrackGuidance(initial, candidate);
            if (!guidance) return initial;
            check();
            progress('Recalculating once through the reviewed Newport track…');
            // No recursive wrapper or retry: exactly one extra provider POST.
            const guided = clone(
                await bounded(
                    () =>
                        deps.calculate(
                            {
                                ...input,
                                departure: { ...input.departure },
                                destination: { ...input.destination },
                                chartTrackConstraints: guidance.points.map(([lon, lat]) => ({ lat, lon })),
                            },
                            controller.signal,
                        ),
                    CHART_GUIDANCE_PROVIDER_TIMEOUT_MS,
                    true,
                ),
            );
            if (
                !endpointsMatch(guided, input, initial) ||
                !validateChannelTrackGuidanceResponse(guidance, guided.coordinates)
            )
                return fallback(REJECTED);
            progress('Rechecking chart revision and review lease…');
            // A local re-read only. No new network ladder after the result.
            const freshChart = await bounded(() => deps.loadCell(before.id, false), CHART_GUIDANCE_LOAD_TIMEOUT_MS);
            const after = deps.getCell(before.id);
            if (registration !== metadataKey(after) || policyKey !== JSON.stringify(deps.policy))
                return fallback(REJECTED);
            const fresh = createNewportChannelTrackCandidate({
                metadata: after,
                chart: freshChart,
                policy: deps.policy,
                now: deps.now(),
            });
            if (!fresh || fresh.provenance.fingerprint !== candidate.provenance.fingerprint) return fallback(REJECTED);
            check();
            const result = withNotice(guided, APPLIED);
            // Never discard earlier diagnostics merely because a second provider
            // answer differs. Label their origin rather than claiming they were
            // reissued against the changed geometry.
            const preliminary = new Set([
                ...initial.warnings,
                ...(initial.providerCheck?.findings.map((finding) => finding.message) ?? []),
            ]);
            for (const warning of preliminary) {
                if (!guided.warnings.includes(warning))
                    result.warnings.push(`Initial proposal also reported: ${warning}`);
            }
            if (initial.providerCheck?.status === 'unsafe' && guided.providerCheck?.status !== 'unsafe')
                result.warnings.push(
                    'The initial proposal was reported unsafe by the provider. Retain its preliminary findings for review.',
                );
            return result;
        } catch {
            // Caller cancellation/account changes must reject, not re-expose a
            // previous account's proposal as an apparently successful fallback.
            return fallback(UNAVAILABLE);
        }
    } finally {
        clearTimeout(totalTimer);
        unsubscribe();
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort);
    }
}
