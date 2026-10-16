import type { Feature, Geometry } from 'geojson';
import { cellsForBBox } from './EncCellMetadata';
import { peekCellGeoJSON } from './EncCellStore';
import { holdingGroundAt } from './seabed';

/** Synchronous advice from the active library's already-loaded chart cells.
 * Geometry and the answer remain local and ephemeral. An unloaded/changed
 * cell cannot turn a partial read into a known bottom. */
export function currentHoldingGroundAt(lat: number, lon: number) {
    const unknown = () => holdingGroundAt(lat, lon, []);
    if (![lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return unknown();
    try {
        const dy = 25 / 110000,
            dx = Math.min(180, dy / Math.max(0.001, Math.cos((lat * Math.PI) / 180)));
        const windows: [number, number][] =
            lon - dx < -180
                ? [
                      [lon - dx + 360, 180],
                      [-180, lon + dx],
                  ]
                : lon + dx > 180
                  ? [
                        [lon - dx, 180],
                        [-180, lon + dx - 360],
                    ]
                  : [[lon - dx, lon + dx]];
        const selected = new Map(
            windows
                .flatMap(([west, east]) => cellsForBBox([west, Math.max(-90, lat - dy), east, Math.min(90, lat + dy)]))
                .map((c) => [c.id, c]),
        );
        if (selected.size > 64) return unknown();
        const features: Feature<Geometry>[] = [];
        for (const cell of selected.values()) {
            const blob = peekCellGeoJSON(cell.id);
            if (!blob || blob.edition !== cell.edition || blob.sourceHO !== cell.sourceHO) return unknown();
            for (const cls of ['SBDARE', 'WEDKLP'] as const) {
                const rows = blob.layers[cls]?.features ?? [];
                if (features.length + rows.length > 8192) return unknown();
                for (const f of rows)
                    features.push({
                        ...f,
                        properties: { ...f.properties, _caution: cls, _reference: cell.usage === 'reference' },
                    });
            }
        }
        return holdingGroundAt(lat, lon, features);
    } catch {
        return unknown();
    }
}
