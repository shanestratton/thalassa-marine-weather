/** Synthetic local chart data; actual parse/index, agreement, sheets and Mapbox camera. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import PaperChartSheet from '../../components/map/PaperChartSheet';
const ChartFindSheet = React.lazy(() => import('../../components/map/ChartFindSheet'));
import { parseAndCacheCellText } from '../../services/enc/EncCellStore';
import { putCell, removeCell } from '../../services/enc/EncCellMetadata';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import type { EncCell, EncConversionResult } from '../../services/enc/types';
import type { ChartFindBounds } from '../../services/enc/chartFind';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
setAuthIdentityScope('chart-find-fixture-owner');
localStorage.removeItem('thalassa_pi_pairing_v1');
mapboxgl.accessToken = 'pk.synthetic-local-chart-find';
const cell: EncCell = {
    id: 'US5TEST1',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    importedAt: '2026-10-16T00:00:00Z',
    bbox: [-180, -30, 180, -20],
    geojsonPath: 'fixture-local',
    hazardCount: 0,
};
const blob: EncConversionResult = {
    cellId: cell.id,
    sourceHO: 'US',
    edition: 1,
    issued: cell.issued,
    bbox: cell.bbox,
    layers: {
        LIGHTS: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { OBJNAM: 'Fictional green entrance light', LITCHR: 2, COLOUR: '4', SIGPER: 3 },
                    geometry: { type: 'Point', coordinates: [179.8, -27] },
                },
            ],
        },
        BOYLAT: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { OBJNAM: 'Fictional port mark' },
                    geometry: { type: 'Point', coordinates: [179.9, -27.1] },
                },
            ],
        },
        SEAARE: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { OBJNAM: 'Fictional Dateline Bay' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [179.6, -27.2],
                                [-179.6, -27.2],
                                [-179.6, -26.8],
                                [179.6, -26.8],
                                [179.6, -27.2],
                            ],
                        ],
                    },
                },
            ],
        },
    },
};
putCell(cell);
parseAndCacheCellText(cell.id, JSON.stringify(blob));
// A protected parse may exist in RAM, but no paired boat LAN means no name is exposed.
parseAndCacheCellText(
    'AU5TEST1',
    JSON.stringify({
        ...blob,
        cellId: 'AU5TEST1',
        sourceHO: 'AU',
        layers: {
            SEAARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { OBJNAM: 'PRIVATE LICENSED BAY' },
                        geometry: { type: 'Point', coordinates: [151, -27] },
                    },
                ],
            },
        },
    }),
);
function Fixture() {
    const container = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [paper, setPaper] = React.useState(false),
        [find, setFind] = React.useState(false),
        [ready, setReady] = React.useState(false);
    const closePaper = React.useCallback(() => setPaper(false), []),
        closeFind = React.useCallback(() => setFind(false), []);
    const camera = map.current?.getBounds();
    const bounds: ChartFindBounds | null = camera
        ? [camera.getWest(), camera.getSouth(), camera.getEast(), camera.getNorth()]
        : null;
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: container.current!,
            testMode: true,
            center: [179.8, -27],
            zoom: 8,
            fadeDuration: 0,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#172d40' } }],
            },
        });
        map.current = m;
        m.on('load', () => setReady(true));
        Object.assign(window, {
            __chartFindMap: m,
            __chartFindRemove: () => removeCell(cell.id),
            __chartFindSwitch: () => setAuthIdentityScope('chart-find-other-owner'),
        });
        return () => {
            m.remove();
            map.current = null;
        };
    }, []);
    return (
        <div className="fixed inset-0 bg-slate-950 text-white">
            <div ref={container} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            <button
                type="button"
                disabled={!ready}
                className="absolute left-3 top-3 z-10 min-h-[44px] rounded bg-slate-800 p-3"
                onClick={() => setPaper(true)}
            >
                Charts & detail
            </button>
            {paper && (
                <PaperChartSheet
                    onClose={closePaper}
                    bounds={bounds}
                    sources={[]}
                    onToggle={() => {}}
                    onOpacity={() => {}}
                    onConsent={() => {}}
                    category="standard"
                    onCategory={() => {}}
                    satelliteMode
                    onFindChart={() => setFind(true)}
                />
            )}
            <React.Suspense fallback={null}>
                {find && (
                    <ChartFindSheet
                        onClose={closeFind}
                        bounds={bounds}
                        onFly={(result) => {
                            const m = map.current!;
                            m.flyTo({
                                center: [
                                    result.lon + 360 * Math.round((m.getCenter().lng - result.lon) / 360),
                                    result.lat,
                                ],
                                zoom: 14,
                                duration: 0,
                            });
                            setFind(false);
                            setPaper(false);
                        }}
                    />
                )}
            </React.Suspense>
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
