/** Real Mapbox + actual relief/downloader/credits; network replay lives in the test. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import { OfflineAreaModal } from '../../components/map/OfflineAreaModal';
import {
    addReliefBase,
    offlineReliefStyle,
    seaBaseLayers,
    setReliefPalette,
    reloadReliefSources,
} from '../../components/map/reliefBase';
import { installPaneAwareAttribution } from '../../components/map/paneAwareAttribution';
import {
    downloadReliefArea,
    hydrateRelief,
    reliefStorage,
    type ReliefProgress,
} from '../../services/OfflineReliefService';
import { offlineReliefUrl } from '../../services/offlineReliefRuntime';
import { planReliefArea } from '../../services/offlineReliefPlan';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';

const point = (z: number, x: number, y: number) =>
    [
        ((x + 0.5) / 2 ** z) * 360 - 180,
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z))) * 180) / Math.PI,
    ] as [number, number];
const locations = {
    nz: { center: point(14, 15825, 10578), zoom: 14 },
    au: { center: [92.1, -8.15] as [number, number], zoom: 8 },
    gap: { center: [174, -45] as [number, number], zoom: 14 },
};
const errors: string[] = [];
let map: mapboxgl.Map;
const ready = (async () => {
    await hydrateRelief();
    mapboxgl.accessToken = 'pk.regional-relief-replay';
    map = new mapboxgl.Map({
        container: 'map',
        style: offlineReliefStyle(),
        ...locations.nz,
        attributionControl: false,
        fadeDuration: 0,
        preserveDrawingBuffer: true,
        maxTileCacheSize: 20,
        transformRequest: (url, type) => ({ url: type === 'Tile' ? (offlineReliefUrl(url) ?? url) : url }),
    });
    map.on('error', (e) => errors.push(e.error?.message ?? 'Map error'));
    installPaneAwareAttribution(map, document.getElementById('map')!);
    await new Promise<void>((resolve) =>
        map.once('load', () => {
            addReliefBase(map);
            for (const [id, on] of seaBaseLayers('relief'))
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
            setReliefPalette(map, 'day');
            resolve();
        }),
    );
    createRoot(document.getElementById('controls')!).render(<Controls />);
})();
function Controls() {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <ObsCreditsRollup
                relief
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
            />
            <button
                className="absolute bottom-14 left-3 z-50 min-h-[44px] rounded-lg bg-slate-950 px-3 text-xs text-white"
                onClick={() => setOpen(true)}
            >
                Offline area
            </button>
            <OfflineAreaModal isOpen={open} onClose={() => setOpen(false)} map={map} />
        </>
    );
}
export interface RegionalReliefFixture {
    ready(): Promise<void>;
    move(name: keyof typeof locations): Promise<void>;
    probe(): Promise<{
        sources: string[];
        layers: string[];
        pixelColours: number;
        nonBackground: number;
        attribution: string;
        errors: string[];
        storage: ReturnType<typeof reliefStorage>;
    }>;
    save(): Promise<{ progress: ReliefProgress | undefined; storage: ReturnType<typeof reliefStorage> }>;
    plan(): ReturnType<typeof planReliefArea>;
    prepareOffline(): Promise<void>;
}
const api: RegionalReliefFixture = {
    prepareOffline: async () => {
        await navigator.serviceWorker.register('/sw-relief140.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
            await new Promise<void>((resolve) =>
                navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
            );
    },
    ready: () => ready,
    move: async (name) => {
        await ready;
        map.jumpTo(locations[name]);
    },
    probe: async () => {
        await ready;
        await new Promise<void>((resolve) => {
            map.once('render', () => resolve());
            map.triggerRepaint();
        });
        const c = map.getCanvas(),
            gl = c.getContext('webgl2')!,
            pixels = new Uint8Array(c.width * c.height * 4),
            colours = new Set<number>();
        let nonBackground = 0;
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 0; i < pixels.length; i += 4) {
            colours.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
            if (pixels[i] !== 51 || pixels[i + 1] !== 59 || pixels[i + 2] !== 69) nonBackground++;
        }
        return {
            sources: Object.keys(map.getStyle().sources),
            layers: map.getStyle().layers.map((l) => l.id),
            pixelColours: colours.size,
            nonBackground,
            attribution: document.querySelector('.mapboxgl-ctrl-attrib')?.textContent ?? '',
            errors: errors.slice(-24),
            storage: reliefStorage(),
        };
    },
    save: async () => {
        await ready;
        let progress: ReliefProgress | undefined;
        const [lon, lat] = locations.nz.center;
        await downloadReliefArea(
            { west: lon - 0.0001, east: lon + 0.0001, south: lat - 0.0001, north: lat + 0.0001 },
            14,
            'https://tiles.thalassatiles.com/v1',
            new AbortController().signal,
            (p) => {
                progress = p;
            },
        );
        reloadReliefSources(map);
        return { progress, storage: reliefStorage() };
    },
    plan: () => {
        const [lon, lat] = locations.nz.center;
        return planReliefArea({ west: lon - 0.0001, east: lon + 0.0001, south: lat - 0.0001, north: lat + 0.0001 }, 14);
    },
};
Object.assign(window, { __relief140: api });
document.body.style.cssText = 'margin:0;overflow:hidden;width:100vw;height:100dvh';
document.getElementById('root')!.innerHTML =
    '<div id="map" style="position:absolute;inset:0"></div><div id="controls"></div>';
