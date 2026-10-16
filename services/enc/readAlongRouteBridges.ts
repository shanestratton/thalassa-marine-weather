/** Complete installed-cell cohorts only. No remoteFallback, chart writes,
 * worker messages, persistent summaries or schedule/tide interpretation. */
import { displayCellsForBBox, getVersion } from './EncCellMetadata';
import { loadCellGeoJSON } from './EncCellStore';
import { loadNoaaPackageCohort } from './noaaPackageWindow';
import { MAX_MERGE_CELLS } from './mergeCap';
import { chartStructureClearance } from '../routing/overheadClearance';
import { bridgeReferencePoint } from '../routing/alongRouteBridgeGeometry';
import type { AlongPlace, AlongRouteGeometry } from '../routing/alongRoutePlaces';
import type { EncCell, EncConversionResult } from './types';
import { isProtectedChart } from './chartLicence';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
export interface AlongBridgeInventory {
    records: AlongPlace[];
    complete: boolean;
    chartVersion: number;
    note: string;
}
const short = (value: unknown, max = 200) =>
    typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').slice(0, max) : '';

export async function readAlongRouteBridges(
    route: AlongRouteGeometry,
    assertCurrent: () => void,
): Promise<AlongBridgeInventory> {
    const version = getVersion(),
        scope = getAuthIdentityScope(),
        records = new Map<string, AlongPlace>(),
        seen = new Set<string>();
    const budget = { comparisons: 0 };
    let missingCoverage = false;
    const check = () => {
        assertCurrent();
        if (getVersion() !== version || !isAuthIdentityScopeCurrent(scope))
            throw Error('Chart inventory changed during the bridge scan.');
    };
    const fail = (note: string): AlongBridgeInventory => ({
        records: [],
        complete: false,
        chartVersion: version,
        note,
    });
    if (route.bounds.length > 32) return fail('Bridge scan exceeds32 local windows. Choose an individual route leg.');
    try {
        for (const bounds of route.bounds) {
            await new Promise<void>((done) => setTimeout(done, 0));
            check();
            const cells = displayCellsForBBox(bounds);
            if (cells.length > MAX_MERGE_CELLS)
                throw Error('The complete installed bridge cohort exceeds the existing cell cap.');
            if (!cells.length) {
                missingCoverage = true;
                continue;
            }
            const cohort = await loadNoaaPackageCohort(
                cells.filter((c) => c.noaaPackage),
                bounds,
                check,
            );
            try {
                check();
                for (const cell of cells) {
                    const blob = cell.noaaPackage ? cohort.blobs.get(cell.id) : await loadCellGeoJSON(cell.id, false);
                    check();
                    if (
                        !blob ||
                        (blob.extractorSchema ?? 0) < 2 ||
                        !blob.layers.BRIDGE ||
                        blob.layers.BRIDGE.type !== 'FeatureCollection'
                    )
                        throw Error('A local chart lacks a complete converted BRIDGE layer.');
                    collect(blob, cell);
                }
                check();
            } finally {
                cohort.release();
            }
        }
        check();
        return {
            records: [...records.values()],
            complete: !missingCoverage,
            chartVersion: version,
            note: missingCoverage
                ? 'Bridges from readable installed charts only; some route windows have no installed charts. Other bridges remain unknown.'
                : 'Complete readable installed-cell cohorts. Uncharted/uninstalled areas and operating permission remain unknown.',
        };
    } catch (error) {
        assertCurrent(); // Cancellation/identity changes must propagate, not become reusable empty results.
        return fail(error instanceof Error ? error.message : 'Local bridge inventory unavailable.');
    }

    function collect(blob: EncConversionResult, cell: EncCell) {
        const cellId = cell.id,
            sourceHO = cell.sourceHO,
            protectedChart = isProtectedChart(cell);
        const features = blob.layers.BRIDGE!.features;
        if (!Array.isArray(features) || features.length > 10000)
            throw Error('Bridge source layer exceeds its inventory bound.');
        for (let i = 0; i < features.length; i++) {
            check();
            const feature = features[i],
                props = feature.properties ?? {};
            const lnam =
                typeof props.LNAM === 'string' && /^[a-f0-9]{16}$/i.test(props.LNAM) ? props.LNAM.toUpperCase() : null;
            const id = lnam ? `bridge:${lnam}` : `bridge:${cellId}:${String(feature.id ?? i).slice(0, 80)}`;
            if (seen.has(id)) continue;
            if (seen.size >= 2048)
                throw Error('The complete bridge inventory exceeds2048 objects; choose an individual leg.');
            seen.add(id);
            if (!feature.geometry) throw Error('A bridge has missing geometry.');
            // Synchronous while the entire selected package cohort is leased.
            // Only independent primitive fields survive this block.
            const point = bridgeReferencePoint(feature.geometry, route, budget, check);
            const clearance = chartStructureClearance('BRIDGE', props);
            const datum = Number.isFinite(blob.verticalDatum)
                ? `source VDAT code ${blob.verticalDatum}`
                : 'vertical datum unknown';
            const note = [
                'Chart reference only; not a checked approach or permission to transit.',
                clearance.clearanceM === null
                    ? 'Closed/fixed clearance unknown.'
                    : `Charted closed/fixed clearance ${clearance.clearanceM.toFixed(1)} m; ${datum}.`,
                clearance.opening ? 'Opening bridge: no verified operating schedule or opening permission.' : '',
                'No tide credit applied.',
            ]
                .filter(Boolean)
                .join(' ');
            records.set(id, {
                id,
                name: short(props.OBJNAM) || 'Charted bridge',
                kind: 'bridge',
                ...point,
                source: `${short(sourceHO, 8)} chart ${cellId} · edition ${blob.edition}`,
                sourceUrl: protectedChart ? null : 'https://charts.noaa.gov/ENCs/',
                sourceAt: short(blob.issued, 80) || null,
                aboardOnly: protectedChart,
                note,
            });
        }
    }
}
