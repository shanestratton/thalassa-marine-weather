/** Development-only loopback replay of the actual public snapshot, no live provider traffic. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import SshObservedLayer from '../../components/map/SshObservedLayer';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import type { AtmosCredit } from '../../components/map/atmosPresentation';
import type { SshMode } from '../../components/map/useSshObservation';
if (!import.meta.env.DEV) throw new Error('Development-only replay');
const requests: string[] = [],
    mapErrors: string[] = [],
    remoteAttempts: string[] = [];
const nativeFetch = window.fetch.bind(window),
    pending: (() => void)[] = [];
let delayed = false;
window.fetch = async (input, options) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.pathname.startsWith('/api/ssh/')) {
        requests.push(url.pathname);
        // A deliberately uncooperative completed transport exercises late source rejection.
        const response = await nativeFetch(input, { ...options, signal: undefined });
        if (delayed && url.pathname.endsWith('.bin')) await new Promise<void>((resolve) => pending.push(resolve));
        return response;
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin)
        return nativeFetch(input, options);
    if (
        url.hostname === 'events.mapbox.com' ||
        (url.hostname === 'api.mapbox.com' && url.pathname.includes('map-sessions'))
    )
        return new Response(null, { status: 204 });
    remoteAttempts.push(url.origin + url.pathname);
    return new Response('Replay denies external traffic', { status: 503 });
};
mapboxgl.accessToken = 'pk.local-published-ocean-replay';
declare global {
    interface Window {
        __ssh141: { off(): void; delay(): void; resolve(): void; pan(): void; evidence(): unknown };
    }
}
function Fixture() {
    const container = React.useRef<HTMLDivElement>(null),
        mapRef = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [mode, setMode] = React.useState<SshMode>('off');
    const [credit, setCredit] = React.useState<AtmosCredit | null>(null);
    React.useEffect(() => {
        const map = new mapboxgl.Map({
            container: container.current!,
            center: [155, -27],
            zoom: 3,
            preserveDrawingBuffer: true,
            performanceMetricsCollection: false,
            attributionControl: false,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'base', type: 'background', paint: { 'background-color': '#081c2c' } }],
            },
        });
        mapRef.current = map;
        map.on('load', () => setReady(true));
        map.on('error', (event) => {
            if (mapErrors.length < 20) mapErrors.push(event.error.message);
        });
        window.__ssh141 = {
            off: () => setMode('off'),
            delay: () => {
                delayed = true;
            },
            resolve: () => {
                delayed = false;
                for (const resolve of pending.splice(0)) resolve();
            },
            pan: () => map.jumpTo({ center: [162, -24] }),
            evidence: () => {
                const canvas = map.getCanvas().getBoundingClientRect(),
                    style = map.getStyle();
                return {
                    requests: [...requests],
                    mapErrors: [...mapErrors],
                    remoteAttempts: [...remoteAttempts],
                    pending: pending.length,
                    overlayIds: style.layers
                        .filter((layer) => layer.id.startsWith('observed-ssh'))
                        .map((layer) => layer.id),
                    sourceIds: Object.keys(style.sources).filter((id) => id.startsWith('observed-ssh')),
                    canvas: { width: canvas.width, height: canvas.height },
                    scrollHeight: document.documentElement.scrollHeight,
                    scrollWidth: document.documentElement.scrollWidth,
                };
            },
        };
        return () => map.remove();
    }, []);
    return (
        <main className="fixed inset-0 isolate overflow-hidden bg-slate-950 text-white">
            <div ref={container} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <SshObservedLayer mapRef={mapRef} mapReady={ready} active mode={mode} onCredit={setCredit} />
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
                atmosphere={credit ? [credit] : []}
            />
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={() => undefined}
                selectInGroup={() => undefined}
                tacticalState={{ sshMode: mode, onChangeSshMode: setMode }}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
