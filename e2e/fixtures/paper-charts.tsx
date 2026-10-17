/** Fictional features, real Mapbox raster, source lifecycle, consent and chart controls. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { MapBaseSelector, type MapBaseKind } from '../../components/map/MapBaseSelector';
import PaperChartSheet from '../../components/map/PaperChartSheet';
import { applyEncOnlyBase } from '../../components/map/encOnlyBase';
import { applyChartDetailLevel } from '../../components/map/encDetailScrubber';
import { CATEGORY_DETAIL, type ChartDisplayCategory } from '../../components/map/chartDisplayCategory';
import { useChartCatalog } from '../../components/map/useChartCatalog';
import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
mapboxgl.accessToken = 'pk.synthetic-paper-chart';
function Fixture() {
    const ref = React.useRef<mapboxgl.Map | null>(null),
        box = React.useRef<HTMLDivElement | null>(null);
    const [ready, setReady] = React.useState(false),
        [open, setOpen] = React.useState(false),
        [paused, setPaused] = React.useState(false),
        [base, setBase] = React.useState<MapBaseKind>('relief'),
        [category, setCategory] = React.useState<ChartDisplayCategory>('standard');
    const catalog = useChartCatalog(ref, ready, base !== 'enc', true, paused);
    const close = React.useCallback(() => setOpen(false), []);
    React.useEffect(() => {
        const map = new mapboxgl.Map({
            container: box.current!,
            center: [-76.3, 36.85],
            zoom: 10,
            fadeDuration: 0,
            preserveDrawingBuffer: true,
            style: {
                version: 8,
                sources: {
                    composite: {
                        type: 'geojson',
                        data: {
                            type: 'Feature',
                            properties: {},
                            geometry: {
                                type: 'Polygon',
                                coordinates: [
                                    [
                                        [-90, 20],
                                        [-60, 20],
                                        [-60, 50],
                                        [-90, 50],
                                        [-90, 20],
                                    ],
                                ],
                            },
                        },
                    },
                    chart: {
                        type: 'geojson',
                        data: {
                            type: 'Feature',
                            properties: {},
                            geometry: { type: 'Point', coordinates: [-76.3, 36.85] },
                        },
                    },
                },
                layers: [
                    { id: 'background', type: 'background', paint: { 'background-color': '#8b9ca4' } },
                    { id: 'base-land', type: 'fill', source: 'composite', paint: { 'fill-color': '#91ad78' } },
                    {
                        id: ENC_VEC_LAYERS.BOYISD,
                        type: 'circle',
                        source: 'chart',
                        paint: { 'circle-color': '#ff0000', 'circle-radius': 15 },
                    },
                ],
            },
        });
        ref.current = map;
        map.on('load', () => setReady(true));
        Object.assign(window, {
            __paperMap: map,
            __paperProbe: async (centre = false) => {
                await new Promise<void>((resolve) => {
                    map.once('render', () => resolve());
                    map.triggerRepaint();
                });
                const canvas = map.getCanvas(),
                    gl = canvas.getContext('webgl2')!,
                    pixel = new Uint8Array(4);
                gl.readPixels(
                    Math.floor(canvas.width * (centre ? 0.5 : 0.75)),
                    Math.floor(canvas.height / 2),
                    1,
                    1,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    pixel,
                );
                return {
                    pixel: [...pixel],
                    loaded: !!map.getSource('chart-catalog-noaa-ncds') && map.isSourceLoaded('chart-catalog-noaa-ncds'),
                };
            },
        });
        return () => {
            map.remove();
            ref.current = null;
        };
    }, []);
    React.useEffect(() => {
        if (ready && ref.current) {
            applyEncOnlyBase(ref.current, base === 'enc');
            applyChartDetailLevel(ref.current, CATEGORY_DETAIL[category]);
        }
    }, [ready, base, category]);
    return (
        <div className="fixed inset-0 bg-slate-950 text-white">
            <div ref={box} className="absolute inset-0" />
            <MapBaseSelector
                visible
                value={base}
                onChange={setBase}
                encCellCount={1}
                encVisible
                onToggleEnc={() => undefined}
                onCharts={() => setOpen(true)}
            />
            <div className="absolute bottom-3 left-3 z-50 flex gap-2">
                <button className="rounded bg-slate-950 p-3" onClick={() => setPaused((v) => !v)}>
                    Satellite {paused ? 'on' : 'off'}
                </button>
                <button
                    className="rounded bg-slate-950 p-3"
                    onClick={() => ref.current?.jumpTo({ center: [174.8, -41.2], zoom: 10 })}
                >
                    NZ camera
                </button>
            </div>
            {open && (
                <PaperChartSheet
                    onClose={close}
                    bounds={catalog.bounds}
                    sources={catalog.sources}
                    onToggle={catalog.toggleSource}
                    onOpacity={catalog.setOpacity}
                    onConsent={catalog.refreshConsent}
                    category={category}
                    onCategory={setCategory}
                    satelliteMode={paused}
                />
            )}
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
