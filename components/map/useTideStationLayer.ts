/** Tide stations: inexpensive chart symbols, predictions fetched only on tap. */
import { createElement, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import { daylightUiColor } from '../../utils/daylightUiColor';
import {
    fetchNearbyTideStations,
    fetchTideStationDetails,
    type TideStation,
    type TideStationDetails,
} from '../../services/tides/stationDetails';
import { TideStationCard, TideStationGauge } from './TideStationCard';
import { tideGaugePresentation } from './tideStationPresentation';

export type { TideStation } from '../../services/tides/stationDetails';
export interface TideExtreme {
    date: string;
    height: number;
    type: 'High' | 'Low';
}

const SOURCE_ID = 'tide-stations';
const LAYER_SYMBOLS = 'tide-station-symbols';
const LAYER_LABELS = 'tide-station-labels';
const ICON_ID = 'thalassa-tide-station-icon';
const MIN_ZOOM = 6;
const DEBOUNCE_MS = 650;
const SEARCH_MAX_AGE_MS = 5 * 60_000;
const SEARCH_MOVE_KM = 40;
const FOREGROUND = /^(routetrack-|passage-ghost-|passage-hud-waypoint|mob-)/;

function escapeTidePopupHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function finiteTideNumber(value: unknown): number | null {
    if (typeof value === 'string' && !value.trim()) return null;
    try {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/** Legacy export retained for stored/read-only callers; live details use React. */
export function buildTideStationPopupHtml(
    station: TideStation,
    predictions: TideExtreme[] | null,
    loading: boolean,
): string {
    const distance = finiteTideNumber(station.distance);
    const distLabel =
        distance == null
            ? 'Distance unavailable'
            : distance < 1
              ? `${Math.max(0, distance * 1000).toFixed(0)} m away`
              : `${Math.max(0, distance).toFixed(1)} km away`;
    const rows = (Array.isArray(predictions) ? predictions : [])
        .filter(
            (p) =>
                p &&
                typeof p === 'object' &&
                typeof p.date === 'string' &&
                Number.isFinite(Date.parse(p.date)) &&
                Number.isFinite(p.height) &&
                (p.type === 'High' || p.type === 'Low'),
        )
        .slice(0, 6)
        .map((p) => {
            const at = new Date(p.date);
            return `<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:${daylightUiColor(p.type === 'High' ? '#38bdf8' : '#94a3b8')}">${p.type === 'High' ? '▲ HIGH' : '▼ LOW'}</span><span>${p.height.toFixed(1)}m</span><span>${escapeTidePopupHtml(at.toLocaleDateString('en-AU', { weekday: 'short' }))} ${escapeTidePopupHtml(at.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false }))}</span></div>`;
        })
        .join('');
    return `<div><div><strong>${escapeTidePopupHtml(station.name)}</strong><p>${escapeTidePopupHtml(distLabel)}</p></div><div>${loading ? '<p>Loading predictions...</p>' : rows || '<p>No predictions available</p>'}</div></div>`;
}

/** Small pixel icon avoids image requests, font availability and hundreds of DOM roots. */
export function tideStationIcon(): { width: number; height: number; data: Uint8Array } {
    const width = 48;
    const data = new Uint8Array(width * width * 4);
    const pixel = (x: number, y: number, color: number[]) => {
        if (x < 0 || x >= width || y < 0 || y >= width) return;
        data.set(color, (y * width + x) * 4);
    };
    for (let y = 3; y < 45; y++)
        for (let x = 3; x < 45; x++) {
            const round = Math.hypot(Math.max(0, 10 - x, x - 37), Math.max(0, 10 - y, y - 37));
            if (round <= 7) pixel(x, y, [8, 31, 43, 235]);
        }
    for (const lineY of [16, 24, 32])
        for (let x = 10; x <= 37; x++) {
            const y = Math.round(lineY + Math.sin(((x - 10) * Math.PI) / 14) * 2);
            for (let thick = -1; thick <= 1; thick++) pixel(x, y + thick, [94, 234, 212, 255]);
        }
    return { width, height: width, data };
}

function stationsGeoJson(stations: readonly TideStation[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
    return {
        type: 'FeatureCollection',
        features: stations.map((station) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
            properties: { id: station.id, name: station.name, lat: station.lat, lon: station.lon },
        })),
    };
}
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const rad = Math.PI / 180;
    const latitude = (b.lat - a.lat) * rad;
    const longitude = (b.lon - a.lon) * rad;
    const h =
        Math.sin(latitude / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(longitude / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function useTideStationLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
) {
    const [stationCount, setStationCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const cache = useRef<{ center: { lat: number; lon: number }; at: number; stations: TideStation[] } | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible) {
            setStationCount(0);
            setLoading(false);
            setError(false);
            return;
        }
        let disposed = false;
        let stations = cache.current?.stations ?? [];
        let sourceData: mapboxgl.GeoJSONSource | undefined;
        let moveTimer: ReturnType<typeof setTimeout> | null = null;
        let searchController: AbortController | null = null;
        let searchGeneration = 0;
        let searchCenter: { lat: number; lon: number } | null = null;
        let detailController: AbortController | null = null;
        let detailGeneration = 0;
        let selected: TideStation | null = null;
        let detail: TideStationDetails | null = null;
        let detailLoading = false;
        let detailError = false;
        let panel: HTMLDivElement | null = null;
        let panelRoot: Root | null = null;
        let gaugeRoot: Root | null = null;
        let gaugeMarker: mapboxgl.Marker | null = null;
        let detailTimer: ReturnType<typeof setInterval> | null = null;
        let focusTimer: ReturnType<typeof setTimeout> | null = null;
        let focusBefore: HTMLElement | null = null;

        const removeRoot = (root: Root | null) => {
            // A hook cleanup may run inside a parent React commit.
            if (root) queueMicrotask(() => root.unmount());
        };
        const closeDetail = () => {
            detailGeneration++;
            detailController?.abort();
            detailController = null;
            selected = null;
            detail = null;
            if (detailTimer !== null) clearInterval(detailTimer);
            detailTimer = null;
            if (focusTimer !== null) clearTimeout(focusTimer);
            focusTimer = null;
            removeRoot(panelRoot);
            panelRoot = null;
            panel?.remove();
            panel = null;
            removeRoot(gaugeRoot);
            gaugeRoot = null;
            gaugeMarker?.remove();
            gaugeMarker = null;
            if (!disposed && focusBefore?.isConnected) focusBefore.focus();
            focusBefore = null;
        };

        const drawDetails = () => {
            if (disposed || !selected || !panelRoot) return;
            const nowMs = Date.now();
            panelRoot.render(
                createElement(TideStationCard, {
                    station: selected,
                    detail,
                    loading: detailLoading,
                    error: detailError,
                    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
                    nowMs,
                    onClose: closeDetail,
                    onRetry: () => {
                        if (selected) void loadDetail(selected);
                    },
                }),
            );
            if (gaugeRoot) {
                const state = detail
                    ? tideGaugePresentation(detail.heights, nowMs)
                    : { fraction: null, trend: 'unknown' as const };
                gaugeRoot.render(
                    createElement(TideStationGauge, {
                        fraction: state.fraction,
                        trend: state.trend,
                        size: 44,
                        label: `Predicted tide at ${selected.name}`,
                    }),
                );
            }
        };
        const loadDetail = async (station: TideStation) => {
            detailController?.abort();
            const controller = new AbortController();
            detailController = controller;
            const generation = ++detailGeneration;
            detailLoading = true;
            detailError = false;
            drawDetails();
            const response = await fetchTideStationDetails(station, {
                signal: controller.signal,
                includeWind: true,
            }).catch(() => null);
            if (disposed || controller.signal.aborted || generation !== detailGeneration || selected?.id !== station.id)
                return;
            detail = response;
            detailLoading = false;
            detailError = response === null;
            drawDetails();
        };
        const openDetail = (station: TideStation) => {
            closeDetail();
            selected = station;
            focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            panel = document.createElement('div');
            panel.className = 'tide-station-detail-overlay';
            panel.style.cssText =
                'position:absolute;z-index:760;left:12px;right:12px;top:calc(80px + env(safe-area-inset-top));bottom:calc(104px + env(safe-area-inset-bottom));display:flex;align-items:flex-end;justify-content:center;pointer-events:none;';
            for (const kind of ['pointerdown', 'mousedown', 'touchstart', 'touchmove', 'wheel', 'click']) {
                panel.addEventListener(kind, (event) => event.stopPropagation());
            }
            panel.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') closeDetail();
            });
            // A stationary card keeps its close button reachable even when
            // the selected marker sits at a screen edge. It never pans the map.
            map.getContainer().append(panel);
            panelRoot = createRoot(panel);
            const gauge = document.createElement('button');
            gauge.type = 'button';
            gauge.className = 'tide-station-selected-gauge';
            gauge.setAttribute('aria-label', `Predicted tide at ${station.name}`);
            gauge.style.cssText = 'padding:0;border:0;background:transparent;cursor:pointer;';
            gauge.addEventListener('click', (event) => {
                event.stopPropagation();
                panel?.querySelector<HTMLButtonElement>('button')?.focus();
            });
            gaugeRoot = createRoot(gauge);
            gaugeMarker = new mapboxgl.Marker({ element: gauge, anchor: 'bottom', offset: [0, -12] })
                .setLngLat([station.lon, station.lat])
                .addTo(map);
            detailTimer = setInterval(drawDetails, 60_000);
            void loadDetail(station);
            const focusedPanel = panel;
            focusTimer = setTimeout(() => {
                focusTimer = null;
                if (!disposed && focusedPanel === panel) panel?.querySelector<HTMLButtonElement>('button')?.focus();
            }, 0);
        };

        const keepBelowPassage = () => {
            const layers = map.getStyle()?.layers ?? [];
            const ids = layers.map((layer) => layer.id);
            const firstProtected = ids.find((id) => FOREGROUND.test(id));
            const lastOwn = ids.indexOf(LAYER_LABELS);
            const laterBase = ids
                .slice(lastOwn + 1)
                .some((id) => id !== LAYER_SYMBOLS && id !== LAYER_LABELS && !FOREGROUND.test(id));
            if (lastOwn < 0 || !laterBase) return;
            map.moveLayer(LAYER_SYMBOLS, firstProtected);
            map.moveLayer(LAYER_LABELS, firstProtected);
        };
        const restore = () => {
            if (disposed || !map.isStyleLoaded()) return;
            try {
                if (!map.hasImage(ICON_ID)) map.addImage(ICON_ID, tideStationIcon(), { pixelRatio: 2 });
                if (!map.getSource(SOURCE_ID)) {
                    map.addSource(SOURCE_ID, { type: 'geojson', data: stationsGeoJson(stations) });
                    sourceData = undefined;
                }
                const before = map.getStyle()?.layers?.find((layer) => FOREGROUND.test(layer.id))?.id;
                if (!map.getLayer(LAYER_SYMBOLS))
                    map.addLayer(
                        {
                            id: LAYER_SYMBOLS,
                            type: 'symbol',
                            source: SOURCE_ID,
                            minzoom: MIN_ZOOM,
                            layout: {
                                'icon-image': ICON_ID,
                                'icon-size': 1,
                                'icon-allow-overlap': true,
                                'icon-ignore-placement': true,
                            },
                        },
                        before,
                    );
                if (!map.getLayer(LAYER_LABELS))
                    map.addLayer(
                        {
                            id: LAYER_LABELS,
                            type: 'symbol',
                            source: SOURCE_ID,
                            minzoom: 9,
                            layout: {
                                'text-field': ['get', 'name'],
                                'text-size': 11,
                                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                                'text-offset': [0, 1.5],
                                'text-anchor': 'top',
                                'text-max-width': 9,
                            },
                            paint: { 'text-color': '#5eead4', 'text-halo-color': '#071725', 'text-halo-width': 1.5 },
                        },
                        before,
                    );
                const source = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource;
                if (source !== sourceData) {
                    source.setData(stationsGeoJson(stations));
                    sourceData = source;
                }
                keepBelowPassage();
            } catch {
                /* style replacement can invalidate a source between checks */
            }
        };
        const loadViewport = async () => {
            if (disposed || map.getZoom() < MIN_ZOOM) return;
            const at = map.getCenter();
            const center = { lat: at.lat, lon: ((at.lng + 540) % 360) - 180 };
            const previous = cache.current;
            if (
                previous &&
                Date.now() - previous.at < SEARCH_MAX_AGE_MS &&
                distanceKm(previous.center, center) < SEARCH_MOVE_KM
            )
                return;
            if (searchController && searchCenter && distanceKm(searchCenter, center) < SEARCH_MOVE_KM) return;
            searchController?.abort();
            const controller = new AbortController();
            searchController = controller;
            searchCenter = center;
            const generation = ++searchGeneration;
            setLoading(true);
            setError(false);
            const response = await fetchNearbyTideStations(center.lat, center.lon, { signal: controller.signal }).catch(
                () => null,
            );
            if (disposed || controller.signal.aborted || generation !== searchGeneration) return;
            searchController = null;
            searchCenter = null;
            setLoading(false);
            if (response === null) {
                setError(true);
                return;
            }
            stations = response;
            cache.current = { center, at: Date.now(), stations };
            sourceData = undefined;
            setStationCount(stations.length);
            restore();
        };
        const onMoveEnd = () => {
            if (moveTimer !== null) clearTimeout(moveTimer);
            const at = map.getCenter();
            if (
                searchController &&
                (map.getZoom() < MIN_ZOOM ||
                    (searchCenter && distanceKm(searchCenter, { lat: at.lat, lon: at.lng }) >= SEARCH_MOVE_KM))
            ) {
                searchGeneration++;
                searchController.abort();
                searchController = null;
                searchCenter = null;
                setLoading(false);
            }
            moveTimer = setTimeout(() => {
                moveTimer = null;
                void loadViewport();
            }, DEBOUNCE_MS);
        };
        const onClick = (event: mapboxgl.MapMouseEvent) => {
            if (!map.getLayer(LAYER_SYMBOLS)) return;
            const feature = map.queryRenderedFeatures(event.point, { layers: [LAYER_SYMBOLS] })[0];
            const station = stations.find((candidate) => candidate.id === feature?.properties?.id);
            if (!station) return;
            event.originalEvent?.stopPropagation();
            openDetail(station);
        };
        const onEnter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const onLeave = () => {
            map.getCanvas().style.cursor = '';
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && selected) closeDetail();
        };

        setStationCount(stations.length);
        restore();
        void loadViewport();
        map.on('moveend', onMoveEnd);
        map.on('style.load', restore);
        map.on('idle', restore);
        map.on('click', LAYER_SYMBOLS, onClick);
        map.on('mouseenter', LAYER_SYMBOLS, onEnter);
        map.on('mouseleave', LAYER_SYMBOLS, onLeave);
        document.addEventListener('keydown', onKey);
        window.addEventListener('online', drawDetails);
        window.addEventListener('offline', drawDetails);
        return () => {
            disposed = true;
            searchGeneration++;
            searchController?.abort();
            if (moveTimer !== null) clearTimeout(moveTimer);
            closeDetail();
            map.off('moveend', onMoveEnd);
            map.off('style.load', restore);
            map.off('idle', restore);
            map.off('click', LAYER_SYMBOLS, onClick);
            map.off('mouseenter', LAYER_SYMBOLS, onEnter);
            map.off('mouseleave', LAYER_SYMBOLS, onLeave);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('online', drawDetails);
            window.removeEventListener('offline', drawDetails);
            map.getCanvas().style.cursor = '';
            try {
                if (map.getLayer(LAYER_LABELS)) map.removeLayer(LAYER_LABELS);
                if (map.getLayer(LAYER_SYMBOLS)) map.removeLayer(LAYER_SYMBOLS);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
                if (map.hasImage(ICON_ID)) map.removeImage(ICON_ID);
            } catch {
                /* removed map or style swap */
            }
        };
    }, [mapRef, mapReady, visible]);
    return { stationCount, loading, error };
}
