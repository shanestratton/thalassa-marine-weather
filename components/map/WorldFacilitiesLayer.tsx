import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import { loadMarineArea } from '../../services/marineCatalogue/service';
import { catalogueCacheEpoch, subscribeCatalogueCacheCleared } from '../../services/marineCatalogue/cache';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { satelliteModeActive } from '../../services/networkPolicy';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    facilityDistanceNM,
    facilityDisplayLongitude,
    facilityPopupContent,
    facilityPopupLayout,
    selectWorldFacilities,
    type WorldFacilitiesStatus,
} from '../../services/marineCatalogue/worldFacilities';
import type { MarinePlace } from '../../services/marineCatalogue/schema';
import { openExternalUrl } from '../../services/externalLinks';
import { openPlaceReviews } from '../../services/community/PlaceReviewsService';

const SOURCE = 'thalassa-world-facilities',
    LAYER = 'thalassa-world-facilities-points';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
export interface WorldFacilitiesLayerProps {
    map: mapboxgl.Map | null;
    mapReady: boolean;
    onStatus: (status: WorldFacilitiesStatus | null) => void;
}
/** Mounted only for an explicit, foreground Obs opt-in. No boot, background or route reader. */
export default function WorldFacilitiesLayer({ map, mapReady, onStatus }: WorldFacilitiesLayerProps) {
    useEffect(() => {
        if (!map || !mapReady) return;
        let disposed = false,
            serial = 0,
            request: AbortController | undefined,
            popup: mapboxgl.Popup | undefined;
        let records = new Map<string, MarinePlace>(),
            last: { lat: number; lon: number } | undefined;
        let status: WorldFacilitiesStatus = { state: 'loading', count: 0, partial: false, cachedOnly: false };
        const emit = (next: WorldFacilitiesStatus) => {
            status = next;
            onStatus(next);
        };
        const closePopup = () => {
            popup?.remove();
            popup = undefined;
        };
        const clear = () => {
            serial++;
            request?.abort();
            request = undefined;
            popup?.remove();
            popup = undefined;
            records.clear();
            last = undefined;
            (map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined)?.setData(EMPTY);
        };
        const install = () => {
            if (map.getSource(SOURCE) && map.getLayer(LAYER)) return true;
            // isStyleLoaded also waits for every other source's network work.
            // getStyle checks style readiness itself, so an unrelated pending raster
            // cannot indefinitely prevent this independently opted-in reference layer.
            try {
                if (!map.getStyle()) return false;
            } catch {
                return false;
            }
            if (!map.getSource(SOURCE))
                map.addSource(SOURCE, {
                    type: 'geojson',
                    data: EMPTY,
                    attribution:
                        '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">Facilities: © OpenStreetMap contributors · ODbL</a>',
                });
            if (!map.getLayer(LAYER))
                map.addLayer({
                    id: LAYER,
                    type: 'circle',
                    source: SOURCE,
                    minzoom: 7,
                    paint: {
                        'circle-radius': 7,
                        'circle-stroke-width': 2,
                        'circle-stroke-color': '#f8fafc',
                        'circle-color': [
                            'match',
                            ['get', 'kind'],
                            'fuel',
                            '#f59e0b',
                            'boat_ramp',
                            '#22c55e',
                            'pump_out',
                            '#c084fc',
                            '#38bdf8',
                        ],
                    },
                });
            return true;
        };
        const reload = async (force = false) => {
            if (disposed || !install()) return;
            if (map.getZoom() < 7) {
                clear();
                emit({ state: 'zoom', count: 0, partial: false, cachedOnly: false });
                return;
            }
            const c = map.getCenter(),
                centre = { lat: c.lat, lon: c.lng };
            if (!force && last && facilityDistanceNM(last, centre) < 10) return;
            clear();
            last = centre;
            const own = ++serial,
                scope = getAuthIdentityScope(),
                epoch = catalogueCacheEpoch(),
                controller = new AbortController();
            request = controller;
            emit({
                state: 'loading',
                count: 0,
                partial: false,
                cachedOnly: satelliteModeActive() || navigator.onLine === false,
            });
            try {
                const result = await loadMarineArea(centre.lat, centre.lon, ['facilities-world'], controller.signal);
                if (disposed || own !== serial || !isAuthIdentityScopeCurrent(scope) || epoch !== catalogueCacheEpoch())
                    return;
                const selected = selectWorldFacilities(result, centre);
                records = new Map(selected.records.map((p) => [p.id, p]));
                const source = map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined;
                source?.setData({
                    type: 'FeatureCollection',
                    features: selected.records.map((p) => ({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                        properties: { id: p.id, kind: p.kind },
                    })),
                });
                emit(selected.status);
            } catch {
                if (!disposed && own === serial && !controller.signal.aborted)
                    emit({
                        state: 'unavailable',
                        count: 0,
                        partial: true,
                        cachedOnly: satelliteModeActive() || navigator.onLine === false,
                    });
            }
        };
        const move = () => {
                void reload();
            },
            style = () => {
                last = undefined;
                void reload(true);
            };
        const policy = () => {
            clear();
            void reload(true);
        };
        const click = (e: mapboxgl.MapLayerMouseEvent) => {
            const id = e.features?.[0]?.properties?.id,
                place = typeof id === 'string' ? records.get(id) : undefined;
            if (!place) return;
            popup?.remove();
            const content = facilityPopupContent(place, status, () => {
                closePopup();
                openPlaceReviews({ id: place.id, name: place.name, kind: 'marina' });
            });
            const position: [number, number] = [facilityDisplayLongitude(place.lon, e.lngLat.lng), place.lat];
            const layout = facilityPopupLayout(map.project(position), map.getContainer().getBoundingClientRect());
            content.style.width = `${Math.max(1, layout.maxWidth - 20)}px`;
            content.style.maxHeight = `${layout.contentMaxHeight}px`;
            content.addEventListener('click', (event) => {
                const a = event.target instanceof Element ? event.target.closest('a') : null;
                if (a instanceof HTMLAnchorElement) {
                    event.preventDefault();
                    void openExternalUrl(a.href);
                }
            });
            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = 'Close';
            close.setAttribute('aria-label', 'Close facility details');
            Object.assign(close.style, { minHeight: '44px', minWidth: '44px', display: 'block' });
            close.onclick = () => popup?.remove();
            // Mapbox focuses the first control. Keep Close before the source links
            // so opening the popup does not scroll its title out of the bounded body.
            content.prepend(close);
            popup = new mapboxgl.Popup({ closeButton: false, maxWidth: `${layout.maxWidth}px`, anchor: layout.anchor })
                .setLngLat(position)
                .setDOMContent(content)
                .addTo(map);
            // This explicitly opened detail must sit above the closed credits strip.
            const popupElement = popup.getElement();
            if (popupElement) popupElement.style.zIndex = '650';
        };
        map.on('moveend', move);
        map.on('style.load', style);
        map.on('click', LAYER, click);
        map.on('movestart', closePopup);
        map.on('resize', closePopup);
        window.addEventListener('online', policy);
        window.addEventListener('offline', policy);
        const identity = subscribeAuthIdentityScope(policy),
            settings = useSettingsStore.subscribe((next, previous) => {
                if (next.settings.satelliteMode !== previous.settings.satelliteMode) policy();
            });
        const deleted = subscribeCatalogueCacheCleared(() => {
            clear();
            emit({ state: 'unavailable', count: 0, partial: true, cachedOnly: true });
        });
        void reload(true);
        return () => {
            disposed = true;
            clear();
            identity();
            settings();
            deleted();
            window.removeEventListener('online', policy);
            window.removeEventListener('offline', policy);
            map.off('moveend', move);
            map.off('style.load', style);
            map.off('click', LAYER, click);
            map.off('movestart', closePopup);
            map.off('resize', closePopup);
            if (map.getLayer(LAYER)) map.removeLayer(LAYER);
            if (map.getSource(SOURCE)) map.removeSource(SOURCE);
            onStatus(null);
        };
    }, [map, mapReady, onStatus]);
    return null;
}
