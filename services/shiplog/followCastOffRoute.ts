/**
 * followCastOffRoute — put a just-cast-off passage's own line on the chart
 * and the public page, automatically.
 *
 * Born with the Cast Off convergence (Shane 2026-08-25: Cast Off from
 * passage planning must end where the Log slider ends — "and dont forget to
 * add it to the public page if appropriate"). The Log slider's flow asks
 * "Follow a route?" because it cannot know which; a passage cast off from
 * planning IS its route, so asking would be a question with one answer.
 *
 * Runs the SAME verification sequence the Log page's manual follow runs —
 * fetch the voyage's trace geometry, steer exactly the trace's own pins, ask
 * the direct-use gate — then start the local follow and publish. Since build
 * 124 the gate WARNS rather than walls: Cast Off is advisory by doctrine (no
 * new hard gates), so an unchecked (amber) or even a red route is still
 * followed — casting off is the deliberate act that accepts it — and the
 * reason rides back as a caution the Log page shows on the passage. Missing
 * geometry still returns a note and the Log's own follow sheet stays the
 * fallback.
 *
 * The Log page then treats this follow as the answered question: its
 * auto-sheet guard sees a follow that STARTED after the voyage began and
 * records it as confirmed rather than re-asking (hardening 2026-08-01).
 */
import { fetchVoyageAsTrack, type RouteOrTrack } from './RoutesAndTracks';
import { buildFollowRoutePlan, buildFollowRoutePlanFromRoute } from './followRoutePlan';
import { displayRouteLabel, loadSavedTraces } from '../routeTracer';
import { markRouteKitAnswered } from '../../utils/passageClass';
import { publishFollowedRoute } from './publishFollowedRoute';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { tracedRouteDirectUseStatus, tracedRouteFollowGeometry } from '../traceDirectUseGate';
import type { TraceFollowCode } from '../traceVerification';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('followCastOffRoute');

const normaliseRouteName = (value: string): string =>
    value.toLowerCase().replace(/[→⇄]/g, '-').replace(/\s+/g, ' ').trim();

export interface CastOffRouteFollow {
    /** Why the line is NOT up (null = it is up, or not yet known). */
    note: string | null;
    /** The line IS up, but its check is missing (amber) or found something (red). */
    caution: { tone: 'unchecked' | 'finding'; text: string; code: TraceFollowCode } | null;
}

/**
 * Follow the voyage's planned route locally and publish it to the public
 * page. `note` says why the line is not up (missing geometry); `caution`
 * carries an unchecked or red route's reason for the passage.
 */
export async function followCastOffRoute(
    voyageId: string,
    savedRouteId?: string | null,
    publishPublic: boolean = true,
    voyageName?: string | null,
): Promise<CastOffRouteFollow> {
    const notUp = (note: string): CastOffRouteFollow => ({ note, caution: null });
    try {
        const logRoute = await fetchVoyageAsTrack(voyageId);
        let steerRoute: Pick<RouteOrTrack, 'savedRouteId' | 'points'>;
        let exactPlan: ReturnType<typeof buildFollowRoutePlanFromRoute>;
        let matchedByNameOnly = false;
        if (logRoute) {
            steerRoute = tracedRouteFollowGeometry(logRoute);
        } else {
            // A JUST-cast-off passage has no ship-log entries yet — GPS is
            // still warming up — so there is no log line to assemble. The
            // passage's route is the saved trace itself, which is local and
            // already checked. This was the silent bail that made the Log
            // page re-ask "which passage?" seconds after casting off from
            // the passage that IS the answer (Shane 2026-08-26).
            const routeId = savedRouteId?.trim();
            const traces = loadSavedTraces();
            let saved = traces.find((trace) => (routeId && trace.id === routeId) || trace.passageVoyageId === voyageId);
            if (!saved && voyageName?.trim()) {
                // Last resort for a voyage row that predates every link
                // column: a UNIQUE name match against the canonical traces.
                // A name is a weak link, so this path still demands a CHECKED
                // route (below): since build 124 the gate no longer refuses an
                // unchecked one, and a wrong-name match must never draw an
                // unrelated, unchecked line on the chart and the public page.
                const wanted = normaliseRouteName(voyageName);
                const byName = traces.filter(
                    (trace) =>
                        normaliseRouteName(trace.name) === wanted ||
                        normaliseRouteName(displayRouteLabel(trace)) === wanted,
                );
                if (byName.length === 1) {
                    saved = byName[0];
                    matchedByNameOnly = true;
                }
            }
            if (!saved) {
                return notUp(
                    routeId
                        ? 'The saved route for this passage is not on this device. Open it in Route Tracer and save it again.'
                        : 'This passage has no linked saved route. Pick it again in Passage Planning, or re-save the route.',
                );
            }
            if (saved.points.length < 2) return notUp('The saved route has no usable waypoints.');
            steerRoute = { savedRouteId: saved.id, points: saved.points };
        }
        const status = tracedRouteDirectUseStatus(steerRoute, { acceptFinding: true });
        if (matchedByNameOnly && status.tone !== 'checked') {
            log.warn(`cast-off route not auto-followed: name-only match is ${status.tone} (${status.code})`);
            return notUp(
                'This passage has no linked saved route, and the route with its name isn’t checked. Pick it from the follow sheet.',
            );
        }
        const caution =
            status.tone !== 'checked' && status.reason
                ? { tone: status.tone, text: status.reason, code: status.code }
                : null;
        if (caution) log.warn(`cast-off route followed with a ${caution.tone} caution (${status.code})`);
        if (logRoute) {
            exactPlan = buildFollowRoutePlanFromRoute({ ...logRoute, points: steerRoute.points });
        } else {
            const saved = loadSavedTraces().find((trace) => trace.id === steerRoute.savedRouteId);
            exactPlan = saved
                ? buildFollowRoutePlan({
                      label: displayRouteLabel(saved),
                      points: steerRoute.points,
                      timestamp: Date.parse(saved.createdAt) || undefined,
                  })
                : null;
        }
        if (!exactPlan) return notUp('Could not build a follow plan from the saved route.');
        // This passage was born in Passage Planning — the kit is answered by
        // construction. Mark BEFORE following so the nudge's route-committed
        // trigger cannot fire first.
        markRouteKitAnswered(steerRoute.points);
        useFollowRouteStore.getState().startFollowing(exactPlan, voyageId, steerRoute.points);
        // Public page (fire-and-forget like the Log page's pick). Usually a
        // no-op 'not-tracking' at this point — GPS is still starting — so
        // the authoritative publish happens in castOffHandoff the moment
        // tracking confirms. This early attempt stays for the resume case
        // where tracking is already live. Opt-out keeps the line private.
        if (publishPublic) {
            // Publish the PLANNED-ROUTE MIRROR id — the voyage whose
            // ship_logs rows are source='planned_route'. The public page
            // draws the plan from those rows; the cast-off voyage's own
            // entries are live fixes and resolve to nothing.
            const mirrorId = loadSavedTraces()
                .find((trace) => trace.id === steerRoute.savedRouteId)
                ?.plannedRouteId?.trim();
            if (mirrorId) {
                void Promise.resolve(publishFollowedRoute(mirrorId)).catch((error) => {
                    log.warn('publish cast-off followed route failed:', error);
                });
            }
        }
        return { note: null, caution };
    } catch (error) {
        log.warn('cast-off route follow failed:', error);
        return notUp(error instanceof Error && error.message.trim() ? error.message.trim() : 'Route follow failed.');
    }
}
