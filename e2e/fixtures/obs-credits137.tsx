/** Synthetic source status and inline local map only. All SDK endpoints are answered locally by the test. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import { MapBaseSelector } from '../../components/map/MapBaseSelector';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import { useObsClearView } from '../../components/map/mapHub/useObsClearView';
import { installPaneAwareAttribution } from '../../components/map/paneAwareAttribution';
import { RELIEF_ATTRIBUTION } from '../../components/map/reliefBase';
import { OPENSEAMAP_ATTRIBUTION } from '../../components/map/seamarkCredit';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import { publishAisCoverage } from '../../services/ais/aisCoverage';
import type { SatIrState } from '../../components/map/useSatelliteLayer';
if (!import.meta.env.DEV) throw Error('Development-only synthetic fixture.');
mapboxgl.accessToken = 'pk.synthetic-credits-test';
publishAisCoverage({ state: 'recent', polledAt: new Date(Date.now() - 60000).toISOString(), truncated: false });
declare global {
    interface Window {
        __creditsFixture: {
            layers: (value: number) => void;
            warning: () => void;
            bounds: () => unknown;
            mapClicks: () => number;
        };
        __creditLinks: string[];
    }
}
window.__creditLinks = [];
window.open = ((url: string | URL | undefined) => {
    window.__creditLinks.push(String(url));
    return null;
}) as typeof window.open;
function Fixture() {
    const frame = React.useRef<HTMLElement | null>(null),
        container = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null),
        clicks = React.useRef(0);
    const [ready, setReady] = React.useState(false),
        [layers, setLayers] = React.useState(5),
        [playing, setPlaying] = React.useState(false),
        [old, setOld] = React.useState(false);
    const clear = useObsClearView({ frameRef: frame, available: true, modeOwnsChart: false });
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: container.current!,
            accessToken: 'pk.synthetic-credits-test',
            performanceMetricsCollection: false,
            preserveDrawingBuffer: true,
            center: [0, 0],
            zoom: 2,
            style: {
                version: 8,
                sources: {
                    local: {
                        type: 'geojson',
                        attribution: `${RELIEF_ATTRIBUTION}; ${OPENSEAMAP_ATTRIBUTION}; NOAA-derived display · not official ENC; © Land Information NZ (CC BY 4.0)`,
                        data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
                    },
                },
                layers: [
                    { id: 'sea', type: 'background', paint: { 'background-color': '#0b2030' } },
                    {
                        id: 'local',
                        type: 'circle',
                        source: 'local',
                        paint: { 'circle-radius': 4, 'circle-color': '#67e8f9' },
                    },
                ],
            },
            attributionControl: false,
        });
        map.current = m;
        m.on('load', () => {
            installPaneAwareAttribution(m, container.current!);
            setReady(true);
        });
        m.on('click', () => clicks.current++);
        window.__creditsFixture = {
            layers: setLayers,
            warning: () => {
                setOld(true);
                publishAisCoverage({ state: 'held' });
            },
            mapClicks: () => clicks.current,
            bounds: () => {
                const main = frame.current!.getBoundingClientRect(),
                    canvas = m.getCanvas().getBoundingClientRect();
                return {
                    main: { width: main.width, height: main.height },
                    canvas: { width: canvas.width, height: canvas.height },
                    scroll: document.documentElement.scrollHeight,
                    scrollWidth: document.documentElement.scrollWidth,
                };
            },
        };
        return () => m.remove();
    }, []);
    const sat: SatIrState = {
        status: layers > 1 ? 'ready' : 'off',
        frameTimeMs: Date.now() - (old ? 5 : 1) * 3600000,
        frameCount: 4,
        coverage: SAT_IR_FULL_COVERAGE,
        playing,
        following: false,
    };
    return (
        <main
            ref={frame}
            data-testid="credits-frame"
            data-obs-clear-view={clear.on ? 'on' : 'off'}
            className="fixed inset-0 isolate overflow-hidden bg-slate-950 text-white"
        >
            <div ref={container} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <MapBaseSelector
                visible={ready}
                value="relief"
                onChange={() => {}}
                encCellCount={0}
                encVisible={false}
                onToggleEnc={() => {}}
                onClearView={clear.hide}
            />
            <RadialHelmMenu
                activeLayers={new Set(['wind', 'rain', 'currents'])}
                toggleLayer={() => {}}
                selectInGroup={() => {}}
                tacticalState={{ aisVisible: true, onToggleAis: () => {}, onOpenMob: () => {} }}
            />
            <ObsCreditsRollup
                rain={layers ? 'radar' : null}
                wind={layers > 1 ? 'Wind: ECMWF (CC BY 4.0) via Open-Meteo' : null}
                cmems={layers > 1 ? ['currents', 'waves', 'chl'] : []}
                lightning={false}
                satellite={sat}
                ais={layers > 1}
                onToggleSatellite={() => setPlaying((v) => !v)}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
