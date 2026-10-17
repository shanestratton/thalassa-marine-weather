import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type mapboxgl from 'mapbox-gl';
import OpticalLightningLayer from '../../components/map/OpticalLightningLayer';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import type { AtmosCredit } from '../../components/map/atmosPresentation';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import packet from '../../tests/fixtures/optical142/fictional-packet.json';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');
Object.defineProperty(Date, 'now', { value: () => packet.now });
document.documentElement.style.fontSize = '20.8px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
let reads = 0;
document.documentElement.dataset.opticalReads = '0';
document.documentElement.dataset.opticalFeatures = '0';
window.fetch = async (url) => {
    const path = new URL(String(url)).pathname.split('/optical-lightning/v1/')[1];
    const raw = packet.resources[path as keyof typeof packet.resources];
    document.documentElement.dataset.opticalReads = String(++reads);
    return new Response(raw ?? 'Fictional cohort only; network disabled', { status: raw ? 200 : 503 });
};
const handlers = new Map<string, Set<(event: unknown) => void>>(),
    sources = new Map<string, unknown>();
let layers: { id: string; source?: string; type: string; layout?: { visibility: string } }[] = [
    { id: 'fixture-base', type: 'raster' },
];
const emit = (name: string, event: unknown = {}) => {
    for (const callback of [...(handlers.get(name) ?? [])]) callback(event);
};
const count = (data: GeoJSON.FeatureCollection) => {
    document.documentElement.dataset.opticalFeatures = String(data?.features?.length ?? 0);
};
function Fixture() {
    const [active, setActive] = useState(false),
        [ready, setReady] = useState(false),
        [credit, setCredit] = useState<AtmosCredit | null>(null);
    const host = useRef<HTMLDivElement>(null),
        ref = useRef<mapboxgl.Map | null>(null);
    useEffect(() => {
        const map = {
            getContainer: () => host.current!,
            getZoom: () => 6,
            getBounds: () => ({ getWest: () => -71, getSouth: () => 9, getEast: () => -69, getNorth: () => 11 }),
            getStyle: () => ({ layers }),
            getSource: (id: string) => sources.get(id),
            getLayer: (id: string) => layers.find((v) => v.id === id),
            isSourceLoaded: () => true,
            addSource: (id: string, value: { data: GeoJSON.FeatureCollection }) => {
                count(value.data);
                sources.set(id, { ...value, setData: count });
                queueMicrotask(() => emit('sourcedata', { sourceId: id, sourceDataType: 'content' }));
            },
            addLayer: (value: (typeof layers)[number]) => {
                layers.push(value);
            },
            removeLayer: (id: string) => {
                layers = layers.filter((v) => v.id !== id);
            },
            removeSource: (id: string) => {
                sources.delete(id);
                document.documentElement.dataset.opticalFeatures = '0';
            },
            setLayoutProperty: (id: string, _key: string, visibility: string) => {
                const value = layers.find((v) => v.id === id);
                if (value) value.layout = { visibility };
            },
            getLayoutProperty: (id: string) => layers.find((v) => v.id === id)?.layout?.visibility,
            moveLayer: () => {},
            on: (name: string, fn: (event: unknown) => void) => {
                if (!handlers.has(name)) handlers.set(name, new Set());
                handlers.get(name)!.add(fn);
            },
            off: (name: string, fn: (event: unknown) => void) => {
                handlers.get(name)?.delete(fn);
            },
        };
        ref.current = map as unknown as mapboxgl.Map;
        setReady(true);
        return () => {
            ref.current = null;
            handlers.clear();
            sources.clear();
        };
    }, []);
    return (
        <main className="flex h-full min-w-0 flex-col overflow-hidden bg-slate-950 text-white">
            <p className="px-3 text-xs">Fictional optical data · synthetic map host</p>
            <div className="px-2">
                <button className="min-h-11 w-[150px] px-2 text-xs" onClick={() => setActive(!active)}>
                    {active ? 'Hide all' : 'Satellite flashes'}
                </button>
            </div>
            <div ref={host} data-testid="map" className="relative min-h-0 flex-1 overflow-hidden bg-slate-900">
                <p className="absolute left-3 top-4 text-xs text-slate-400">Synthetic map canvas</p>
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
                    atmosphere={credit ? [credit] : []}
                />
            </div>
            <OpticalLightningLayer mapRef={ref} mapReady={ready} active={active} onCredit={setCredit} />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
