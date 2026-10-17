/** Invented THAS endpoint responses. Actual codec/session/image/vector hooks, Mapbox and capped controls. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import {
    ATMOS_CELLS,
    ATMOS_DATASETS,
    ATMOS_FIELDS,
    ATMOS_HEADER_BYTES,
    atmosFileBytes,
    canonicalAtmosGeneration,
    type AtmosDataset,
} from '../../services/weather/api/atmosContract';
import { sha256Hex } from '../../services/weather/api/marineManifestContract';
import type { AtmosPresentation } from '../../components/map/atmosPresentation';
import type { WeatherLayer } from '../../components/map/mapConstants';
import type { useWeatherLayers } from '../../components/map/useWeatherLayers';
if (!import.meta.env.DEV) throw new Error('Development-only fictional fixture');

const RUN = Date.parse('2026-10-17T00:00:00Z'),
    HOUR = 3_600_000;
const requests: string[] = [],
    remoteAttempts: string[] = [];
const sourceEvents: unknown[] = [],
    mapErrors: string[] = [];
let delayed = false;
const pending: (() => void)[] = [];
const cohorts = new Map<AtmosDataset, { manifest: unknown; buffers: Map<string, ArrayBuffer> }>();
for (const dataset of ['gfs-atmos', 'ifs-pressure'] as const) {
    const spec = ATMOS_DATASETS[dataset],
        frames = new Map<number, ArrayBuffer>();
    for (const step of [0, 1, spec.steps - 1]) {
        const buffer = new ArrayBuffer(atmosFileBytes(dataset)),
            view = new DataView(buffer);
        view.setUint32(0, 0x53414854, true);
        view.setUint8(4, 1);
        view.setUint8(5, spec.code);
        view.setUint8(6, spec.fields.length);
        view.setUint16(8, 360, true);
        view.setUint16(10, 181, true);
        view.setFloat64(12, -180, true);
        view.setFloat64(20, -90, true);
        view.setFloat64(28, 1, true);
        view.setFloat64(36, 1, true);
        view.setFloat64(44, RUN, true);
        view.setUint16(52, step * 6, true);
        spec.fields.forEach((field, channel) => {
            view.setUint8(56 + channel, ATMOS_FIELDS[field].code);
            const base = ATMOS_HEADER_BYTES + channel * ATMOS_CELLS * 5;
            for (let i = 0; i < ATMOS_CELLS; i++) {
                const value =
                    field === 'pressure'
                        ? 101200 + 1200 * Math.sin(((i % 360) * Math.PI) / 180) + step * 3
                        : field === 'gust'
                          ? 12
                          : field === 'visibility'
                            ? 5000
                            : field === 'temperature'
                              ? 290
                              : 289;
                view.setFloat32(base + i * 4, value, true);
            }
            new Uint8Array(buffer, base + ATMOS_CELLS * 4, ATMOS_CELLS).fill(1);
        });
        frames.set(step, buffer);
    }
    const hashes = Array.from({ length: spec.steps }, (_, step) =>
        frames.has(step) ? sha256Hex(new Uint8Array(frames.get(step)!)) : 'a'.repeat(64),
    );
    const run = new Date(RUN).toISOString().replace('.000Z', 'Z'),
        generation = canonicalAtmosGeneration(run, dataset, hashes);
    const files = hashes.map((hash, step) => ({
        step,
        offset_hours: step * 6,
        data_time: new Date(RUN + step * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
        filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
        bytes: atmosFileBytes(dataset),
        sha256: hash,
        content_type: 'application/octet-stream',
    }));
    const manifest = {
        schema_version: 2,
        dataset: { key: dataset, id: spec.id },
        generation,
        generated_at: '2026-10-17T04:00:00Z',
        published_at: '2026-10-17T04:05:00Z',
        data_start: run,
        data_end: files.at(-1)!.data_time,
        cadence_hours: 6,
        dimensions: { width: 360, height: 181 },
        bounds: { west: -180, south: -90, east: 179, north: 90 },
        producer: { commit: 'b'.repeat(40), run_id: 1, run_attempt: 1 },
        metadata: {
            model: spec.model,
            source_resolution_degrees: '0.25',
            display_resolution_degrees: '1',
            fields: spec.fields.join(','),
            attribution: spec.attribution,
            licence: spec.licence,
        },
        files,
    };
    cohorts.set(dataset, {
        manifest,
        buffers: new Map([...frames].map(([step, buffer]) => [files[step].filename, buffer])),
    });
}
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.pathname.startsWith('/api/atmos/')) {
        requests.push(url.pathname + url.search);
        const dataset = url.searchParams.get('model') === 'gfs' ? 'gfs-atmos' : 'ifs-pressure';
        const cohort = cohorts.get(dataset)!,
            name = url.pathname.split('/').at(-1)!;
        if (name === 'manifest-v2.json')
            return new Response(JSON.stringify(cohort.manifest), { headers: { 'content-type': 'application/json' } });
        const buffer = cohort.buffers.get(name);
        if (!buffer) return new Response('Unprepared fictional frame', { status: 404 });
        if (delayed) await new Promise<void>((resolve) => pending.push(resolve)); // Intentionally ignores abort to prove late rejection.
        return new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin)
        return nativeFetch(input, options);
    if (
        url.hostname === 'events.mapbox.com' ||
        (url.hostname === 'api.mapbox.com' && url.pathname.includes('map-sessions'))
    )
        return new Response(null, { status: 204 });
    remoteAttempts.push(url.origin + url.pathname);
    return new Response('Fixture denies network', { status: 503 });
};
const [
    { default: AtmosWeatherLayer },
    { MapWeatherControls },
    { default: ObsCreditsRollup },
    { RadialHelmMenu },
    { SAT_IR_FULL_COVERAGE },
    settings,
    { WindStore },
] = await Promise.all([
    import('../../components/map/AtmosWeatherLayer'),
    import('../../components/map/MapWeatherControls'),
    import('../../components/map/ObsCreditsRollup'),
    import('../../components/map/RadialHelmMenu'),
    import('../../components/map/satelliteImagery'),
    import('../../stores/settingsStore'),
    import('../../stores/WindStore'),
]);
await settings.awaitSettingsLoaded();
settings.useSettingsStore.setState({
    settings: { ...settings.useSettingsStore.getState().settings, satelliteMode: false },
});
mapboxgl.accessToken = 'pk.fictional-atmosphere-proof';
declare global {
    interface Window {
        __atmos141: {
            pressureOnly(model: string): void;
            off(): void;
            delay(): void;
            resolve(): void;
            evidence(): unknown;
        };
    }
}

function Fixture() {
    const container = React.useRef<HTMLDivElement>(null),
        mapRef = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [layers, setLayers] = React.useState<Set<WeatherLayer>>(new Set(['gust', 'visibility', 'pressure']));
    const [model, setModel] = React.useState('ecmwf');
    const [presentation, setPresentation] = React.useState<AtmosPresentation>({ legend: null, credits: [] });
    React.useEffect(() => {
        const map = new mapboxgl.Map({
            container: container.current!,
            center: [0, 0],
            zoom: 1,
            preserveDrawingBuffer: true,
            performanceMetricsCollection: false,
            attributionControl: false,
            style: {
                version: 8,
                glyphs: `${location.origin}/fixture-glyphs/{fontstack}/{range}.pbf`,
                sources: {},
                layers: [{ id: 'base', type: 'background', paint: { 'background-color': '#081c2c' } }],
            },
        });
        mapRef.current = map;
        map.on('sourcedata', (event) => {
            if (!event.sourceId?.startsWith('atmos-') || sourceEvents.length >= 128) return;
            let loaded: boolean | null = null;
            try {
                loaded = map.isSourceLoaded(event.sourceId);
            } catch {
                /* preserve unknown */
            }
            sourceEvents.push({ id: event.sourceId, kind: event.sourceDataType, loaded, time: performance.now() });
        });
        map.on('error', (event) => {
            if (mapErrors.length < 20) mapErrors.push(event.error.message);
        });
        map.on('load', () => setReady(true));
        window.__atmos141 = {
            pressureOnly: (next) => {
                setModel(next);
                setLayers(new Set(['pressure']));
            },
            off: () => setLayers(new Set()),
            delay: () => {
                delayed = true;
            },
            resolve: () => {
                delayed = false;
                for (const finish of pending.splice(0)) finish();
            },
            evidence: () => {
                const canvas = map.getCanvas().getBoundingClientRect();
                return {
                    requests: [...requests],
                    sourceEvents: [...sourceEvents],
                    mapErrors: [...mapErrors],
                    remoteAttempts: [...remoteAttempts],
                    overlayIds: map
                        .getStyle()
                        .layers.filter((layer) => layer.id.startsWith('atmos-'))
                        .map((layer) => layer.id),
                    canvas: { width: canvas.width, height: canvas.height },
                    scrollHeight: document.documentElement.scrollHeight,
                    scrollWidth: document.documentElement.scrollWidth,
                    innerHeight: window.innerHeight,
                    innerWidth: window.innerWidth,
                };
            },
        };
        return () => map.remove();
    }, []);
    const weather = {
        activeLayers: layers,
        pressureManaged: true,
        windState: WindStore.getState(),
        windModel: model,
        windReady: false,
        windForecastHours: [],
        windHour: 0,
    } as unknown as ReturnType<typeof useWeatherLayers>;
    return (
        <main data-testid="atmos-frame" className="fixed inset-0 isolate overflow-hidden bg-slate-950 text-white">
            <div ref={container} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <AtmosWeatherLayer
                mapRef={mapRef}
                mapReady={ready}
                gust={layers.has('gust')}
                visibility={layers.has('visibility')}
                pressure={layers.has('pressure')}
                pressureModel={model}
                followWindMs={null}
                standalonePressure={layers.size === 1}
                point={{ lat: 0, lon: 0 }}
                onPresentation={setPresentation}
            />
            <MapWeatherControls
                weather={weather}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={() => undefined}
                extraLegend={presentation.legend}
                extraLegendCount={presentation.credits.length}
                creditsInRollup
            />
            <ObsCreditsRollup
                rain={null}
                wind={null}
                cmems={[]}
                lightning={false}
                ais={false}
                satellite={{
                    status: 'off',
                    frameTimeMs: null,
                    frameCount: 0,
                    coverage: SAT_IR_FULL_COVERAGE,
                    playing: false,
                    following: false,
                }}
                onToggleSatellite={() => undefined}
                atmosphere={presentation.credits}
            />
            <RadialHelmMenu
                activeLayers={layers}
                toggleLayer={(layer) =>
                    setLayers((previous) => {
                        const next = new Set(previous);
                        if (next.has(layer)) next.delete(layer);
                        else next.add(layer);
                        return next;
                    })
                }
                selectInGroup={() => undefined}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
