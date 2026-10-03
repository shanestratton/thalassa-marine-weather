/**
 * A recording stub Mapbox map for the ENC chart layer's stack (item f,
 * scale-ordered drawing): mountEncVectorLayer runs on it for real, and the
 * final layer order, filters and paint can be read back — so a test can say
 * which layer paints a feature, and what paints over what.
 */
import type { Feature } from 'geojson';
import type mapboxgl from 'mapbox-gl';
import { evalExpr } from '../enc/exprEval';

export interface StubLayer {
    id: string;
    type: string;
    source?: string;
    filter?: unknown;
    paint: Record<string, unknown>;
}

export function recordingMap() {
    const layers: StubLayer[] = [];
    const sources = new Map<string, unknown>();
    const indexOf = (id: string) => layers.findIndex((l) => l.id === id);
    const insert = (layer: StubLayer, beforeId?: string) => {
        const at = beforeId ? indexOf(beforeId) : -1;
        if (at >= 0) layers.splice(at, 0, layer);
        else layers.push(layer);
    };
    const target = {
        getStyle: () => ({ layers: layers.map((l) => ({ id: l.id, type: l.type })) }),
        getSource: (id: string) => (sources.has(id) ? { setData: (d: unknown) => void sources.set(id, d) } : undefined),
        addSource: (id: string, spec: { data: unknown }) => void sources.set(id, spec.data),
        getLayer: (id: string) => layers.find((l) => l.id === id),
        addLayer: (
            spec: { id: string; type: string; source?: string; filter?: unknown; paint?: Record<string, unknown> },
            beforeId?: string,
        ) =>
            insert(
                { id: spec.id, type: spec.type, source: spec.source, filter: spec.filter, paint: { ...spec.paint } },
                beforeId,
            ),
        moveLayer: (id: string, beforeId?: string) => {
            const at = indexOf(id);
            if (at < 0) return;
            const [layer] = layers.splice(at, 1);
            insert(layer, beforeId);
        },
        removeLayer: (id: string) => {
            const at = indexOf(id);
            if (at >= 0) layers.splice(at, 1);
        },
        setFilter: (id: string, filter: unknown) => {
            const layer = layers.find((l) => l.id === id);
            if (layer) layer.filter = filter ?? undefined;
        },
        setPaintProperty: (id: string, prop: string, value: unknown) => {
            const layer = layers.find((l) => l.id === id);
            if (layer) layer.paint[prop] = value;
        },
        getFilter: (id: string) => layers.find((l) => l.id === id)?.filter,
        isMoving: () => false,
        areTilesLoaded: () => true,
    };
    const map = new Proxy(target, {
        get: (t, prop: string) => (prop in t ? (t as Record<string, unknown>)[prop] : () => undefined),
    }) as unknown as mapboxgl.Map;
    return { map, layers };
}

/** The final stack position of every FILL / LINE layer that paints `f` from
 *  `source` (its filter, evaluated at chart zoom 12, passes). */
export function paintedAt(layers: StubLayer[], source: string, f: Feature): number[] {
    const kind = f.geometry.type.includes('Polygon') ? 'fill' : f.geometry.type.includes('LineString') ? 'line' : '';
    const out: number[] = [];
    layers.forEach((l, i) => {
        if (l.source !== source || l.type !== kind) return;
        if (l.filter !== undefined && l.filter !== null) {
            let pass = false;
            try {
                pass =
                    evalExpr(l.filter, { props: (f.properties ?? {}) as Record<string, unknown>, zoom: 12 }) === true;
            } catch {
                pass = false;
            }
            if (!pass) return;
        }
        // A fill painted at opacity 0 (the satellite base) paints nothing.
        if (l.paint['fill-opacity'] === 0) return;
        out.push(i);
    });
    return out;
}
