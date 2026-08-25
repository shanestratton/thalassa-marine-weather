/**
 * useAnchorageLayer — the Anchorages reference overlay for Mapbox GL.
 *
 * v1 QLD coast (2026-08-25): data arrives in 2° tiles loaded around the
 * dynamic CENTRE (the location box — which is the boat whenever it is set
 * to Current Location) within 50 NM, per Shane's spec. Visited tiles stay
 * in the SW data cache, so the reference works offline where you have been.
 *
 * Renders, from tiled open data, bottom-to-top:
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
import { AnchorageService, type AnchorageData, type AnchorageProps } from '../../services/anchorages/AnchorageService';
import { scoreAnchorage, type AnchorageForVerdict } from '../../services/anchorages/anchorageVerdict';
import { getStayWindowCached } from '../../services/anchorages/anchorageForecast';
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
/** Everything within this of the centre loads; matches the spec ("within
 *  say 50NM of somewhere, show all of the anchorages around that area"). */
const LOAD_RADIUS_NM = 50;
/** Centre movement below this reuses the loaded set — no refetch churn. */
const RELOAD_DRIFT_NM = 10;

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

/** Imperative surface for the Tonight? sheet: put a chosen anchorage on
 *  the chart — fly to it and open its verdict popup, exactly as a pin tap
 *  would. Returns false when the layer is down or the id unknown. */
export interface AnchorageLayerHandle {
    showAnchorage(id: string): boolean;
}

export function useAnchorageLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    centre: { lat: number; lon: number } | null,
): AnchorageLayerHandle {
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    /** Set inside the layer effect (needs its popup helpers); null while
     *  the layer is unmounted. */
    const showImplRef = useRef<((id: string) => boolean) | null>(null);
    /** The merged tile data currently on the map — the popup verdict reads
     *  fetch tables from HERE by id, because Mapbox stringifies nested
     *  arrays in queryRenderedFeatures properties. */
    const dataRef = useRef<AnchorageData | null>(null);
    const centreRef = useRef(centre);
    centreRef.current = centre;
    const handleRef = useRef<AnchorageLayerHandle>({
        showAnchorage: (id) => showImplRef.current?.(id) ?? false,
    });
    const loadedAtRef = useRef<{ lat: number; lon: number } | null>(null);
    const handlersRef = useRef<
        Array<{
            event: 'click' | 'mouseenter' | 'mouseleave';
            layer: string;
            fn: (e: mapboxgl.MapLayerMouseEvent) => void;
        }>
    >([]);

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
            if (!f) return;
            const p = f.properties as unknown as AnchorageProps;
            popupAt(e.lngLat, pointPopupHtml(p) + verdictShellHtml(), 10);
            void fillVerdict(popupRef, p.id, dataRef.current, centreRef.current);
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

        // The Tonight? sheet's "show me" — same popup a pin tap opens, with
        // a flight so the bay fills the screen instead of being a dot at z9.
        showImplRef.current = (id: string): boolean => {
            const data = dataRef.current;
            const f = data?.points.features.find((x) => x.properties?.id === id);
            if (!f) return false;
            const [lon, lat] = f.geometry.coordinates;
            map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12.2), duration: 1200 });
            popupAt(new mapboxgl.LngLat(lon, lat), pointPopupHtml(f.properties) + verdictShellHtml(), 10);
            void fillVerdict(popupRef, id, data, centreRef.current);
            return true;
        };

        // Data arrives from the tile effect below (tiles follow the centre,
        // not the layer lifecycle). Re-showing the layer repaints whatever
        // that effect last held.
        if (dataRef.current) applyData(map, dataRef.current);

        return () => {
            showImplRef.current = null;
            removeAll();
        };
    }, [mapRef, mapReady, visible]);

    // ── Tile loading follows the CENTRE (50 NM), with 10 NM hysteresis ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || !centre) return;
        const last = loadedAtRef.current;
        if (last) {
            const dNM = Math.hypot(
                (centre.lat - last.lat) * 60,
                (centre.lon - last.lon) * 60 * Math.cos((centre.lat * Math.PI) / 180),
            );
            if (dNM < RELOAD_DRIFT_NM && dataRef.current) return;
        }
        let cancelled = false;
        AnchorageService.loadNear(centre.lat, centre.lon, LOAD_RADIUS_NM)
            .then((data) => {
                if (cancelled) return;
                dataRef.current = data;
                loadedAtRef.current = { lat: centre.lat, lon: centre.lon };
                const m = mapRef.current;
                if (m && m.getSource(SRC_PTS)) applyData(m, data);
            })
            .catch((err) => log.warn('anchorage tile load failed', err));
        return () => {
            cancelled = true;
        };
    }, [mapRef, mapReady, visible, centre]);

    return handleRef.current;
}

function applyData(map: mapboxgl.Map, data: AnchorageData): void {
    (map.getSource(SRC_ZONE) as mapboxgl.GeoJSONSource | undefined)?.setData(data.zoning as GeoJSON.FeatureCollection);
    (map.getSource(SRC_NA) as mapboxgl.GeoJSONSource | undefined)?.setData(data.noAnchor as GeoJSON.FeatureCollection);
    (map.getSource(SRC_PTS) as mapboxgl.GeoJSONSource | undefined)?.setData(data.points as GeoJSON.FeatureCollection);
    log.info(`anchorage overlay populated (${data.tiles.join('+') || 'no tiles'})`);
}

// ── The popup verdict: shelter tables × tonight's forecast ──

const GRADE_STYLE: Record<string, { label: string; color: string }> = {
    bombproof: { label: 'BOMBPROOF TONIGHT', color: '#1d7a46' },
    good: { label: 'GOOD TONIGHT', color: '#2a9d8f' },
    tenable: { label: 'TENABLE — WATCH IT', color: '#c98a1b' },
    poor: { label: 'POOR TONIGHT', color: '#c0392b' },
    'no-anchoring': { label: 'NO ANCHORING', color: '#c0392b' },
};

function verdictShellHtml(): string {
    return `<div class="anch-verdict" style="margin-top:8px;padding-top:7px;border-top:1px solid #d5dde2;font-size:11px;color:#5a6a73">Reading tonight's conditions…</div>`;
}

/** Fill the verdict block of the OPEN popup once forecast + tables agree.
 *  The popup may close or be replaced while we fetch — check before writing. */
async function fillVerdict(
    popupRef: MutableRefObject<mapboxgl.Popup | null>,
    id: string,
    data: AnchorageData | null,
    centre: { lat: number; lon: number } | null,
): Promise<void> {
    const el = () => popupRef.current?.getElement()?.querySelector('.anch-verdict') as HTMLElement | null | undefined;
    const feature = data?.points.features.find((f) => f.properties?.id === id);
    const p = feature?.properties;
    if (!feature || !p?.fetchLandNM || !p.fetchReefNM) {
        const node = el();
        if (node) node.innerHTML = `<span style="color:#8a969d">No shelter data for this point.</span>`;
        return;
    }
    const hours = centre ? await getStayWindowCached(centre.lat, centre.lon) : null;
    const node = el();
    if (!node) return; // popup gone — nobody is reading
    const anchorage: AnchorageForVerdict = {
        id: p.id,
        name: p.name,
        kind: p.kind,
        lat: feature.geometry.coordinates[1],
        lon: feature.geometry.coordinates[0],
        fetchLandNM: p.fetchLandNM,
        fetchReefNM: p.fetchReefNM,
        noAnchoring: p.noAnchoring,
        noAnchoringName: p.noAnchoringName,
    };
    const v = scoreAnchorage({ anchorage, hours: hours ?? [] });
    const g = GRADE_STYLE[v.grade];
    node.innerHTML =
        `<div style="font-weight:800;font-size:10.5px;letter-spacing:0.06em;color:${g.color}">${g.label}` +
        (hours ? ` · ${v.score}/100` : '') +
        `</div>` +
        v.reasons.map((r) => `<div style="margin-top:3px;line-height:1.35">${esc(r)}</div>`).join('') +
        `<div style="margin-top:5px;font-size:9px;color:#8a969d">Advisory only — verify against charts and your own eyes. Forecast: Open-Meteo · Shelter: OSM/GBRMPA open data.</div>`;
}
