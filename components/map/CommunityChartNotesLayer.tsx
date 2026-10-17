import React from 'react';
import type mapboxgl from 'mapbox-gl';
import { readChartNoteWindow, type ChartNoteWindow } from '../../services/community/ChartNotesService';
import { chartNoteOpacity, type ChartNote } from '../../services/community/chartNotesModel';
import ChartNoteSheet from '../community/ChartNoteSheet';
const SOURCE = 'community-chart-notes',
    LAYER = 'community-chart-notes-unofficial';
const EMPTY: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: 'FeatureCollection', features: [] };
/** Display-only point source. Content stays out of Mapbox properties and every route/watch/depth path. */
export default function CommunityChartNotesLayer({
    mapRef,
    mapReady,
}: {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
}) {
    const [status, setStatus] = React.useState('Loading unofficial notes…');
    const [sheet, setSheet] = React.useState<{
        key: string;
        note?: ChartNote;
        pin: { lat: number; lon: number };
        retired?: boolean;
    } | null>(null);
    const refreshRef = React.useRef<(() => void) | null>(null);
    const close = React.useCallback(() => setSheet(null), []);
    React.useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        let lease: ChartNoteWindow | undefined, ctl: AbortController | undefined;
        let intent = 0,
            disposed = false;
        let lookup = new Map<string, ChartNote>();
        const clear = () => {
            lookup.clear();
            (map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined)?.setData(EMPTY);
        };
        const retire = () => {
            intent++;
            ctl?.abort();
            lease?.release();
            lease = undefined;
            clear();
        };
        const create = () => {
            if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
            if (!map.getLayer(LAYER))
                map.addLayer({
                    id: LAYER,
                    type: 'circle',
                    source: SOURCE,
                    paint: {
                        'circle-radius': 8,
                        'circle-color': '#a78bfa',
                        'circle-opacity': ['get', 'opacity'],
                        'circle-stroke-color': '#f5f3ff',
                        'circle-stroke-width': 2,
                        'circle-stroke-opacity': ['get', 'opacity'],
                    },
                });
        };
        const refresh = () => {
            retire();
            if (disposed || document.hidden) return;
            create();
            const bounds = map.getBounds();
            if (!bounds) return;
            const request = ++intent;
            ctl = new AbortController();
            const current = ctl;
            setStatus('Loading unofficial notes…');
            void readChartNoteWindow(
                [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                current.signal,
                () => {
                    if (!disposed && request === intent) {
                        clear();
                        setSheet((s) => (s?.note ? { ...s, note: undefined, retired: true } : s));
                        setStatus('Notes retired. Refresh to recheck.');
                    }
                },
            )
                .then((next) => {
                    if (disposed || request !== intent || current.signal.aborted || !next.isCurrent()) {
                        next.release();
                        return;
                    }
                    lease = next;
                    lookup = new Map(next.notes.map((n) => [n.id, n]));
                    (map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined)?.setData({
                        type: 'FeatureCollection',
                        features: next.notes.map((n) => ({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [n.longitude, n.latitude] },
                            properties: { id: n.id, opacity: chartNoteOpacity(n, next.serverNow()) },
                        })),
                    });
                    setStatus(`${lookup.size} unofficial notes${next.truncated ? ' · more: zoom in' : ''}`);
                })
                .catch((e) => {
                    if (!disposed && request === intent && !current.signal.aborted) {
                        clear();
                        setStatus(e instanceof Error ? e.message : 'Community notes unavailable.');
                    }
                });
        };
        const click = (event: mapboxgl.MapLayerMouseEvent) => {
            if (!lease?.isCurrent()) {
                clear();
                return;
            }
            const id = event.features?.[0]?.properties?.id;
            const note = typeof id === 'string' ? lookup.get(id) : undefined;
            if (note) setSheet({ key: note.id, note, pin: { lat: note.latitude, lon: note.longitude } });
        };
        const moving = () => {
            retire();
            setSheet(null);
            setStatus('Move complete: notes will be rechecked.');
        };
        const visibility = () => {
            if (document.hidden) {
                retire();
                setSheet(null);
                setStatus('Refresh to recheck unofficial notes.');
            }
        };
        create();
        map.on('click', LAYER, click);
        map.on('movestart', moving);
        map.on('moveend', refresh);
        map.on('style.load', refresh);
        document.addEventListener('visibilitychange', visibility);
        refreshRef.current = refresh;
        refresh();
        return () => {
            disposed = true;
            retire();
            refreshRef.current = null;
            map.off('click', LAYER, click);
            map.off('movestart', moving);
            map.off('moveend', refresh);
            map.off('style.load', refresh);
            document.removeEventListener('visibilitychange', visibility);
            if (map.getLayer(LAYER)) map.removeLayer(LAYER);
            if (map.getSource(SOURCE)) map.removeSource(SOURCE);
        };
    }, [mapRef, mapReady]);
    return (
        <>
            <div className="absolute bottom-24 left-3 z-30 max-w-[calc(100%-1.5rem)] rounded-lg border border-violet-300/40 bg-slate-950/95 p-2 text-xs text-violet-100">
                <p role="status" className="max-w-64 break-words">
                    {status}
                </p>
                <div className="flex flex-wrap gap-2">
                    <button
                        className="min-h-[44px] rounded border border-white/20 px-3"
                        onClick={() => refreshRef.current?.()}
                    >
                        Refresh notes
                    </button>
                    <button
                        className="min-h-[44px] rounded border border-white/20 px-3"
                        onClick={() => {
                            const c = mapRef.current?.getCenter();
                            if (c && Math.abs(c.lat) <= 85 && Math.abs(c.lng) <= 180)
                                setSheet({ key: 'new:' + performance.now(), pin: { lat: c.lat, lon: c.lng } });
                        }}
                    >
                        Add at map centre
                    </button>
                </div>
            </div>
            {sheet && (
                <ChartNoteSheet
                    key={sheet.key}
                    note={sheet.note}
                    pin={sheet.pin}
                    retired={sheet.retired}
                    onClose={close}
                />
            )}
        </>
    );
}
