import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadarPictureSnapshot } from '../services/radar/radarStore';
const f = vi.hoisted(() => ({
    snapshot: { version: 0, contacts: [], feeds: [] } as RadarPictureSnapshot,
    features: [] as GeoJSON.Feature<GeoJSON.Point>[],
    listeners: new Set<() => void>(),
    release: vi.fn(),
    retain: vi.fn(),
    popupContent: null as HTMLElement | null,
}));
vi.mock('../services/radar/radarStore', () => ({
    RadarStore: {
        getSnapshot: () => f.snapshot,
        subscribe: (fn: () => void) => {
            f.listeners.add(fn);
            return () => f.listeners.delete(fn);
        },
    },
}));
vi.mock('../services/radar/radarPiSession', () => ({ retainPiRadar: f.retain }));
vi.mock('../services/ais/aisTargetCache', () => ({
    readAisTargetPicture: () => f.features,
    subscribeAisTargetPicture: () => () => undefined,
}));
vi.mock('../services/AisGuardWatch', () => ({
    readCollisionInputs: () => ({ own: null, ownMmsis: new Set(), atAnchor: false, prefs: undefined }),
    gradeCollisionTargets: () => [],
}));
vi.mock('mapbox-gl', () => ({
    default: {
        Popup: class {
            el: HTMLElement | null = null;
            close: (() => void) | null = null;
            setLngLat() {
                return this;
            }
            setDOMContent(el: HTMLElement) {
                this.el = el;
                f.popupContent = el;
                return this;
            }
            addTo() {
                document.body.append(this.el!);
                return this;
            }
            on(_name: string, fn: () => void) {
                this.close = fn;
                return this;
            }
            remove() {
                this.el?.remove();
                this.close?.();
                return this;
            }
        },
    },
}));
import { useRadarLayer } from '../components/map/useRadarLayer';
import { RadarFeed } from '../utils/radarFeed';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function setup() {
    const feed = new RadarFeed('gateway:generated');
    for (const body of [
        'GPRMC,120000,A,0000.000,N,17959.940,E,5,0,020126,,,A',
        'HEHDT,0,T',
        'RATTM,1,1,90,R,10,180,R,0,6,N,<img src=x onerror=alert(1)>,T,,120000,A',
    ])
        feed.ingest(frame(body), T, T);
    f.snapshot = {
        version: 1,
        contacts: feed.contacts(T),
        feeds: [
            {
                feedId: feed.feedId,
                source: 'gateway',
                ownship: feed.ownshipSnapshot(),
                lastFrameAt: T,
                lastTargetAt: T,
            },
        ],
    };
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>(),
        layers = new Set<string>(),
        events = new Map<string, () => void>();
    const canvas = document.createElement('canvas');
    return {
        sources,
        layers,
        events,
        map: {
            isStyleLoaded: () => true,
            getCenter: () => ({ lng: 180 }),
            getSource: (id: string) => sources.get(id),
            getLayer: (id: string) => layers.has(id),
            addSource: vi.fn((id: string) => sources.set(id, { setData: vi.fn() })),
            addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
            removeSource: vi.fn((id: string) => sources.delete(id)),
            removeLayer: vi.fn((id: string) => layers.delete(id)),
            getCanvas: () => canvas,
            on: vi.fn((name: string, ...args: unknown[]) => {
                if (typeof args[0] === 'function') events.set(name, args[0] as () => void);
            }),
            off: vi.fn(),
        },
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.features = [];
    f.listeners.clear();
    f.release.mockReset();
    f.retain.mockReset().mockReturnValue(f.release);
    f.popupContent = null;
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('actual radar map source ownership', () => {
    it('draws original positions on the adjacent dateline world copy and restores style resources', () => {
        const m = setup();
        const h = renderHook(() => useRadarLayer(m.map as never, true));
        const write = m.sources.get('radar-targets')!.setData;
        expect(write.mock.calls.at(-1)![0].features[0].geometry.coordinates[0]).toBeGreaterThan(180);
        expect(h.result.current.size).toBe(0);
        m.sources.clear();
        m.layers.clear();
        act(() => m.events.get('style.load')!());
        expect(m.sources.has('radar-targets')).toBe(true);
        h.unmount();
        expect(m.sources.size).toBe(0);
        expect(m.layers.size).toBe(0);
        expect(f.release).toHaveBeenCalledOnce();
    });
    it('recovers an initially busy style on idle without repeatedly waking workers', () => {
        const m = setup();
        let loaded = false;
        m.map.isStyleLoaded = () => loaded;
        const h = renderHook(() => useRadarLayer(m.map as never, true));
        expect(m.sources.size).toBe(0);
        loaded = true;
        act(() => m.events.get('idle')!());
        const write = m.sources.get('radar-targets')!.setData;
        expect(write).toHaveBeenCalledOnce();
        act(() => m.events.get('idle')!());
        expect(write).toHaveBeenCalledOnce();
        h.unmount();
        expect(m.map.off).toHaveBeenCalledWith('idle', expect.any(Function));
    });
    it('hides a proven duplicate only after the real radar source accepted the combined picture', () => {
        const m = setup(),
            c = f.snapshot.contacts[0];
        f.features = [
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [c.position!.lon, c.position!.lat] },
                properties: {
                    mmsi: 123456789,
                    name: 'Generated match',
                    source: 'local',
                    lastUpdated: T,
                    sog: c.motion!.sogKn,
                    cog: c.motion!.cogTrueDeg,
                },
            },
        ];
        const h = renderHook(() => useRadarLayer(m.map as never, true));
        expect([...h.result.current]).toEqual([123456789]);
        expect(m.sources.get('radar-targets')!.setData.mock.calls.at(-1)![0].features).toHaveLength(1);
        f.snapshot = {
            ...f.snapshot,
            contacts: f.snapshot.contacts.map((contact) => ({
                ...contact,
                position: { ...contact.position!, lon: contact.position!.lon + 0.00001 },
            })),
        };
        m.sources.get('radar-targets')!.setData.mockImplementation(() => {
            throw Error('renderer unavailable');
        });
        act(() => f.listeners.forEach((fn) => fn()));
        expect(h.result.current.size).toBe(0);
    });
    it('uses safe text, keeps focused controls during refresh, and removes private popup on owner retirement', () => {
        const m = setup();
        renderHook(() => useRadarLayer(m.map as never, true));
        act(() =>
            window.dispatchEvent(
                new CustomEvent('thalassa:select-radar-target', {
                    detail: { contactKey: f.snapshot.contacts[0].contactKey },
                }),
            ),
        );
        expect(f.popupContent!.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(f.popupContent!.querySelector('img')).toBeNull();
        const button = f.popupContent!.querySelector('button')!;
        button.focus();
        act(() => f.listeners.forEach((fn) => fn()));
        expect(f.popupContent!.querySelector('button')).toBe(button);
        f.snapshot = { version: 2, contacts: [], feeds: [] };
        act(() => f.listeners.forEach((fn) => fn()));
        expect(document.body.contains(f.popupContent!)).toBe(false);
    });
    it('does not connect/read/create resources when display is off', () => {
        const m = setup();
        renderHook(() => useRadarLayer(m.map as never, false));
        expect(f.retain).not.toHaveBeenCalled();
        expect(m.map.addSource).not.toHaveBeenCalled();
    });
});
