/**
 * Hazard Report Service — find ENC obstructions, wrecks, and
 * underwater rocks within a buffer along a planned route.
 *
 * Distinct from the routing validator:
 *   validateRouteSegments asks "does the route CROSS a hazard?"
 *   findHazardsAlongRoute asks "is there a charted hazard NEAR
 *                          the route the user should know about?"
 *
 * Used after routing succeeds to surface a "things to watch out
 * for" list — e.g. a wreck 0.3 NM off the rhumbline, an isolated
 * UWTROC abeam at 0.4 NM. The crew can pre-mark these on the
 * chart, plan visual sightings, etc.
 *
 * Algorithm:
 *   1. Build a buffered bbox around the route (the union of route
 *      points expanded by `bufferNm`).
 *   2. For every imported cell whose own bbox intersects, load
 *      the spatial index and bbox-search inside the buffered
 *      route bbox.
 *   3. For each candidate hazard, compute the closest distance
 *      from any of its bbox corners (or its point coordinate) to
 *      the route polyline.
 *   4. Filter by distance < bufferNm; sort by distance.
 *   5. Deduplicate by source-feature identity (geometry hash) so
 *      a wreck reported by two overlapping cells appears once.
 *
 * What's deliberately NOT in scope:
 *   - LNDARE/DEPARE — already handled by the validator (those
 *     cause the route to detour). A report of "land 0.05 NM off
 *     starboard" would be 90% noise.
 *   - Distance to coastline (COALNE) — would need full polyline
 *     integration; phase 6 once we add COALNE to the conversion.
 */

import type { Geometry } from 'geojson';
import { useEffect, useState } from 'react';

import { createLogger } from '../../utils/createLogger';
import * as cellMeta from './EncCellMetadata';
import { getIndexForCell } from './EncHazardService';
import type { EncCatzoc, EncHazard, EncHazardType } from './types';
import type { BBoxEntry } from './types';

const log = createLogger('EncHazardReportService');

// ── Types ──────────────────────────────────────────────────────────

export interface RoutePoint {
    lat: number;
    lon: number;
}

/** A single hazard reported by `findHazardsAlongRoute`. */
export interface RouteHazardReportEntry {
    /** Cell ID this hazard belongs to (for citation). */
    cellId: string;
    /** Source HO of that cell. */
    sourceHO: string;
    /** Hazard type — already filtered to OBSTRN/WRECKS/UWTROC. */
    hazardType: EncHazardType;
    /** Closest representative point of the hazard, in lat/lon. */
    representativePoint: { lat: number; lon: number };
    /** Distance from the closest leg of the route, in NM. */
    distanceNm: number;
    /** Side of the route (port/starboard/on-track). */
    side: 'port' | 'starboard' | 'on';
    /** Minimum charted depth at the hazard, metres (positive = depth). */
    minDepthM: number | null;
    /** S-57 OBJNAM if present (descriptive label). */
    description?: string;
    /** CATZOC at the hazard's location, if M_QUAL was present. */
    catzoc?: EncCatzoc | null;
}

export interface RouteHazardReport {
    /** Total cells consulted (the report covers their union). */
    cellsConsulted: number;
    /** Lateral buffer used (NM). */
    bufferNm: number;
    /** Hazards found, sorted by distance ascending. */
    entries: RouteHazardReportEntry[];
}

// ── Geometry helpers ──────────────────────────────────────────────

const NM_PER_DEG_LAT = 60;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // Earth radius in NM.
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    let Δλ = ((lon2 - lon1) * Math.PI) / 180;
    if (Δλ > Math.PI) Δλ -= 2 * Math.PI;
    if (Δλ < -Math.PI) Δλ += 2 * Math.PI;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Distance from a point to a great-circle segment, in NM.
 *
 * For typical coastal segments (≤200 NM) the small-angle equirectangular
 * approximation is within 0.1 NM of geodesic — fine for hazard report
 * granularity. For very long segments we'd want a proper cross-track
 * formula, but coastal hazard reports rarely span >50 NM segments.
 */
function pointToSegmentNm(p: RoutePoint, a: RoutePoint, b: RoutePoint): { distNm: number; side: -1 | 0 | 1 } {
    // Convert to local equirectangular metres relative to the segment
    // midpoint so we can do flat-plane geometry.
    const midLat = (a.lat + b.lat) / 2;
    const cosLat = Math.cos((midLat * Math.PI) / 180);
    const toXY = (pt: RoutePoint) => ({
        x: (pt.lon - a.lon) * NM_PER_DEG_LAT * cosLat,
        y: (pt.lat - a.lat) * NM_PER_DEG_LAT,
    });
    const A = toXY(a);
    const B = toXY(b);
    const P = toXY(p);

    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const segLen2 = dx * dx + dy * dy;
    if (segLen2 < 1e-9) {
        // Degenerate segment — fall back to point-to-point.
        return { distNm: haversineNm(p.lat, p.lon, a.lat, a.lon), side: 0 };
    }

    const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / segLen2));
    const closestX = A.x + t * dx;
    const closestY = A.y + t * dy;
    const cx = closestX - P.x;
    const cy = closestY - P.y;
    const distNm = Math.sqrt(cx * cx + cy * cy);

    // Cross product sign tells us which side of A→B the point is on.
    // Positive cross = point is to the LEFT of the bearing (port side
    // relative to a vessel travelling A→B).
    const cross = dx * (P.y - A.y) - dy * (P.x - A.x);
    const side: -1 | 0 | 1 = cross > 1e-6 ? 1 : cross < -1e-6 ? -1 : 0;
    return { distNm, side };
}

/**
 * Closest distance from any point to the route polyline. Returns
 * the closest leg index plus side relative to that leg.
 */
function pointToRoute(p: RoutePoint, route: RoutePoint[]): { distNm: number; side: 'port' | 'starboard' | 'on' } {
    let best = Infinity;
    let bestSide: 'port' | 'starboard' | 'on' = 'on';
    for (let i = 0; i < route.length - 1; i++) {
        const { distNm, side } = pointToSegmentNm(p, route[i], route[i + 1]);
        if (distNm < best) {
            best = distNm;
            bestSide = side === 1 ? 'port' : side === -1 ? 'starboard' : 'on';
        }
    }
    return { distNm: best, side: bestSide };
}

/**
 * Pull a representative {lat, lon} from a hazard's geometry.
 * Polygons → centroid of bbox; points → the coord; lines → bbox
 * centre. Fine for distance ranking — we don't need pixel-precision.
 */
function representativePoint(
    hazard: EncHazard,
    bbox: { minX: number; minY: number; maxX: number; maxY: number },
): {
    lat: number;
    lon: number;
} {
    if (hazard.geometry.type === 'Point') {
        const [lon, lat] = hazard.geometry.coordinates as [number, number];
        return { lat, lon };
    }
    return {
        lat: (bbox.minY + bbox.maxY) / 2,
        lon: (bbox.minX + bbox.maxX) / 2,
    };
}

// ── Hazard classification ─────────────────────────────────────────

/**
 * Map an EncHazard to a report-eligible type. We deliberately
 * exclude LNDARE/DEPARE — those drive the routing detour logic
 * upstream; reporting them here would double-count.
 */
function reportableHazardType(hazard: EncHazard): EncHazardType | null {
    if (hazard.layer === 'OBSTRN') return 'obstruction';
    if (hazard.layer === 'WRECKS') return 'wreck';
    if (hazard.layer === 'UWTROC') return 'rock';
    return null;
}

/**
 * Geometry-based dedup key — overlapping cells often duplicate
 * the same wreck. We hash the centroid to ~10m precision; collisions
 * across genuinely different features in the same patch are
 * acceptable (they'd be reported as one hazard, which is fine).
 */
function dedupeKey(layer: string, repr: { lat: number; lon: number }): string {
    return `${layer}@${repr.lat.toFixed(4)},${repr.lon.toFixed(4)}`;
}

// ── Bbox helpers ──────────────────────────────────────────────────

function routeBufferedBBox(route: RoutePoint[], bufferNm: number): [number, number, number, number] {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const p of route) {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat > maxLat) maxLat = p.lat;
    }
    if (!Number.isFinite(minLon)) return [0, 0, 0, 0];
    // Convert NM buffer to degrees. Lat is constant 60 NM/deg; lon
    // depends on cos(lat) which we approximate with the route midpoint.
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
    const dLat = bufferNm / 60;
    const dLon = bufferNm / (60 * cosLat);
    return [minLon - dLon, minLat - dLat, maxLon + dLon, maxLat + dLat];
}

// ── Public API ────────────────────────────────────────────────────

export interface HazardReportOptions {
    /** Lateral buffer in NM. Default 1.0 NM (typical visual horizon). */
    bufferNm?: number;
    /** Hard cap on entries returned (prevents reports ballooning). */
    maxEntries?: number;
}

/**
 * Build a hazard report for a planned route.
 *
 * Returns `{cellsConsulted, bufferNm, entries: [...]}` sorted by
 * distance ascending. Entries cap at `maxEntries` (default 50)
 * so dense ports don't generate 1000-item lists.
 */
export async function findHazardsAlongRoute(
    route: RoutePoint[],
    options: HazardReportOptions = {},
): Promise<RouteHazardReport> {
    const bufferNm = options.bufferNm ?? 1.0;
    const maxEntries = options.maxEntries ?? 50;

    if (route.length < 2) {
        return { cellsConsulted: 0, bufferNm, entries: [] };
    }

    // ── 1. Find every imported cell whose bbox covers any part of
    //     the buffered route bbox. Cells outside contribute nothing.
    const queryBBox = routeBufferedBBox(route, bufferNm);
    const candidateCells = cellMeta.cellsForBBox(queryBBox);
    if (candidateCells.length === 0) {
        return { cellsConsulted: 0, bufferNm, entries: [] };
    }

    // ── 2. For each cell, load its spatial index and bbox-search.
    const seen = new Map<string, RouteHazardReportEntry>();

    for (const cell of candidateCells) {
        let index;
        try {
            index = await getIndexForCell(cell.id);
        } catch (err) {
            log.warn(`could not load index for ${cell.id}`, err);
            continue;
        }
        if (!index) continue;

        const candidates: BBoxEntry[] = index.searchInBBox(queryBBox);

        for (const entry of candidates) {
            const type = reportableHazardType(entry.hazard);
            if (!type) continue; // LNDARE/DEPARE — covered by validator.

            const repr = representativePoint(entry.hazard, entry);
            const { distNm, side } = pointToRoute(repr, route);
            if (distNm > bufferNm) continue;

            const key = dedupeKey(entry.hazard.layer, repr);
            const existing = seen.get(key);
            if (existing && existing.distanceNm <= distNm) continue;

            const catzoc = index.queryCatzocAt(repr.lat, repr.lon);

            seen.set(key, {
                cellId: cell.id,
                sourceHO: cell.sourceHO,
                hazardType: type,
                representativePoint: repr,
                distanceNm: distNm,
                side,
                minDepthM: entry.hazard.minDepthM,
                description: entry.hazard.description,
                catzoc,
            });
        }
    }

    const entries = Array.from(seen.values())
        .sort((a, b) => a.distanceNm - b.distanceNm)
        .slice(0, maxEntries);

    log.info(
        `report: ${entries.length} hazards within ${bufferNm.toFixed(1)} NM of route ` +
            `(${candidateCells.length} cells consulted)`,
    );
    return { cellsConsulted: candidateCells.length, bufferNm, entries };
}

// ── "Last report" singleton + React hook ──────────────────────────

/**
 * In-memory store for the most recently computed hazard report.
 * Updated by the route planner after validation succeeds; consumed
 * by the UI panel.
 *
 * Session-only — we don't persist this. A new route plan replaces
 * the previous report; clearing the route nulls it.
 */
let lastReport: RouteHazardReport | null = null;
const reportListeners = new Set<() => void>();

export function getLastReport(): RouteHazardReport | null {
    return lastReport;
}

export function setLastReport(report: RouteHazardReport | null): void {
    lastReport = report;
    for (const l of reportListeners) {
        try {
            l();
        } catch (err) {
            log.warn('report listener threw', err);
        }
    }
}

export function subscribeToReport(listener: () => void): () => void {
    reportListeners.add(listener);
    return () => {
        reportListeners.delete(listener);
    };
}

/**
 * React hook — re-renders the consumer whenever the last hazard
 * report changes. Returns the current report (or null).
 */
export function useLastHazardReport(): RouteHazardReport | null {
    const [, bump] = useState(0);
    useEffect(() => subscribeToReport(() => bump((x) => x + 1)), []);
    return lastReport;
}
