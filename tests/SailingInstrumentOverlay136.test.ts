import { beforeEach, describe, expect, it, vi } from 'vitest';
const markers = vi.hoisted(
    () =>
        [] as Array<{
            remove: ReturnType<typeof vi.fn>;
            setLngLat: ReturnType<typeof vi.fn>;
            setOffset: ReturnType<typeof vi.fn>;
            addTo: ReturnType<typeof vi.fn>;
        }>,
);
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            remove = vi.fn();
            setLngLat = vi.fn(() => this);
            setOffset = vi.fn(() => this);
            addTo = vi.fn(() => this);
            constructor() {
                markers.push(this);
            }
        },
    },
}));
import { InstrumentOverlayRenderer } from '../components/map/SailingInstrumentOverlay';
import { nextFollowedMark } from '../services/instruments/nextMark';
import type mapboxgl from 'mapbox-gl';
import type { VoyagePlan } from '../types/navigation';
const NOW = Date.parse('2026-10-16T10:00:00Z');
const current = {
    kind: 'available' as const,
    provenance: 'instrument-derived' as const,
    identity: 'boat',
    via: 'lan' as const,
    eastKts: 1,
    northKts: 0,
    driftKts: 1,
    setTrueDeg: 90,
    observedAt: NOW,
    computedAt: NOW,
    freshness: 'live' as const,
    leewayDeg: null,
    leewaySource: null,
    sources: ['test'],
};
function fixture() {
    const sources = new Map(),
        layers = new Map(),
        events = new Map();
    const map = {
        on: vi.fn((event, fn) => events.set(event, fn)),
        off: vi.fn(),
        once: vi.fn((event, fn) => events.set(event, fn)),
        getBearing: () => 30,
        project: () => ({ x: 150, y: 300 }),
        getContainer: () => ({ clientWidth: 300, clientHeight: 667 }),
        isStyleLoaded: () => true,
        getSource: (key: string) => sources.get(key),
        getLayer: (key: string) => layers.get(key),
        addSource: vi.fn((key: string, value: unknown) => sources.set(key, { value, setData: vi.fn() })),
        addLayer: vi.fn((value: { id: string }) => layers.set(value.id, value)),
        removeLayer: vi.fn((key: string) => layers.delete(key)),
        removeSource: vi.fn((key: string) => sources.delete(key)),
    };
    return { map: map as unknown as mapboxgl.Map, raw: map, sources, layers, events };
}
beforeEach(() => (markers.length = 0));
describe('source-free instrument overlay ownership', () => {
    it('updates one private boat marker, rebuilds only its local style source and fully cleans up', () => {
        const f = fixture(),
            r = new InstrumentOverlayRenderer(f.map);
        const frame = {
            position: { lat: 30, lon: -60 },
            current,
            laylines: {
                observedAt: NOW,
                correction: 'local-instrument-current' as const,
                note: 'Local only',
                mode: 'upwind' as const,
                lines: [
                    {
                        tack: 'port' as const,
                        headingTrueDeg: 45,
                        groundCourseTrueDeg: 50,
                        points: [
                            { lat: 30, lon: -60 },
                            { lat: 30.01, lon: -60 },
                        ] as [{ lat: number; lon: number }, { lat: number; lon: number }],
                    },
                ],
            },
            markName: 'Test mark',
            now: NOW,
        };
        r.update(frame);
        r.update({ ...frame, now: NOW + 1000 });
        expect(markers).toHaveLength(1);
        expect(markers[0].setLngLat).toHaveBeenCalledWith([-60, 30]);
        expect(f.raw.addSource).toHaveBeenCalledTimes(1);
        expect([...f.sources.values()][0].value.type).toBe('geojson');
        expect(f.raw.addLayer).toHaveBeenCalledTimes(1);
        f.sources.clear();
        f.layers.clear();
        f.events.get('style.load')();
        expect(f.raw.addSource).toHaveBeenCalledTimes(2);
        r.destroy();
        expect(markers[0].remove).toHaveBeenCalledOnce();
        expect(f.sources.size).toBe(0);
        expect(f.layers.size).toBe(0);
        expect(f.raw.off).toHaveBeenCalledWith('move', expect.any(Function));
    });
    it('removes the marker and guides immediately on source refusal, without leaving model-current layers affected', () => {
        const f = fixture();
        f.layers.set('model-current', { id: 'model-current' });
        const r = new InstrumentOverlayRenderer(f.map);
        r.update({ position: { lat: 30, lon: -60 }, current, laylines: null, markName: null, now: NOW });
        r.update({ position: null, current: null, laylines: null, markName: null, now: NOW });
        expect(markers[0].remove).toHaveBeenCalledOnce();
        expect(f.layers.has('model-current')).toBe(true);
        r.destroy();
    });
});
describe('explicit followed marks', () => {
    const route = [
        { lat: 30, lon: -60 },
        { lat: 30.02, lon: -60 },
        { lat: 30.04, lon: -60 },
    ];
    const plan = {
        waypoints: [{ name: 'Middle', coordinates: route[1] }],
        destination: 'Finish',
        destinationCoordinates: route[2],
    } as VoyagePlan;
    it('uses the next real waypoint, then the real destination after passing it', () => {
        expect(nextFollowedMark(route, plan, { lat: 30.005, lon: -60 })?.name).toBe('Middle');
        expect(nextFollowedMark(route, plan, { lat: 30.025, lon: -60 })?.name).toBe('Finish');
    });
    it('refuses off-route/unknown/ambiguous marks instead of substituting a route vertex', () => {
        expect(nextFollowedMark(route, null, route[0])).toBeNull();
        expect(nextFollowedMark(route, plan, { lat: 30, lon: -59 })).toBeNull();
        expect(
            nextFollowedMark(
                route,
                { ...plan, waypoints: [{ name: 'Wrong', coordinates: { lat: 31, lon: -60 } }] },
                route[0],
            ),
        ).toBeNull();
    });
});

it('queues one owned idle retry when another source delays style readiness, and cancels it on teardown', () => {
    const f = fixture();
    let ready = false;
    f.raw.isStyleLoaded = () => ready;
    const renderer = new InstrumentOverlayRenderer(f.map);
    const frame = { position: { lat: 30, lon: -60 }, current, laylines: null, markName: null, now: NOW };
    renderer.update(frame);
    renderer.update(frame);
    expect(f.raw.once).toHaveBeenCalledTimes(1);
    ready = true;
    f.events.get('idle')();
    expect(f.raw.once).toHaveBeenCalledTimes(1);
    ready = false;
    renderer.update(frame);
    renderer.destroy();
    expect(f.raw.off).toHaveBeenCalledWith('idle', expect.any(Function));
});
