import { vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { AtmosView } from '../../services/weather/api/atmosSession';

type Layer = { id: string; source?: string; type: string; layout?: { visibility?: string } };
export function ownedVectorFixture() {
    const sources = new Map<string, object>();
    let layers: Layer[] = [
        { id: 'hybrid-base-layer', type: 'raster' },
        { id: 'enc-vec-depth', type: 'fill' },
    ];
    const events = new Map<string, Set<(event: unknown) => void>>();
    const map = {
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => layers.find((layer) => layer.id === id),
        getStyle: () => ({ layers }),
        isSourceLoaded: () => true,
        on: (name: string, callback: (event: unknown) => void) => {
            if (!events.has(name)) events.set(name, new Set());
            events.get(name)!.add(callback);
        },
        off: (name: string, callback: (event: unknown) => void) => {
            events.get(name)?.delete(callback);
        },
        emit: (name: string, event: unknown = {}) => {
            for (const callback of [...(events.get(name) ?? [])]) callback(event);
        },
        addSource: vi.fn((id: string, source: object) => {
            sources.set(id, source);
        }),
        addLayer: vi.fn((layer: Layer, before?: string) => {
            const index = layers.findIndex((item) => item.id === before);
            layers.splice(index < 0 ? layers.length : index, 0, layer);
        }),
        removeLayer: vi.fn((id: string) => {
            layers = layers.filter((layer) => layer.id !== id);
        }),
        removeSource: vi.fn((id: string) => {
            if (layers.some((layer) => layer.source === id)) throw new Error('Source still used');
            sources.delete(id);
        }),
        setLayoutProperty: vi.fn((id: string, _key: string, visibility: string) => {
            const layer = layers.find((layer) => layer.id === id);
            if (layer) layer.layout = { visibility };
        }),
        getLayoutProperty: (id: string) => layers.find((layer) => layer.id === id)?.layout?.visibility,
        moveLayer: vi.fn((id: string, before?: string) => {
            const layer = layers.find((item) => item.id === id)!;
            layers = layers.filter((item) => item.id !== id);
            const index = layers.findIndex((item) => item.id === before);
            layers.splice(index < 0 ? layers.length : index, 0, layer);
        }),
        content: () => map.emit('sourcedata', { sourceId: 'atmos-pressure-symbols-source', sourceDataType: 'content' }),
        restyle: () => {
            sources.clear();
            layers = [
                { id: 'hybrid-base-layer', type: 'raster' },
                { id: 'enc-vec-depth', type: 'fill' },
            ];
            map.emit('style.load');
        },
        sources,
        events,
    };
    const mapRef = { current: map as unknown as mapboxgl.Map };
    let current = true;
    const view: AtmosView = {
        dataset: 'ifs-pressure',
        generation: 'fixture',
        runMs: 0,
        validMs: 0,
        fields: {},
        isCurrent: () => current,
    };
    return {
        map,
        mapRef,
        view,
        retire: () => {
            current = false;
        },
    };
}
