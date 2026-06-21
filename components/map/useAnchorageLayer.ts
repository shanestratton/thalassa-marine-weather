/**
 * useAnchorageLayer — Whitsundays anchorage reference overlay for Mapbox GL.
 *
 * Renders, from bundled open data (offline-capable), bottom-to-top:
 *   - GBRMPA marine-park ZONING as faint colour-coded fill (green/yellow/blue…) —
 *     tells you what you may legally DO at an anchorage (fishing/collecting).
 *   - GBRMPA NO-ANCHORING areas as red fill + outline (you must not anchor here).
 *   - Anchorages (OSM), official designated anchorages (GBRMPA) and marinas as
 *     colour-coded circles. A point inside a no-anchoring area gets a red ring.
 *   - Tap a pin, a no-anchoring area, or a zone → plain Mapbox popup with the
 *     details and an explicit "verify against official charts" safety line.
 *
 * Mirrors the source+layer+click pattern of useSeamarkLayer. Display-only, so
 * popups use setHTML (no React portal). NOT a navigational chart.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { AnchorageService, type AnchorageProps } from '../../services/anchorages/AnchorageService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AnchorageLayer');

const SRC_PTS = 'anchorage-points';
const SRC_NA = 'anchorage-noanchor';
const SRC_ZONE = 'anchorage-zoning';
const L_ZONE_FILL = 'anchorage-zoning-fill';
const L_ZONE_LINE = 'anchorage-zoning-line';
const L_NA_FILL = 'anchorage-noanchor-fill';
const L_NA_LINE = 'anchorage-noanchor-line';
const L_PTS = 'anchorage-points-circle';
const MIN_ZOOM = 7;

const ALL_LAYERS = [L_PTS, L_NA_LINE, L_NA_FILL, L_ZONE_LINE, L_ZONE_FILL];
const ALL_SOURCES = [SRC_PTS, SRC_NA, SRC_ZONE];

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const esc = (s: unknown): string =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

const KIND_LABEL: Record<string, string> = {
    anchorage: 'Anchorage',
    designated_anchorage: 'Official designated anchorage',
    marina: 'Marina',
};

function shell(inner: string): string {
    return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:240px;color:#16242c">${inner}</div>`;
}

function pointPopupHtml(p: AnchorageProps): string {
    const kind = KIND_LABEL[p.kind] ?? 'Anchorage';
    const warn = p.noAnchoring
        ? `<div style="margin-top:6px;padding:6px 8px;background:#f7e1de;border-left:3px solid #c0392b;border-radius:3px;color:#7a201b;font-size:11px;line-height:1.4">
             ⚓⃠ <strong>No-anchoring area</strong>${p.noAnchoringName ? ` — ${esc(p.noAnchoringName)}` : ''}.
             Anchoring is prohibited here (GBRMPA coral protection). Use a public mooring or move on.
           </div>`
        : '';
    const notes = p.notes
        ? `<div style="margin-top:5px;font-size:11px;color:#33424b;line-height:1.4">${esc(p.notes)}</div>`
        : '';
    return shell(`
        <div style="font-weight:700;font-size:13.5px;color:#0c2230">${esc(p.name)}</div>
        <div style="font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:#9c6f1f;margin-top:2px">${esc(kind)}</div>
        ${warn}
        ${notes}
        <div style="margin-top:6px;font-size:9.5px;color:#6b7880;line-height:1.35">
          Source: ${esc(p.source)}. Open-data reference — verify depth, holding &amp; zoning against official charts before anchoring.
        </div>`);
}

function areaPopupHtml(props: Record<string, unknown>): string {
    return shell(`
        <div style="font-weight:700;font-size:13.5px;color:#0c2230">${esc(props.name)}</div>
        <div style="font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:#c0392b;margin-top:2px">No-anchoring area</div>
        <div style="margin-top:5px;font-size:11px;color:#33424b;line-height:1.4">
          Anchoring prohibited (GBRMPA coral protection).${props.legal ? ` ${esc(props.legal)}.` : ''}
        </div>
        <div style="margin-top:6px;font-size:9.5px;color:#6b7880">Source: GBRMPA. Confirm current no-anchoring areas before relying on this.</div>`);
}

function zonePopupHtml(props: Record<string, unknown>): string {
    const type = esc(props.type);
    const zone = props.zone && props.zone !== props.type ? ` (${esc(props.zone)})` : '';
    const where = props.permit
        ? `<div style="margin-top:4px;font-size:11px;color:#33424b">${esc(props.permit)}</div>`
        : '';
    return shell(`
        <div style="font-weight:700;font-size:13px;color:#0c2230">${type}${zone}</div>
        <div style="font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:#5d6b73;margin-top:2px">GBRMPA marine-park zone</div>
        ${where}
        <div style="margin-top:6px;font-size:9.5px;color:#6b7880;line-height:1.35">
          The zone governs what you may do here (fishing, collecting), not just anchoring. Confirm permitted
          activities on the official GBRMPA zoning map before acting.
        </div>`);
}

export function useAnchorageLayer(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible: boolean) {
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const handlersRef = useRef<
        Array<{
            event: 'click' | 'mouseenter' | 'mouseleave';
            layer: string;
            fn: (e: mapboxgl.MapLayerMouseEvent) => void;
        }>
    >([]);
    const wasVisibleRef = useRef(false);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const closePopup = () => {
            popupRef.current?.remove();
            popupRef.current = null;
        };

        const removeAll = () => {
            closePopup();
            for (const h of handlersRef.current) map.off(h.event, h.layer, h.fn);
            handlersRef.current = [];
            for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
            for (const id of ALL_SOURCES) if (map.getSource(id)) map.removeSource(id);
        };

        if (!visible) {
            wasVisibleRef.current = false;
            removeAll();
            return;
        }

        // ── Sources (empty first; filled after async load) ──
        if (!map.getSource(SRC_ZONE)) map.addSource(SRC_ZONE, { type: 'geojson', data: EMPTY });
        if (!map.getSource(SRC_NA)) map.addSource(SRC_NA, { type: 'geojson', data: EMPTY });
        if (!map.getSource(SRC_PTS)) map.addSource(SRC_PTS, { type: 'geojson', data: EMPTY });

        // ── Layers, bottom → top: zoning, no-anchoring, points ──
        if (!map.getLayer(L_ZONE_FILL)) {
            map.addLayer({
                id: L_ZONE_FILL,
                type: 'fill',
                source: SRC_ZONE,
                paint: { 'fill-color': ['coalesce', ['get', 'color'], '#9aa7ad'], 'fill-opacity': 0.12 },
            });
        }
        if (!map.getLayer(L_ZONE_LINE)) {
            map.addLayer({
                id: L_ZONE_LINE,
                type: 'line',
                source: SRC_ZONE,
                paint: {
                    'line-color': ['coalesce', ['get', 'color'], '#9aa7ad'],
                    'line-width': 0.6,
                    'line-opacity': 0.4,
                },
            });
        }
        if (!map.getLayer(L_NA_FILL)) {
            map.addLayer({
                id: L_NA_FILL,
                type: 'fill',
                source: SRC_NA,
                paint: { 'fill-color': '#c0392b', 'fill-opacity': 0.16 },
            });
        }
        if (!map.getLayer(L_NA_LINE)) {
            map.addLayer({
                id: L_NA_LINE,
                type: 'line',
                source: SRC_NA,
                paint: { 'line-color': '#c0392b', 'line-width': 1.4, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 },
            });
        }
        if (!map.getLayer(L_PTS)) {
            map.addLayer({
                id: L_PTS,
                type: 'circle',
                source: SRC_PTS,
                minzoom: MIN_ZOOM,
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 5.5, 16, 8],
                    'circle-color': [
                        'match',
                        ['get', 'kind'],
                        'designated_anchorage',
                        '#d9a441',
                        'marina',
                        '#2a9d8f',
                        /* default: anchorage */ '#1f5e80',
                    ],
                    'circle-stroke-color': ['case', ['==', ['get', 'noAnchoring'], true], '#c0392b', '#ffffff'],
                    'circle-stroke-width': ['case', ['==', ['get', 'noAnchoring'], true], 2.4, 1.2],
                    'circle-opacity': ['case', ['==', ['get', 'likelyAnchorage'], false], 0.5, 0.95],
                },
            });
        }

        // ── Interactions (priority: point > no-anchor area > zone) ──
        const popupAt = (lngLat: mapboxgl.LngLat, html: string, offset: number) => {
            closePopup();
            popupRef.current = new mapboxgl.Popup({ closeButton: true, maxWidth: '260px', offset })
                .setLngLat(lngLat)
                .setHTML(html)
                .addTo(map);
        };
        const hitElsewhere = (e: mapboxgl.MapLayerMouseEvent, layers: string[]) =>
            map.queryRenderedFeatures(e.point, { layers: layers.filter((l) => map.getLayer(l)) }).length > 0;

        const onPointClick = (e: mapboxgl.MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (f) popupAt(e.lngLat, pointPopupHtml(f.properties as unknown as AnchorageProps), 10);
        };
        const onAreaClick = (e: mapboxgl.MapLayerMouseEvent) => {
            if (hitElsewhere(e, [L_PTS])) return;
            const f = e.features?.[0];
            if (f) popupAt(e.lngLat, areaPopupHtml((f.properties ?? {}) as Record<string, unknown>), 6);
        };
        const onZoneClick = (e: mapboxgl.MapLayerMouseEvent) => {
            if (hitElsewhere(e, [L_PTS, L_NA_FILL])) return;
            const f = e.features?.[0];
            if (f) popupAt(e.lngLat, zonePopupHtml((f.properties ?? {}) as Record<string, unknown>), 2);
        };
        const enter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const leave = () => {
            map.getCanvas().style.cursor = '';
        };

        const reg = (
            event: 'click' | 'mouseenter' | 'mouseleave',
            layer: string,
            fn: (e: mapboxgl.MapLayerMouseEvent) => void,
        ) => {
            map.on(event, layer, fn);
            handlersRef.current.push({ event, layer, fn });
        };
        reg('click', L_PTS, onPointClick);
        reg('click', L_NA_FILL, onAreaClick);
        reg('click', L_ZONE_FILL, onZoneClick);
        reg('mouseenter', L_PTS, enter as (e: mapboxgl.MapLayerMouseEvent) => void);
        reg('mouseleave', L_PTS, leave as (e: mapboxgl.MapLayerMouseEvent) => void);

        // First time the overlay is switched on, bring the map to the data so the
        // toggle visibly DOES something even if the skipper was looking elsewhere —
        // the dataset is Whitsundays-only in v1. fitBounds covers the island group.
        if (!wasVisibleRef.current) {
            wasVisibleRef.current = true;
            try {
                map.fitBounds(
                    [
                        [148.4, -20.6],
                        [149.15, -19.9],
                    ],
                    { padding: 48, maxZoom: 11, duration: 900 },
                );
            } catch (err) {
                log.warn('fitBounds to Whitsundays failed', err);
            }
        }

        // ── Load data ──
        let cancelled = false;
        AnchorageService.load()
            .then(({ points, noAnchor, zoning }) => {
                if (cancelled) return;
                (map.getSource(SRC_ZONE) as mapboxgl.GeoJSONSource | undefined)?.setData(
                    zoning as GeoJSON.FeatureCollection,
                );
                (map.getSource(SRC_NA) as mapboxgl.GeoJSONSource | undefined)?.setData(
                    noAnchor as GeoJSON.FeatureCollection,
                );
                (map.getSource(SRC_PTS) as mapboxgl.GeoJSONSource | undefined)?.setData(
                    points as GeoJSON.FeatureCollection,
                );
                log.info('anchorage overlay populated');
            })
            .catch((err) => log.warn('anchorage data load failed', err));

        return () => {
            cancelled = true;
            removeAll();
        };
    }, [mapRef, mapReady, visible]);
}
