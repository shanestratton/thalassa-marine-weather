/** Local invented geometry/encoded pixels, actual Mapbox expressions and display controls. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import PaperChartSheet from '../../components/map/PaperChartSheet';
import { MapBaseSelector } from '../../components/map/MapBaseSelector';
import { buildDepareFillColor } from '../../components/map/encDepthStyle';
import { depthStyleState, setEncContourBands } from '../../components/map/encDepthStyleState';
import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
import { depthIndex, LIGHT_PALETTE, reliefIndexRamp, setReliefPalette } from '../../components/map/reliefBase';
import { effectiveChartContours, type ChartContours } from '../../services/enc/chartContours';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
setAuthIdentityScope('chart-contours-fixture-owner');
mapboxgl.accessToken = 'pk.synthetic-local-contours';
const lons = [179.4, 179.7, 180, 180.3, 180.6];
function fixtureRaster() {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    for (const [i, value] of [
        0,
        Math.round(depthIndex(1)),
        Math.round(depthIndex(4)),
        Math.round(depthIndex(10)),
        255,
    ].entries()) {
        ctx.fillStyle = `rgb(${value},0,0)`;
        ctx.fillRect(i * 20, 0, 20, 8);
    }
    return canvas.toDataURL('image/png');
}
function Fixture() {
    const holder = React.useRef<HTMLDivElement>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [paper, setPaper] = React.useState(false);
    const [choice, setChoice] = React.useState<ChartContours | null>(null);
    const [category, setCategory] = React.useState<'base' | 'standard' | 'all'>('standard');
    const effective = effectiveChartContours(choice, 3);
    const close = React.useCallback(() => setPaper(false), []);
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: holder.current!,
            testMode: true,
            center: [180, -27.1],
            zoom: 7,
            preserveDrawingBuffer: true,
            fadeDuration: 0,
            attributionControl: false,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'fixture-background', type: 'background', paint: { 'background-color': '#223344' } }],
            },
        });
        map.current = m;
        m.on('load', () => {
            m.addSource('fixture-depths', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: [null, 1, 4, 8, 40].map((depth, i) => ({
                        type: 'Feature' as const,
                        properties: { DRVAL1: depth, _drawTier: 1 },
                        geometry: {
                            type: 'Polygon' as const,
                            coordinates: [
                                [
                                    [lons[i] - 0.13, -27.06],
                                    [lons[i] + 0.13, -27.06],
                                    [lons[i] + 0.13, -26.96],
                                    [lons[i] - 0.13, -26.96],
                                    [lons[i] - 0.13, -27.06],
                                ],
                            ],
                        },
                    })),
                },
            });
            m.addLayer({
                id: ENC_VEC_LAYERS.DEPARE,
                type: 'fill',
                source: 'fixture-depths',
                paint: { 'fill-color': buildDepareFillColor(), 'fill-opacity': 0.95, 'fill-antialias': false },
            });
            m.addSource('fixture-contours', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: [
                        ['coarse', 5],
                        ['coarse', 10],
                        ['fine', 6],
                        ['fine', 20],
                    ].map(([cell, depth], i) => ({
                        type: 'Feature' as const,
                        properties: { _cellId: cell, VALDCO: depth },
                        geometry: {
                            type: 'LineString' as const,
                            coordinates: [
                                [179.4 + i * 0.3, -27.32],
                                [179.4 + i * 0.3, -27.38],
                            ],
                        },
                    })),
                },
            });
            for (const id of [ENC_VEC_LAYERS.DEPCNT_LINE, ENC_VEC_LAYERS.DEPCNT_SAFETY])
                m.addLayer({
                    id,
                    type: 'line',
                    source: 'fixture-contours',
                    paint: { 'line-color': '#f97316', 'line-width': 4 },
                });
            m.addSource('fixture-relief', {
                type: 'image',
                url: fixtureRaster(),
                coordinates: [
                    [179.25, -27.14],
                    [180.75, -27.14],
                    [180.75, -27.25],
                    [179.25, -27.25],
                ],
            });
            m.addLayer({
                id: 'relief-global-tint',
                type: 'raster',
                source: 'fixture-relief',
                paint: {
                    'raster-color': reliefIndexRamp(LIGHT_PALETTE.ramp),
                    'raster-color-mix': [255, 0, 0, 0],
                    'raster-color-range': [0, 255],
                    'raster-resampling': 'nearest',
                    'raster-fade-duration': 0,
                },
            });
            depthStyleState.set(m, {
                safetyDepthM: 3,
                hazardDepthM: 5,
                depcntValdcosByCell: { coarse: [5, 10], fine: [6, 20] },
            });
            setEncContourBands(m, null);
            setReady(true);
        });
        Object.assign(window, { __chartContoursMap: m });
        return () => {
            map.current = null;
            m.remove();
        };
    }, []);
    React.useEffect(() => {
        const m = map.current;
        if (!ready || !m) return;
        setEncContourBands(m, choice);
        setReliefPalette(m, 'light', effective?.reliefSafety ? effective.safetyM : null);
    }, [choice, effective, ready]);
    return (
        <main className="h-dvh bg-slate-950 text-slate-100">
            <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
            <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2">
                <MapBaseSelector
                    visible={ready}
                    value="relief"
                    onChange={() => undefined}
                    encCellCount={2}
                    encVisible
                    onToggleEnc={() => undefined}
                    onCharts={() => setPaper(true)}
                    safetyDepthNotice={
                        effective?.reliefSafety
                            ? `Relief safety marker ~${effective.safetyM} m · not for navigation`
                            : undefined
                    }
                />
            </div>
            <div className="pointer-events-none absolute bottom-0 w-full bg-slate-950 p-2 text-center text-xs">
                Synthetic display · chart datum and model depth differ
            </div>
            {paper && (
                <PaperChartSheet
                    onClose={close}
                    bounds={[179, -28, 181, -26]}
                    sources={[]}
                    onToggle={() => undefined}
                    onOpacity={() => undefined}
                    onConsent={() => undefined}
                    category={category}
                    onCategory={setCategory}
                    satelliteMode={false}
                    contours={{ value: choice, requiredM: 3, draftAssumed: true, unit: 'm', onChange: setChoice }}
                />
            )}
            <output className="sr-only" aria-label="Fixture ready">
                {ready ? 'Ready' : 'Loading'}
            </output>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
