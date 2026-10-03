/**
 * useChartLeadsLayer — "Show charted leads" (Settings → Preferences → Chart).
 * Off by default.
 *
 * Draws the compiled lead graph (services/routing/leadCompiler.ts) from the
 * installed navigation cells in view: recommended tracks and the on-water
 * spans of leading lines in pink, buoyed channels in indigo — solid only when
 * 'clear' (charted deep enough for this boat's draft + 0.5 m even after the
 * survey's vertical error, on a graded survey, nothing charted on or beside
 * the line, no coarser chart's land paint under it, and the draft is the
 * skipper's own). No installed cell carries bridges, pontoons or overhead
 * lines yet, so today nothing is clear: every line is amber 'bridges not in
 * chart data' until the cells are re-extracted with them (leadReview.ts,
 * Phase 1 review; the extractor and the Pi emit them since Part B). Once they
 * are, a bridge or overhead line on a lead is read against the vessel's air
 * draft: too low for it + 1 m, no clearance charted, or no air draft set
 * makes the line 'blocked' — red dashes on the dark casing, the label naming
 * the structure and its clearance, never saveable (the router blocks it:
 * owner decision 5; round 2, 2026-09-30, it was amber before); one the mast
 * clears still keeps the line amber, 'bridge on the line (clears your
 * mast)'. The label names the rest in plain words: 'survey not
 * graded', 'poor or unassessed survey', 'survey too rough for this depth',
 * 'a coarser chart shows land' (owner decisions 1, 3 and 4, 2026-09-30).
 * 'needs tide' and 'needs review' are an amber dash on a dark casing — deliberately NOT
 * the base chart's own amber track dash (EncVectorLayer RECTRC, drawn on the
 * very same lines), which reads as ordinary chart furniture. Where part of a
 * line has no charted depth it is dotted grey. A line label says why. Chart
 * furniture only — it routes nothing, and Auto does not follow it yet
 * (Phase 2).
 *
 * Same mount / teardown pattern as the other ENC-derived overlays
 * (useBuoyageDirectionLayer): one GeoJSON source, idempotent re-mount on a
 * style swap, recompile debounced on moveend and on cell changes, everything
 * removed when the switch goes off. It adds map layers only; it never touches
 * Mapbox's own controls (logo, attribution).
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';

import { subscribe as subscribeCells } from '../../services/enc/EncCellMetadata';
import { leadGraphOverlayGeoJSON } from '../../services/routing/leadCompiler';
import { leadGraphForView } from '../../services/routing/leadOverlayData';
import { createLogger } from '../../utils/createLogger';
import { ENC_VEC_LAYERS } from './encLayerIds';
import { BLOCKED_LEAD_DASH, NEEDS_TIDE_AMBER, SURVEY_DASH } from './inshoreRouteState';

const log = createLogger('useChartLeadsLayer');

export const CHART_LEADS_SOURCE_ID = 'thalassa-chart-leads';
export const CHART_LEADS_LAYER_IDS = {
    clear: 'thalassa-chart-leads-clear',
    amberCasing: 'thalassa-chart-leads-amber-casing',
    amber: 'thalassa-chart-leads-amber',
    blocked: 'thalassa-chart-leads-blocked',
    unknown: 'thalassa-chart-leads-unknown',
    label: 'thalassa-chart-leads-label',
} as const;
const ALL_LAYERS = [
    CHART_LEADS_LAYER_IDS.label,
    CHART_LEADS_LAYER_IDS.unknown,
    CHART_LEADS_LAYER_IDS.blocked,
    CHART_LEADS_LAYER_IDS.amber,
    CHART_LEADS_LAYER_IDS.amberCasing,
    CHART_LEADS_LAYER_IDS.clear,
];

/** Harbour-approach furniture, like the ENC leads it explains. */
export const CHART_LEADS_MIN_ZOOM = 11;
/** Leads (RECTRC, leading lines): magenta (pink), the chart's own track
 *  ink — apart from the amber ENC lead dash, the route tiers and the radio
 *  blue. Solid only when clear. */
export const LEAD_INK = '#e879f9';
/** Buoyed channels: indigo. Solid only when clear. */
export const CHANNEL_INK = '#818cf8';
/** 'needs tide' / 'needs review': the app's ONE needs-tide amber — the
 *  route line's and its tide chip's too (owner decision 10, 2026-09-30; it
 *  was #fbbf24, a shade off the route's #ff9100) — on a dark casing, so it
 *  never reads as the chart's own RECTRC track dash (#f59e0b) it is drawn
 *  on top of. */
export const AMBER_INK = NEEDS_TIDE_AMBER;
export const AMBER_CASING_INK = SURVEY_DASH.casing;
export const UNKNOWN_INK = '#9ca3af';
/** 'blocked': a structure this mast cannot clear (owner decision 5) — the
 *  app's danger red (--day-ui-danger), dashed on the same dark casing, so it
 *  reads as "not for this boat" and never as the amber "check this". One spec
 *  (inshoreRouteState BLOCKED_LEAD_DASH) for the overlay, the chart key and
 *  the unverified route line, whose red and white dashes must never pass for
 *  it (review fix-up, 2026-10-03). */
export const BLOCKED_INK = BLOCKED_LEAD_DASH.ink;
const AMBER_CLASSES = ['needs-tide', 'needs-review'];
/** Classes drawn on the dark casing: amber and blocked. */
const CASED_CLASSES = [...AMBER_CLASSES, 'blocked'];

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Keep the lines under the physical marks they lead between. */
const MARK_ANCHORS = [
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
] as const;

const inkByKind: mapboxgl.Expression = ['match', ['get', 'ink'], 'channel', CHANNEL_INK, LEAD_INK];
const width: mapboxgl.Expression = ['interpolate', ['linear'], ['zoom'], CHART_LEADS_MIN_ZOOM, 1.6, 15, 3];

function layerSpecs(): mapboxgl.AnyLayer[] {
    return [
        {
            id: CHART_LEADS_LAYER_IDS.clear,
            type: 'line',
            source: CHART_LEADS_SOURCE_ID,
            minzoom: CHART_LEADS_MIN_ZOOM,
            filter: ['==', ['get', 'depthClass'], 'clear'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': inkByKind, 'line-width': width, 'line-opacity': 0.85 },
        },
        {
            // The dark edge under the amber dash: the double line is what
            // sets it apart from the base chart's plain amber track dash.
            id: CHART_LEADS_LAYER_IDS.amberCasing,
            type: 'line',
            source: CHART_LEADS_SOURCE_ID,
            minzoom: CHART_LEADS_MIN_ZOOM,
            filter: ['match', ['get', 'depthClass'], CASED_CLASSES, true, false],
            layout: { 'line-join': 'round', 'line-cap': 'butt' },
            paint: {
                'line-color': AMBER_CASING_INK,
                'line-width': ['interpolate', ['linear'], ['zoom'], CHART_LEADS_MIN_ZOOM, 4, 15, 6],
                'line-opacity': 0.8,
            },
        },
        {
            id: CHART_LEADS_LAYER_IDS.amber,
            type: 'line',
            source: CHART_LEADS_SOURCE_ID,
            minzoom: CHART_LEADS_MIN_ZOOM,
            filter: ['match', ['get', 'depthClass'], AMBER_CLASSES, true, false],
            layout: { 'line-join': 'round', 'line-cap': 'butt' },
            paint: {
                'line-color': AMBER_INK,
                'line-width': width,
                'line-opacity': 0.95,
                'line-dasharray': [1.6, 1.2],
            },
        },
        {
            // Blocked: red, in longer dashes than the amber, so the two
            // differ in pattern as well as colour.
            id: CHART_LEADS_LAYER_IDS.blocked,
            type: 'line',
            source: CHART_LEADS_SOURCE_ID,
            minzoom: CHART_LEADS_MIN_ZOOM,
            filter: ['==', ['get', 'depthClass'], 'blocked'],
            layout: { 'line-join': 'round', 'line-cap': 'butt' },
            paint: {
                'line-color': BLOCKED_INK,
                'line-width': width,
                'line-opacity': 0.95,
                'line-dasharray': [...BLOCKED_LEAD_DASH.dasharray],
            },
        },
        {
            id: CHART_LEADS_LAYER_IDS.unknown,
            type: 'line',
            source: CHART_LEADS_SOURCE_ID,
            minzoom: CHART_LEADS_MIN_ZOOM,
            filter: ['==', ['get', 'depthClass'], 'unknown'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': UNKNOWN_INK,
                'line-width': width,
                'line-opacity': 0.9,
                'line-dasharray': [0.1, 2.2],
            },
        },
        {
            id: CHART_LEADS_LAYER_IDS.label,
            type: 'symbol',
            source: CHART_LEADS_SOURCE_ID,
            minzoom: 13,
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 420,
                'text-field': ['get', 'label'],
                'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                'text-size': 10,
                'text-offset': [0, -0.9],
                'text-allow-overlap': false,
            },
            paint: {
                'text-color': [
                    'match',
                    ['get', 'depthClass'],
                    'needs-tide',
                    AMBER_INK,
                    'needs-review',
                    AMBER_INK,
                    'blocked',
                    BLOCKED_INK,
                    'unknown',
                    UNKNOWN_INK,
                    inkByKind,
                ],
                'text-halo-color': 'rgba(0, 0, 0, 0.85)',
                'text-halo-width': 1.3,
            },
        },
    ] as mapboxgl.AnyLayer[];
}

export function useChartLeadsLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    draftM: number,
    /** The draft is a fallback or onboarding estimate (vesselDraftIsAssumed):
     *  nothing is drawn clear and the lines say "draft not set". */
    draftAssumed = false,
    /** The vessel's air draft, metres (vesselAirDraftMetres). A bridge or
     *  overhead line on a lead is read against it: too low, not charted, or
     *  this null (not set) makes the line 'blocked' — red dashes, never
     *  saveable (Part B; round 2, 2026-09-30). */
    airDraftM: number | null = null,
): void {
    const compileTokenRef = useRef(0);
    const latestDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        let disposed = false;
        let moveTimer: ReturnType<typeof setTimeout> | null = null;
        let styleTimer: ReturnType<typeof setTimeout> | null = null;

        const remove = (): void => {
            try {
                for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
                if (map.getSource(CHART_LEADS_SOURCE_ID)) map.removeSource(CHART_LEADS_SOURCE_ID);
            } catch {
                // A base-style swap can remove these between the calls.
            }
        };

        const anchorId = (): string | undefined => MARK_ANCHORS.find((id) => !!map.getLayer(id));

        const ensureMounted = (): void => {
            try {
                if (!map.getSource(CHART_LEADS_SOURCE_ID)) {
                    map.addSource(CHART_LEADS_SOURCE_ID, { type: 'geojson', data: latestDataRef.current });
                }
                for (const spec of layerSpecs()) {
                    if (!map.getLayer(spec.id)) map.addLayer(spec, anchorId());
                }
            } catch (error) {
                // Mid style-swap: the next styledata event retries the idempotent mount.
                log.debug('mount deferred', error);
            }
        };

        if (!visible) {
            latestDataRef.current = EMPTY;
            compileTokenRef.current += 1;
            remove();
            return;
        }

        ensureMounted();

        const setData = (data: GeoJSON.FeatureCollection): void => {
            latestDataRef.current = data;
            (map.getSource(CHART_LEADS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
        };

        const recompile = async (): Promise<void> => {
            const token = ++compileTokenRef.current;
            if (map.getZoom() < CHART_LEADS_MIN_ZOOM) {
                setData(EMPTY);
                return;
            }
            try {
                const bounds = map.getBounds();
                if (!bounds) {
                    setData(EMPTY);
                    return;
                }
                const graph = await leadGraphForView(
                    [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                    draftM,
                    draftAssumed,
                    airDraftM,
                );
                if (disposed || token !== compileTokenRef.current) return;
                setData(leadGraphOverlayGeoJSON(graph) as GeoJSON.FeatureCollection);
            } catch (error) {
                if (!disposed) {
                    setData(EMPTY);
                    log.warn('lead compile failed', error);
                }
            }
        };

        const scheduleCompile = (): void => {
            if (moveTimer) clearTimeout(moveTimer);
            moveTimer = setTimeout(() => void recompile(), 350);
        };

        const onStyleData = (): void => {
            if (styleTimer) return;
            styleTimer = setTimeout(() => {
                styleTimer = null;
                if (!disposed) ensureMounted();
            }, 0);
        };

        void recompile();
        map.on('moveend', scheduleCompile);
        map.on('styledata', onStyleData);
        const unsubscribe = subscribeCells(scheduleCompile);

        return () => {
            disposed = true;
            compileTokenRef.current += 1;
            map.off('moveend', scheduleCompile);
            map.off('styledata', onStyleData);
            if (moveTimer) clearTimeout(moveTimer);
            if (styleTimer) clearTimeout(styleTimer);
            unsubscribe();
            remove();
        };
    }, [mapReady, mapRef, visible, draftM, draftAssumed, airDraftM]);
}
