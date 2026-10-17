import type mapboxgl from 'mapbox-gl';
import type { ReliefDisplayRegion } from '../../services/reliefDisplayRegions';
import { reliefViewportCovered } from '../../services/reliefViewport';

const owners = new WeakMap<object, { stop(): void; owns(id: string): boolean }>();
export const ownsSparseRelief = (map: object, id: string): boolean => owners.get(map)?.owns(id) === true;
let sequence = 0;
export const SPARSE_RELIEF_OWNER = 'thalassaSparseReliefOwner';
/** One map/style owner. Sparse sources leave the GPU cache when the view leaves
 * their actual tile footprint. Foreign sources/layers are never overwritten. */
export function installSparseReliefOwner(
    map: mapboxgl.Map,
    regions: readonly ReliefDisplayRegion[],
    mount: (region: ReliefDisplayRegion, token: string) => void,
    repaint: () => void,
): void {
    owners.get(map)?.stop();
    if (typeof map.on !== 'function' || typeof map.getBounds !== 'function') return;
    const token = `relief-${++sequence}`;
    const owned = new Map<string, readonly (WeakRef<object> | undefined)[]>();
    let stopped = false;
    const sourceIds = (id: string) => [`relief-${id}-idx`, `relief-${id}-dem`];
    const layerIds = (id: string) => [`relief-${id}-tint`, `relief-${id}-shade`];
    const retire = (id: string) => {
        const entry = owned.get(id);
        if (!entry) return;
        const sources = sourceIds(id),
            layers = layerIds(id);
        // getLayer serializes its result: object identity is not stable. Its
        // private marker and the actual source object jointly prove ownership.
        if (
            sources.some((s, i) => map.getSource(s) && map.getSource(s) !== entry[i]?.deref()) ||
            layers.some((l) => {
                const layer = map.getLayer(l);
                return (
                    layer && (layer.metadata as Record<string, unknown> | undefined)?.[SPARSE_RELIEF_OWNER] !== token
                );
            })
        )
            return;
        for (const l of layers) if (map.getLayer(l)) map.removeLayer(l);
        for (const s of sources) if (map.getSource(s)) map.removeSource(s);
        owned.delete(id);
    };
    const sync = () => {
        if (stopped) return;
        const b = map.getBounds();
        const bounds = b ? ([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as const) : null;
        let changed = false;
        for (const region of regions) {
            const wanted = !!bounds && reliefViewportCovered(region, bounds, map.getZoom());
            if (!wanted) {
                if (owned.has(region.id)) {
                    retire(region.id);
                    changed = true;
                }
                continue;
            }
            if (
                owned.has(region.id) ||
                [...sourceIds(region.id), ...layerIds(region.id)].some((id) => map.getSource(id) || map.getLayer(id))
            )
                continue;
            try {
                mount(region, token);
            } finally {
                // A partial add still belongs to this owner and must be
                // retired on reinitialisation/exit. Never pin an old cache.
                owned.set(
                    region.id,
                    sourceIds(region.id).map((id) => {
                        const source = map.getSource(id);
                        return source ? new WeakRef(source) : undefined;
                    }),
                );
            }
            changed = true;
        }
        if (changed) repaint();
    };
    const removed = () => stop(false);
    const stop = (remove = true) => {
        if (stopped) return;
        stopped = true;
        map.off('moveend', sync);
        map.off('remove', removed);
        if (remove) for (const id of owned.keys()) retire(id);
        owned.clear();
        owners.delete(map);
    };
    owners.set(map, {
        stop,
        owns: (id) => {
            const entry = owned.get(id);
            return (
                !!entry &&
                sourceIds(id).every((s, i) => !!map.getSource(s) && map.getSource(s) === entry[i]?.deref()) &&
                layerIds(id).every(
                    (l) =>
                        (map.getLayer(l)?.metadata as Record<string, unknown> | undefined)?.[SPARSE_RELIEF_OWNER] ===
                        token,
                )
            );
        },
    });
    map.on('moveend', sync);
    map.on('remove', removed);
    sync();
}
