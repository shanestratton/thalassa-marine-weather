import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'pages/LogPage.tsx'), 'utf8');
const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The cast-off "Following a route?" sheet must not offer a row it will refuse.
 *
 * Log follow steers route.points, built from a voyage's ship-log ENTRIES. A
 * trace's verification is signed over the tracer's WAYPOINTS, so the geometry
 * binding fails for every trace-linked voyage and tracedRouteDirectUseBlockReason
 * refuses it — always, no matter how often the route is re-checked in Route
 * Tracer. Following a trace is Route Tracer's Sail button.
 *
 * This flow worked before 2026-08-06: the gate arrived with the beta-candidate
 * hardening (01383633), which closed a real bypass into follow/publication but
 * did not notice the two geometries were never the same thing.
 */
describe('follow picker excludes trace-linked voyages', () => {
    it('filters the frozen choice list on trace linkage', () => {
        expect(code).toContain('traceLinkedVoyageIds');
        const snapshot = code.slice(code.indexOf('const followable = plannedChoices.filter'));
        expect(snapshot.slice(0, 200)).toContain('!traceLinkedVoyageIds.has(summary.voyageId)');
        // The filtered list is what gets frozen — not the raw one.
        expect(code).toContain('setFollowPromptChoices(followable);');
        expect(code).not.toContain('setFollowPromptChoices(plannedChoices);');
    });

    it('derives linkage from the same signal RoutesAndTracks uses', () => {
        // savedRouteId on the entries, not a separate heuristic — two
        // definitions of "is this a traced route" would drift.
        const derive = code.slice(code.indexOf('const traceLinkedVoyageIds'));
        expect(derive.slice(0, 700)).toContain('entry.savedRouteId');
    });

    it('does not open a sheet with nothing in it', () => {
        // Every candidate trace-linked means the sheet's only content would be
        // its dismiss button.
        const snapshot = code.slice(code.indexOf('const followable = plannedChoices.filter'));
        const guard = snapshot.indexOf('if (followable.length === 0) return;');
        const open = snapshot.indexOf('setFollowPromptVoyageId(vid);');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(open);
    });

    it('keeps the refusal path for anything that still slips through', () => {
        // Hiding rows is ergonomics; the gate is the safety property and must
        // not be removed on the strength of the filter.
        expect(code).toContain('tracedRouteDirectUseBlockReason(exactRoute)');
    });
});
