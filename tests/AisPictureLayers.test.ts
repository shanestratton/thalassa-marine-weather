import type mapboxgl from 'mapbox-gl';
import { describe, expect, it } from 'vitest';
import { ensureAisPictureLayers, writeAisMapData } from '../components/map/aisPictureLayers';

const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const picture: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', properties: { kind: 'ghost' }, geometry: { type: 'Point', coordinates: [151, -27] } },
    ],
};
function fixture() {
    const sources = new Map<string, { writes: number; setData: () => void }>();
    const layers = new Set<string>();
    const calls = { sources: 0, layers: 0 };
    const map = {
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => layers.has(id),
        addSource: (id: string) => {
            calls.sources++;
            const source = {
                writes: 0,
                setData() {
                    this.writes++;
                },
            };
            sources.set(id, source);
        },
        addLayer: (layer: { id: string }) => {
            calls.layers++;
            layers.add(layer.id);
        },
    } as unknown as mapboxgl.Map;
    return { map, sources, layers, calls };
}
describe('AIS picture resource lifecycle', () => {
    it('keeps an empty chart at zero resource allocations and zero writes across age ticks', () => {
        const f = fixture();
        for (const id of ['ais-targets', 'ais-predicted-tracks', 'ais-guard-zone'])
            f.map.addSource(id, { type: 'geojson', data: empty });
        f.calls.sources = 0;
        for (let tick = 0; tick < 60; tick++) {
            for (const id of [
                'ais-targets',
                'ais-predicted-tracks',
                'ais-guard-zone',
                'ais-dr-estimates',
                'ais-target-trail',
            ])
                writeAisMapData(f.map, id, empty);
            ensureAisPictureLayers(f.map, false);
        }
        expect(f.calls).toEqual({ sources: 0, layers: 0 });
        expect([...f.sources.values()].every((s) => s.writes === 0)).toBe(true);
    });
    it('creates the DR resources once, only when a stale moving target exists', () => {
        const f = fixture();
        writeAisMapData(f.map, 'ais-dr-estimates', picture);
        ensureAisPictureLayers(f.map, true);
        writeAisMapData(f.map, 'ais-dr-estimates', picture);
        ensureAisPictureLayers(f.map, true);
        expect(f.calls).toEqual({ sources: 1, layers: 3 });
        expect(f.sources.get('ais-dr-estimates')!.writes).toBe(0);
    });
    it('clears once on hiding, then restores the same picture', () => {
        const f = fixture();
        writeAisMapData(f.map, 'ais-target-trail', picture);
        writeAisMapData(f.map, 'ais-target-trail', empty);
        writeAisMapData(f.map, 'ais-target-trail', empty);
        writeAisMapData(f.map, 'ais-target-trail', picture);
        expect(f.sources.get('ais-target-trail')!.writes).toBe(2);
    });
    it('recreates content after a style reload instead of reusing the old source cache', () => {
        const f = fixture();
        writeAisMapData(f.map, 'ais-dr-estimates', picture);
        ensureAisPictureLayers(f.map, true);
        f.sources.clear();
        f.layers.clear();
        writeAisMapData(f.map, 'ais-dr-estimates', picture);
        ensureAisPictureLayers(f.map, true);
        expect(f.calls).toEqual({ sources: 2, layers: 6 });
    });
});
