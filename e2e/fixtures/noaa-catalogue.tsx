/** Real NOAA conversion + real phone stores, import, merge and map layer.
 * Public source bytes are supplied by the test route; no provider/account writes. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import NoaaCatalogueSheet from '../../components/map/NoaaCatalogueSheet';
import { getMergedVectorData } from '../../services/enc/EncHazardService';
import { getRegisteredCell } from '../../services/enc/EncCellMetadata';
import { loadCellGeoJSON } from '../../services/enc/EncCellStore';
import { mountEncVectorLayer } from '../../components/map/EncVectorLayer';
import { ENC_VEC_SRC } from '../../components/map/encLayerIds';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
const bounds: [number, number, number, number] = [-118.51, 33.44, -118.42, 33.53];
function Fixture() {
    const box = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [open, setOpen] = React.useState(true),
        [state, setState] = React.useState('Map loading');
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: box.current!,
            accessToken: 'pk.synthetic-noaa-map',
            preserveDrawingBuffer: true,
            center: [-118.46, 33.485],
            zoom: 12,
            fadeDuration: 0,
            attributionControl: false,
            style: {
                version: 8,
                glyphs: `${location.origin}/fixture-fonts/{fontstack}/{range}.pbf`,
                sources: {},
                layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#86b9cf' } }],
            },
        });
        map.current = m;
        m.once('load', () => setState('Map ready'));
        Object.assign(window, {
            __noaaProof: {
                async render() {
                    const merged = await getMergedVectorData(bounds, 11);
                    if (!merged) throw Error('No chart installed');
                    mountEncVectorLayer(m, merged, { minZoom: 5 });
                    await new Promise<void>((resolve) => {
                        const deadline = setTimeout(resolve, 5000);
                        m.once('idle', () => {
                            clearTimeout(deadline);
                            resolve();
                        });
                    });
                    const raw = await loadCellGeoJSON('US5CA1LK', false);
                    await new Promise<void>((resolve) => {
                        m.once('render', () => resolve());
                        m.triggerRepaint();
                    });
                    const canvas = m.getCanvas();
                    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
                    const pixel = new Uint8Array(4);
                    gl?.readPixels(
                        Math.floor(canvas.width / 2),
                        Math.floor(canvas.height / 2),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                    );
                    return {
                        cell: getRegisteredCell('US5CA1LK'),
                        mergedCells: merged.cellCount,
                        depthFeatures: merged.DEPARE.features.length,
                        sbdareOriginal: raw?.layers.SBDARE?.features.length ?? 0,
                        sourceMounted: !!m.getSource(ENC_VEC_SRC.DEPARE),
                        renderedFeatures: m.queryRenderedFeatures().length,
                        framebuffer: [...pixel],
                    };
                },
            },
        });
        return () => {
            m.remove();
            map.current = null;
        };
    }, []);
    return (
        <main className="fixed inset-0 bg-slate-950 text-white">
            <div ref={box} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            <div className="absolute bottom-2 left-2 z-10 rounded bg-slate-950 p-2">
                <span role="status">{state}</span> <button onClick={() => setOpen(true)}>Open NOAA catalogue</button>
            </div>
            {open && <NoaaCatalogueSheet bounds={bounds} onClose={() => setOpen(false)} />}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
