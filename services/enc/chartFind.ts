/** Local chart lookup. Query text, names and positions never leave this process. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getPairing } from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { boatLanBaseNow } from './piCellSync';
import { chartLicenceOf } from './chartLicence';
import { getDisplayCell, getVersion, listDisplayCells } from './EncCellMetadata';
import { noaaAgreementAccepted } from './noaaAgreement';
import { noaaPartIntersects } from './noaaPackageContract';
import {
    captureChartFindCell,
    indexChartFindCell,
    chartFindGeneration,
    chartFindResultCurrent,
    searchChartFindMemory,
    subscribeChartFind,
    type ChartFindResult,
} from './chartFindMemory';
import type { ChartLicence } from './types';

export type ChartFindBounds = [number, number, number, number];
function permitted(id: string, licence: ChartLicence, consent: boolean): boolean {
    const cell = getDisplayCell(id);
    if (!cell || chartLicenceOf(cell) !== licence) return false;
    return licence === 'open' ? consent : !!getPairing() && !!boatLanBaseNow();
}
export async function findChartObjects(query: string) {
    const scope = getAuthIdentityScope(),
        generation = chartFindGeneration();
    const consent = await noaaAgreementAccepted(scope);
    if (!isAuthIdentityScopeCurrent(scope) || generation !== chartFindGeneration()) return null;
    return {
        ...searchChartFindMemory(query, (id, licence) => permitted(id, licence, consent)),
        consent,
        aboard: !!getPairing() && !!boatLanBaseNow(),
    };
}
/** Recheck at the action, including across async agreement reads. Omitted or
 * stale results confer no authority to move the camera. */
export async function chartFindSelectionCurrent(result: ChartFindResult): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!chartFindResultCurrent(result)) return false;
    const consent = await noaaAgreementAccepted(scope);
    return (
        isAuthIdentityScopeCurrent(scope) &&
        chartFindResultCurrent(result) &&
        permitted(result.cellId, result.licence, consent)
    );
}
export function subscribeChartFindAccess(listener: () => void): () => void {
    const memory = subscribeChartFind(listener),
        transport = piCache.onStatusChange(listener);
    return () => {
        memory();
        transport();
    };
}
/** Small current-camera read only. Split a dateline view locally; a worldwide
 * camera is deliberately not a request to scan every downloaded chart. */
export function chartFindViews(bounds: ChartFindBounds | null): ChartFindBounds[] {
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return [];
    const [w, s, e, n] = bounds;
    if (Math.abs(w) > 1e6 || Math.abs(e) > 1e6 || s < -90 || n > 90 || s >= n) return [];
    const span = e >= w ? e - w : e + 360 - w;
    if (span <= 0 || span > 120 || n - s > 90) return [];
    // Mapbox returns unwrapped bounds on adjacent world copies, e.g179..181.
    const west = ((((w + 180) % 360) + 360) % 360) - 180,
        east = west + span;
    return east <= 180
        ? [[west, s, east, n]]
        : [
              [west, s, 180, n],
              [-180, s, east - 360, n],
          ];
}
/** Explicit tap, downloaded NOAA only, sequential, four cells maximum. Local
 * package reads borrow the existing 16MiB lease and release every geometry. No
 * Pi/cloud ladder, catalogue lookup, remote geocoder or background prefetch. */
export async function readDownloadedChartFind(
    bounds: ChartFindBounds | null,
    options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
) {
    if (reading) throw Error('A local chart read is still finishing. Try again when it has stopped.');
    reading = true;
    try {
        return await readLocal(bounds, options);
    } finally {
        reading = false;
    }
}
// A cancelled Capacitor file read cannot be forcibly interrupted. Keep its
// slot until it settles; repeated Cancel/Read taps cannot multiply buffers.
let reading = false;
async function readLocal(bounds: ChartFindBounds | null, options: { signal?: AbortSignal; isCurrent?: () => boolean }) {
    const scope = getAuthIdentityScope(),
        generation = chartFindGeneration(),
        version = getVersion(),
        deadline = performance.now() + 10000;
    const check = () => {
        if (
            options.signal?.aborted ||
            options.isCurrent?.() === false ||
            !isAuthIdentityScopeCurrent(scope) ||
            generation !== chartFindGeneration() ||
            version !== getVersion() ||
            performance.now() > deadline
        )
            throw Error('Chart search changed or was cancelled.');
    };
    const views = chartFindViews(bounds);
    if (!views.length) throw Error('Zoom in to a smaller chart area first.');
    if (!(await noaaAgreementAccepted(scope)))
        throw Error('Accept the NOAA ENC agreement before reading downloaded NOAA charts.');
    check();
    const cells = listDisplayCells().filter(
        (cell) => chartLicenceOf(cell) === 'open' && views.some((view) => noaaPartIntersects(cell.bbox, view)),
    );
    let read = 0,
        unavailable = 0;
    for (const cell of cells.slice(0, 4)) {
        check();
        const token = captureChartFindCell(cell.id);
        try {
            if (cell.noaaPackage) {
                const { loadNoaaPackageWindow } = await import('./noaaPackageWindow');
                // A dateline camera reads one intersecting side per cell and
                // reports partial coverage; never make a world-spanning box.
                const view = views.find((view) => noaaPartIntersects(cell.bbox, view))!;
                const held = await loadNoaaPackageWindow(cell, view, check);
                try {
                    check();
                    read++;
                } finally {
                    held.release();
                }
            } else {
                const { loadCellGeoJSON } = await import('./EncCellStore');
                const blob = await loadCellGeoJSON(cell.id, false);
                check();
                if (blob) {
                    indexChartFindCell(token, blob, 'open');
                    read++;
                } else unavailable++;
            }
        } catch (error) {
            check();
            unavailable++;
            if (!(error instanceof Error)) throw error;
        }
    }
    check();
    return { read, unavailable, limited: cells.length > 4 || views.length > 1 };
}
