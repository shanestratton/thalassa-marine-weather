import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type mapboxgl from 'mapbox-gl';
import { PlannerVesselLocator } from '../../components/map/PlannerVesselLocator';
import '../../index.css';
function Fixture() {
    const mapRef = useRef<mapboxgl.Map | null>(null);
    return (
        <main className="relative h-full bg-sky-950 text-white">
            <div className="map-tracer-panel absolute left-3 top-4 w-72 max-w-[calc(100%-80px)] rounded-2xl border border-amber-400/30 bg-slate-900 p-4">
                <h1 className="text-lg font-bold text-amber-300">Route tracer</h1>
                <p className="mt-2 text-sm text-slate-300">Layout preview · no GPS or route changes</p>
            </div>
            <div className="absolute right-3 top-4 flex flex-col gap-2">
                <button className="h-12 w-12 rounded-xl bg-slate-900 text-xl">+</button>
                <button className="h-12 w-12 rounded-xl bg-slate-900 text-xl">−</button>
            </div>
            <PlannerVesselLocator mapRef={mapRef} mapReady />
            <div className="absolute bottom-4 right-3 rounded-xl bg-slate-900 p-2 text-xs text-amber-300">
                ENC · chart attribution
            </div>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
