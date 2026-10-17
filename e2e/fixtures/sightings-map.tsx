/** Real shared map with fictional private sightings only; browser routes every request to generated tiles. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import '../../index.css';
import '../../components/sightings/sightings.css';
import type { SightingItem } from '../../components/sightings/sightingsFormat';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const params = new URLSearchParams(location.search);
const maps: mapboxgl.Map[] = [];
const AppMap = mapboxgl.Map;
let removed = 0;
(mapboxgl as unknown as { Map: unknown }).Map = class extends AppMap {
    constructor(options: mapboxgl.MapboxOptions) {
        super(options);
        maps.push(this);
        this.once('remove', () => removed++);
    }
};
const [{ SightingsMap }, { seaBaseLayers }] = await Promise.all([
    import('../../components/sightings/SightingsMap'),
    import('../../components/map/reliefBase'),
]);
const dateline = params.has('offline');
const point = (id: string, latitude: number, longitude: number, observerId: string): SightingItem => ({
    id,
    latitude,
    longitude,
    observerId,
    group: 'whale',
    scientificName: null,
    vernacularName: id,
    count: 1,
    hasCalf: false,
    eventDate: '2026-10-16T00:00:00Z',
    visibility: 'crew',
    observerDisplay: null,
    positionSource: 'bus',
    vesselOwnerId: 'fictional-mine',
    voyageId: null,
    local: null,
    server: null,
    publicRow: null,
    syncState: null,
});
const items = dateline
    ? [
          point('Fictional private whale', -17.1, 179.8, 'fictional-mine'),
          point('Fictional crew turtle', -17.15, -179.8, 'fictional-crew'),
      ]
    : [
          point('Fictional private whale', 50.765, -1.297, 'fictional-mine'),
          point('Fictional crew turtle', 50.751, -1.33, 'fictional-crew'),
      ];
const listeners = new Set<(mounted: boolean) => void>();
Object.assign(window, {
    __logMapFixture: {
        ready: true,
        maps,
        taps: { count: 0 },
        // Solent/Fiji are outside the frozen sparse AU/NZ footprints. Absence
        // is asserted explicitly rather than ignoring the new regional layers.
        expected: seaBaseLayers('reliefSat').map(([id, on]): [string, boolean | null] => [
            id,
            /^relief-(?:au250|nz)-/.test(id) ? null : on,
        ]),
        boat: [items[0].longitude, items[0].latitude],
        spots: {},
        boatIndex: 0,
        get removed() {
            return removed;
        },
        mount: () => listeners.forEach((listener) => listener(true)),
        unmount: () => listeners.forEach((listener) => listener(false)),
        forget: () => undefined,
        at: (lon: number, lat: number) => maps.at(-1)!.project([lon, lat]),
        probe(lon: number, lat: number): Promise<number[] | null> {
            const map = maps.at(-1)!;
            const canvas = map.getCanvas();
            const reference = map.getCenter().lng;
            const p = map.project([lon + 360 * Math.round((reference - lon) / 360), lat]);
            return new Promise((resolve) => {
                map.once('render', () => {
                    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
                    const binding = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    const pixel = new Uint8Array(4),
                        scale = canvas.width / canvas.clientWidth;
                    gl.readPixels(
                        Math.round(p.x * scale),
                        Math.round(canvas.height - p.y * scale),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                    );
                    gl.bindFramebuffer(gl.FRAMEBUFFER, binding);
                    resolve([...pixel]);
                });
                map.triggerRepaint();
            });
        },
    },
});
function Fixture() {
    const [mounted, setMounted] = React.useState(true),
        [opened, setOpened] = React.useState('');
    React.useEffect(() => {
        listeners.add(setMounted);
        return () => {
            listeners.delete(setMounted);
        };
    }, []);
    return (
        <main className="sg-scope h-dvh bg-slate-950 p-2 text-white">
            <p data-testid="opened">{opened}</p>
            <div style={{ height: 'calc(100dvh - 48px)' }}>
                {mounted && (
                    <SightingsMap
                        items={items}
                        myUserId="fictional-mine"
                        isOffline={params.has('offline')}
                        onOpen={(item) => setOpened(item.id)}
                    />
                )}
            </div>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
