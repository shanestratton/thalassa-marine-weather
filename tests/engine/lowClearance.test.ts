/**
 * Low-clearance (air-draft) blocking — a fixed bridge the vessel cannot clear
 * is LAND for that vessel.
 *
 * The orchestrator injects `_class:'low-clearance'` OBSTRN bars across bridges
 * whose clearance < airDraft. The grid must hard-block them AND every rescue
 * path must refuse to tunnel: the component-bridge carve was built to punch
 * ≤500 m gaps between water bodies — a blocked bridge line is exactly such a
 * gap, so without the clearanceBarred exclusion the carve would sail the mast
 * straight under the bridge.
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import type { FeatureCollection, Feature } from 'geojson';

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
const fc = (...f: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: f });

const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;

const WATER = fc(rect(153.3, -27.5, 153.34, -27.49, { DRVAL1: 10, acronym: 'DEPARE' }));
// Canal BANKS — hard land sealing the waterway top and bottom, so the only way
// past the bar is UNDER the bridge (mirrors a real canal; without banks the
// fixture's permissive unknown-open water lets A* stroll around the bar's tip).
const BANKS = [
    rect(153.29, -27.49, 153.35, -27.483, { acronym: 'LNDARE' }),
    rect(153.29, -27.507, 153.35, -27.5, { acronym: 'LNDARE' }),
];
const BAR_LON = 153.32;
const req: RouteRequest = {
    fromLat: -27.495,
    fromLon: 153.305,
    toLat: -27.495,
    toLon: 153.335,
    draftM: 2.0,
    safetyM: 0.5,
    resolutionM: 50,
    unchartedPolicy: 'strict',
};

describe('low-clearance bridge blocking', () => {
    it('without a bar the route crosses the channel', () => {
        const r = routeInshore({ DEPARE: WATER, LNDARE: fc(...BANKS) }, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.polyline[r.polyline.length - 1][0]).toBeGreaterThan(BAR_LON);
    });

    it('a low-clearance bar seals the passage — no carve may tunnel the mast under the bridge', () => {
        const layers = {
            DEPARE: WATER,
            LNDARE: fc(...BANKS),
            OBSTRN: fc(
                // 0.0008° ≈ 80 m wide — comfortably ≥ one 50 m grid cell, matching
                // the production bridgeBarPolygon 60 m minimum (cell-centre
                // rasterisation would let a 20 m bar claim zero cells).
                rect(BAR_LON - 0.0004, -27.501, BAR_LON + 0.0004, -27.489, {
                    _class: 'low-clearance',
                    _name: 'test fixed bridge',
                    _clearanceM: 3.0,
                }),
            ),
        };
        const r = routeInshore(layers, req);
        if (isResult(r)) {
            // A route may ship — the shared-component snap legally drags BOTH
            // endpoints onto one side of the bar — but it must NEVER span both
            // sides (that would mean the mast sailed under the bridge).
            let minLon = Infinity;
            let maxLon = -Infinity;
            for (const [lon] of r.polyline) {
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
            }
            const west = minLon < BAR_LON - 0.0006;
            const east = maxLon > BAR_LON + 0.0006;
            expect(west && east, `route spans both sides of the bar (${minLon}..${maxLon})`).toBe(false);
        } else {
            // Refusing outright is also acceptable — never tunnelling is the contract.
            expect(r.error).toBeTruthy();
        }
    });

    it('a CAGED origin refuses with air-draft-blocked — never a cross-country runner', () => {
        // The origin pocket's ONLY exit is the barred bridge: banks on both
        // sides AND a land cap sealing the west end. Strict routing splits the
        // components, the carve refuses the bar, and the verdict must be the
        // honest refusal naming the bridge — not a relax-zone hop over the
        // bank beside it (Shane 2026-07-02: "instead of going cross country
        // like a fucken runner, just say route not possible").
        const layers = {
            DEPARE: WATER,
            LNDARE: fc(
                ...BANKS,
                rect(153.298, -27.5, 153.302, -27.49, { acronym: 'LNDARE' }), // west cap — pocket sealed
            ),
            OBSTRN: fc(
                rect(BAR_LON - 0.0004, -27.501, BAR_LON + 0.0004, -27.489, {
                    _class: 'low-clearance',
                    _name: 'test fixed bridge',
                    _clearanceM: 3.0,
                }),
            ),
        };
        const r = routeInshore(layers, {
            ...req,
            fromLat: -27.495,
            fromLon: 153.31, // inside the cage (west of the bar, east of the cap)
            toLat: -27.495,
            toLon: 153.335, // open water east of the bridge
        });
        if (isResult(r)) {
            // If a route ships anyway, it must stay INSIDE the cage (a legal
            // same-side snap) — never span the bar or hop the banks.
            let minLon = Infinity;
            let maxLon = -Infinity;
            for (const [lon] of r.polyline) {
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
            }
            expect(minLon < BAR_LON - 0.0006 && maxLon > BAR_LON + 0.0006).toBe(false);
        } else {
            expect(r.code).toBe('air-draft-blocked');
            expect(r.error).toMatch(/mast-safe|bridge/i);
        }
    });
});
