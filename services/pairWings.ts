/**
 * pairWings — outboard CAUTION wings for an accepted port/starboard pair.
 * Masterplan §3 Phase 3 (Step 4.5 + engine Pass 5c).
 *
 * IALA-A seamanship: the navigable gate is BETWEEN the marks; the water
 * outboard of each mark is the side you must not pass on. Each accepted
 * pair therefore emits two thin rectangles extending OUTBOARD from each
 * mark along the pair axis — rasterised by the engine to CAUTION +
 * preferred=0 (never hardBlocked: a mispair must degrade to a red wiggle,
 * not no-path). Geometry mirrors the scorecard's audit wings exactly
 * (tests/helpers/routeScorecard.ts auditGates): length
 * clamp(pairDistM, 60..150), the masterplan constant; width 30 m.
 *
 * Pure + dependency-free so the orchestrator (InshoreRouter Step 4.5),
 * the fixtures, and any debug renderer share one wing geometry.
 */

export interface WingLatLon {
    lat: number;
    lon: number;
}

/** GeoJSON-ish Polygon feature (no @types/geojson dependency). */
export interface WingFeature {
    type: 'Feature';
    properties: {
        _class: 'pair-wing';
        _source: 'pair-wing-outboard';
        /** Which mark this wing stands outboard of. */
        _side: 'port' | 'stbd';
        _wingLenM: number;
        /** The wing's centreline, mark → outboard end ([lon,lat] pairs).
         *  Engine Pass 5c stamps THIS via Bresenham — a 30 m-wide polygon
         *  can straddle zero cell centres on a 50–100 m grid, so the spine
         *  (not the polygon) is the rasterisation contract. */
        _spine: [number, number][];
    };
    geometry: { type: 'Polygon'; coordinates: [number, number][][] };
}

export const PAIR_WING_WIDTH_M = 30;
export const PAIR_WING_MIN_LEN_M = 60;
export const PAIR_WING_MAX_LEN_M = 150;

/**
 * Build the two outboard wing rectangles for an accepted pair.
 * Returns [] for a degenerate pair (marks closer than ~1 m).
 */
export function pairWingFeatures(port: WingLatLon, stbd: WingLatLon): WingFeature[] {
    const mPerLat = 110_540;
    const mPerLon = 111_320 * Math.cos((((port.lat + stbd.lat) / 2) * Math.PI) / 180);
    // Pair axis port→stbd in local planar metres.
    const ax = (stbd.lon - port.lon) * mPerLon;
    const ay = (stbd.lat - port.lat) * mPerLat;
    const pairDistM = Math.hypot(ax, ay);
    if (pairDistM < 1) return [];
    const ux = ax / pairDistM;
    const uy = ay / pairDistM;
    const wingLenM = Math.min(PAIR_WING_MAX_LEN_M, Math.max(PAIR_WING_MIN_LEN_M, pairDistM));
    const halfW = PAIR_WING_WIDTH_M / 2;
    // Perpendicular to the pair axis (for the rectangle's width).
    const px = -uy;
    const py = ux;

    const rectFor = (mark: WingLatLon, dirX: number, dirY: number, side: 'port' | 'stbd'): WingFeature => {
        // Rectangle from the mark to wingLenM outboard, 30 m wide.
        const cornersM: [number, number][] = [
            [px * halfW, py * halfW],
            [dirX * wingLenM + px * halfW, dirY * wingLenM + py * halfW],
            [dirX * wingLenM - px * halfW, dirY * wingLenM - py * halfW],
            [-px * halfW, -py * halfW],
        ];
        const ring: [number, number][] = cornersM.map(([x, y]) => [mark.lon + x / mPerLon, mark.lat + y / mPerLat]);
        ring.push(ring[0]);
        const spine: [number, number][] = [
            [mark.lon, mark.lat],
            [mark.lon + (dirX * wingLenM) / mPerLon, mark.lat + (dirY * wingLenM) / mPerLat],
        ];
        return {
            type: 'Feature',
            properties: {
                _class: 'pair-wing',
                _source: 'pair-wing-outboard',
                _side: side,
                _wingLenM: wingLenM,
                _spine: spine,
            },
            geometry: { type: 'Polygon', coordinates: [ring] },
        };
    };

    // Outboard = away from the opposite mark: port wing extends along
    // stbd→port continued; stbd wing along port→stbd continued.
    return [rectFor(port, -ux, -uy, 'port'), rectFor(stbd, ux, uy, 'stbd')];
}
