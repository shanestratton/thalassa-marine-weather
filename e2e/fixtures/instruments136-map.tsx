/** Real source-free Mapbox drawing of fictional measured vectors and local guides. */
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { InstrumentOverlayRenderer } from '../../components/map/SailingInstrumentOverlay';
import { measuredCurrent } from '../../services/instruments/measuredCurrent';
import { sailingPerformance } from '../../services/instruments/performance';
import { instrumentLaylines } from '../../services/instruments/laylines';
import type { InstrumentEvidence } from '../../services/instruments/measurements';
function Fixture() {
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        mapboxgl.accessToken = 'pk.synthetic-instruments';
        const map = new mapboxgl.Map({
            container: ref.current!,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#071524' } }],
            },
            center: [-60, 30.01],
            zoom: 12,
            bearing: 30,
            attributionControl: false,
            preserveDrawingBuffer: true,
        });
        let renderer: InstrumentOverlayRenderer | null = null;
        map.on('load', () => {
            const now = Date.now();
            const reading = (
                value: number,
                unit: 'knots' | 'degrees',
                reference?: 'true' | 'ground' | 'water' | 'relative',
            ) => ({ value, unit, reference, at: now, source: 'Fictional fixture' });
            const e: InstrumentEvidence = {
                identity: 'fictional-boat',
                via: 'lan',
                position: { lat: 30, lon: -60, at: now },
                readings: {
                    sog: reading(Math.sqrt(26), 'knots', 'ground'),
                    cogTrue: reading((Math.atan2(1, 5) * 180) / Math.PI, 'degrees', 'true'),
                    stw: reading(5, 'knots', 'water'),
                    headingTrue: reading(0, 'degrees', 'true'),
                    tws: reading(15, 'knots'),
                    twaSigned: reading(60, 'degrees', 'relative'),
                    twdTrue: reading(60, 'degrees', 'true'),
                },
            };
            const c = measuredCurrent(e, now);
            const p = sailingPerformance({
                evidence: e,
                polar: {
                    polar: {
                        windSpeeds: [10, 20],
                        angles: [45, 90, 135, 180],
                        matrix: [
                            [4, 8],
                            [4, 8],
                            [4, 8],
                            [4, 8],
                        ],
                    },
                    source: 'manual',
                    label: 'Fictional polar',
                    reason: 'Test',
                    signature: 'fictional',
                },
                vessel: { type: 'sail' },
                propulsion: 'sail',
                now,
            });
            if (c.kind !== 'available' || p.kind !== 'available') throw Error('Fixture data refused');
            const guides = instrumentLaylines({
                boat: { lat: 30, lon: -60 },
                mark: { lat: 30.02, lon: -60 },
                performance: p,
                current: c,
                now,
            });
            map.addSource('model-current', {
                type: 'geojson',
                data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-60, 30.01] } },
            });
            map.addLayer({
                id: 'model-current',
                type: 'circle',
                source: 'model-current',
                paint: { 'circle-color': '#2563eb', 'circle-radius': 4 },
            });
            renderer = new InstrumentOverlayRenderer(map);
            renderer.update({
                position: { lat: 30, lon: -60 },
                current: c,
                laylines: guides,
                markName: 'Fictional mark',
                now,
            });
            Object.assign(window, {
                __instrumentMap: {
                    clear: () =>
                        renderer?.update({ position: null, current: null, laylines: null, markName: null, now }),
                    probe: () => ({
                        styleLoaded: map.isStyleLoaded(),
                        modelLoaded: map.isSourceLoaded('model-current'),
                        renderLoaded: map.loaded(),
                        own: !!map.getLayer('own-instrument-layline-guides'),
                        model: !!map.getLayer('model-current'),
                        features: (
                            map.getSource('own-instrument-laylines') as mapboxgl.GeoJSONSource | undefined
                        )?.serialize().data,
                        angle: document.querySelector('.mapboxgl-marker span')?.getAttribute('style'),
                    }),
                },
            });
            document.body.dataset.ready = 'true';
        });
        return () => {
            renderer?.destroy();
            map.remove();
        };
    }, []);
    return <div ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
