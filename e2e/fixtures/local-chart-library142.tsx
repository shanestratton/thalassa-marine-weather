/** Real Directory.Data web adapter, SQLite, raster worker and Mapbox; own fictional chart fixtures only. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import LocalChartLibrarySurface from '../../components/map/LocalChartLibrarySurface';
import PaperChartSheet from '../../components/map/PaperChartSheet';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import type { AtmosCredit } from '../../components/map/atmosPresentation';
import { ToastPortal } from '../../components/Toast';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { MBTilesService, TRANSPARENT_TILE_DATA_URL } from '../../services/MBTilesService';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { listLocalCharts, readLocalChart } from '../../services/charts/localChartLibrary';
import { localChartPath } from '../../services/charts/localChartLibraryContract';

setAuthIdentityScope('chart-proof-owner-a');
document.documentElement.style.fontSize = '130%';
const style = document.createElement('style');
style.textContent =
    'html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}body{background:#08243b}.proof-toolbar{position:absolute;top:8px;left:8px;z-index:10;display:flex;gap:8px}.proof-toolbar button{min-height:44px;padding:6px 12px;background:#08243b;color:white;border:1px solid #789;border-radius:8px}';
document.head.append(style);
let map: mapboxgl.Map;
const report = {
    ready: false,
    active: false,
    credit: null as AtmosCredit | null,
    blobUrlsHanded: 0,
    errors: [] as string[],
    violations: [] as { directive: string; blockedURI: string }[],
    switchAccount(owner: 'a' | 'b') {
        setAuthIdentityScope(`chart-proof-owner-${owner}`);
    },
    async loseSavedBytes(name: string) {
        const chart = (await listLocalCharts()).find((chart) => chart.name === name);
        if (!chart) throw new Error('Own fixture chart missing');
        const original = await readLocalChart(chart.id);
        if (!original.isCurrent()) throw new Error('Own fixture retired');
        await Filesystem.deleteFile({ path: localChartPath(original.namespace, chart), directory: Directory.Data });
    },
    probe(lon: number, lat: number) {
        const point = map.project([lon, lat]),
            source = map.getCanvas(),
            canvas = document.createElement('canvas');
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        context.drawImage(source, 0, 0);
        return Array.from(
            context.getImageData(Math.round(point.x * devicePixelRatio), Math.round(point.y * devicePixelRatio), 1, 1)
                .data,
        );
    },
    sourcePresent() {
        return !!map?.getSource('retained-local-chart-source');
    },
    center() {
        return map.getCenter().toArray();
    },
};
(window as unknown as { __localChart142: typeof report }).__localChart142 = report;
document.addEventListener('securitypolicyviolation', (event) =>
    report.violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI }),
);
// Offline test-mode fixture: no live token/provider request. Mapbox otherwise
// suppresses its render loop even for a completely local background style.
mapboxgl.accessToken = 'pk.private-chart-replay';

function App() {
    const container = React.useRef<HTMLDivElement>(null),
        mapRef = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [paper, setPaper] = React.useState(false),
        [open, setOpen] = React.useState(false),
        [requested, setRequested] = React.useState(false);
    const [clearRevision, clear] = React.useReducer((n: number) => n + 1, 0),
        [credit, setCredit] = React.useState<AtmosCredit | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    const creditChanged = React.useCallback((value: AtmosCredit | null) => {
        report.credit = value;
        setCredit(value);
    }, []);
    const activeChanged = React.useCallback((value: boolean) => {
        report.active = value;
    }, []);
    const local = React.useCallback(() => {
        setPaper(false);
        setRequested(true);
        setOpen(true);
    }, []);
    React.useEffect(() => {
        if (!container.current) return;
        map = new mapboxgl.Map({
            container: container.current,
            testMode: true,
            preserveDrawingBuffer: true,
            attributionControl: false,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#08243b' } }],
            },
            center: [-33.75, -11],
            zoom: 3,
            transformRequest(url, type) {
                if (type === 'Tile' && /^https?:\/\/mbtiles\.local\//i.test(url)) {
                    const match = url.match(/mbtiles\.local\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
                    if (match) {
                        const blob = MBTilesService.getTileBlobUrl(
                            decodeURIComponent(match[1]),
                            Number(match[2]),
                            Number(match[3]),
                            Number(match[4]),
                        );
                        if (blob) report.blobUrlsHanded++;
                        return { url: blob || TRANSPARENT_TILE_DATA_URL };
                    }
                }
                return { url };
            },
        });
        mapRef.current = map;
        map.on('error', (event) => report.errors.push(event.error?.message || event.type));
        map.on('load', () => {
            report.ready = true;
            setReady(true);
        });
        return () => map.remove();
    }, []);
    return (
        <main style={{ position: 'fixed', inset: 0 }}>
            <div ref={container} style={{ position: 'absolute', inset: 0 }} />
            <div className="proof-toolbar">
                <button onClick={() => setPaper(true)}>Charts</button>
                <button onClick={clear}>Clear</button>
            </div>
            {paper && (
                <PaperChartSheet
                    onClose={() => setPaper(false)}
                    bounds={null}
                    sources={[]}
                    onToggle={() => {}}
                    onOpacity={() => {}}
                    onConsent={() => {}}
                    category="standard"
                    onCategory={() => {}}
                    satelliteMode={false}
                    onLocalCharts={local}
                />
            )}
            {requested && (
                <LocalChartLibrarySurface
                    mapRef={mapRef}
                    mapReady={ready}
                    open={open}
                    onClose={close}
                    clearRevision={clearRevision}
                    onCredit={creditChanged}
                    onActive={activeChanged}
                />
            )}
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
                    playing: false,
                    following: false,
                    coverage: { outside: null, edgeNorth: false, edgeSouth: false, lowAngle: false },
                }}
                onToggleSatellite={() => {}}
                atmosphere={credit ? [credit] : []}
            />
            <ToastPortal />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<App />);
