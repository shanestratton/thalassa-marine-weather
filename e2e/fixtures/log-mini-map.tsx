/**
 * The little Log map on Relief + Sat (125-13a), drawn for real by Mapbox GL in
 * the app's own cards, offline: the spec (browser-tests/log-mini-map-layout.
 * spec.ts) answers every tile from made-up coastlines (e2e/helpers/
 * syntheticChartTiles.ts). Fictional boats and tracks at public harbours.
 *
 *   ?screen=live        the live recording card (LiveVoyageCard), in the Solent
 *   ?screen=fullscreen  its fullscreen map
 *   ?screen=planned     an expanded planned route card (VoyageCard), in the
 *                       Whitsundays (the GBR 30 m relief grid)
 *   ?screen=heap        a bare card-sized map the spec mounts and unmounts
 *   ?pi=1               the boat's Pi can serve tiles (a fictional host;
 *                       forced on here, dormant in the app until
 *                       PI_TILE_PROXY_USABLE flips)
 *   ?fonts=wide         Verdana / DejaVu Sans, as the Linux runner draws
 *
 * window.__logMapFixture: every Mapbox map the page built, the layers
 * seaBaseLayers('reliefSat') says are on, taps on the map, a pixel probe, and
 * mount/unmount for the heap screen.
 */
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import '../../index.css';
import type { ShipLogEntry } from '../../types';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';

const params = new URLSearchParams(location.search);
const screenName = params.get('screen') ?? 'live';

if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
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

const [{ LiveVoyageCard }, { VoyageCard }, { LiveMiniMap }, { seaBaseLayers }] = await Promise.all([
    import('../../pages/log/LiveVoyageCard'),
    import('../../pages/log/LogSubComponents'),
    import('../../components/LiveMiniMap'),
    import('../../components/map/reliefBase'),
]);
// The map's own chunk, loaded before anything is measured (Obs has it loaded in the app).
await import('../../components/LiveMiniMapGL');

const minute = (n: number) => new Date(Date.UTC(2026, 9, 9, 7, n)).toISOString();
const fix = (i: number, lat: number, lon: number, source = 'device'): ShipLogEntry =>
    ({
        id: `fixture-${source}-${i}`,
        userId: 'fixture-skipper',
        voyageId: source === 'planned_route' ? 'fixture-plan' : 'fixture-live',
        latitude: lat,
        longitude: lon,
        timestamp: minute(i * 4),
        positionFormatted: '',
        entryType: 'auto',
        source,
        cumulativeDistanceNM: i * 0.27,
    }) as ShipLogEntry;

/** Out of Cowes, west down the Solent (a fictional boat, "Sea Wren"). */
const SOLENT_TRACK = Array.from({ length: 24 }, (_, t) =>
    fix(t, 50.765 + 0.012 * Math.sin((t / 23) * Math.PI) - 0.008 * (t / 23), -1.297 - 0.006 * t),
);
const SOLENT_ROUTE = [
    { lat: 50.766, lon: -1.296 },
    { lat: 50.778, lon: -1.36 },
    { lat: 50.758, lon: -1.45 },
    { lat: 50.72, lon: -1.53 },
];
/** Airlie Beach to Cid Harbour, planned. */
const WHITSUNDAYS_PLAN = [
    [-20.245, 148.722],
    [-20.24, 148.78],
    [-20.225, 148.85],
    [-20.22, 148.91],
    [-20.235, 148.945],
].map(([lat, lon], i) => fix(i, lat, lon, 'planned_route'));

const taps = { count: 0 };
const liveStats = {
    activeEntries: SOLENT_TRACK,
    first: SOLENT_TRACK[0],
    dist: 6.2,
    durationHrs: 1,
    durationMins: 32,
    liveAvgSpeed: 4.1,
    departedAt: minute(0),
};

const mountListeners = new Set<(mounted: boolean) => void>();
const fixture = {
    ready: true,
    screen: screenName,
    maps,
    taps,
    expected: seaBaseLayers('reliefSat'),
    boat: [SOLENT_TRACK[23].longitude, SOLENT_TRACK[23].latitude] as [number, number],
    mount: () => mountListeners.forEach((listener) => listener(true)),
    unmount: () => mountListeners.forEach((listener) => listener(false)),
    /** Drop the fixture's own hold on removed maps, so the heap shows what the app keeps. */
    forget: () => {
        maps.length = 0;
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

const noop = () => undefined;
const planSummary: VoyageSummary = {
    voyageId: 'fixture-plan',
    entryCount: WHITSUNDAYS_PLAN.length,
    startedAt: WHITSUNDAYS_PLAN[0].timestamp,
    endedAt: WHITSUNDAYS_PLAN[WHITSUNDAYS_PLAN.length - 1].timestamp,
    totalDistanceNM: 13.1,
    avgSpeedKts: 0,
    hasManual: false,
    isPlannedRoute: true,
    isImported: false,
    firstLat: -20.245,
    firstLon: 148.722,
    lastLat: -20.235,
    lastLon: 148.945,
    firstIsOnWater: true,
    landFraction: 0,
    spanM: 24000,
} as VoyageSummary;

function Heap() {
    const [mounted, setMounted] = useState(false);
    mountListeners.add(setMounted);
    return (
        <div className="p-4" style={{ width: 390 }}>
            {mounted && <LiveMiniMap entries={SOLENT_TRACK} followedRouteCoords={SOLENT_ROUTE} height={220} isLive />}
        </div>
    );
}

function Body() {
    const expand = useRef<HTMLButtonElement>(null);
    const shrink = useRef<HTMLButtonElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    if (screenName === 'heap') return <Heap />;
    if (screenName === 'planned') {
        return (
            <div className="h-full overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))]">
                <div className="px-4 pt-4 pb-3">
                    <h1 className="ui-page-title text-xl font-extrabold uppercase tracking-wider text-white">
                        Ship’s Log
                    </h1>
                    <p className="text-xs uppercase tracking-widest text-gray-300">Planned routes</p>
                </div>
                <div className="px-4">
                    <VoyageCard
                        summary={planSummary}
                        entries={WHITSUNDAYS_PLAN}
                        filteredEntries={WHITSUNDAYS_PLAN}
                        isSelected
                        isExpanded
                        onToggle={noop}
                        onSelect={noop}
                        onDelete={noop}
                        onArchive={noop}
                        onShowMap={() => {
                            taps.count += 1;
                        }}
                        onFollowPlannedRoute={async () => false}
                        onDeleteEntry={noop}
                        onEditEntry={noop}
                    />
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
            <div className="px-4 pt-4 pb-1">
                <h1 className="ui-page-title text-xl font-extrabold uppercase tracking-wider text-white">Ship’s Log</h1>
                <p className="text-xs uppercase tracking-widest text-gray-300">Recording · Cowes → Hurst</p>
            </div>
            <LiveVoyageCard
                liveStats={liveStats}
                engineGroupId="engine"
                engineRunning={false}
                toggleEngine={noop}
                liveMapExpanded={screenName === 'fullscreen'}
                showTrackMap={false}
                followedRouteCoords={SOLENT_ROUTE}
                liveFix={{ lat: SOLENT_TRACK[23].latitude!, lon: SOLENT_TRACK[23].longitude! }}
                currentFix={null}
                openLiveMap={() => {
                    taps.count += 1;
                }}
                closeLiveMap={() => {
                    taps.count += 1;
                }}
                expandLiveMapRef={expand as React.RefObject<HTMLButtonElement>}
                shrinkLiveMapRef={shrink as React.RefObject<HTMLButtonElement>}
                liveMapDialogRef={dialog as React.RefObject<HTMLDivElement>}
                liveMapTitleId="live-map-title"
            />
        </div>
    );
}

function Fixture() {
    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-950 text-white">
            <section data-testid="page-frame" className="absolute inset-0">
                <Body />
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
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
