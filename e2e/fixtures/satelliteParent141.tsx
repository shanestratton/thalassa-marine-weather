/** Fictional providers; actual shared Obs selection/menu, both satellite hooks, capped key and credit rollup. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import type { AtmosCredit } from '../../components/map/atmosPresentation';
import type { WeatherLayer } from '../../components/map/mapConstants';
import type { useWeatherLayers } from '../../components/map/useWeatherLayers';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import { useSatellitePictureSelection } from '../../components/map/useSatellitePictureSelection';
import { useSatelliteLayer } from '../../components/map/useSatelliteLayer';
import { ObsLayerKey } from '../../components/map/ObsLayerKey';
if (!import.meta.env.DEV) throw Error('Development-only fictional fixture');
const nativeFetch = window.fetch.bind(window),
    requests: string[] = [],
    upstream: string[] = [],
    remote: string[] = [],
    errors: string[] = [];
const events: { atMs: number; kind: string; value: unknown }[] = [];
const started = performance.now();
const record = (kind: string, value: unknown) => {
    if (events.length < 1200) events.push({ atMs: Math.round(performance.now() - started), kind, value });
};
let delay = false,
    blank = false,
    uniform = false;
const pending: (() => void)[] = [];
const iso = (time: number) => new Date(time).toISOString().replace('.000Z', 'Z');
function domain(daily = false) {
    const now = Date.now();
    if (daily) {
        const day = new Date(now).toISOString().slice(0, 10);
        return `<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${new Date(now - 86400000).toISOString().slice(0, 10)}/${day}/P1D</Domain><Size>1</Size></DimensionDomain></Domains>`;
    }
    const last = Math.floor(now / 600000) * 600000;
    return `<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${iso(last - 3600000)}/${iso(last - 3000000)}/PT10M,${iso(last - 1800000)}/${iso(last)}/PT10M</Domain><Size>2</Size></DimensionDomain></Domains>`;
}
async function image(url: URL) {
    const canvas = document.createElement('canvas');
    canvas.width = Number(url.searchParams.get('width'));
    canvas.height = Number(url.searchParams.get('height'));
    const context = canvas.getContext('2d')!,
        phase = [...(url.searchParams.get('time') ?? '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 255;
    context.fillStyle =
        url.searchParams.get('layers') === 'global_longwave_imagery_mosaic'
            ? 'rgb(240,240,240)'
            : `rgb(${phase},100,150)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (url.searchParams.get('layers') !== 'global_longwave_imagery_mosaic') {
        context.fillStyle = `rgb(${(phase + 30) % 255},120,160)`;
        context.fillRect(Math.floor(canvas.width / 2), 0, Math.ceil(canvas.width / 2), canvas.height);
    }
    context.clearRect(0, 0, Math.ceil(canvas.width / 8), canvas.height);
    if (uniform && url.searchParams.get('layers') !== 'global_longwave_imagery_mosaic') {
        context.fillStyle = 'black';
        context.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (blank && url.searchParams.get('layers') !== 'global_longwave_imagery_mosaic')
        context.clearRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => (value ? resolve(value) : reject(Error('Fixture PNG failed'))), 'image/png'),
    );
    return new Response(blob, { headers: { 'content-type': 'image/png' } });
}
const { createPublicSatelliteViewHandler } = await import('../../supabase/functions/satellite-view/handler');
const handler = createPublicSatelliteViewHandler(
    () => true,
    async () => null,
);
window.fetch = async (input, options) => {
    const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href,
    );
    if (url.pathname === '/functions/v1/satellite-view' && url.origin === 'https://pcisdplnodrphauixcau.supabase.co') {
        requests.push(url.pathname + url.search);
        record('client-start', url.search);
        if (delay && url.searchParams.get('action') === 'image')
            await new Promise<void>((resolve) => pending.push(resolve));
        const response = await handler(new Request(url.href, options));
        record('client-response', { query: url.search, status: response.status });
        return response;
    }
    if (['gibs.earthdata.nasa.gov', 'view.eumetsat.int', 'nowcoast.noaa.gov'].includes(url.hostname)) {
        upstream.push(url.href);
        if (url.searchParams.get('request')?.toLowerCase() === 'getmap') return image(url);
        if (url.hostname === 'gibs.earthdata.nasa.gov')
            return new Response(domain(url.searchParams.get('LAYER')?.includes('VIIRS')), {
                headers: { 'content-type': 'text/xml' },
            });
        const source = url.hostname === 'view.eumetsat.int' ? 'mtg_fd:ir105_hrfi' : 'global_water_vapor_imagery_mosaic';
        const last = Math.floor(Date.now() / 3600000) * 3600000;
        return new Response(
            `<WMS_Capabilities><Capability><Layer><CRS>EPSG:3857</CRS><Layer><Name>${source}</Name><Dimension name="time">${iso(last - 5 * 3600000)}/${iso(last)}/PT${source.startsWith('mtg') ? '10M' : '1H'}</Dimension></Layer><Layer><Name>global_longwave_imagery_mosaic</Name><Dimension name="time">${iso(last - 5 * 3600000)}/${iso(last)}/PT1H</Dimension></Layer></Layer></Capability></WMS_Capabilities>`,
            { headers: { 'content-type': 'text/xml' } },
        );
    }
    if (
        url.hostname === 'events.mapbox.com' ||
        (url.hostname === 'api.mapbox.com' && url.pathname.includes('map-sessions'))
    )
        return new Response(null, { status: 204 });
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin)
        return nativeFetch(input, options);
    remote.push(url.origin + url.pathname);
    return new Response('Fixture denies network', { status: 503 });
};
const [{ default: Layer }, { MapWeatherControls }, { default: Credits }, { WindStore }, settings] = await Promise.all([
    import('../../components/map/SharperSatelliteLayer'),
    import('../../components/map/MapWeatherControls'),
    import('../../components/map/ObsCreditsRollup'),
    import('../../stores/WindStore'),
    import('../../stores/settingsStore'),
]);
await settings.awaitSettingsLoaded();
settings.useSettingsStore.setState({
    settings: { ...settings.useSettingsStore.getState().settings, satelliteMode: false },
});
mapboxgl.accessToken = 'pk.fictional-satellite-proof';
declare global {
    interface Window {
        __satelliteParent141: {
            off(): void;
            blank(on: boolean): void;
            uniform(on: boolean): void;
            satMode(on: boolean): void;
            dateline(): void;
            delay(): void;
            resolve(): void;
            evidence(): unknown;
        };
    }
}
function Fixture() {
    const container = React.useRef<HTMLDivElement>(null),
        ref = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [hourly, setHourly] = React.useState(false),
        [credit, setCredit] = React.useState<AtmosCredit | null>(null),
        [controls, setControls] = React.useState<React.ReactNode>(null);
    const toggleHourly = React.useCallback(() => setHourly((value) => !value), []);
    const picture = useSatellitePictureSelection(
        import.meta.env.VITE_SHARPER_SATELLITE_ENABLED === 'true',
        hourly,
        toggleHourly,
    );
    const satellite = useSatelliteLayer(ref, ready, hourly && !picture.sharperVisible, null);
    const current = React.useRef({ hourly, sharper: picture.sharperVisible, satellite });
    current.current = { hourly, sharper: picture.sharperVisible, satellite };
    const weatherAction = (layer: WeatherLayer) => {
        picture.weatherAction(layer);
        if (layer === 'satIR') toggleHourly();
        else if (layer === 'none') setHourly(false);
    };
    React.useEffect(() => {
        const map = new mapboxgl.Map({
            container: container.current!,
            center: [153, -27],
            zoom: 4,
            preserveDrawingBuffer: true,
            performanceMetricsCollection: false,
            attributionControl: false,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'base', type: 'background', paint: { 'background-color': '#081c2c' } }],
            },
        });
        ref.current = map;
        map.on('load', () => setReady(true));
        map.on('error', (event) => errors.push(event.error.message));
        map.on('sourcedata', (event) => {
            if (event.sourceId?.startsWith('sharper-satellite'))
                record('native-source', {
                    id: event.sourceId,
                    type: event.sourceDataType,
                    loaded: event.isSourceLoaded,
                });
        });
        let previousStatus = '';
        const observer = new MutationObserver(() => {
            const status =
                document.querySelector('[aria-label="Sharper satellite controls"] [role="status"]')?.textContent ?? '';
            if (status !== previousStatus) {
                previousStatus = status;
                record('status', status);
            }
        });
        observer.observe(document.getElementById('root')!, { childList: true, subtree: true, characterData: true });
        window.__satelliteParent141 = {
            off: picture.clearSharper,
            uniform: (on) => {
                uniform = on;
            },
            blank: (on) => {
                blank = on;
            },
            satMode: (on) =>
                settings.useSettingsStore.setState({
                    settings: { ...settings.useSettingsStore.getState().settings, satelliteMode: on },
                }),
            dateline: () => map.jumpTo({ center: [179, 0], zoom: 4 }),
            delay: () => {
                delay = true;
            },
            resolve: () => {
                delay = false;
                for (const finish of pending.splice(0)) finish();
            },
            evidence: () => ({
                selection: {
                    hourly: current.current.hourly,
                    sharper: current.current.sharper,
                    hourlyStatus: current.current.satellite.status,
                },
                events: [...events],
                requests: [...requests],
                upstream: [...upstream],
                remote: [...remote],
                errors: [...errors],
                layers: map
                    .getStyle()
                    .layers.filter((layer) => layer.id.startsWith('sharper-satellite') || layer.id === 'sat-ir-layer')
                    .map((layer) => layer.id),
                canvas: {
                    width: map.getCanvas().getBoundingClientRect().width,
                    height: map.getCanvas().getBoundingClientRect().height,
                },
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
            }),
        };
        return () => {
            observer.disconnect();
            map.remove();
        };
    }, []);
    const legend =
        controls ??
        (picture.sharperVisible ? (
            <p role="status">Loading satellite controls...</p>
        ) : hourly ? (
            <ObsLayerKey
                satelliteIr
                ais={false}
                lightning={false}
                squall={false}
                storms={false}
                tides={false}
                moorings={false}
                anchorages={false}
                marks={false}
                protectedAreas={false}
                route={false}
                track={false}
                passage={false}
                forecastRoute={false}
                verificationStatus="idle"
                referenceStatus="off"
                mooringFilter="all"
                onMooringFilter={() => undefined}
                tideStatus={{ stationCount: 0, loading: false, error: false, zoomRequired: false }}
            />
        ) : null);
    const weather = {
        activeLayers: new Set<WeatherLayer>(hourly ? ['satIR'] : []),
        pressureManaged: true,
        windState: WindStore.getState(),
        windModel: 'gfs',
        windReady: false,
        windForecastHours: [],
        windHour: 0,
    } as unknown as ReturnType<typeof useWeatherLayers>;
    return (
        <main className="fixed inset-0 isolate overflow-hidden bg-slate-950 text-white">
            <div ref={container} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <Layer
                mapRef={ref}
                mapReady={ready}
                active={picture.sharperVisible}
                onCredit={setCredit}
                onControls={setControls}
                onFallback={picture.useHourly}
            />
            {(hourly || legend) && (
                <MapWeatherControls
                    weather={weather}
                    visible
                    embedded={false}
                    controlsHidden={false}
                    onControlsHiddenChange={() => undefined}
                    extraLegend={legend}
                    extraLegendCount={legend ? 1 : 0}
                    creditsInRollup
                />
            )}
            <Credits
                rain={null}
                wind={null}
                cmems={[]}
                lightning={false}
                ais={false}
                satellite={satellite}
                onToggleSatellite={() => satellite.setPlaying(!satellite.playing)}
                atmosphere={credit ? [credit] : []}
            />
            <RadialHelmMenu
                activeLayers={weather.activeLayers}
                toggleLayer={weatherAction}
                selectInGroup={weatherAction}
                tacticalState={{
                    sharperSatelliteVisible: picture.sharperVisible,
                    onToggleSharperSatellite: picture.toggleSharper,
                }}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
