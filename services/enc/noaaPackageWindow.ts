/** Bounded local view, never a whole-cell read. Caller owns the lease until
 * every index/merge borrowing this geometry is detached. No cache or WAN. */
import { noaaPartIntersects, noaaPartBounds, NOAA_PART_BYTES } from './noaaPackageContract';
import { readNoaaPackage, readNoaaPackagePart } from './noaaPackageStore';
import { reserveNoaaResident } from './EncCellStore';
import type { EncCell, EncConversionResult } from './types';
import { getVersion } from './EncCellMetadata';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { MAX_MERGE_CELLS } from './mergeCap';

const VIEW_BYTES = 16 * 1024 * 1024;

export async function loadNoaaPackageWindow(
    cell: EncCell,
    bounds: [number, number, number, number],
    assertCurrent: () => void = () => {},
    maximumBytes = VIEW_BYTES,
): Promise<{ blob: EncConversionResult; bytes: number; release: () => void }> {
    if (!noaaPartBounds(bounds)) throw Error('Invalid NOAA chart view.');
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < NOAA_PART_BYTES || maximumBytes > VIEW_BYTES)
        throw Error('NOAA chart cohort exceeds the resident limit.');
    const version = getVersion(),
        lease = reserveNoaaResident(NOAA_PART_BYTES);
    const resize = (bytes: number): void => {
        if (bytes > maximumBytes) throw Error('NOAA chart cohort exceeds the resident limit.');
        lease.resize(bytes);
    };
    const check = (): void => {
        assertCurrent();
        if (version !== getVersion()) throw Error('NOAA chart revision changed during scan.');
    };
    try {
        check();
        const manifest = await readNoaaPackage(cell);
        check();
        const blob: EncConversionResult = { ...manifest.metadata, layers: {} };
        for (const l of manifest.layers)
            blob.layers[l.name as keyof typeof blob.layers] = {
                ...l.collection,
                type: 'FeatureCollection',
                features: [],
            };
        let bytes = new TextEncoder().encode(JSON.stringify(blob)).length;
        resize(bytes + NOAA_PART_BYTES);
        for (const part of manifest.parts) {
            check();
            if (!noaaPartIntersects(part.bbox, bounds)) continue;
            // Sequential: at most one <=4MiB part is read/decoded at a time.
            const selected = await readNoaaPackagePart(cell, manifest, part, bounds);
            check();
            bytes += selected.selectedBytes;
            // Reserve BEFORE retaining a part. Over budget discards this entire
            // view; it never returns a truncated set or invented clear water.
            resize(bytes + NOAA_PART_BYTES);
            for (const [name, fc] of Object.entries(selected.layers)) {
                if (fc)
                    for (const feature of fc.features)
                        blob.layers[name as keyof typeof blob.layers]!.features.push(feature);
            }
        }
        check();
        resize(bytes);
        return { blob, bytes, release: lease.release };
    } catch (error) {
        lease.release();
        throw error;
    }
}

/** All requested packages or none, before any scale-shadow merge. One logical
 * request shares the existing 16MiB view ceiling, including the next decode.
 * The borrower must release only after its actual asynchronous work settles. */
export async function loadNoaaPackageCohort(
    cells: readonly EncCell[],
    bounds: [number, number, number, number],
    assertCurrent: () => void = () => {},
) {
    if (!noaaPartBounds(bounds) || cells.length > MAX_MERGE_CELLS)
        throw Error('Invalid or oversized NOAA chart cohort.');
    const scope = getAuthIdentityScope(),
        version = getVersion(),
        blobs = new Map<string, EncConversionResult>(),
        releases: Array<() => void> = [];
    let bytes = 0,
        released = false;
    const check = (): void => {
        assertCurrent();
        if (released || version !== getVersion() || !isAuthIdentityScopeCurrent(scope))
            throw Error('NOAA chart cohort changed during use.');
    };
    const release = (): void => {
        released = true;
        blobs.clear();
        for (const done of releases.splice(0)) done();
    };
    try {
        check();
        for (const cell of cells) {
            if (!cell.noaaPackage || blobs.has(cell.id)) throw Error('Invalid NOAA chart cohort.');
            const view = await loadNoaaPackageWindow(cell, bounds, check, VIEW_BYTES - bytes);
            releases.push(view.release);
            check();
            bytes += view.bytes;
            blobs.set(cell.id, view.blob);
        }
        return { blobs, check, release };
    } catch (error) {
        release();
        throw error;
    }
}
