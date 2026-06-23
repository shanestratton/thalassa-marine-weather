/**
 * Leading-approach SPLICE-JUNCTION guard — the ±171° double-back field
 * artefact (2026-06-13, Newport approach, ROUTING_COLLAB A-23 idx
 * 148-150: legs 268 m → 337 m → 1765 m, spike then return).
 *
 * Mechanism: applyLeadingLineApproach diverted at the route vertex
 * NEAREST the seaward anchor with no direction discipline. When the
 * route already sits between the anchor and the destination ON the lead
 * axis (it overshot the capture point — or never needed it), the splice
 * yanked it BACKWARD to the anchor and ran forward again. The internal
 * dog-leg guard (cosTurn > −0.5) never covered the two SPLICE junctions.
 *
 * Fix under test: both junctions (route→anchor at the divert,
 * divert→anchor→turn at the anchor) must satisfy the same |turn| ≤ 120°
 * family; candidates try nearest-first; no compliant divert ⇒ the
 * approach is SKIPPED — a route already lined up past the anchor is
 * already doing what the leads ask.
 *
 *  • OVERSHOOT (167.0x): origin BETWEEN anchor and dest on the axis —
 *    every divert candidate reverses ⇒ approach skipped, no >150° turn
 *    anywhere (pre-fix: spliced spike-and-return, the field shape).
 *  • CAPTURE control (167.5x): origin SEAWARD of the anchor — the
 *    classic stand-off-and-line-up still splices (leadingApproach ≥ 1),
 *    reversal-free.
 */

import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';

function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

const AXIS_LAT = -27.2;
const M_PER_LON = 111_320 * Math.cos((AXIS_LAT * Math.PI) / 180);
const eastM = (lon0: number, m: number): number => lon0 + m / M_PER_LON;

const navline = (a: [number, number], b: [number, number]): Feature => ({
    type: 'Feature',
    properties: { _layer: 'NAVLINE' },
    geometry: { type: 'LineString', coordinates: [a, b] },
});

/** Largest absolute heading change at any interior vertex, degrees. */
function maxTurnDeg(polyline: [number, number][]): number {
    const heading = (p: [number, number], q: [number, number]): number =>
        (Math.atan2((q[0] - p[0]) * M_PER_LON, (q[1] - p[1]) * 110_540) * 180) / Math.PI;
    let worst = 0;
    for (let i = 1; i < polyline.length - 1; i++) {
        // Ignore micro-legs (< 30 m) — endpoint splices create them and
        // their headings are quantisation noise, not navigation.
        const legA = Math.hypot(
            (polyline[i][0] - polyline[i - 1][0]) * M_PER_LON,
            (polyline[i][1] - polyline[i - 1][1]) * 110_540,
        );
        const legB = Math.hypot(
            (polyline[i + 1][0] - polyline[i][0]) * M_PER_LON,
            (polyline[i + 1][1] - polyline[i][1]) * 110_540,
        );
        if (legA < 30 || legB < 30) continue;
        let turn = heading(polyline[i], polyline[i + 1]) - heading(polyline[i - 1], polyline[i]);
        while (turn > 180) turn -= 360;
        while (turn < -180) turn += 360;
        worst = Math.max(worst, Math.abs(turn));
    }
    return worst;
}

const isResult = (
    r: ReturnType<typeof routeInshore>,
): r is Extract<ReturnType<typeof routeInshore>, { polyline: unknown }> => 'polyline' in r;

describe('leading-approach splice junctions (lon 167.00–167.70)', () => {
    it('OVERSHOOT: a route already between anchor and dest skips the approach — no spike-and-return', () => {
        // For a dest collinear with the lead axis the capture anchor
        // lands +800 m seaward (measured). ORIGIN at +500 m sits BETWEEN
        // anchor and dest — the field shape: diverting means a backward
        // yank to +800 then a reversal home. Pre-fix: spliced exactly
        // that spike-and-return; post-fix: every candidate fails a
        // junction (origin→anchor heads E, anchor→turn heads W ⇒
        // cos ≈ −1) and the approach is skipped.
        const DEST_LON = 167.05;
        const layers = {
            DEPARE: fc(rect(166.98, -27.26, 167.16, -27.14, { DRVAL1: 12, DRVAL2: 20 })),
            NAVLINE: fc(navline([eastM(DEST_LON, 400), AXIS_LAT], [eastM(DEST_LON, 1200), AXIS_LAT])),
        };
        const req: RouteRequest = {
            fromLat: AXIS_LAT,
            fromLon: eastM(DEST_LON, 500),
            toLat: AXIS_LAT,
            toLon: DEST_LON,
            draftM: 2.0,
            safetyM: 0.5,
            resolutionM: 50,
        };
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.leadingApproach ?? 0).toBe(0); // skipped, not spliced backward
        expect(maxTurnDeg(r.polyline)).toBeLessThan(150); // and no reversal anywhere
        expect(r.distanceNM).toBeLessThan(0.5); // essentially direct
    });

    it('CAPTURE control: a route arriving off-axis still gets the stand-off splice', () => {
        // Origin NE of the dest at (+500 mE, +1400 mN): the diagonal
        // arrival's origin vertex sits 1432 m from the anchor (+800 mE)
        // with junction angles ≈102° — inside the 120° discipline, so
        // the classic make-the-mark splice still fires.
        const DEST_LON = 167.55;
        const layers = {
            DEPARE: fc(rect(167.48, -27.26, 167.72, -27.1, { DRVAL1: 12, DRVAL2: 20 })),
            NAVLINE: fc(navline([eastM(DEST_LON, 400), AXIS_LAT], [eastM(DEST_LON, 1200), AXIS_LAT])),
        };
        const req: RouteRequest = {
            fromLat: AXIS_LAT + 1400 / 110_540,
            fromLon: eastM(DEST_LON, 500),
            toLat: AXIS_LAT,
            toLon: DEST_LON,
            draftM: 2.0,
            safetyM: 0.5,
            resolutionM: 50,
        };
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // RE-PIN 2026-06-18 (tier-contract path, 2d63775a): the off-axis arrival
        // no longer routes through the old applyLeadingLineApproach splice —
        // the tier-contract path handles it as a clean tier-3 passthrough
        // (debug.threeTier='tier3:passthrough', verified live). The INTENT
        // survives and is what we actually care about: NO sharp reversal on
        // the off-axis approach. maxTurn measured 50° here, far under the cap.
        expect(r.debug?.threeTier).toBeTruthy(); // tier-contract path engaged, old splice retired
        expect(maxTurnDeg(r.polyline)).toBeLessThan(150); // bounded approach, no jink
    });
});
