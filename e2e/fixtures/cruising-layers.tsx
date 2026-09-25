import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { useCruisingReferenceLayer } from '../../components/map/useCruisingReferenceLayer';
import { useAnchorageLayer } from '../../components/map/useAnchorageLayer';
import { CruisingReferenceKey } from '../../components/map/CruisingReferenceKey';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import type { MooringColourFilter } from '../../services/anchorages/cruisingReference';

const style: mapboxgl.StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#08243b' } }],
};
function Fixture() {
    const container = useRef<HTMLDivElement>(null),
        mapRef = useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = useState(false),
        [moorings, setMoorings] = useState(true),
        [anchors, setAnchors] = useState(true);
    const [filter, setFilter] = useState<MooringColourFilter>('all');
    useEffect(() => {
        const map = new mapboxgl.Map({
            container: container.current!,
            style,
            center: [148.9252, -20.074],
            zoom: 14.6,
            attributionControl: false,
            preserveDrawingBuffer: true,
            testMode: true,
        });
        mapRef.current = map;
        map.on('load', () => setReady(true));
        Object.assign(window, {
            cruisingTest: {
                resetStyle: () => map.setStyle(style),
                count: () =>
                    map.queryRenderedFeatures({
                        layers: map.getLayer('cruising-mooring-symbols') ? ['cruising-mooring-symbols'] : [],
                    }).length,
                point: () => map.project([148.92429721599896, -20.074777005728155]),
            },
        });
        return () => {
            mapRef.current = null;
            map.remove();
        };
    }, []);
    const refs = useCruisingReferenceLayer(mapRef, ready, moorings, anchors, filter, {
        length: 48,
        hullType: 'monohull',
    } as import('../../types/vessel').VesselProfile);
    useAnchorageLayer(mapRef, ready, anchors, refs.center, refs.anchors);
    return (
        <main className="fixed inset-0 bg-slate-950 text-white">
            <div ref={container} style={{ position: 'absolute', inset: 0 }} />
            <div className="absolute top-4 left-3 rounded-xl bg-slate-950/90 px-3 py-2 text-sm font-bold">
                Butterfly Bay · reference test
            </div>
            <div
                data-testid="status"
                className="absolute top-16 left-3 max-w-52 rounded-xl bg-slate-950/90 px-3 py-2 text-xs"
            >
                {refs.status}
            </div>
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={() => {}}
                selectInGroup={() => {}}
                tacticalState={{
                    mooringsVisible: moorings,
                    onToggleMoorings: () => setMoorings((v) => !v),
                    anchorageVisible: anchors,
                    onToggleAnchorage: () => setAnchors((v) => !v),
                }}
            />
            {(moorings || anchors) && (
                <CruisingReferenceKey moorings={moorings} status={refs.status} filter={filter} onFilter={setFilter} />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
