/**
 * useAnchorSwingLayer — anchor point + swing-radius circle on the chart
 * while the anchor watch is set.
 *
 * 2026-08-03 audit, marine-safety-UX: an ARMED anchor watch had zero
 * presence on the chart — no anchor point, no swing circle. The watch
 * UI lived only on the 'compass' page, so the surface a skipper
 * actually stares at while swinging at anchor showed nothing.
 *
 * Self-subscribes to AnchorWatchService (MapHub threads no props):
 *   setting/watching/paused → amber dashed guard ring + anchor datum
 *   alarm                   → red, heavier, brighter wash
 *   idle                    → nothing
 *
 * The ring is a true geodesic circle (64-point destination-formula ring
 * of swingRadius metres), not a screen-pixel circle — it must stay
 * glued to the water as the chart zooms. Layers self-heal if a basemap
 * swap drops the source (checked on every service emission, which fires
 * from GPS/timer callbacks — never inside a styledata handler, per the
 * placement-crash contract).
 */
import { useEffect } from 'react';
import type mapboxgl from 'mapbox-gl';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';

const SOURCE_ID = 'anchor-swing-src';
const FILL_ID = 'anchor-swing-fill';
const LINE_ID = 'anchor-swing-line';
const POINT_ID = 'anchor-swing-point';
const LAYER_IDS = [FILL_ID, LINE_ID, POINT_ID];

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const EARTH_RADIUS_M = 6371000;

/** Destination point from (lat, lon) along bearingDeg for distM metres. */
function destinationPoint(lat: number, lon: number, bearingDeg: number, distM: number): [number, number] {
    const δ = distM / EARTH_RADIUS_M;
    const θ = (bearingDeg * Math.PI) / 180;
    const φ1 = (lat * Math.PI) / 180;
    const λ1 = (lon * Math.PI) / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI];
}

function buildFeatures(snap: AnchorWatchSnapshot): GeoJSON.FeatureCollection {
    const anchor = snap.anchorPosition;
    const showFor = new Set(['setting', 'watching', 'paused', 'alarm']);
    if (!anchor || !showFor.has(snap.state) || !(snap.swingRadius > 0)) return EMPTY_FC;

    const ring: [number, number][] = [];
    for (let i = 0; i <= 64; i++) {
        ring.push(destinationPoint(anchor.latitude, anchor.longitude, (i * 360) / 64, snap.swingRadius));
    }

    const alarm = snap.state === 'alarm';
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { alarm },
                geometry: { type: 'Polygon', coordinates: [ring] },
            },
            {
                type: 'Feature',
                properties: { alarm, isAnchor: true },
                geometry: { type: 'Point', coordinates: [anchor.longitude, anchor.latitude] },
            },
        ],
    };
}

function ensureLayers(map: mapboxgl.Map): void {
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(FILL_ID)) {
        map.addLayer({
            id: FILL_ID,
            type: 'fill',
            source: SOURCE_ID,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
                'fill-color': ['case', ['get', 'alarm'], '#ef4444', '#f59e0b'],
                'fill-opacity': ['case', ['get', 'alarm'], 0.16, 0.07],
            },
        });
    }
    if (!map.getLayer(LINE_ID)) {
        map.addLayer({
            id: LINE_ID,
            type: 'line',
            source: SOURCE_ID,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
                'line-color': ['case', ['get', 'alarm'], '#ef4444', '#f59e0b'],
                'line-width': ['case', ['get', 'alarm'], 3, 2],
                'line-dasharray': [2, 2],
            },
        });
    }
    if (!map.getLayer(POINT_ID)) {
        map.addLayer({
            id: POINT_ID,
            type: 'circle',
            source: SOURCE_ID,
            filter: ['==', ['get', 'isAnchor'], true],
            paint: {
                'circle-radius': 6,
                'circle-color': ['case', ['get', 'alarm'], '#ef4444', '#f59e0b'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        });
    }
}

export function useAnchorSwingLayer(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean): void {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // The service only emits on GPS fixes and state transitions — and
        // GPS can be SILENT in exactly the cases that matter (blind watch,
        // still boat with distanceFilter suppressing fixes). So healing
        // after a style boot or basemap swap must come from MAP events
        // replaying the last snapshot, never from "the next emission".
        let lastSnap: AnchorWatchSnapshot = AnchorWatchService.getSnapshot();
        let healTimer: number | null = null;

        const apply = (snap: AnchorWatchSnapshot) => {
            lastSnap = snap;
            if (!map.isStyleLoaded() && !map.getSource(SOURCE_ID)) {
                // Style still booting — heal once it settles (deferred a
                // macrotask; never mutate the style inside event dispatch).
                map.once('idle', deferredHeal);
                return;
            }
            try {
                ensureLayers(map);
                (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(buildFeatures(snap));
                // Z-ORDER OWNER (repo lesson): these layers are added with no
                // beforeId, so weather rasters and late ENC mounts paint over
                // them unless re-asserted. moveLayer is idempotent and cheap;
                // last call ends up on top (fill under line under point).
                // Also listed in NAV_LAYER_IDS so promoteNavLayers lifts them
                // when the weather stack mounts.
                for (const id of LAYER_IDS) if (map.getLayer(id)) map.moveLayer(id);
            } catch {
                /* map mid-teardown */
            }
        };

        const deferredHeal = () => {
            if (healTimer !== null) return;
            healTimer = window.setTimeout(() => {
                healTimer = null;
                apply(lastSnap);
            }, 0);
        };

        // Basemap swap (setStyle) wipes the source + layers; re-add from the
        // retained snapshot once the new style is up.
        map.on('style.load', deferredHeal);

        const unsub = AnchorWatchService.subscribe(apply);

        return () => {
            unsub();
            map.off('style.load', deferredHeal);
            map.off('idle', deferredHeal);
            if (healTimer !== null) window.clearTimeout(healTimer);
            try {
                for (const id of LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            } catch {
                /* map already destroyed */
            }
        };
    }, [mapRef, mapReady]);
}
