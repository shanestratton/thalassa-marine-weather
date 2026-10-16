/** Bounded local view, never a whole-cell read. Caller owns the lease until
 * every index/merge borrowing this geometry is detached. No cache or WAN. */
import { noaaPartIntersects, noaaPartBounds, NOAA_PART_BYTES } from './noaaPackageContract';
import { readNoaaPackage, readNoaaPackagePart } from './noaaPackageStore';
import { reserveNoaaResident } from './EncCellStore';
import type { EncCell, EncConversionResult } from './types';
import { getVersion } from './EncCellMetadata';

export async function loadNoaaPackageWindow(
    cell: EncCell,
    bounds: [number, number, number, number],
    assertCurrent: () => void = () => {},
): Promise<{ blob: EncConversionResult; bytes: number; release: () => void }> {
    if (!noaaPartBounds(bounds)) throw Error('Invalid NOAA chart view.');
    const version = getVersion(),
        lease = reserveNoaaResident(NOAA_PART_BYTES);
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
        lease.resize(bytes + NOAA_PART_BYTES);
        for (const part of manifest.parts) {
            check();
            if (!noaaPartIntersects(part.bbox, bounds)) continue;
            // Sequential: at most one <=4MiB part is read/decoded at a time.
            const selected = await readNoaaPackagePart(cell, manifest, part, bounds);
            check();
            bytes += selected.selectedBytes;
            // Reserve BEFORE retaining a part. Over budget discards this entire
            // view; it never returns a truncated set or invented clear water.
            lease.resize(bytes + NOAA_PART_BYTES);
            for (const [name, fc] of Object.entries(selected.layers)) {
                if (fc)
                    for (const feature of fc.features)
                        blob.layers[name as keyof typeof blob.layers]!.features.push(feature);
            }
        }
        check();
        lease.resize(bytes);
        return { blob, bytes, release: lease.release };
    } catch (error) {
        lease.release();
        throw error;
    }
}
