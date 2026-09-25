import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { loadOfficialMoorings, loadReferenceTile } from '../../services/anchorages/CruisingReferenceService';
import {
    matchesMooringColour,
    mergeMooringReferences,
    referenceTiles,
    type CruisingPoint,
    type MooringColourFilter,
} from '../../services/anchorages/cruisingReference';
import type { AnchorageData } from '../../services/anchorages/AnchorageService';
import { mooringIcon, mooringPopup } from './cruisingReferencePresentation';
import { cachedPlaceConditions, loadPlaceConditions } from '../../services/anchorages/PlaceConditionsService';
import { type ConditionsPlace } from '../../services/anchorages/placeConditions';
import type { VesselProfile } from '../../types/vessel';
import { watchPlaceConditions } from './watchPlaceConditions';
import { placeConditionsHtml } from './placeConditionsPresentation';

const SOURCE = 'cruising-moorings';
const LAYER = 'cruising-mooring-symbols';
const EMPTY_ANCHORAGES: AnchorageData['points'] = { type: 'FeatureCollection', features: [] };
export function worldAnchorages(points: CruisingPoint[]): AnchorageData['points'] {
    return {
        type: 'FeatureCollection',
        features: points
            .filter((p) => p.kind === 'anchorage')
            .map((p) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: {
                    id: p.id,
                    name: p.name,
                    kind: 'anchorage',
                    source: 'OpenStreetMap',
                    sourceRef: p.sourceUrl,
                    notes: [
                        p.notes,
                        `Access: ${p.access}.`,
                        p.approximate ? 'Approximate area centre, not an anchor-drop position.' : '',
                        `Retrieved ${p.retrievedAt.slice(0, 10)}. Depth, holding, shelter and restrictions are not verified.`,
                    ]
                        .filter(Boolean)
                        .join(' '),
                },
            })),
    };
}
export function useCruisingReferenceLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    mooringsVisible: boolean,
    anchoragesVisible: boolean,
    colourFilter: MooringColourFilter,
    vessel?: VesselProfile,
) {
    const [status, setStatus] = useState('');
    const [center, setCenter] = useState<{ lat: number; lon: number } | null>(null);
    const [anchors, setAnchors] = useState(EMPTY_ANCHORAGES);
    const filterRef = useRef(colourFilter);
    filterRef.current = colourFilter;
    const vesselRef = useRef(vessel);
    vesselRef.current = vessel;
    const repaint = useRef<(() => void) | null>(null);
    useEffect(() => {
        repaint.current?.();
    }, [colourFilter, vessel?.length, vessel?.hullType]);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || (!mooringsVisible && !anchoragesVisible)) {
            setAnchors(EMPTY_ANCHORAGES);
            setStatus('');
            return;
        }
        let disposed = false;
        let official: CruisingPoint[] = [];
        let osm: CruisingPoint[] = [];
        let popup: mapboxgl.Popup | null = null;
        let controller: AbortController | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let styleTimer: ReturnType<typeof setTimeout> | null = null;
        let generation = 0;
        let lastKey = '';
        let officialError = false;
        let lookup = new Map<string, CruisingPoint>();
        let popupPoint: CruisingPoint | null = null;
        const conditionsPlace = (p: CruisingPoint): ConditionsPlace => ({
            ...p,
            vessel: vesselRef.current
                ? { lengthM: vesselRef.current.length * 0.3048, hullType: vesselRef.current.hullType }
                : undefined,
        });
        const icons = new Set<string>();
        const closePopup = () => {
            popup?.remove();
            popup = null;
            popupPoint = null;
        };
        const paint = (styleReady = false) => {
            // isStyleLoaded also waits for OTHER sources to finish fetching.
            // During style.load the style graph is ready even if those tiles
            // aren't; deferring here can leave our source missing indefinitely.
            if (disposed || (!styleReady && !map.isStyleLoaded() && !map.getSource(SOURCE))) return;
            if (!mooringsVisible) return;
            const points = mergeMooringReferences(
                official,
                osm.filter((p) => p.kind === 'mooring'),
            ).filter((p) => matchesMooringColour(p, filterRef.current));
            lookup = new Map(points.map((p) => [p.id, p]));
            const features: GeoJSON.Feature<GeoJSON.Point>[] = points.map((p) => {
                const light = cachedPlaceConditions(conditionsPlace(p)).light;
                const icon = `cruising-buoy-${p.colours.slice(0, 2).join('-') || 'unknown'}-${p.band ?? 'none'}-${light}`;
                if (!map.hasImage(icon)) map.addImage(icon, mooringIcon(p.colours, p.band, light), { pixelRatio: 2 });
                icons.add(icon);
                return {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                    properties: { id: p.id, icon, conditions: light },
                };
            });
            const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
            if (!map.getSource(SOURCE))
                map.addSource(SOURCE, {
                    type: 'geojson',
                    data,
                    attribution: 'Moorings: © State of Queensland · © OpenStreetMap contributors (ODbL)',
                });
            else (map.getSource(SOURCE) as mapboxgl.GeoJSONSource).setData(data);
            if (!map.getLayer(LAYER))
                map.addLayer(
                    {
                        id: LAYER,
                        type: 'symbol',
                        source: SOURCE,
                        minzoom: 9,
                        layout: {
                            'icon-image': ['get', 'icon'],
                            'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 13, 1.1],
                            'icon-allow-overlap': false,
                            'icon-anchor': 'center',
                        },
                    },
                    map.getStyle()?.layers?.find((l) => /^(routetrack-|passage-ghost-|mob-)/.test(l.id))?.id,
                );
            if (popupPoint) {
                const node = popup?.getElement()?.querySelector('.place-conditions');
                if (node) {
                    node.innerHTML = placeConditionsHtml(cachedPlaceConditions(conditionsPlace(popupPoint)));
                    popup?.setLngLat([popupPoint.lon, popupPoint.lat]);
                }
            }
        };
        const weather = watchPlaceConditions(
            map,
            () => [...lookup.values()].map(conditionsPlace),
            () => paint(),
        );
        repaint.current = () => {
            closePopup();
            paint();
        };
        const load = async () => {
            if (disposed) return;
            const c = map.getCenter();
            setCenter({ lat: c.lat, lon: ((((c.lng + 180) % 360) + 360) % 360) - 180 });
            const b = map.getBounds();
            if (!b) return;
            const tiles = referenceTiles(
                { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
                map.getZoom(),
            );
            const key = tiles
                .map((t) => t.key)
                .sort()
                .join('|');
            if (key && key === lastKey) return;
            lastKey = key;
            controller?.abort();
            controller = new AbortController();
            const signal = controller.signal;
            const ownGeneration = ++generation;
            osm = [];
            setAnchors(EMPTY_ANCHORAGES);
            closePopup();
            paint();
            if (!tiles.length) {
                setStatus('Zoom in for moorings and anchorage detail');
                return;
            }
            setStatus('Loading mapped places…');
            let failed = 0,
                stale = false;
            const found = new Map<string, CruisingPoint>();
            // Sequential bounded cells: no global download or request burst.
            for (const tile of tiles) {
                try {
                    const result = await loadReferenceTile(tile, signal);
                    stale ||= result.stale;
                    for (const p of result.points) found.set(p.id, p);
                } catch {
                    if (signal.aborted) return;
                    failed++;
                    break;
                }
                if (disposed || ownGeneration !== generation) return;
                osm = [...found.values()];
                setAnchors(anchoragesVisible ? worldAnchorages(osm) : EMPTY_ANCHORAGES);
                paint();
                weather.changed();
                if (found.size > 6000) {
                    failed++;
                    break;
                }
            }
            if (disposed || ownGeneration !== generation) return;
            setStatus(
                failed || officialError
                    ? 'Some reference data unavailable — coverage incomplete'
                    : stale
                      ? 'Cached reference — could not refresh'
                      : 'Mapped places · coverage varies · not live availability',
            );
            // Permit an explicit pan/zoom to retry a failed viewport.
            if (failed) lastKey = '';
        };
        const moved = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                void load();
            }, 700);
        };
        const restored = () => {
            paint(true);
            lastKey = '';
            moved();
        };
        // Mapbox's diffed setStyle can remove custom layers without emitting
        // style.load. Repair only missing resources, after the style mutation.
        const checkStyle = () => {
            if (styleTimer || disposed || !mooringsVisible) return;
            styleTimer = setTimeout(() => {
                styleTimer = null;
                if (!disposed && map.isStyleLoaded() && (!map.getSource(SOURCE) || !map.getLayer(LAYER))) paint(true);
            }, 0);
        };
        const click = (e: mapboxgl.MapLayerMouseEvent) => {
            const p = lookup.get(String(e.features?.[0]?.properties?.id));
            if (!p) return;
            closePopup();
            popupPoint = p;
            popup = new mapboxgl.Popup({ maxWidth: '300px', offset: 16 })
                .setLngLat([p.lon, p.lat])
                .setHTML(mooringPopup(p, cachedPlaceConditions(conditionsPlace(p))))
                .addTo(map);
            void loadPlaceConditions([conditionsPlace(p)]).then(() => {
                if (!disposed) paint();
            });
        };
        const enter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const leave = () => {
            map.getCanvas().style.cursor = '';
        };
        map.on('moveend', moved);
        map.on('style.load', restored);
        map.on('styledata', checkStyle);
        map.on('idle', checkStyle);
        map.on('click', LAYER, click);
        map.on('mouseenter', LAYER, enter);
        map.on('mouseleave', LAYER, leave);
        if (mooringsVisible)
            void loadOfficialMoorings()
                .then((points) => {
                    if (!disposed) {
                        official = points;
                        paint();
                        weather.changed();
                    }
                })
                .catch(() => {
                    if (!disposed) {
                        officialError = true;
                        setStatus('Official mooring copy unavailable — coverage incomplete');
                    }
                });
        paint(true);
        void load();
        return () => {
            disposed = true;
            weather.dispose();
            controller?.abort();
            if (timer) clearTimeout(timer);
            if (styleTimer) clearTimeout(styleTimer);
            closePopup();
            repaint.current = null;
            map.off('moveend', moved);
            map.off('style.load', restored);
            map.off('styledata', checkStyle);
            map.off('idle', checkStyle);
            map.off('click', LAYER, click);
            map.off('mouseenter', LAYER, enter);
            map.off('mouseleave', LAYER, leave);
            if (map.getLayer(LAYER)) map.removeLayer(LAYER);
            if (map.getSource(SOURCE)) map.removeSource(SOURCE);
            for (const icon of icons) if (map.hasImage(icon)) map.removeImage(icon);
            map.getCanvas().style.cursor = '';
        };
    }, [mapRef, mapReady, mooringsVisible, anchoragesVisible]);
    return { status, center, anchors };
}
