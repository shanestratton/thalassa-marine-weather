/** Local blank Mapbox surface and synthetic public catalogue served only by the browser test. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import type { WorldFacilitiesStatus } from '../../services/marineCatalogue/worldFacilities';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { clearCatalogueCache } from '../../services/marineCatalogue/cache';
if (!import.meta.env.DEV) throw Error('Development-only fictional fixture.');
const Layer = React.lazy(() => import('../../components/map/WorldFacilitiesLayer'));
mapboxgl.accessToken = 'pk.synthetic-facilities-test';
declare global {
    interface Window {
        __facilitiesFixture: {
            ready: () => boolean;
            count: () => number;
            project: (lon: number, lat: number) => { x: number; y: number };
            foreground: (v: boolean) => void;
            satellite: (v: boolean) => void;
            identity: () => void;
            clear: () => Promise<void>;
            zoom: (v: number) => void;
            style: () => void;
        };
    }
}
function Fixture() {
    const frame = React.useRef<HTMLDivElement>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [visible, setVisible] = React.useState(false),
        [active, setActive] = React.useState(true),
        [status, setStatus] = React.useState<WorldFacilitiesStatus | null>(null);
    React.useEffect(() => {
        const style: mapboxgl.Style = {
            version: 8,
            sources: {},
            layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#123044' } }],
        };
        const m = new mapboxgl.Map({
            container: frame.current!,
            style,
            center: [0.1, 0.1],
            zoom: 11,
            attributionControl: false,
            fadeDuration: 0,
        });
        map.current = m;
        m.on('load', () => setReady(true));
        window.__facilitiesFixture = {
            ready: () => m.loaded(),
            count: () =>
                m
                    .queryRenderedFeatures({
                        layers: m.getLayer('thalassa-world-facilities-points')
                            ? ['thalassa-world-facilities-points']
                            : [],
                    })
                    .filter((f) => f.layer.id === 'thalassa-world-facilities-points').length,
            project: (lon, lat) => {
                const p = m.project([lon, lat]);
                return { x: p.x, y: p.y };
            },
            foreground: setActive,
            satellite: (value) =>
                useSettingsStore.setState((s) => ({ settings: { ...s.settings, satelliteMode: value } })),
            identity: () => setAuthIdentityScope('fictional-other-facilities-owner'),
            clear: clearCatalogueCache,
            zoom: (zoom) => m.jumpTo({ zoom }),
            style: () => m.setStyle(style),
        };
        return () => m.remove();
    }, []);
    return (
        <main className="fixed inset-0 overflow-hidden bg-slate-950 text-white">
            <div ref={frame} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={() => {}}
                selectInGroup={() => {}}
                tacticalState={{ facilitiesVisible: visible, onToggleFacilities: () => setVisible((v) => !v) }}
            />
            {visible && active && (
                <React.Suspense fallback={null}>
                    <Layer map={map.current} mapReady={ready} onStatus={setStatus} />
                </React.Suspense>
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
                    coverage: SAT_IR_FULL_COVERAGE,
                    playing: false,
                    following: false,
                }}
                onToggleSatellite={() => {}}
                facilities={visible && active ? status : null}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
