/**
 * useBuoyageDirectionLayer — quiet direction-of-buoyage arrows for the
 * planning chart.
 *
 * The source is intentionally the Seaway compiler, not a visual guess from
 * nearby buoy glyphs. It emits only high-confidence, numbered chart channels
 * and only at a few gate midpoints, so the chart gains an orientation cue
 * without becoming a second symbology system.
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';

import { subscribe as subscribeCells } from '../../services/enc/EncHazardService';
import { buoyageDirectionGeoJSON } from '../../services/seaway/buoyageDirectionOverlay';
import { compileSeawayGraphForViewport } from '../../services/seaway/compileFromCells';
import { createLogger } from '../../utils/createLogger';
import { ENC_VEC_LAYERS } from './encLayerIds';

const log = createLogger('useBuoyageDirectionLayer');

const SOURCE_ID = 'thalassa-buoyage-direction';
const LAYER_ID = 'thalassa-buoyage-direction-arrow';
const MIN_ZOOM = 10.75;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Keep these arrows underneath the physical lateral marks they explain. */
const MARK_ANCHORS = [
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
] as const;

export function useBuoyageDirectionLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
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
                if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            } catch {
                // A base-style swap can remove these between the two calls.
            }
        };

        const anchorId = (): string | undefined => MARK_ANCHORS.find((id) => !!map.getLayer(id));

        const keepUnderMarks = (): void => {
            const anchor = anchorId();
            if (!anchor || !map.getLayer(LAYER_ID)) return;
            const ids = map.getStyle()?.layers?.map((layer) => layer.id) ?? [];
            if (ids.indexOf(LAYER_ID) > ids.indexOf(anchor)) {
                map.moveLayer(LAYER_ID, anchor);
            }
        };

        const ensureMounted = (): void => {
            try {
                const sourceMissing = !map.getSource(SOURCE_ID);
                if (sourceMissing) {
                    map.addSource(SOURCE_ID, { type: 'geojson', data: latestDataRef.current });
                }
                if (!map.getLayer(LAYER_ID)) {
                    map.addLayer(
                        {
                            id: LAYER_ID,
                            type: 'symbol',
                            source: SOURCE_ID,
                            minzoom: MIN_ZOOM,
                            layout: {
                                // Up-arrow + map rotation makes 0° true north;
                                // the compiler supplies the seaward→landward
                                // direction-of-buoyage bearing per gate.
                                'text-field': '⇧',
                                'text-font': ['Arial Unicode MS Regular'],
                                'text-size': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 13, 15, 18],
                                'text-rotate': ['get', 'bearingDeg'],
                                'text-rotation-alignment': 'map',
                                'text-keep-upright': false,
                                'text-offset': [0, -0.95],
                                // There are only a few candidates per channel,
                                // but collision avoidance keeps a tight marina
                                // clean rather than forcing decorative ink.
                                'text-allow-overlap': false,
                                'text-ignore-placement': false,
                            },
                            paint: {
                                'text-color': '#38bdf8',
                                'text-opacity': 0.58,
                                'text-halo-color': 'rgba(8, 25, 42, 0.72)',
                                'text-halo-width': 1.1,
                            },
                        },
                        anchorId(),
                    );
                }
                keepUnderMarks();
            } catch (error) {
                // Mapbox can be mid-style-swap. Its following styledata event
                // retries the idempotent mount; no user-facing map failure.
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
            (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
        };

        const recompile = async (): Promise<void> => {
            const token = ++compileTokenRef.current;
            if (map.getZoom() < MIN_ZOOM) {
                setData(EMPTY);
                return;
            }

            try {
                const bounds = map.getBounds();
                if (!bounds) {
                    setData(EMPTY);
                    return;
                }
                const result = await compileSeawayGraphForViewport(
                    [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
                    map.getZoom(),
                );
                if (disposed || token !== compileTokenRef.current) return;
                setData(buoyageDirectionGeoJSON(result?.graph));
            } catch (error) {
                if (!disposed) {
                    setData(EMPTY);
                    log.warn('compile failed', error);
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
    }, [mapReady, mapRef, visible]);
}
