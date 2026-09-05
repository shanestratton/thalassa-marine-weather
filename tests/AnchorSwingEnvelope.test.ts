/**
 * At anchor the trail is an envelope, not a path.
 *
 * Shane, 2026-09-05, at z20.2 with a 0.003 nm scale bar — about 5.5 m across
 * the whole bar — looking at a trail zigzagging 15–20 m: "this happens a lot
 * claude. i take it it GPS jump. can we fix that?? or is that just a gps
 * feature created by the gps people??"
 *
 * It is a GPS jump, and that half is not fixable at source: a stationary
 * receiver wanders 5–15 m, worse alongside a marina where the fix bounces off
 * the rigging and neighbouring hulls. What we DRAW is ours. The trail filter
 * only skipped fixes closer than 5 m, so the wander went straight through and
 * was joined into a path that reads like the boat sprinting back and forth.
 *
 * Smoothing was the other candidate and is worse on this surface: it draws a
 * prettier wander and DELAYS the moment genuine movement shows. The envelope
 * hides nothing — a real drag stretches it toward the alarm ring immediately —
 * and every raw fix stays drawn underneath it.
 *
 * THE INVARIANT: smooth the drawing, never the alarm. Drag detection stays on
 * raw fixes with anchorGpsWatchdog's 3-strike hysteresis, and nothing in this
 * change may reach it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convexHull, hullRing, type LonLat } from '../utils/convexHull';

const src = readFileSync('components/map/useVesselTracker.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** ~15 m of wander around a mooring, the shape Shane photographed. */
function wander(n: number): LonLat[] {
    const pts: LonLat[] = [];
    for (let i = 0; i < n; i++) {
        const a = (i * 137.50776405) % 360;
        // 0.00013° ≈ 14 m of latitude.
        const r = 0.00013 * ((i % 11) / 10);
        pts.push([153.1 + r * Math.cos((a * Math.PI) / 180), -27.2 + r * Math.sin((a * Math.PI) / 180)]);
    }
    return pts;
}

describe('anchor swing envelope', () => {
    it('collapses a zigzag of wander to a handful of corners', () => {
        const pts = wander(120);
        const hull = convexHull(pts);
        expect(pts.length).toBe(120);
        // The line drew 120 vertices of noise; the envelope draws its outline.
        expect(hull.length).toBeLessThan(20);
        expect(hull.length).toBeGreaterThanOrEqual(3);
    });

    it('never draws smaller than the movement it describes', () => {
        // The safety property, restated at this level: no fix may fall outside
        // the shape drawn around the fixes.
        const pts = wander(200);
        const hull = convexHull(pts);
        for (const [px, py] of pts) {
            let inside = true;
            for (let i = 0; i < hull.length; i++) {
                const a = hull[i];
                const b = hull[(i + 1) % hull.length];
                if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < -1e-12) inside = false;
            }
            expect(inside).toBe(true);
        }
    });

    it('grows the moment the boat actually moves', () => {
        const pts = wander(80);
        const extent = (ring: LonLat[]) => {
            const lons = ring.map((p) => p[0]);
            const lats = ring.map((p) => p[1]);
            return (Math.max(...lons) - Math.min(...lons)) * (Math.max(...lats) - Math.min(...lats));
        };
        const before = hullRing(pts)!;
        // A genuine drag: 60 m to the north-east, well outside the wander.
        pts.push([153.1006, -27.1994]);
        const after = hullRing(pts)!;
        expect(after).toContainEqual([153.1006, -27.1994]);
        // EXTENT, not vertex count. A distant point can subsume several
        // corners of a small blob, so the hull may legitimately have FEWER
        // vertices while covering far more ground — which is the property that
        // actually matters.
        expect(extent(after)).toBeGreaterThan(extent(before) * 2);
    });
});

describe('the tracker wires it that way', () => {
    it('routes anchored fixes to the envelope and freezes the path', () => {
        expect(code).toMatch(/const anchored = SWING_STATES\.has\(AnchorWatchService\.getSnapshot\(\)\.state\);/);
        const handler = code.slice(code.indexOf('const anchored ='));
        const branch = handler.slice(0, handler.indexOf('const trail = trailCoordsRef.current;'));
        expect(branch).toContain('updateSwingData(map, swing)');
        // A chord across the swing is exactly what the old code drew.
        expect(branch).toMatch(/\breturn;/);
    });

    it('applies NO distance filter to the swing — the wander is the measurement', () => {
        const handler = code.slice(code.indexOf('if (anchored) {'));
        const branch = handler.slice(0, handler.indexOf('const trail = trailCoordsRef.current;'));
        expect(branch).not.toContain('MIN_TRAIL_DISTANCE_M');
    });

    it('covers every state the anchor is actually down in, including alarm', () => {
        // Dropping the envelope at the moment of an alarm would blank the
        // drawing precisely when it is being looked at.
        expect(code).toMatch(/SWING_STATES[^=]*=\s*new Set\(\['setting', 'watching', 'paused', 'alarm'\]\)/);
    });

    it('keeps the raw fixes drawn, rather than replacing them with a claim', () => {
        expect(code).toContain('SWING_DOTS_LAYER');
        const at = code.indexOf('function updateSwingData');
        expect(at).toBeGreaterThan(-1);
        // Slice forward from AFTER the header — indexOf('function ') from the
        // header itself matches at 0 and yields an empty string that passes
        // nothing and fails everything.
        const body = code.slice(at, code.indexOf('function removeTrailLayers', at));
        expect(body).toContain('points.map');
    });

    it('clears the envelope when she gets under way, and on teardown', () => {
        const handler = code.slice(code.indexOf('if (swingPointsRef.current.length > 0)'));
        expect(handler.slice(0, 200)).toContain('removeSwingLayers(map)');
        expect(code).toMatch(/clearTrail[\s\S]{0,400}removeSwingLayers\(map\)/);
    });

    it('does not touch the alarm — no watchdog or drag logic in this file', () => {
        expect(code).not.toContain('anchorGpsWatchdog');
        expect(code).not.toContain('nextDragState');
        // Read-only on the watch: a snapshot, never a command.
        expect(code).not.toMatch(/AnchorWatchService\.(?!getSnapshot)/);
    });
});
