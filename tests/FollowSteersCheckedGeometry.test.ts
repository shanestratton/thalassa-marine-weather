import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The Log page was split into pages/log/ on 2026-09-03 — the cast-off sheet and
// the row-building arithmetic now live beside it. Scan the page TOGETHER with
// the modules it was split into, so the contract below still covers all of it.
const source = ['pages/LogPage.tsx', 'pages/log/logPageDerive.ts', 'pages/log/FollowRoutePromptSheet.tsx']
    .map((file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8'))
    .join('\n');
const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Verify and steer the SAME geometry.
 *
 * The 2026-08-06 beta hardening added a gate that verified `route.points` —
 * the line the Log assembles from ship-log ENTRIES, which include recorder
 * rows the tracer never drew (Voyage Start / End, Latest Position). A trace's
 * verification is signed over its waypoints, so the two never matched: every
 * trace-linked voyage was refused, permanently, and re-checking in Route
 * Tracer could not help.
 *
 * The fix is not to relax the check but to follow what was checked:
 * tracedRouteFollowGeometry substitutes the trace's own waypoints, and the
 * same object is then verified, planned and followed. Any future change that
 * verifies one object and steers another reintroduces the original defect —
 * in the dangerous direction, since the gate would be passing on geometry
 * nobody is steering.
 */
describe('Log follow steers the geometry it verified', () => {
    const followFn = code.slice(code.indexOf('const followPlannedRouteLocally'));
    const body = followFn.slice(0, followFn.indexOf('\n    );'));

    it('substitutes the trace waypoints before checking', () => {
        // Grouping a full passage under its first leg does not prove the two
        // geometries match. Only the separately proven geometry identity may
        // fill a legacy log route's missing link before waypoint substitution.
        const identity = body.indexOf('const pickerTraceId = plannedRouteGeometryIds.get(voyageId)');
        const link = body.indexOf('const linkedRoute =');
        const substitute = body.indexOf('const steerRoute = tracedRouteFollowGeometry(linkedRoute)');
        const check = body.indexOf('tracedRouteDirectUseBlockReason(');
        expect(identity).toBeGreaterThan(-1);
        expect(link).toBeGreaterThan(identity);
        expect(body).toContain(
            '!logRoute.savedRouteId && pickerTraceId ? { ...logRoute, savedRouteId: pickerTraceId } : logRoute',
        );
        expect(body).not.toContain('const pickerTraceId = plannedRouteLinkIds.get(voyageId)');
        expect(substitute).toBeGreaterThan(link);
        expect(check).toBeGreaterThan(substitute);
    });

    it('verifies, plans and follows one and the same object', () => {
        expect(body).toContain('tracedRouteDirectUseBlockReason(steerRoute)');
        expect(body).toContain('buildFollowRoutePlanFromRoute(steerRoute)');
        expect(body).toContain('startFollowing(exactPlan, voyageId, steerRoute.points)');
        // The raw log line must not reach any of the three.
        expect(body).not.toContain('tracedRouteDirectUseBlockReason(logRoute)');
        expect(body).not.toContain('startFollowing(exactPlan, voyageId, logRoute.points)');
    });

    it('keeps the gate — substitution is not a bypass', () => {
        // Steering the checked line is what makes the check PASS honestly; it
        // must not become a reason to stop checking.
        expect(body).toContain('TRACE_ROUTE_USE_BLOCK_PREFIX');
    });

    it('offers EVERY planned route, carrying the follow gate verdict per row', () => {
        // Design history, because this flipped twice: pick-then-refuse (Shane
        // 2026-08-10: "just show tracks that are ready to be followed"), then
        // hide-the-blocked — honest, but a skipper whose routes all needed
        // re-checks saw NOTHING at cast-off (Shane 2026-08-13: "the saved
        // routes do not show up on the startup screen to select one"). Now
        // every planned route reaches the sheet with the gate's verdict on
        // the row: null = pickable, a reason = visible but disabled. The
        // FollowRouteChoiceBlocked suite pins the row behaviour itself.
        expect(code).not.toContain('traceLinkedVoyageIds');
        // Since the cast-off sheet learned trip legs (2026-09-08) the row builder
        // takes the gate through its deps so tests can seed it — the live deps
        // still wire the real gate, and every row still carries its verdict.
        expect(code).toContain('blockReason: savedTraceFollowBlockReason');
        expect(code).toContain('deps.blockReason(sid)');
        expect(code).toContain('setFollowPromptChoices(followSheetChoices);');
        expect(code).toContain('blockReason={blockReason}');
    });
});

describe('tracedRouteFollowGeometry falls through rather than inventing geometry', () => {
    const gate = fs
        .readFileSync(path.join(process.cwd(), 'services/traceDirectUseGate.ts'), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const fn = gate.slice(gate.indexOf('export function tracedRouteFollowGeometry'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    it('returns the route untouched when there is no trace link', () => {
        expect(body).toContain('if (!routeId) return route;');
    });

    it('returns the route untouched when the trace is missing or unusable', () => {
        // Not a silent fabrication: the gate then refuses it on its own terms.
        expect(body).toContain('if (!saved || saved.points.length < 2) return route;');
    });
});
