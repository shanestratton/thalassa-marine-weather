/** One current RAM preview. Its private source/cohort lease never enters a
 * worker payload, saved route, GPX, PDF, cloud request or departure watch. */
import type { InshoreRouteResult, RouteJob } from './routeJob';
import type { TideGatedSourceRequest } from './tideGatedSources';
import { prepareTideGatedSources, checkTideGatedSourcePermit, recheckTideGatedSourcePermit } from './tideGatedSources';
import { readCurrentRoutingExclusions } from './routingExclusions';
import { buildExclusionField, routeExclusionConflict } from '../engine/exclusionField';
import { runRouteJobHosted } from './routeWorkerHost';
import type { RouteStage } from './routeWorkerHost';

export type TideShortcutView =
    | { readonly kind: 'held'; readonly reason: string }
    | {
          readonly kind: 'preview';
          readonly expiresAtMs: number;
          readonly departureMs: number;
          readonly arrivalMs: number;
          readonly speedKts: number;
          readonly uncertaintyMs: number;
          readonly sourceSummary: string;
      };
type PreviewRecord = { check: () => void; verify: () => Promise<boolean>; release: () => void };
const previews = new WeakMap<object, PreviewRecord>();
const active = new Set<PreviewRecord>();
export function retireTideShortcutPreview(result?: InshoreRouteResult): void {
    if (result) previews.get(result)?.release();
    else for (const record of [...active]) record.release();
}
export async function finalizeTideShortcutPreview(result: InshoreRouteResult): Promise<boolean> {
    const record = previews.get(result);
    if (!record) return false;
    try {
        record.check();
        const valid = await record.verify();
        record.check();
        return valid;
    } catch {
        record.release();
        return false;
    }
}

export async function planTideGatedShortcut(
    request: TideGatedSourceRequest & { draftM: number; safetyM: number; airDraftM: number | null },
    options: {
        signal: AbortSignal;
        assertCurrent: () => void;
        onStage?: (stage: RouteStage) => void;
        onRetired?: (reason: string) => void;
    },
): Promise<{ kind: 'held'; view: TideShortcutView } | { kind: 'preview'; result: InshoreRouteResult }> {
    retireTideShortcutPreview();
    const source = await prepareTideGatedSources(request, options);
    if (source.kind === 'held') return { kind: 'held', view: { kind: 'held', reason: source.reason } };
    let context: Awaited<ReturnType<typeof readCurrentRoutingExclusions>> | null = null;
    let retained = false;
    try {
        const check = () => {
            options.signal.throwIfAborted();
            options.assertCurrent();
            if (!checkTideGatedSourcePermit(source.permit) || (context && !context.isCurrent()))
                throw new DOMException('Tide route source or exclusion context retired.', 'AbortError');
        };
        context = await readCurrentRoutingExclusions({ bbox: source.permit.bounds, signal: options.signal });
        check();
        const layers = { ...source.permit.layers, USER_NOGO: context.manual, MPA_CAUTION: context.marineParks };
        const field = buildExclusionField({
            RESARE: layers.RESARE,
            TSEZNE: layers.TSEZNE,
            manual: layers.USER_NOGO,
            marineParks: layers.MPA_CAUTION,
        });
        const job: RouteJob = {
            layers,
            routeOpts: {
                fromLat: request.from.lat,
                fromLon: request.from.lon,
                toLat: request.to.lat,
                toLon: request.to.lon,
                draftM: request.draftM,
                safetyM: request.safetyM,
                obstructionBufferM: 60,
                unchartedPolicy: 'strict',
                routeProfile: 'safest',
                surveyUncheckedCells: [],
                _tideCandidate: source.permit.request,
            },
            origin: request.from,
            destination: request.to,
            airDraftM: request.airDraftM,
            cellsUsed: source.permit.chartContentKey.split('|').map((s) => s.split('@')[0]),
            structuresUnknownCells: [],
            structuresUnknownBboxes: [],
            regionalPairs: [],
            leadGraph: null,
            tideCeilings: [],
        };
        const hosted = await runRouteJobHosted(job, { signal: options.signal, onStage: options.onStage });
        check();
        const output = hosted.output.result;
        if (!output || 'error' in output || !output._tideCandidatePath)
            return {
                kind: 'held',
                view: {
                    kind: 'held',
                    reason:
                        output && 'error' in output
                            ? output.error
                            : 'The strict worker found no complete timed candidate.',
                },
            };
        const path = structuredClone(output._tideCandidatePath);
        for (const point of path.points) Object.freeze(point);
        Object.freeze(path.points);
        Object.freeze(path.timesMs);
        Object.freeze(path.indices);
        Object.freeze(path.tideCells);
        Object.freeze(path);
        const points = path.points.map((p) => [p[0], p[1]] as [number, number]);
        const outputKey = JSON.stringify(output.polyline),
            distance = output.distanceNM;
        if (
            outputKey !== JSON.stringify(points) ||
            distance !== path.distanceM / 1852 ||
            routeExclusionConflict(points, field)
        )
            return {
                kind: 'held',
                view: { kind: 'held', reason: 'The final timed geometry differs or crosses a current exclusion.' },
            };
        if (!(await recheckTideGatedSourcePermit(source.permit, path)))
            return {
                kind: 'held',
                view: { kind: 'held', reason: 'The complete original tide interval could not be reverified.' },
            };
        check();
        if (
            outputKey !== JSON.stringify(output.polyline) ||
            output.distanceNM !== distance ||
            routeExclusionConflict(points, field)
        )
            return {
                kind: 'held',
                view: { kind: 'held', reason: 'The final geometry or clock changed during source review.' },
            };
        const view: TideShortcutView = Object.freeze({
            kind: 'preview',
            expiresAtMs: source.permit.request.expiresAtMs,
            departureMs: request.departureMs,
            arrivalMs: path.timesMs.at(-1)!,
            speedKts: request.speedKts,
            uncertaintyMs: request.uncertaintyMs,
            sourceSummary: source.permit.sourceSummary,
        });
        const result: InshoreRouteResult = { ...output, polyline: points, tideShortcut: view };
        delete result._tideCandidatePath;
        const exact = JSON.stringify([points, result.distanceNM]);
        let released = false;
        const retire = (reason: string) => {
            record.release();
            options.onRetired?.(reason);
        };
        const timer = setTimeout(
            () => retire('The timed source review expired. Replan to read the current aboard evidence.'),
            Math.max(1, view.expiresAtMs - Date.now()),
        );
        // A single bounded RAM preview; these are read-only fences, never a
        // forecast/chart fetch, source TTL renewal or background watch change.
        const guard = setInterval(() => {
            try {
                record.check();
            } catch {
                retire('The boat, original source, chart or no-go context changed. Replan the timed preview.');
            }
        }, 1000);
        const record: PreviewRecord = {
            check: () => {
                check();
                if (
                    released ||
                    Date.now() >= view.expiresAtMs ||
                    result.tideShortcut !== view ||
                    JSON.stringify([result.polyline, result.distanceNM]) !== exact
                )
                    throw new DOMException('The exact timed preview retired.', 'AbortError');
                if (routeExclusionConflict(result.polyline, field))
                    throw new DOMException('Current route exclusion conflict.', 'AbortError');
            },
            verify: () => recheckTideGatedSourcePermit(source.permit, path),
            release: () => {
                if (released) return;
                released = true;
                clearTimeout(timer);
                clearInterval(guard);
                active.delete(record);
                previews.delete(result);
                source.release();
                context?.release();
            },
        };
        record.check();
        active.add(record);
        previews.set(result, record);
        retained = true;
        return { kind: 'preview', result };
    } finally {
        if (!retained) {
            source.release();
            context?.release();
        }
    }
}
