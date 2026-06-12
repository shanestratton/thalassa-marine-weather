/**
 * UNCHARTED ≠ OPEN — fixtures for the reply-16 structural fix (field bug
 * 2026-06-12: Newport→Mooloolaba routed a dead-straight 32.7 NM line over
 * Bribie Island with zero caution flags, because the engine's UNKNOWN_OPEN
 * permissive default makes uncharted islands not exist and the coverage
 * gate only checked the route endpoints).
 *
 * Three nets, outermost first:
 *   1. Orchestrator corridor gate — findCorridorCoverageGap samples the
 *      direct line every 1 NM against ROUTING-GRADE installed-cell bboxes
 *      (overview-class cells are excluded by feature density: 351724 is
 *      1°×1° with 48 features and Bribie is not among them). Pure helper,
 *      tested directly.
 *   2. Engine strict policy — unchartedPolicy:'strict' (the live
 *      orchestrator setting) flags no-evidence cells as caution and
 *      REFUSES routes whose longest no-evidence run exceeds
 *      UNCHARTED_MAX_RUN_M with code 'uncharted-corridor'. Evidence-based,
 *      not bbox-based, so it catches reply-16 cause #3 (ribbon cells whose
 *      bboxes cover Bribie but contain zero LNDARE).
 *   3. Claude A's GEBCO landBackstop (caller-side) — its own suite.
 *
 * The permissive default is also pinned here: it is the legacy disease,
 * and fixtures/harbour-corridor callers rely on it staying unchanged.
 *
 * Engine fixtures live in exclusive lon-region 162.x (NavGrid cache keys
 * on bbox + feature counts — distinct regions prevent cross-suite cache
 * collisions; sub-regions 162.0x / 162.5x / 162.8x differ in bbox).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: async () => ({ status: 599, data: null }) } }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => [], listCells: () => [] }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: async () => null }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: () => false, baseUrl: 'http://test.invalid' },
}));
vi.mock('../services/OsmRouteOverlayService', () => ({ getOsmRouteOverlay: async () => null }));

import type { Feature, FeatureCollection } from 'geojson';
import { routeInshore, UNCHARTED_MAX_RUN_M, type RouteRequest } from '../services/inshoreRouterEngine';
import { findCorridorCoverageGap } from '../services/InshoreRouter';
import type { EncCell } from '../services/enc/types';

// ── Shared synthetic-chart helpers (seamanship-suite conventions) ───

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

function fc(...features: Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

const isResult = (
    r: ReturnType<typeof routeInshore>,
): r is Extract<ReturnType<typeof routeInshore>, { polyline: unknown }> => 'polyline' in r;

const cautionCount = (r: ReturnType<typeof routeInshore>): number =>
    isResult(r) ? (r.cautionMask ?? []).filter(Boolean).length : -1;

const baseReq = (fromLon: number, toLon: number): RouteRequest => ({
    fromLat: -27.2,
    fromLon,
    toLat: -27.2,
    toLon,
    draftM: 2.0,
    safetyM: 0.5,
    resolutionM: 50,
});

describe('engine — strict unchartedPolicy across a chart-coverage hole (lon 162.00–162.30)', () => {
    // Two deep charted basins (DRVAL1 10 m) with a ~4 km hole of NOTHING
    // between them — the Bribie corridor in miniature. No LNDARE anywhere:
    // the island the route would cross simply is not in any layer, exactly
    // like the live repro.
    const FROM_LON = 162.1;
    const TO_LON = 162.2;
    const layers = {
        DEPARE: fc(
            rect(162.08, -27.24, 162.13, -27.16, { DRVAL1: 10, DRVAL2: 20 }),
            rect(162.17, -27.24, 162.22, -27.16, { DRVAL1: 10, DRVAL2: 20 }),
        ),
    };

    it('PERMISSIVE (default) pins the legacy disease: routes the hole dead-straight with ZERO caution flags', () => {
        const r = routeInshore(layers, baseReq(FROM_LON, TO_LON));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // Dead straight: within 2% of the direct-line distance.
        const directNM = 0.1 * 111.32 * Math.cos((-27.2 * Math.PI) / 180) * 0.539957; // ≈ 5.35
        expect(r.distanceNM).toBeLessThan(directNM * 1.02 + 0.2);
        // ...and silently clean. THIS is what 'strict' exists to end.
        expect(cautionCount(r)).toBe(0);
    });

    it("STRICT refuses with 'uncharted-corridor' — ~4 km of no-evidence water exceeds UNCHARTED_MAX_RUN_M", () => {
        const r = routeInshore(layers, { ...baseReq(FROM_LON, TO_LON), unchartedPolicy: 'strict' });
        expect(isResult(r)).toBe(false);
        if (isResult(r)) return;
        expect(r.code).toBe('uncharted-corridor');
        // The measured no-evidence run is the ~3.96 km hole (± a cell or
        // two and the endpoint-basin margins), comfortably over the 1 NM cap.
        expect(r.debug?.unchartedMaxRunM ?? 0).toBeGreaterThan(UNCHARTED_MAX_RUN_M);
        expect(r.debug?.unchartedMaxRunM ?? 0).toBeGreaterThan(3000);
        expect(r.debug?.unchartedMaxRunM ?? 0).toBeLessThan(5500);
        // ...and the refusal came from the sub-second 400 m pre-check,
        // not a 20-47 s fine build (field hang, reply 19 fix 3).
        expect(r.debug?.coarsePrecheck).toBe(true);
    });
});

describe('engine — strict flags but ROUTES a short no-evidence sliver (lon 162.50–162.70)', () => {
    // Same two-basin shape, hole shrunk to ~1 km (< UNCHARTED_MAX_RUN_M):
    // ogr2ogr sliver gaps and short unsurveyed cuts must keep routing —
    // honestly red, never refused.
    const FROM_LON = 162.55;
    const TO_LON = 162.65;
    const layers = {
        DEPARE: fc(
            rect(162.53, -27.24, 162.595, -27.16, { DRVAL1: 10, DRVAL2: 20 }),
            rect(162.605, -27.24, 162.67, -27.16, { DRVAL1: 10, DRVAL2: 20 }),
        ),
    };

    it('succeeds, with the gap segments caution-flagged and unchartedMaxRunM under the cap', () => {
        const r = routeInshore(layers, { ...baseReq(FROM_LON, TO_LON), unchartedPolicy: 'strict' });
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(cautionCount(r)).toBeGreaterThan(0); // the sliver renders red
        expect(r.debug?.unchartedMaxRunM ?? 0).toBeGreaterThan(400);
        expect(r.debug?.unchartedMaxRunM ?? 0).toBeLessThanOrEqual(UNCHARTED_MAX_RUN_M);
        // No insane detour to dodge the sliver.
        expect(r.distanceNM).toBeLessThan(7);
    });
});

describe('engine — strict is a no-op on a fully charted corridor (lon 162.80–162.95)', () => {
    const FROM_LON = 162.84;
    const TO_LON = 162.91;
    const layers = {
        DEPARE: fc(rect(162.78, -27.28, 162.97, -27.12, { DRVAL1: 10, DRVAL2: 20 })),
    };

    it('clean route, zero caution, unchartedMaxRunM = 0', () => {
        const r = routeInshore(layers, { ...baseReq(FROM_LON, TO_LON), unchartedPolicy: 'strict' });
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(cautionCount(r)).toBe(0);
        expect(r.debug?.unchartedMaxRunM ?? -1).toBe(0);
    });
});

// ── Orchestrator corridor gate (pure helper) ────────────────────────

const cell = (id: string, bbox: [number, number, number, number], hazardCount: number): EncCell =>
    ({ id, bbox, hazardCount, sourceHO: 'AHO', edition: 1, issued: '', importedAt: '', geojsonPath: '' }) as EncCell;

// ~30 NM N-S corridor off a synthetic coast.
const ORIGIN = { lat: -27.0, lon: 153.2 };
const DEST = { lat: -26.5, lon: 153.2 };

describe('orchestrator — findCorridorCoverageGap (direct-line 1 NM sampling)', () => {
    it('null when dense cells tile the whole corridor', () => {
        const cells = [cell('A', [153.0, -27.1, 153.4, -26.8], 5000), cell('B', [153.0, -26.85, 153.4, -26.4], 5000)];
        expect(findCorridorCoverageGap(ORIGIN, DEST, cells)).toBeNull();
    });

    it('reports the first uncovered sample when the corridor has a mid-route hole', () => {
        // Endpoint cells only — the middle ~0.2° (≈12 NM) is uncovered.
        const cells = [
            cell('origin-harbour', [153.0, -27.1, 153.4, -26.9], 5000),
            cell('dest-harbour', [153.0, -26.6, 153.4, -26.4], 5000),
        ];
        const gap = findCorridorCoverageGap(ORIGIN, DEST, cells);
        expect(gap).not.toBeNull();
        if (!gap) return;
        expect(gap.lat).toBeGreaterThan(-26.9); // first sample past the origin cell's roof
        expect(gap.lat).toBeLessThan(-26.6); // ...and before the dest cell begins
        expect(gap.atNM).toBeGreaterThan(3);
        expect(gap.atNM).toBeLessThan(27);
    });

    it('an overview-class blanket does NOT satisfy the gate (density floor)', () => {
        // The live failure: 351724-style 1°×1° cell with 48 features
        // blankets the corridor, so bbox containment alone would pass.
        const cells = [
            cell('origin-harbour', [153.0, -27.1, 153.4, -26.9], 5000),
            cell('dest-harbour', [153.0, -26.6, 153.4, -26.4], 5000),
            cell('351724-overview', [153.0, -27.5, 154.0, -26.0], 48),
        ];
        const gap = findCorridorCoverageGap(ORIGIN, DEST, cells);
        expect(gap).not.toBeNull();
    });

    it('a DENSE large cell does satisfy the gate (it is real coverage, not overview)', () => {
        const cells = [cell('big-coastal', [153.0, -27.5, 154.0, -26.0], 60000)]; // 40k features/deg²
        expect(findCorridorCoverageGap(ORIGIN, DEST, cells)).toBeNull();
    });

    it("sub-1-NM routes have no interior samples — endpoints stay the endpoint gate's job", () => {
        const a = { lat: -27.0, lon: 153.2 };
        const b = { lat: -27.012, lon: 153.2 }; // ≈0.7 NM
        expect(findCorridorCoverageGap(a, b, [])).toBeNull();
    });
});
