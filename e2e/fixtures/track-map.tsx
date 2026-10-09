/**
 * The big Log track map on Relief + Sat (125-13b), drawn for real by Mapbox GL
 * in the app's own TrackMapViewer, offline: the spec (browser-tests/
 * track-map-viewer-layout.spec.ts) answers every tile from made-up coastlines
 * (e2e/helpers/syntheticChartTiles.ts). Fictional boats on fictional tracks
 * at public waters.
 *
 *   ?screen=solent       a sailed voyage out of Cowes, west down the Solent,
 *                        coloured by forecast wind, with the route it followed
 *   ?screen=fiji         Savusavu Bay east across the antimeridian
 *   ?screen=whitsundays  a planned route and the voyage sailed beside it
 *                        (the GBR 30 m relief grid)
 *   ?screen=heap         the viewer closed; the spec opens and closes it
 *   ?pi=1                the boat's Pi can serve tiles (a fictional host;
 *                        forced on here, dormant in the app until
 *                        PI_TILE_PROXY_USABLE flips)
 *   ?webgl=0             a web view with no WebGL (Lockdown Mode)
 *   ?note=long           the Solent's waypoint carries a note of several lines
 *   ?fonts=wide          Verdana / DejaVu Sans, as the Linux runner draws
 *
 * window.__logMapFixture (the shape e2e/helpers/logMapBrowser.ts reads):
 * every Mapbox map the page built, the layers seaBaseLayers('reliefSat') says
 * are on, named places on the track, a pixel probe, and open/close.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import '../../index.css';
import type { ShipLogEntry } from '../../types';
import type { RouteCoordinate } from '../../utils/routeCoordinates';

const params = new URLSearchParams(location.search);
const screenName = params.get('screen') ?? 'solent';

if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

// No WebGL at all, as in Lockdown Mode: Mapbox cannot start.
if (params.get('webgl') === '0') {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        if (/webgl/.test(kind)) return null;
        return (getContext as (...args: unknown[]) => RenderingContext | null).call(this, kind, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
}

// Every Mapbox map the page builds, for the spec to read (the app keeps them private).
const maps: mapboxgl.Map[] = [];
const AppMap = mapboxgl.Map;
(mapboxgl as unknown as { Map: unknown }).Map = class extends AppMap {
    constructor(options: mapboxgl.MapboxOptions) {
        super(options);
        maps.push(this);
    }
};

// The boat's Pi, able to serve tiles to a map engine (in the app that waits on
// a transport that can present its pin; PiCacheService.PI_TILE_PROXY_USABLE).
if (params.get('pi') === '1') {
    const { piCache } = await import('../../services/PiCacheService');
    Object.assign(piCache, {
        canDisplayProxiedTiles: () => true,
        passthroughTileUrl: (url: string) =>
            `https://pi.fixture.test/api/passthrough-tile?${new URLSearchParams({ url, ttl: '1800000', ct: 'image/png' })}`,
    });
}

const [{ TrackMapViewer }, { seaBaseLayers }] = await Promise.all([
    import('../../components/TrackMapViewer'),
    import('../../components/map/reliefBase'),
]);
// The map's own chunk, loaded before anything is measured (Obs has mapbox-gl
// loaded in the app).
await import('../../components/TrackMapViewerGL');

const minute = (n: number) => new Date(Date.UTC(2026, 6, 4, 8, 0) + n * 60_000).toISOString();

interface FixOptions {
    voyageId: string;
    source?: ShipLogEntry['source'];
    windSpeed?: number;
    over?: Partial<ShipLogEntry>;
}

const fix = (i: number, lat: number, lon: number, { voyageId, source = 'device', windSpeed, over }: FixOptions) =>
    ({
        id: `fixture-${voyageId}-${i}`,
        userId: 'fixture-skipper',
        voyageId,
        latitude: lat,
        longitude: lon > 180 ? lon - 360 : lon,
        timestamp: minute(i * 6),
        positionFormatted: '',
        entryType: 'auto',
        source,
        isOnWater: true,
        windSpeed,
        windDirection: windSpeed === undefined ? undefined : 'SW',
        speedKts: source === 'planned_route' ? undefined : 4.2 + 0.1 * (i % 9),
        courseDeg: source === 'planned_route' ? undefined : 255,
        cumulativeDistanceNM: i * 0.45,
        airTemp: source === 'planned_route' ? undefined : 17,
        pressure: source === 'planned_route' ? undefined : 1016,
        waveHeight: source === 'planned_route' ? undefined : 0.6,
        ...over,
    }) as ShipLogEntry;

/**
 * "Sea Wren" out of Cowes, west down the Solent, then south-west for Hurst
 * (fictional). The wind builds from 4 to 26 kt, so the line runs through the
 * forecast-wind colours; a turn dot sits where she bears away.
 */
const LUNCH_NOTE =
    params.get('note') === 'long'
        ? 'Anchored off Newtown for lunch. The tide turned early, so we waited for the flood before beating west past Yarmouth, then tucked in a reef for the gusts off Hurst and kept the engine warm in case the wind died at the Needles.'
        : 'Anchored off Newtown for lunch';
const SOLENT_WINDS = [4, 4, 5, 5, 7, 8, 9, 10, 12, 13, 14, 15, 16, 18, 19, 20, 21, 23, 24, 25, 26, 25, 24, 23];
const SOLENT: ShipLogEntry[] = SOLENT_WINDS.map((wind, t) => {
    const west = t <= 15;
    const lon = west ? -1.297 - 0.0085 * t : -1.4245 - 0.009 * (t - 15);
    const lat = west ? 50.766 + 0.005 * Math.sin((Math.PI * t) / 15) : 50.766 - 0.0045 * (t - 15);
    return fix(t, lat, lon, { voyageId: 'fixture-solent', windSpeed: wind });
});
SOLENT.splice(
    11,
    0,
    fix(10.5, 50.7655, -1.3855, {
        voyageId: 'fixture-solent',
        windSpeed: 14,
        over: { entryType: 'waypoint', waypointName: 'Lunch stop', notes: LUNCH_NOTE },
    }),
);
const SOLENT_ROUTE: RouteCoordinate[] = [
    { lat: 50.768, lon: -1.296 },
    { lat: 50.776, lon: -1.36 },
    { lat: 50.766, lon: -1.425 },
    { lat: 50.732, lon: -1.497 },
];

/** Savusavu Bay east across the 180th meridian toward the Lau Group (fictional). */
const FIJI: ShipLogEntry[] = Array.from({ length: 24 }, (_, t) =>
    fix(t, -16.85 - 0.01 * t, 179.55 + 0.0435 * t, { voyageId: 'fixture-fiji', windSpeed: 15 + (t % 6) }),
);

/** Airlie Beach to Cid Harbour: the plan (north about), and the voyage sailed south of it (fictional). */
const WHITSUNDAYS_PLAN = [
    [-20.245, 148.722],
    [-20.215, 148.78],
    [-20.2, 148.85],
    [-20.205, 148.91],
    [-20.235, 148.945],
].map(([lat, lon], i) => fix(i, lat, lon, { voyageId: 'fixture-plan', source: 'planned_route' }));
const WHITSUNDAYS_SAILED = Array.from({ length: 18 }, (_, t) =>
    fix(t, -20.25 + 0.0018 * t, 148.725 + 0.012 * t, { voyageId: 'fixture-sailed', windSpeed: 9 + (t % 5) }),
);

const SCREENS: Record<string, { entries: ShipLogEntry[]; route?: RouteCoordinate[] }> = {
    solent: { entries: SOLENT, route: SOLENT_ROUTE },
    heap: { entries: SOLENT, route: SOLENT_ROUTE },
    fiji: { entries: FIJI },
    whitsundays: { entries: [...WHITSUNDAYS_PLAN, ...WHITSUNDAYS_SAILED] },
};
const { entries, route } = SCREENS[screenName] ?? SCREENS.solent;

/** The fix the spec scrubs the playback boat to (its slider index). */
const BOAT_INDEX = 14;
const lineFixes = entries.filter((e) => e.source !== 'planned_route');
const lonLat = (e: ShipLogEntry): [number, number] => [e.longitude, e.latitude];
/** Halfway along the leg from fix i to i + 1, as the map draws it (the short way round). */
const midLeg = (fixes: ShipLogEntry[], i: number): [number, number] => {
    const [a, b] = [fixes[i], fixes[i + 1]];
    const east = b.longitude - a.longitude < -180 ? b.longitude + 360 : b.longitude;
    return [(a.longitude + east) / 2, (a.latitude + b.latitude) / 2];
};
/** Fiji: the leg that crosses the 180th meridian. */
const CROSSING_LEG = FIJI.findIndex((e) => e.longitude < 0) - 1;

const spots: Record<string, [number, number]> = {
    start: lonLat(lineFixes[0]),
    end: lonLat(lineFixes[lineFixes.length - 1]),
    sea: screenName === 'whitsundays' ? [148.85, -20.17] : screenName === 'fiji' ? [179.7, -16.75] : [-1.36, 50.758],
    /**
     * Halfway along a leg, clear of the GPS dots and the turn dots: in the
     * Solent, its 22-28 kt stretch (strong: orange).
     */
    track: midLeg(lineFixes, screenName === 'solent' || screenName === 'heap' ? 21 : lineFixes.length >> 1),
    /** Fiji: halfway along the leg across 180°, past +180 as the map draws it. */
    crossing: midLeg(FIJI, CROSSING_LEG),
    /** Halfway along a leg of the plan, well north of the sailed line (Whitsundays). */
    plan: midLeg(WHITSUNDAYS_PLAN, 1),
};

const mountListeners = new Set<(open: boolean) => void>();
const fixture = {
    ready: true,
    screen: screenName,
    maps,
    taps: { count: 0 },
    expected: seaBaseLayers('reliefSat'),
    boat: lonLat([...lineFixes].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[BOAT_INDEX] ?? lineFixes[0]),
    boatIndex: BOAT_INDEX,
    spots,
    mount: () => mountListeners.forEach((listener) => listener(true)),
    unmount: () => mountListeners.forEach((listener) => listener(false)),
    /** Drop the fixture's own hold on removed maps, so the heap shows what the app keeps. */
    forget: () => {
        maps.length = 0;
    },
    /** Where [lon, lat] is on the screen (client pixels), on the newest map. */
    at(lon: number, lat: number) {
        const map = maps[maps.length - 1];
        const box = map.getCanvas().getBoundingClientRect();
        const p = map.project([lon, lat]);
        return { x: box.left + p.x, y: box.top + p.y };
    },
    /** One drawn pixel of the newest map, read in its render frame (no preserveDrawingBuffer). */
    probe(lon: number, lat: number): Promise<number[] | null> {
        const map = maps[maps.length - 1];
        const canvas = map.getCanvas();
        const p = map.project([lon, lat]);
        if (p.x < 0 || p.y < 0 || p.x >= canvas.clientWidth || p.y >= canvas.clientHeight) return Promise.resolve(null);
        const scale = canvas.width / canvas.clientWidth;
        return new Promise((resolve) => {
            map.once('render', () => {
                const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
                const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                const pixel = new Uint8Array(4);
                gl.readPixels(
                    Math.round(p.x * scale),
                    Math.round(canvas.height - p.y * scale),
                    1,
                    1,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    pixel,
                );
                gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
                resolve([...pixel]);
            });
            map.triggerRepaint();
        });
    },
};
(window as unknown as { __logMapFixture: typeof fixture }).__logMapFixture = fixture;

function Fixture() {
    const [open, setOpen] = useState(screenName !== 'heap');
    mountListeners.add(setOpen);
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-950 text-white">
            <section data-testid="page-frame" className="absolute inset-0 px-4 pt-4">
                <h1 className="ui-page-title text-xl font-extrabold uppercase tracking-wider text-white">Ship’s Log</h1>
                <button
                    type="button"
                    className="mt-4 rounded-xl border border-white/10 px-4 py-3 text-sm font-bold"
                    onClick={() => setOpen(true)}
                >
                    Open voyage track
                </button>
            </section>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the home indicator. */}
            <nav
                aria-label="Main"
                data-testid="app-bottom-nav"
                className="fixed right-0 bottom-0 left-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="mx-auto flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-400">
                    <span>The Glass</span>
                    <span>Obs</span>
                    <span>Plan</span>
                    <span className="text-sky-400">Log</span>
                    <span>Vessel</span>
                </div>
            </nav>
            <TrackMapViewer
                isOpen={open}
                onClose={() => setOpen(false)}
                entries={entries}
                followedRouteCoords={route}
            />
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
