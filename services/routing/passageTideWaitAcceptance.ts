/** Explicit wait acceptance produces only a point edit. No chart/tide facts,
 * assumed timing, watch changes or route replacement cross this boundary. */
import type { CompleteHoldingReader, HoldingLimits, HoldingReviewOptions, TideWaitRequest } from './tideWaitReview';
import type { TraceRoutePoint } from './traceRoutePoint';
const intents = new WeakMap<
    object,
    {
        expectedPoints: TraceRoutePoint[];
        expectedEpoch: number;
        holdingIndex: number;
        current: () => boolean;
        expiresAtMs: number;
        geometry: string;
    }
>();
const mark: unique symbol = Symbol('point-only-wait-intent');
export interface PointOnlyWaitIntent {
    readonly [mark]: true;
}
export type CheckedTracePointCommit = (
    expectedEpoch: number,
    expectedPoints: TraceRoutePoint[],
    transform: (current: TraceRoutePoint[]) => TraceRoutePoint[],
    isCurrent: () => boolean,
) => boolean;

export async function preparePointOnlyWaitIntent(
    draft: unknown,
    request: TideWaitRequest,
    limits: HoldingLimits,
    water: unknown,
    options: HoldingReviewOptions,
    reader: CompleteHoldingReader,
    target: {
        points: TraceRoutePoint[];
        editEpoch: number;
        beforeIndex: number;
        holdingIndex: number;
        isCurrent: () => boolean;
    },
): Promise<PointOnlyWaitIntent | null> {
    if (
        !Number.isSafeInteger(target.editEpoch) ||
        target.editEpoch < 0 ||
        !Number.isSafeInteger(target.beforeIndex) ||
        target.beforeIndex < 1 ||
        target.beforeIndex >= target.points.length ||
        !Number.isSafeInteger(target.holdingIndex) ||
        target.holdingIndex < 0 ||
        target.holdingIndex >= target.beforeIndex ||
        target.points[target.holdingIndex].lat !== request.lat ||
        target.points[target.holdingIndex].lon !== request.lon ||
        target.points.length >= 10000 ||
        !target.isCurrent()
    )
        return null;
    const geometry = JSON.stringify(target.points);
    const { recheckTideWaitForAcceptance } = await import('./tideWaitReview');
    const point = await recheckTideWaitForAcceptance(draft, request, limits, water, options, reader);
    options.signal.throwIfAborted();
    options.assertCurrent();
    if (!point || !target.isCurrent() || JSON.stringify(target.points) !== geometry) return null;
    const intent = Object.freeze({ [mark]: true as const });
    intents.set(intent, {
        expectedPoints: target.points,
        expectedEpoch: target.editEpoch,
        holdingIndex: target.holdingIndex,
        current: target.isCurrent,
        expiresAtMs: Date.now() + 1000,
        geometry,
    });
    return intent;
}
/** Called by the editor's synchronous compare-and-set, not by a saved route
 * loader. An intent is one-use even if its pending React updater is refused. */
export function commitPointOnlyWaitIntent(value: PointOnlyWaitIntent, commit: CheckedTracePointCommit): boolean {
    const intent = intents.get(value);
    if (!intent) return false;
    intents.delete(value);
    const current = () => Date.now() < intent.expiresAtMs && intent.current();
    if (!current()) return false;
    return commit(
        intent.expectedEpoch,
        intent.expectedPoints,
        (points) => {
            if (!current() || points !== intent.expectedPoints || JSON.stringify(points) !== intent.geometry)
                return points;
            // The selected holding visit already belongs to the user's route.
            // Label that visit; reinserting it at the gate would make a
            // duplicate leg or an unreviewed backtrack.
            return points.map((p, i) => (i === intent.holdingIndex ? { ...p, name: 'Wait' } : p));
        },
        current,
    );
}
