import type { TracePoint } from '../routeTracer';
import { copyTraceRoutePoints } from './traceRoutePoint';
import { routeConstraintsForTrace } from './traceConstraints';
import { calculateDistance } from '../../utils/navigationCalculations';

/** One explicit leg edit. It never saves, publishes or falls back to a chord. */
export async function autoTraceLeg(input: {
    points: readonly TracePoint[];
    legIndex: number;
    draftM: number;
    airDraftM: number | null;
    departureMs: number;
    satelliteMode: boolean;
    signal: AbortSignal;
    shouldContinue: () => boolean;
}): Promise<{ points: TracePoint[]; added: number; distanceNM: number }> {
    const points = copyTraceRoutePoints(input.points);
    if (
        !points ||
        !Number.isInteger(input.legIndex) ||
        input.legIndex < 0 ||
        input.legIndex + 1 >= points.length ||
        !Number.isFinite(input.departureMs) ||
        !(input.draftM > 0) ||
        !routeConstraintsForTrace(points)
    )
        throw Error('Review the route points, leave-side choices and draft before Auto. Nothing changed.');
    if (input.satelliteMode)
        throw Error('Auto needs a complete chart and land check. Leave Satellite Mode before requesting it.');
    const a = points[input.legIndex],
        b = points[input.legIndex + 1];
    if (
        Math.abs(a.lat) > 83 ||
        Math.abs(b.lat) > 83 ||
        Math.abs(a.lon - b.lon) > 180 ||
        calculateDistance(a.lat, a.lon, b.lat, b.lon) > 50
    )
        throw Error(
            'Auto supports regional legs up to 50 NM, away from the dateline and polar limits. Nothing changed.',
        );

    const stop = new AbortController();
    const cancel = () => stop.abort();
    const wallStop = Date.now() + 60_000,
        monotonicStop = performance.now() + 60_000;
    const alive = () =>
        !input.signal.aborted && Date.now() < wallStop && performance.now() < monotonicStop && input.shouldContinue();
    const check = () => {
        if (stop.signal.aborted || !alive()) throw Error('Auto stopped: the request changed or its time expired.');
    };
    input.signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, 60_000);
    const watch = setInterval(() => {
        if (!alive()) cancel();
    }, 100);
    // An uncancellable native request must not hold the caller past its lifetime.
    const awaitCurrent = <T>(promise: Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const abort = () => reject(Error('Auto stopped: the request changed or its time expired.'));
            if (stop.signal.aborted || !alive()) {
                void promise.catch(() => {});
                return abort();
            }
            stop.signal.addEventListener('abort', abort, { once: true });
            promise.then(
                (value) => {
                    stop.signal.removeEventListener('abort', abort);
                    try {
                        check();
                        resolve(value);
                    } catch (error) {
                        reject(error);
                    }
                },
                (error) => {
                    stop.signal.removeEventListener('abort', abort);
                    reject(error);
                },
            );
        });
    try {
        check();
        const { tryInshoreRoute } = await awaitCurrent(import('../InshoreRouter'));
        // The charted-depth path only: no navigation tide credit or hidden chart
        // acquisition. Coverage gaps remain an explicit refusal to edit.
        const result = await awaitCurrent(
            tryInshoreRoute(a, b, input.draftM, input.airDraftM, 'safest', {
                departureMs: input.departureMs,
                tideCeilings: [],
                signal: stop.signal,
            }),
        );
        if (!result || !('polyline' in result))
            throw Error(
                result && 'error' in result && result.code === 'coverage-gap'
                    ? "Auto needs installed chart coverage. Licensed charts come only from your boat's Pi; open them aboard, then try again. Nothing changed."
                    : result && 'error' in result
                      ? `Auto could not check this leg: ${result.error}. Nothing changed.`
                      : 'Auto found no complete charted route. Nothing changed.',
            );
        const [{ inshoreSegmentStates }, { chartedLandFinding }, tracer, land, cold] = await awaitCurrent(
            Promise.all([
                import('../../components/map/inshoreRouteState'),
                import('./landBackstopWords'),
                import('../routeTracer'),
                import('./landBackstop'),
                import('../traceRecheck'),
            ]),
        );
        if (
            result.polyline.length > 8192 ||
            !Number.isFinite(result.distanceNM) ||
            !inshoreSegmentStates(result) ||
            chartedLandFinding(result.hardLand)
        )
            throw Error('Auto lacks complete route masks or found charted land. Nothing changed.');
        const raw = copyTraceRoutePoints(result.polyline.map(([lon, lat]) => ({ lat, lon })));
        if (!raw) throw Error('Auto returned invalid geometry. Nothing changed.');
        // The existing flat Tracer simplifier/capper cannot represent dateline
        // wrapping. Refuse before a chord creates an almost-global relief ROI.
        if (
            raw.some(
                (p, i) =>
                    Math.abs(p.lat) > 83 ||
                    calculateDistance(a.lat, a.lon, p.lat, p.lon) > 150 ||
                    (i > 0 && Math.abs(p.lon - raw[i - 1].lon) > 180),
            )
        )
            throw Error('Auto returned unsupported regional, dateline or polar geometry. Nothing changed.');
        const followed = tracer.capSegmentLength(tracer.rdpTracePoints(raw, 40), 15_000);
        if (
            followed.length < 2 ||
            Math.abs(followed[0].lat - a.lat) > 1e-7 ||
            Math.abs(followed[0].lon - a.lon) > 1e-7 ||
            Math.abs(followed.at(-1)!.lat - b.lat) > 1e-7 ||
            Math.abs(followed.at(-1)!.lon - b.lon) > 1e-7
        )
            throw Error('Auto did not retain both selected pins. Nothing changed.');
        const proposed = [
            ...points.slice(0, input.legIndex + 1),
            ...followed.slice(1, -1).map((p) => ({ lat: p.lat, lon: p.lon, shape: true as const })),
            ...points.slice(input.legIndex + 1),
        ];
        if (!copyTraceRoutePoints(proposed) || !routeConstraintsForTrace(proposed))
            throw Error('Auto would cross or lose a required mark. Nothing changed.');
        // Check the FINAL simplified/capped geometry, never only the worker's
        // original curve. A shortcut through land must be caught here.
        const backstop = await awaitCurrent(
            land.inshoreRouteCrossesLand(
                followed.map((p): [number, number] => [p.lon, p.lat]),
                { chartVerdicts: result.chartVerdicts },
            ),
        );
        if (backstop.status !== 'verified' || backstop.crossesLand)
            throw Error('The final Auto line could not pass its complete land check. Nothing changed.');
        // Bare coordinates check the selected leg itself; original side marks
        // are checked against the whole proposed trace above, including any
        // mark that is a terminal of this individual leg. No inherited ACKs.
        const checked = await awaitCurrent(
            cold.recheckTrace(
                followed.map(({ lat, lon }) => ({ lat, lon })),
                { departureMs: input.departureMs, signal: stop.signal },
            ),
        );
        if (
            !checked.ok ||
            checked.verification.legGrades.length !== followed.length - 1 ||
            checked.verification.legGrades.some((grade) => grade !== 'clear')
        )
            throw Error('The final Auto line is not completely clear on a fresh chart check. Nothing changed.');
        check();
        return { points: proposed, added: proposed.length - points.length, distanceNM: result.distanceNM };
    } finally {
        clearTimeout(deadline);
        clearInterval(watch);
        input.signal.removeEventListener('abort', cancel);
        stop.abort();
    }
}
