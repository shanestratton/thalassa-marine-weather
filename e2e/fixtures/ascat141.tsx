import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type mapboxgl from 'mapbox-gl';
import AscatObservedLayer from '../../components/map/AscatObservedLayer';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import type { AtmosCredit } from '../../components/map/atmosPresentation';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import packet from '../../tests/fixtures/ascat141-packet.json';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
Object.defineProperty(Date, 'now', { value: () => packet.now * 1000 + 1000 });
document.documentElement.style.fontSize = '20.8px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
let reads = 0;
document.documentElement.dataset.ascatReads = '0';
window.fetch = async (url) => {
    const path = new URL(String(url)).pathname.split('/weather/ascat/v1/')[1];
    const raw = packet.resources[path as keyof typeof packet.resources];
    document.documentElement.dataset.ascatReads = String(++reads);
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
function Fixture() {
    const [active, setActive] = useState(false),
        [ready, setReady] = useState(false),
        [credit, setCredit] = useState<AtmosCredit | null>(null);
    const host = useRef<HTMLDivElement>(null),
        ref = useRef<mapboxgl.Map | null>(null);
    useEffect(() => {
        const map = {
            getContainer: () => host.current!,
            getCenter: () => ({ lng: 154.1, lat: -27 }),
            getBounds: () => ({ getWest: () => 153, getSouth: () => -28, getEast: () => 155, getNorth: () => -26 }),
            project: ([lon, lat]: [number, number]) => ({ x: 70 + (lon - 154) * 300, y: 100 - (lat + 27) * 300 }),
            unproject: ([x, y]: [number, number]) => ({ lng: 154 + (x - 70) / 300, lat: -27 - (y - 100) / 300 }),
            getStyle: () => ({ layers }),
            getSource: (id: string) => sources.get(id),
            getLayer: (id: string) => layers.find((v) => v.id === id),
            isSourceLoaded: () => true,
            addSource: (id: string, value: object) => {
                sources.set(id, { ...value, setData: () => {} });
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
            },
            setLayoutProperty: (id: string, _key: string, visibility: string) => {
                const layer = layers.find((v) => v.id === id);
                if (layer) layer.layout = { visibility };
            },
            getLayoutProperty: (id: string) => layers.find((v) => v.id === id)?.layout?.visibility,
            moveLayer: () => {},
            on: (name: string, callback: (event: unknown) => void) => {
                if (!handlers.has(name)) handlers.set(name, new Set());
                handlers.get(name)!.add(callback);
            },
            off: (name: string, callback: (event: unknown) => void) => {
                handlers.get(name)?.delete(callback);
            },
            queryRenderedFeatures: () => [{ source: 'ascat-observed141-source', properties: { row: 1 } }],
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
            <p className="px-3 text-xs">Fictional swath · synthetic map host</p>
            <div className="flex flex-wrap gap-1 px-2">
                <button className="min-h-11 px-2 text-xs" onClick={() => setActive(!active)}>
                    {active ? 'Hide all' : 'Satellite wind'}
                </button>
                <button
                    className="min-h-11 px-2 text-xs"
                    onClick={() =>
                        emit('click', {
                            point: { x: 70, y: 100 },
                            preventDefault() {},
                            originalEvent: new Event('click'),
                        })
                    }
                >
                    Inspect vector
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
            <AscatObservedLayer
                mapRef={ref}
                mapReady={ready}
                active={active}
                canInteract
                onCredit={setCredit}
                onInteractionChange={() => {}}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
