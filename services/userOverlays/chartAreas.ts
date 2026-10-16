import type { Feature, Geometry } from 'geojson';
import type { EncMergedVectorData } from '../enc/EncHazardService';
import { getDisplayCell, getVersion } from '../enc/EncCellMetadata';
import { readS57 } from '../enc/types';
import { encCellContentIdentity } from '../enc/cellContentIdentity';
import { restrnCodes, restrnMeaning } from '../enc/s57Restrn';
import { getPairing } from '../PiPairingService';
import { boatLanBaseNow } from '../enc/piCellSync';
import { safeLabel } from './model';
import type { EntryArea } from './entry';

const providers = new WeakMap<object, () => EncMergedVectorData | null>();
/** Getter borrows the renderer's existing owner; stores no geometry itself. */
export function registerEntryChartView(map: object, get: () => EncMergedVectorData | null): () => void {
    providers.set(map, get);
    return () => {
        if (providers.get(map) === get) providers.delete(map);
    };
}
const codes = new Set(['7', '8', '13', '14', '27']);
function hash(text: string): string {
    let a = 2166136261,
        b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b ^ text.charCodeAt(i), 2246822519);
    }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
}
/** Synchronous/current renderer data only; never calls filesystem, Pi or WAN. */
export function borrowedEntryChartAreas(map: object): EntryArea[] | null {
    if (!getPairing() || !boatLanBaseNow()) return null;
    const version = getVersion(),
        data = providers.get(map)?.();
    if (!data) return null;
    const features = data.CAUTION_AREAS.features;
    if (features.length > 50000) return null;
    const areas: EntryArea[] = [];
    let vertices = 0;
    for (const feature of features as Feature<Geometry>[]) {
        if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') continue;
        const selected = restrnCodes(readS57(feature.properties, 'RESTRN')).filter((c) => codes.has(c));
        if (!selected.length) continue;
        const id = String(feature.properties?._cellId ?? ''),
            cell = getDisplayCell(id);
        if (!cell || cell.usage === 'reference' || cell.usage === 'pending') return null;
        const rings =
            feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
        for (const ring of rings) {
            vertices += ring.length;
            if (vertices > 50000) return null;
        }
        // LNAM alone can repeat between source revisions; bind the exact cell
        // content and geometry too. Distinct unnamed polygons remain distinct.
        const geometry = JSON.stringify(feature.geometry);
        if (geometry.length > 1024 * 1024) return null;
        const lnam = readS57(feature.properties, 'LNAM');
        areas.push({
            key: `enc:${encCellContentIdentity(cell)}:${typeof lnam === 'string' && /^[a-f0-9]{16}$/i.test(lnam) ? lnam : ''}:${hash(geometry)}`,
            label:
                safeLabel(readS57(feature.properties, 'OBJNAM'), 'Charted area') +
                ': ' +
                selected.map(restrnMeaning).join(', '),
            source: 'displayed chart aboard',
            geometry: feature.geometry,
        });
        // The label describes where the check runs; protected geometry has the
        // same strict aboard gate and is never copied into an overlay file.
        if (areas.length > 2000) return null;
    }
    return version === getVersion() && getPairing() && boatLanBaseNow() ? areas : null;
}
