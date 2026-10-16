/** Local public/synthetic chart lifecycle proof. No provider/account writes. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import NoaaCatalogueSheet from '../../components/map/NoaaCatalogueSheet';
import { useEncVectorLayer } from '../../components/map/useEncVectorLayer';
import { getRegisteredCell } from '../../services/enc/EncCellMetadata';
import { getCoverage, importCell, queryHazards } from '../../services/enc/EncHazardService';
import { noaaResidentBytes, loadCellGeoJSON } from '../../services/enc/EncCellStore';
import { loadNoaaPackageWindow } from '../../services/enc/noaaPackageWindow';
import { readNoaaPackage } from '../../services/enc/noaaPackageStore';
import { clearMergedData } from '../../services/enc/mergedDataCache';
import { readChartDatumForBounds } from '../../services/enc/readChartDatum';
import { queryChartLookahead } from '../../services/underway/ChartLookaheadQuery';
import { aheadCone } from '../../services/underway/lookaheadRule';
import { removeNoaaDownload, savedNoaaDownloads } from '../../services/enc/noaaCatalogue';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { ENC_VEC_SRC } from '../../components/map/encLayerIds';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
setAuthIdentityScope('noaa-package-synthetic');
const bounds: [number, number, number, number] = [-133.82, 55.4, -133.63, 55.6];
function Fixture() {
    const element = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [open, setOpen] = React.useState(true);
    useEncVectorLayer(map, ready, true, true, 3, 4);
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: element.current!,
            accessToken: 'pk.synthetic-noaa-package',
            center: [-133.725, 55.5],
            zoom: 12,
            preserveDrawingBuffer: true,
            attributionControl: false,
            fadeDuration: 0,
            style: {
                version: 8,
                glyphs: `${location.origin}/fixture-fonts/{fontstack}/{range}.pbf`,
                sources: {},
                layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#86b9cf' } }],
            },
        });
        map.current = m;
        m.once('load', () => setReady(true));
        Object.assign(window, {
            __noaaPackageProof: {
                async inspect() {
                    const canvas = m.getCanvas(),
                        gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl'),
                        pixel = new Uint8Array(4),
                        at = m.project([-133.75, 55.5]),
                        ratio = canvas.width / Math.max(1, canvas.clientWidth);
                    gl?.readPixels(
                        Math.floor(at.x * ratio),
                        Math.floor(canvas.height - at.y * ratio - 1),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                    );
                    return {
                        framebuffer: [...pixel],
                        canvasHeight: canvas.clientHeight,
                        cell: getRegisteredCell('US3AK1EX'),
                        coverage: getCoverage().length,
                        downloads: await savedNoaaDownloads(),
                        residentBytes: noaaResidentBytes(),
                        oldWholeCellRefused: (await loadCellGeoJSON('US3AK1EX', false)) === null,
                        mounted: !!m.getSource(ENC_VEC_SRC.DEPARE),
                        rendered: m.queryRenderedFeatures().length,
                    };
                },
                async view(windowBounds: [number, number, number, number] = bounds) {
                    const cell = getRegisteredCell('US3AK1EX');
                    if (!cell) throw Error('No chart');
                    const view = await loadNoaaPackageWindow(cell, windowBounds);
                    try {
                        return {
                            ids: view.blob.layers.DEPARE?.features.map((f) => f.id),
                            datum: view.blob.soundingDatum,
                            bytes: view.bytes,
                            layerCounts: Object.fromEntries(
                                Object.entries(view.blob.layers).map(([l, fc]) => [l, fc?.features.length]),
                            ),
                        };
                    } finally {
                        view.release();
                    }
                },
                query: () => queryHazards([{ lat: 55.5, lon: -133.75 }]),
                clearMergeMemo: () => clearMergedData(),
                datum: () => readChartDatumForBounds(bounds),
                ahead: () =>
                    queryChartLookahead(
                        aheadCone({ lat: 55.5, lon: -133.75, at: Date.now(), sogKn: 6, cogDeg: 0 })!,
                        2,
                        0.5,
                    ),
                async inshore() {
                    const { tryInshoreRoute } = await import('../../services/InshoreRouter');
                    const before = noaaResidentBytes();
                    const result = await tryInshoreRoute(
                        { lat: 55.5, lon: -133.76 },
                        { lat: 55.5, lon: -133.74 },
                        0.5,
                        null,
                        'safest',
                        { tideCeilings: [] },
                    );
                    return { result, before, after: noaaResidentBytes() };
                },
                satellite(enabled: boolean) {
                    const s = useSettingsStore.getState();
                    useSettingsStore.setState({ settings: { ...s.settings, satelliteMode: enabled } });
                },
                account(owner: string) {
                    setAuthIdentityScope(owner);
                },
                async corruptFirstPart() {
                    const cell = getRegisteredCell('US3AK1EX')!;
                    const manifest = await readNoaaPackage(cell);
                    await Filesystem.writeFile({
                        path: `${cell.noaaPackage!.path}/${manifest.parts[0].sha256}.json`,
                        directory: Directory.Data,
                        encoding: Encoding.UTF8,
                        data: '{}',
                    });
                },
                async replaceManual() {
                    await importCell(
                        {
                            cellId: 'US3AK1EX',
                            sourceHO: 'US',
                            edition: 2,
                            updateNumber: 0,
                            issued: '2026-03-17',
                            bbox: [-134, 55, -132, 56],
                            layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
                        },
                        { usage: 'navigation', contentSha256: 'd'.repeat(64) },
                    );
                },
                async removeOriginal() {
                    const rows = await savedNoaaDownloads();
                    await removeNoaaDownload(rows[0]);
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
            <div ref={element} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            <div className="absolute bottom-2 left-2 z-10 bg-slate-950 p-2">
                <span role="status">{ready ? 'Map ready' : 'Loading'}</span>
                <button onClick={() => setOpen(true)}>Open NOAA catalogue</button>
            </div>
            {open && <NoaaCatalogueSheet bounds={bounds} onClose={() => setOpen(false)} />}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
