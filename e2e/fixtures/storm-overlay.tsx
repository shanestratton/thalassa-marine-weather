/**
 * Obs with a storm open (129-13): the top of the chart as the skipper sees it
 * with the cyclone view on, and the clear view that takes the chrome away.
 *
 * Real parts: the zoom readout, the map-base pill, the helm menu with MOB and
 * the layers button, the threat chip (components/map/ThreatBanner.tsx), the
 * storm card and its stepper (components/map/useCycloneLayer.ts), the
 * scrubber's pill (MapWeatherControls) with the wind's credit, the clear view
 * (mapHub/useObsClearView.ts, ObsClearViewChrome.tsx), the app's CSS, and the
 * tab bar's real geometry. The chart is a plain sea with no network: no
 * Mapbox, or with &map=1 a real Mapbox GL map of an empty style, for the
 * gestures. Mapbox's own corner containers are drawn so the clear view can be
 * shown keeping the wordmark and the credits.
 *
 *   ?largeText        root font 24 px, as the app's large text sizes
 *   &fonts=wide       Verdana / DejaVu Sans, the widest faces we meet
 *   &storms=1         one storm (no stepper); default three
 *   &nearer=1         another storm nearer the place than the card's: its chip shows
 *   &weather=0        no weather layer up: no scrubber pill, no wind credit
 *   &map=1            a real Mapbox GL map (Chromium's gesture tests)
 *
 * <html data-clear-view="on|off"> says whether the controls are hidden;
 * window.__stormFixture.zoom() and .mapClicks() report the real map's.
 *
 * Fictional storms and places only: this repository is public.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';

if (!import.meta.env.DEV)
    throw new Error('The storm-overlay fixture is available only through the development server.');

class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
window.fetch = async () => new Response(JSON.stringify({ error: 'Storm fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

const [
    { ZoomLevelFab },
    { MapBaseSelector },
    { RadialHelmMenu },
    { ThreatBanner },
    cycloneLayer,
    { MapWeatherControls },
    { useObsClearView },
    { ObsClearViewChrome },
    { windCreditLine },
    { CREDITS_STRIP_POSITION_CLASS, creditsStripTop },
] = await Promise.all([
    import('../../components/map/ZoomLevelFab'),
    import('../../components/map/MapBaseSelector'),
    import('../../components/map/RadialHelmMenu'),
    import('../../components/map/ThreatBanner'),
    import('../../components/map/useCycloneLayer'),
    import('../../components/map/MapWeatherControls'),
    import('../../components/map/mapHub/useObsClearView'),
    import('../../components/map/ObsClearViewChrome'),
    import('../../components/map/deskWind'),
    import('../../components/map/creditsStrip'),
]);

const HOUR = 3_600_000;
const now = Date.now();
/** A made-up port on a made-up coast: the selected place the storm is measured from. */
const PLACE = { lat: 20.6, lon: -105.2 };

function storm(over: Partial<ActiveCyclone> & Pick<ActiveCyclone, 'sid' | 'name' | 'basin'>): ActiveCyclone {
    const at = { lat: 20.1, lon: -107.6, time: new Date(now - 2 * HOUR).toISOString(), windKts: 80, pressureMb: 977 };
    return {
        category: 1,
        categoryLabel: '1',
        currentPosition: at,
        lastAdvisoryTime: at.time,
        track: [
            { ...at, lat: 18.2, lon: -105.9, time: new Date(now - 26 * HOUR).toISOString(), pressureMb: 990 },
            { ...at, lat: 19.3, lon: -106.8, time: new Date(now - 14 * HOUR).toISOString(), pressureMb: 982 },
            at,
        ],
        forecastTrack: [
            { ...at, lat: 21.4, lon: -108.9, time: new Date(now + 24 * HOUR).toISOString() },
            { ...at, lat: 22.9, lon: -110.4, time: new Date(now + 72 * HOUR).toISOString() },
        ],
        maxWindKts: 80,
        minPressureMb: 977,
        nature: 'TS',
        forecastBy: { by: 'NHC', advisory: '26', issued: new Date(now - 3 * HOUR).toISOString() },
        issuer: { official: true, text: 'NHC official forecast' },
        cone: {
            type: 'Polygon',
            coordinates: [
                [
                    [-107, 20],
                    [-111, 22],
                    [-110, 24],
                    [-107, 20],
                ],
            ],
        },
        ...over,
    };
}

// The live feed's spellings (supabase/functions/_shared/cyclone/feed.ts): one ATCF letter for the basin, the sid lower case.
const ALL: ActiveCyclone[] = [
    storm({ sid: 'ep312026', name: 'ZZSIMONETTA', basin: 'E' }),
    storm({
        sid: 'wp332026',
        name: 'ZZKOHARU',
        basin: 'W',
        category: 3,
        categoryLabel: '3',
        maxWindKts: 105,
        currentPosition: {
            lat: 24.2,
            lon: 128.4,
            time: new Date(now - HOUR).toISOString(),
            windKts: 105,
            pressureMb: 955,
        },
        forecastBy: { by: 'JTWC', advisory: '12', issued: new Date(now - 2 * HOUR).toISOString() },
        issuer: { official: false, text: 'JTWC forecast (US Navy)' },
        centre: { short: 'JMA', url: 'https://www.jma.go.jp/bosai/map.html#contents=typhoon' },
    }),
    storm({
        sid: 'sh372027',
        name: 'ZZTAVITA',
        basin: 'P',
        category: 2,
        categoryLabel: '2',
        maxWindKts: 88,
        currentPosition: {
            lat: -17.4,
            lon: 179.6,
            time: new Date(now - HOUR).toISOString(),
            windKts: 88,
            pressureMb: 968,
        },
        forecastBy: { by: 'JTWC', advisory: '7', issued: new Date(now - 2 * HOUR).toISOString() },
        issuer: { official: false, text: 'JTWC forecast (US Navy)' },
        centre: { short: 'Fiji Met', url: 'https://www.met.gov.fj/' },
    }),
];
if (params.has('nearer'))
    ALL.push(
        storm({
            sid: 'ep322026',
            name: 'ZZQUILLON',
            basin: 'E',
            category: 0,
            categoryLabel: 'TS',
            maxWindKts: 45,
            currentPosition: {
                lat: 20.0,
                lon: -104.6,
                time: new Date(now - HOUR).toISOString(),
                windKts: 45,
                pressureMb: 1001,
            },
        }),
    );
const STORMS = params.get('storms') === '1' ? ALL.slice(0, 1) : ALL;
/** A weather layer up (the wind, so the scrubber's pill), unless &weather=0. */
const WEATHER = params.get('weather') !== '0';
const SELECTED = STORMS[0];

/** Just enough of a map for the zoom readout and the clear view's gesture, without &map=1. */
const fakeMap = {
    getZoom: () => 4,
    on: () => undefined,
    off: () => undefined,
    getContainer: () => document.querySelector<HTMLElement>('[data-testid="chart"]')!,
} as unknown as mapboxgl.Map;
const noop = () => undefined;
const fixtureState = { mapClicks: 0, map: null as mapboxgl.Map | null };
(window as unknown as { __stormFixture: unknown }).__stormFixture = {
    zoom: () => fixtureState.map?.getZoom() ?? null,
    centre: () => fixtureState.map?.getCenter().toArray() ?? null,
    mapClicks: () => fixtureState.mapClicks,
};

/** The scrubber's pill: the wind on, its controls folded, as Obs opens them. */
const windFrames = [0, 1, 2].map(() => new Float32Array([1]));
const windWeather = {
    activeLayers: new Set(['wind']),
    windForecastHours: [0, 3, 6],
    windForecastHoursRef: { current: [0, 3, 6] },
    windNowIdx: 0,
    windNowIdxRef: { current: 0 },
    windHour: 0,
    windTotalHours: 3,
    windPlaying: false,
    windReady: true,
    setWindHour: noop,
    setWindPlaying: noop,
    windModel: 'icon',
    setWindModel: noop,
    windState: {
        loading: false,
        error: null,
        grid: { u: windFrames, v: windFrames, speed: windFrames, totalHours: 3, refTime: new Date(now).toISOString() },
    },
} as unknown as Parameters<typeof MapWeatherControls>[0]['weather'];

/** A real Mapbox map of an empty style, built as useMapInit builds Obs's: no rotation, no pitch. */
function useRealMap(containerRef: React.RefObject<HTMLDivElement | null>, wanted: boolean) {
    const [map, setMap] = useState<mapboxgl.Map | null>(null);
    useEffect(() => {
        const container = containerRef.current;
        if (!wanted || !container) return undefined;
        const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
            ?.VITE_MAPBOX_ACCESS_TOKEN;
        if (token) mapboxgl.accessToken = token;
        const m = new mapboxgl.Map({
            container,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b3d5c' } }],
            },
            center: [-106, 20],
            zoom: 4,
            projection: 'mercator',
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            attributionControl: false,
            testMode: true,
        } as mapboxgl.MapOptions);
        m.touchZoomRotate.disableRotation();
        m.on('click', () => {
            fixtureState.mapClicks += 1;
        });
        m.once('load', () => {
            fixtureState.map = m;
            setMap(m);
        });
        return () => {
            fixtureState.map = null;
            m.remove();
        };
    }, [containerRef, wanted]);
    return map;
}

/** The storm card and stepper, mounted as useCycloneLayer mounts them in the map's container. */
function mountStormHud(container: HTMLElement): () => void {
    const hud = cycloneLayer.createStormHud(SELECTED, STORMS, noop, { animate: false, from: PLACE });
    container.appendChild(hud);
    return () => hud.remove();
}

function Fixture() {
    const realMap = params.get('map') === '1';
    const mapRef = useRef<mapboxgl.Map | null>(realMap ? null : fakeMap);
    const containerRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const [controlsHidden, setControlsHidden] = useState(true);
    const map = useRealMap(containerRef, realMap);
    if (realMap) mapRef.current = map;
    const mapReady = !realMap || map !== null;
    const clearView = useObsClearView({
        frameRef,
        mapRef,
        mapReady,
        available: true,
        modeOwnsChart: false,
        holdGesture: true,
    });
    useEffect(() => {
        const container = containerRef.current;
        if (!container || !mapReady) return undefined;
        const unmount = mountStormHud(container);
        document.documentElement.dataset.stormFixture = 'ready';
        return unmount;
    }, [mapReady]);
    useEffect(() => {
        document.documentElement.dataset.clearView = clearView.on ? 'on' : 'off';
    }, [clearView.on]);
    return (
        <main className="relative w-full overflow-hidden bg-slate-900" style={{ height: '100dvh' }}>
            <div data-testid="map-hub" className="isolate w-full h-full relative">
                <div
                    ref={frameRef}
                    data-testid="obs-frame"
                    data-obs-clear-view={clearView.on ? 'on' : undefined}
                    className="relative w-full h-full"
                >
                    <div
                        ref={containerRef}
                        data-testid="chart"
                        className="thalassa-chart-map mapboxgl-map w-full h-full"
                        style={{ background: 'linear-gradient(160deg, #0b3d5c, #07263d)' }}
                    >
                        <div className="mapboxgl-control-container">
                            <div className="mapboxgl-ctrl-bottom-left">
                                <div className="mapboxgl-ctrl" style={{ margin: '0 0 10px 10px' }}>
                                    <a
                                        className="mapboxgl-ctrl-logo"
                                        data-testid="mapbox-wordmark"
                                        href="https://www.mapbox.com/"
                                        aria-label="Mapbox logo"
                                    />
                                </div>
                            </div>
                            <div className="mapboxgl-ctrl-bottom-right">
                                <div
                                    className="mapboxgl-ctrl mapboxgl-ctrl-scale"
                                    data-testid="scale"
                                    style={{ width: 80 }}
                                >
                                    200 nm
                                </div>
                                <details
                                    className="mapboxgl-ctrl mapboxgl-ctrl-attrib mapboxgl-compact"
                                    data-testid="attribution"
                                >
                                    <summary className="mapboxgl-ctrl-attrib-button" aria-label="Toggle attribution" />
                                    <div className="mapboxgl-ctrl-attrib-inner">© Mapbox © OpenStreetMap</div>
                                </details>
                            </div>
                        </div>
                    </div>
                    <ObsClearViewChrome view={clearView} />
                    <ZoomLevelFab mapRef={mapRef} mapReady={mapReady} />
                    <MapBaseSelector
                        visible
                        value="reliefSat"
                        onChange={noop}
                        encCellCount={0}
                        encVisible={false}
                        onToggleEnc={noop}
                    />
                    <RadialHelmMenu
                        activeLayers={new Set()}
                        toggleLayer={noop}
                        selectInGroup={noop}
                        tacticalState={{ onOpenMob: noop, cycloneVisible: true, onToggleCyclones: noop }}
                    />
                    <ThreatBanner
                        visible
                        userLat={PLACE.lat}
                        userLon={PLACE.lon}
                        cyclones={STORMS}
                        lightningActive={false}
                        flyTo={noop}
                        stormCardSid={SELECTED.sid}
                    />
                    {WEATHER && (
                        <div
                            data-testid="wind-credit"
                            data-map-credit
                            className={`thalassa-wind-credit ${CREDITS_STRIP_POSITION_CLASS}`}
                            style={{ top: creditsStripTop(0) }}
                        >
                            {windCreditLine('icon')}
                        </div>
                    )}
                    {/* MapHub draws the controls only while a layer is up. */}
                    {WEATHER && (
                        <MapWeatherControls
                            weather={windWeather}
                            visible
                            embedded={false}
                            controlsHidden={controlsHidden}
                            onControlsHiddenChange={setControlsHidden}
                            keepInClearView
                        />
                    )}
                </div>
            </div>
            {/* The chart page's own corner controls App.tsx draws beside MapHub: the status button. */}
            <div
                data-obs-chrome=""
                data-testid="status-corner"
                className="absolute z-601 flex items-center gap-2"
                style={{ top: 'calc(env(safe-area-inset-top) + 8px)', right: 'max(16px, env(safe-area-inset-right))' }}
            >
                <button
                    type="button"
                    aria-label="System status"
                    className="h-12 w-12 rounded-2xl border border-white/8 bg-slate-900/90 text-white"
                >
                    ((•))
                </button>
            </div>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the home indicator. */}
            <nav
                aria-label="Main"
                data-thalassa-tab-bar=""
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span>PLAN</span>
                    <span>LOG</span>
                    <span>VESSEL</span>
                </div>
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
