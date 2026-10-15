/** Read chart datum proof from existing blobs only. No fetch/reconversion,
 * no registry writes, no new persistence for licensed chart metadata. */
import { displayCellsForBBox, cellsForBBox, getVersion } from './EncCellMetadata';
import { loadCellGeoJSON } from './EncCellStore';
import { matchingSoundingDatum, type ChartBounds, type SoundingDatum } from './chartDatum';

export async function readChartDatumForBounds(bounds: ChartBounds, display = false): Promise<SoundingDatum | null> {
    if (
        !bounds.every(Number.isFinite) ||
        bounds[0] > bounds[2] ||
        bounds[1] > bounds[3] ||
        bounds[0] < -180 ||
        bounds[2] > 180 ||
        bounds[1] < -90 ||
        bounds[3] > 90
    )
        return null;
    const version = getVersion();
    const records = display ? displayCellsForBBox(bounds) : cellsForBBox(bounds);
    if (records.length === 0) return null;
    // Serial reads avoid cloning an entire licensed corpus at once.
    let datum: SoundingDatum | null = null;
    for (const record of records) {
        let cell;
        try {
            cell = await loadCellGeoJSON(record.id, false);
        } catch {
            return null;
        }
        if (!cell) return null;
        const next = matchingSoundingDatum([cell]);
        if (!next || (datum !== null && datum !== next)) return null;
        datum = next;
    }
    return getVersion() === version ? datum : null;
}
