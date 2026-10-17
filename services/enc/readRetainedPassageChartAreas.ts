/** Current original RAM geometry only; no source read, LRU refresh or download. */
import type { FeatureCollection, Polygon, MultiPolygon, Geometry } from 'geojson';
import type { EncCell } from './types';
import { cellsForBBox, getVersion } from './EncCellMetadata';
import { peekCellGeoJSON, readRetainedCellGeoJSONBytes } from './EncCellStore';
import { readPiChartReadEvidence, isPiChartReadEvidenceCurrent } from './piCellSync';
import { noaaAgreementAccepted } from './noaaAgreement';
import { borrowRetainedNoaaWindow, retainedNoaaWindowIdentity } from './noaaRetainedWindow';
import { MAX_MERGE_CELLS } from './mergeCap';
import { isProtectedChart } from './chartLicence';
import { encCellContentIdentity } from './cellContentIdentity';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { reserveRetainedAreaField } from './retainedAreaBudget';
import {
    buildExclusionField,
    routeExclusionConflict,
    exclusionRefusal,
    type ExclusionField,
} from '../engine/exclusionField';
import { auditTrafficLaneRoute, type TrafficLaneGuidance } from '../engine/trafficLanes';
import { geometryBbox } from '../engine/geometry';
import type { OverlayRouteBounds } from '../userOverlays/model';
import { ROUTING_AREA_CAVEATS } from '../routing/routeAreaWords';

export const PASSAGE_AREA_CLASSES = ['RESARE', 'TSEZNE', 'TSSLPT'] as const;
type AreaClass = (typeof PASSAGE_AREA_CLASSES)[number];
export interface PassageChartAreaVerdict {
    refusal?: { code: 'route-exclusion' | 'exclusion-unavailable'; error: string };
    trafficLaneGuidance?: TrafficLaneGuidance;
    exclusionsUnchecked: true;
    notes: readonly string[];
}
export interface RetainedPassageChartAreas {
    readonly classes: Readonly<Record<AreaClass, 'extracted' | 'partial' | 'unavailable'>>;
    readonly geographicCoverage: 'unknown';
    isCurrent(): boolean;
    /** Weak source proofs remain usable after geometry/reservation release. */
    authorityCurrent(): boolean;
    confirmCurrent(): Promise<boolean>;
    auditFinishedRoute(points: readonly (readonly [number, number])[], check: () => void): PassageChartAreaVerdict;
    release(): void;
}
const cellAuthorityKey = (cell: EncCell) =>
    JSON.stringify([
        encCellContentIdentity(cell),
        cell.sourceHO,
        cell.bbox,
        cell.usage,
        cell.licence,
        cell.noaaPackage,
    ]);
const empty = (): FeatureCollection<Polygon | MultiPolygon> => ({ type: 'FeatureCollection', features: [] });
const unavailable = () => ({
    code: 'exclusion-unavailable' as const,
    error: 'The current original chart-area geometry could not be checked. Review the passage again.',
});
const overlap = (a: readonly number[], b: readonly number[]) =>
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
function countedArea(geometry: Geometry, spend: () => void): geometry is Polygon | MultiPolygon {
    if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') return false;
    const stack: unknown[] = [geometry.coordinates];
    while (stack.length) {
        spend();
        const next = stack.pop();
        if (!Array.isArray(next) || !next.length) return false;
        if (typeof next[0] === 'number') {
            if (next.length < 2 || !next.every(Number.isFinite) || Math.abs(next[0]) > 180 || Math.abs(next[1]) > 85)
                return false;
        } else for (const child of next) stack.push(child);
    }
    return true;
}
export async function readRetainedPassageChartAreas({
    bbox,
    signal,
    assertCurrent,
}: {
    bbox: OverlayRouteBounds;
    signal: AbortSignal;
    assertCurrent: () => void;
}): Promise<RetainedPassageChartAreas> {
    const scope = getAuthIdentityScope(),
        version = getVersion();
    const window = Object.freeze([...bbox]) as OverlayRouteBounds;
    const proofs: Array<() => boolean> = [];
    const borrowed: Array<ReturnType<typeof borrowRetainedNoaaWindow>> = [];
    const allocation = reserveRetainedAreaField();
    let active = true,
        field: ExclusionField | undefined,
        hasOpen = false,
        consent = false;
    let classes: RetainedPassageChartAreas['classes'] = Object.freeze({
        RESARE: 'unavailable',
        TSEZNE: 'unavailable',
        TSSLPT: 'unavailable',
    });
    const authority = () => {
        try {
            return isAuthIdentityScopeCurrent(scope) && version === getVersion() && proofs.every((check) => check());
        } catch {
            return false;
        }
    };
    const current = () => active && !signal.aborted && authority();
    const check = () => {
        signal.throwIfAborted();
        assertCurrent();
        if (!current()) throw new DOMException('Original chart-area sources retired.', 'AbortError');
    };
    const release = () => {
        if (!active) return;
        active = false;
        field = undefined;
        allocation.release();
        borrowed.splice(0).forEach((value) => value?.release());
        signal.removeEventListener('abort', release);
    };
    signal.addEventListener('abort', release, { once: true });
    const unknown = () => {
        field = undefined;
        classes = Object.freeze({ RESARE: 'unavailable', TSEZNE: 'unavailable', TSSLPT: 'unavailable' });
        allocation.resize(0);
    };
    const finish = (): RetainedPassageChartAreas => ({
        get classes() {
            return classes;
        },
        geographicCoverage: 'unknown',
        isCurrent: current,
        authorityCurrent: authority,
        confirmCurrent: async () => {
            check();
            const allowed = !hasOpen || (await noaaAgreementAccepted(scope));
            check();
            return allowed === consent || !hasOpen;
        },
        auditFinishedRoute: (points, ensure) => {
            try {
                check();
                ensure();
                if (!field) return { exclusionsUnchecked: true, notes: [ROUTING_AREA_CAVEATS[6]] };
                // The caller's original source window is not expanded at audit.
                if (
                    points.length < 2 ||
                    points.length > 8192 ||
                    points.some(
                        (p) =>
                            p.length !== 2 ||
                            !p.every(Number.isFinite) ||
                            p[0] < window[0] ||
                            p[0] > window[2] ||
                            p[1] < window[1] ||
                            p[1] > window[3],
                    )
                )
                    return { refusal: unavailable(), exclusionsUnchecked: true, notes: [ROUTING_AREA_CAVEATS[6]] };
                const kind = routeExclusionConflict(points, field, () => {
                    check();
                    ensure();
                });
                if (kind)
                    return {
                        refusal: { code: 'route-exclusion', error: exclusionRefusal(kind) },
                        exclusionsUnchecked: true,
                        notes: [ROUTING_AREA_CAVEATS[6]],
                    };
                const lane = auditTrafficLaneRoute(points, field.trafficLanes, () => {
                    check();
                    ensure();
                });
                check();
                ensure();
                return {
                    exclusionsUnchecked: true,
                    ...(lane.guidance ? { trafficLaneGuidance: lane.guidance } : {}),
                    notes: [
                        ROUTING_AREA_CAVEATS[6],
                        ...(lane.guidance
                            ? [ROUTING_AREA_CAVEATS[lane.guidance === 'charted-flow' ? 7 : 8], ROUTING_AREA_CAVEATS[9]]
                            : []),
                    ],
                };
            } catch (error) {
                signal.throwIfAborted();
                assertCurrent();
                return { refusal: unavailable(), exclusionsUnchecked: true, notes: [ROUTING_AREA_CAVEATS[6]] };
            }
        },
        release,
    });
    try {
        check();
        if (
            window.length !== 4 ||
            !window.every(Number.isFinite) ||
            window[0] >= window[2] ||
            window[1] >= window[3] ||
            window[0] < -180 ||
            window[2] > 180 ||
            window[1] < -85 ||
            window[3] > 85
        )
            return finish();
        const cells = cellsForBBox([...window]);
        if (!cells.length || cells.length > MAX_MERGE_CELLS) return finish();
        hasOpen = cells.some((cell) => !isProtectedChart(cell));
        consent = hasOpen ? await noaaAgreementAccepted(scope) : false;
        check();
        const selected = { RESARE: empty(), TSEZNE: empty(), TSSLPT: empty() };
        const counts = { RESARE: 0, TSEZNE: 0, TSSLPT: 0 };
        let originalBytes = 0,
            selectedBytes = 512,
            objects = 0,
            operations = 0;
        const spend = () => {
            if (++operations > 200000) throw Error('Original chart-area geometry exceeds its bound.');
            if ((operations & 255) === 0) check();
        };
        allocation.resize(selectedBytes);
        for (const cell of cells) {
            check();
            if (isProtectedChart(cell)) {
                const receipt = readPiChartReadEvidence(cell);
                if (!receipt) {
                    proofs.push(() => readPiChartReadEvidence(cell) === null);
                    continue;
                }
                proofs.push(() => isPiChartReadEvidenceCurrent(receipt, cell));
            } else if (!consent) continue;
            const view = cell.noaaPackage ? borrowRetainedNoaaWindow(cell, window) : null;
            if (cell.noaaPackage && !view) proofs.push(() => retainedNoaaWindowIdentity(cell, window) === null);
            if (view) borrowed.push(view);
            const blob = cell.noaaPackage ? view?.blob : peekCellGeoJSON(cell.id);
            if (!blob) {
                if (!cell.noaaPackage) proofs.push(() => peekCellGeoJSON(cell.id) === undefined);
                continue;
            }
            const weak = new WeakRef(blob),
                key = cellAuthorityKey(cell);
            proofs.push(() => cellAuthorityKey(cell) === key);
            if (view) proofs.push(() => view.authorityCurrent());
            else
                proofs.push(() => {
                    const value = weak.deref();
                    return (
                        !!value &&
                        peekCellGeoJSON(cell.id) === value &&
                        readRetainedCellGeoJSONBytes(cell.id, value) !== null &&
                        cellAuthorityKey(cell) === key
                    );
                });
            const measured = view?.bytes ?? readRetainedCellGeoJSONBytes(cell.id, blob);
            if (
                !measured ||
                !Number.isSafeInteger(measured) ||
                measured < 0 ||
                (originalBytes += measured) > 16 * 1024 * 1024
            ) {
                unknown();
                return finish();
            }
            if (
                blob.cellId !== cell.id ||
                blob.sourceHO !== cell.sourceHO ||
                blob.edition !== cell.edition ||
                blob.updateNumber !== cell.updateNumber ||
                blob.issued !== cell.issued
            )
                continue;
            for (const cls of PASSAGE_AREA_CLASSES) {
                const collection = blob.layers[cls];
                if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features))
                    continue;
                let complete = true;
                for (const feature of collection.features) {
                    if (++objects > 16000) throw Error('Original chart-area object budget exceeded.');
                    if (!feature?.geometry || !countedArea(feature.geometry, spend)) {
                        complete = false;
                        continue;
                    }
                    if (!overlap(geometryBbox(feature.geometry), window)) continue;
                    const p = feature.properties ?? {};
                    const safe = {
                        type: 'Feature',
                        properties:
                            cls === 'RESARE'
                                ? { RESTRN: p.RESTRN ?? p.restrn }
                                : cls === 'TSSLPT'
                                  ? { ORIENT: p.ORIENT, orient: p.orient }
                                  : {},
                        geometry: feature.geometry,
                    };
                    // Strip labels, measure BEFORE retaining, and keep only an
                    // independent bounded selected field. Whole blobs stay weak.
                    const text = JSON.stringify(safe);
                    selectedBytes += new TextEncoder().encode(text).length + 1;
                    allocation.resize(selectedBytes);
                    selected[cls].features.push(JSON.parse(text));
                }
                if (complete) counts[cls]++;
            }
        }
        check();
        classes = Object.freeze(
            Object.fromEntries(
                PASSAGE_AREA_CLASSES.map((cls) => [
                    cls,
                    counts[cls] === cells.length ? 'extracted' : counts[cls] ? 'partial' : 'unavailable',
                ]),
            ) as Record<AreaClass, 'extracted' | 'partial' | 'unavailable'>,
        );
        field = buildExclusionField(selected);
        check();
        return finish();
    } catch (error) {
        try {
            assertCurrent();
        } catch (retired) {
            release();
            throw retired;
        }
        if (signal.aborted || !authority()) {
            release();
            throw error;
        }
        // Unsupported/budget-limited original data remains explicitly unknown.
        unknown();
        return finish();
    }
}
