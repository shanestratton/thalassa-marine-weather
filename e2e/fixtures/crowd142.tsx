import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type mapboxgl from 'mapbox-gl';
import CrowdSoundingLayer from '../../components/map/CrowdSoundingLayer';
import CrowdSoundingConsentSheet, {
    type CrowdConsentActions,
} from '../../components/settings/CrowdSoundingConsentSheet';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import type { AtmosCredit } from '../../components/map/atmosPresentation';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import packet from '../../tests/fixtures/crowd142/fictional-cohort.json';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development-only fictional crowd fixture');
Object.defineProperty(Date, 'now', { value: () => packet.now });
setAuthIdentityScope('11111111-1111-4111-8111-111111111111');
document.documentElement.style.fontSize = '20.8px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
document.documentElement.dataset.crowdReads = '0';
document.documentElement.dataset.crowdFeatures = '0';
let reads = 0;
window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.href.startsWith('https://tiles.thalassatiles.com/crowd/v1/'))
        return new Response('Fictional fixture only', { status: 503 });
    const key = url.pathname.split('/crowd/v1/generations/')[1];
    const raw = url.pathname.endsWith('/latest.json')
        ? packet.pointer
        : packet.objects[key as keyof typeof packet.objects];
    document.documentElement.dataset.crowdReads = String(++reads);
    return new Response(raw ?? 'Missing fictional tile', { status: raw ? 200 : 404 });
};
const boat = '22222222-2222-4222-8222-222222222222';
const actions: CrowdConsentActions = {
    flushCrowdRevoke: async () => true,
    readCrowdPermission: async () => ({
        boatId: boat,
        boatName: 'Fictional owned yacht with a long calibration review name',
        permission: null,
        pendingRevoke: false,
    }),
    revokeCrowdPermission: async () => 'pending',
    saveCrowdPermission: async (input) => ({
        revision: '33333333-3333-4333-8333-333333333333',
        mapEnabled: input.mapEnabled,
        dcdbEnabled: input.dcdbEnabled,
        mapEffectiveFrom: input.mapEnabled ? packet.now : null,
        dcdbEffectiveFrom: input.dcdbEnabled ? packet.now : null,
        calibration: input.calibration,
    }),
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
        [open, setOpen] = useState(false),
        [credit, setCredit] = useState<AtmosCredit | null>(null);
    const host = useRef<HTMLDivElement>(null),
        ref = useRef<mapboxgl.Map | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    useEffect(() => {
        const map = {
            getContainer: () => host.current!,
            getCenter: () => ({ lng: 154, lat: -27 }),
            getZoom: () => 11,
            getBounds: () => ({
                getWest: () => 153.99,
                getSouth: () => -27.01,
                getEast: () => 154.01,
                getNorth: () => -26.99,
            }),
            project: ([lon, lat]: [number, number]) => ({ x: 70 + (lon - 154) * 300, y: 100 - (lat + 27) * 300 }),
            unproject: ([x, y]: [number, number]) => ({ lng: 154 + (x - 70) / 300, lat: -27 - (y - 100) / 300 }),
            getStyle: () => ({ layers }),
            getSource: (id: string) => sources.get(id),
            getLayer: (id: string) => layers.find((v) => v.id === id),
            isSourceLoaded: () => true,
            addSource: (id: string, value: object) => {
                sources.set(id, { ...value, setData: () => {} });
                document.documentElement.dataset.crowdFeatures = String(
                    (value as { data?: GeoJSON.FeatureCollection }).data?.features.length ?? 0,
                );
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
                document.documentElement.dataset.crowdFeatures = '0';
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
            queryRenderedFeatures: () => [],
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
            <p className="px-3 text-xs">Fictional crowd data · synthetic map host</p>
            <div className="flex flex-wrap gap-1 px-2">
                <button className="min-h-11 px-2 text-xs" style={{ width: 132 }} onClick={() => setActive(!active)}>
                    {active ? 'Hide all' : 'Crowd soundings'}
                </button>
                <button className="min-h-11 px-2 text-xs" style={{ width: 132 }} onClick={() => setOpen(true)}>
                    Contribution settings
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
            <CrowdSoundingLayer mapRef={ref} mapReady={ready} active={active} onCredit={setCredit} />
            {open && <CrowdSoundingConsentSheet boatId={boat} onClose={close} actions={actions} />}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
