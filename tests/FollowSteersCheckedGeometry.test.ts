import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'pages/LogPage.tsx'), 'utf8');
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
        const substitute = body.indexOf('tracedRouteFollowGeometry(logRoute)');
        const check = body.indexOf('tracedRouteDirectUseBlockReason(');
        expect(substitute).toBeGreaterThan(-1);
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

    it('no longer hides trace-linked voyages from the picker', () => {
        // They work now, so the filter that hid them is gone.
        expect(code).toContain('setFollowPromptChoices(plannedChoices);');
        expect(code).not.toContain('traceLinkedVoyageIds');
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
