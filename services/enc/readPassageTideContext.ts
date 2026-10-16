/** Installed charts only. Leases end before primitive, RAM-only disclosures
 * leave this reader. Complete inventory is not complete holding-area proof. */
import { cellsForBBox, getVersion } from './EncCellMetadata';
import { loadCellGeoJSON } from './EncCellStore';
import { loadNoaaPackageCohort } from './noaaPackageWindow';
import { MAX_MERGE_CELLS } from './mergeCap';
import { encCellContentIdentity } from './cellContentIdentity';
import { cellSoundingDatum } from './chartDatum';
import { isProtectedChart } from './chartLicence';
import { holdingGroundAt } from './seabed';
import { pointInGeometry } from '../engine/geometry';
import { chartStructureClearance } from '../routing/overheadClearance';
import { bridgeReferencePoint } from '../routing/alongRouteBridgeGeometry';
import type { AlongRouteGeometry } from '../routing/alongRoutePlaces';
import { tideDistanceKm } from '../tides/offlineTideStore';
import type { Feature, Geometry } from 'geojson';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';

export interface PassageChartBridge {
    featureKey: string;
    name: string;
    lat: number;
    lon: number;
    chartContentKey: string;
    heightDatum: string | null;
    heightDatumEpoch: null;
    closedClearanceM: number | null;
    openClearanceM: number | null;
    opening: boolean;
    estimated: boolean;
    aboardOnly: boolean;
}
export interface PassageTideChartContext {
    chartVersion: number;
    contentKey: string | null;
    completeInventory: boolean;
    aboardOnly: boolean;
    soundingDatum: string | null;
    soundingDatumEpoch: string | null;
    pointDepthM: number | null;
    holdingText: string;
    holdingPointSample: boolean;
    bridges: PassageChartBridge[];
    notes: string[];
}
const short = (v: unknown, max = 160) => (typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').slice(0, max) : '');
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function unavailablePassageTideContext(note: string, version: number): PassageTideChartContext {
    return {
        chartVersion: version,
        contentKey: null,
        completeInventory: false,
        aboardOnly: true,
        soundingDatum: null,
        soundingDatumEpoch: null,
        pointDepthM: null,
        holdingText: 'Holding ground unknown here.',
        holdingPointSample: false,
        bridges: [],
        notes: [note],
    };
}
export async function readPassageTideContext(
    point: { lat: number; lon: number },
    route: AlongRouteGeometry,
    assertCurrent: () => void,
): Promise<PassageTideChartContext> {
    const version = getVersion(),
        scope = getAuthIdentityScope();
    const empty = (note: string) => unavailablePassageTideContext(note, version);
    if (![point.lat, point.lon].every(Number.isFinite) || Math.abs(point.lat) > 85 || Math.abs(point.lon) > 180)
        return empty('The selected point is outside the supported local chart window.');
    const dy = 1200 / 110000,
        dx = dy / Math.cos((point.lat * Math.PI) / 180);
    const ranges: [number, number][] =
        point.lon - dx < -180
            ? [
                  [point.lon - dx + 360, 180],
                  [-180, point.lon + dx],
              ]
            : point.lon + dx > 180
              ? [
                    [point.lon - dx, 180],
                    [-180, point.lon + dx - 360],
                ]
              : [[point.lon - dx, point.lon + dx]];
    const selected = new Map(
        ranges.flatMap(([w, e]) => cellsForBBox([w, point.lat - dy, e, point.lat + dy])).map((c) => [c.id, c]),
    );
    if (!selected.size) return empty('No installed navigation chart covers this local window.');
    if (selected.size > MAX_MERGE_CELLS)
        return empty('The complete local chart cohort exceeds the existing cell limit.');
    const check = () => {
        assertCurrent();
        if (getVersion() !== version || !isAuthIdentityScopeCurrent(scope))
            throw new DOMException('Chart owner or revision changed.', 'AbortError');
    };
    const bottom: Feature<Geometry>[] = [],
        bridges = new Map<string, PassageChartBridge>(),
        depths: number[] = [],
        datums = new Set<string>();
    const keys: string[] = [],
        notes = new Set<string>();
    let complete = true,
        aboardOnly = false,
        features = 0,
        vertices = 0,
        unknownDatum = false,
        unknownDepth = false;
    const boundedGeometry = (geometry: Geometry): boolean => {
        if (geometry.type === 'GeometryCollection') return false;
        const stack: unknown[] = [geometry.coordinates];
        let nodes = 0;
        while (stack.length) {
            if (++nodes > 131072 || vertices > 65536) return false;
            if (nodes % 256 === 0) check();
            const part = stack.pop();
            if (!Array.isArray(part) || !part.length) return false;
            if (typeof part[0] === 'number') {
                if (
                    ++vertices > 65536 ||
                    part.length < 2 ||
                    !part.every(Number.isFinite) ||
                    Math.abs(part[0]) > 180 ||
                    Math.abs(part[1]) > 90
                )
                    return false;
            } else {
                if (part.length + stack.length > 65536) return false;
                for (const item of part) stack.push(item);
            }
        }
        return true;
    };
    const budget = { comparisons: 0 };
    for (const [w, e] of ranges) {
        check();
        const bounds: [number, number, number, number] = [w, point.lat - dy, e, point.lat + dy];
        const cells = [...selected.values()].filter((c) => c.bbox[0] <= e && c.bbox[2] >= w);
        const cohort = await loadNoaaPackageCohort(
            cells.filter((c) => c.noaaPackage),
            bounds,
            check,
        );
        try {
            for (const cell of cells) {
                const blob = cell.noaaPackage ? cohort.blobs.get(cell.id) : await loadCellGeoJSON(cell.id, false);
                check();
                if (
                    !blob ||
                    blob.cellId !== cell.id ||
                    blob.edition !== cell.edition ||
                    blob.sourceHO !== cell.sourceHO
                ) {
                    complete = false;
                    notes.add('An installed chart could not be read at its current revision.');
                    continue;
                }
                const contentKey = encCellContentIdentity(cell),
                    protectedChart = isProtectedChart(cell);
                keys.push(contentKey);
                aboardOnly ||= protectedChart;
                const datumAreas = blob.layers.M_SDAT?.features;
                if (datumAreas) {
                    if ((features += datumAreas.length) > 16000)
                        return empty('The local review exceeds16,000 chart objects.');
                    for (const area of datumAreas)
                        if (!area.geometry || !boundedGeometry(area.geometry))
                            return empty('Local datum geometry exceeds the65,536-vertex review bound or is malformed.');
                }
                const datum = cellSoundingDatum(blob);
                if (datum) datums.add(datum);
                else {
                    unknownDatum = true;
                    notes.add('Sounding datum or complete M_SDAT extraction is unknown.');
                }
                for (const cls of ['DEPARE', 'SBDARE', 'WEDKLP', 'BRIDGE'] as const) {
                    const layer = blob.layers[cls];
                    if (!layer || layer.type !== 'FeatureCollection' || !Array.isArray(layer.features)) {
                        complete = false;
                        notes.add(`The ${cls} layer is missing; absence is not proof of clear coverage.`);
                        continue;
                    }
                    if ((features += layer.features.length) > 16000)
                        return empty('The local review exceeds 16,000 chart objects.');
                    for (let i = 0; i < layer.features.length; i++) {
                        if (i % 64 === 0) check();
                        const f = layer.features[i],
                            p = f?.properties ?? {};
                        if (!f?.geometry) {
                            complete = false;
                            continue;
                        }
                        if (!boundedGeometry(f.geometry))
                            return empty(
                                'A local chart geometry exceeds the 65,536-vertex review bound or is malformed.',
                            );
                        if (cls === 'DEPARE') {
                            if (pointInGeometry(point.lon, point.lat, f.geometry)) {
                                const depth = number(p.DRVAL1 ?? p.drval1);
                                if (depth !== null) depths.push(depth);
                                else {
                                    unknownDepth = true;
                                    notes.add('A covering depth area has no numeric lower depth.');
                                }
                            }
                        } else if (cls === 'BRIDGE') {
                            const at = bridgeReferencePoint(f.geometry, route, budget, check);
                            if (tideDistanceKm(point, at) > 1.2) continue;
                            const featureKey = short(p.LNAM) || `${cell.id}:${String(f.id ?? i).slice(0, 80)}`;
                            if (bridges.size >= 32 && !bridges.has(featureKey))
                                return empty('More than 32 local bridges require a smaller review.');
                            const clearance = chartStructureClearance('BRIDGE', p);
                            bridges.set(featureKey, {
                                featureKey,
                                name: short(p.OBJNAM) || 'Charted bridge',
                                ...at,
                                chartContentKey: contentKey,
                                heightDatum:
                                    number(blob.verticalDatum) === null ? null : `S-57 VDAT ${blob.verticalDatum}`,
                                heightDatumEpoch: null,
                                closedClearanceM: clearance.clearanceM,
                                openClearanceM: number(p.VERCOP ?? p.vercop),
                                opening: clearance.opening,
                                estimated: clearance.estimated,
                                aboardOnly: protectedChart,
                            });
                        } else
                            bottom.push({ type: 'Feature', geometry: f.geometry, properties: { ...p, _caution: cls } });
                    }
                }
            }
        } finally {
            cohort.release();
        }
    }
    check();
    const holding = holdingGroundAt(point.lat, point.lon, bottom);
    notes.add('Chart datums have no reviewed station-to-cell epoch tie; no tide credit applied.');
    notes.add(
        'A point depth/bottom sample does not prove the complete holding circle, approach, permission or interval exposure.',
    );
    return {
        chartVersion: version,
        contentKey: [...new Set(keys)].sort().join('|') || null,
        completeInventory: complete,
        aboardOnly,
        soundingDatum: !unknownDatum && datums.size === 1 ? [...datums][0] : null,
        soundingDatumEpoch: null,
        pointDepthM: !unknownDepth && depths.length ? Math.min(...depths) : null,
        holdingText: holding.text,
        holdingPointSample: holding.pointSample,
        bridges: [...bridges.values()],
        notes: [...notes],
    };
}
