/**
 * useWeatherInspectPopup — the tap-the-water forecast bubble.
 *
 * Extracted from MapHub. This is an IMPERATIVE popup: it mounts a detached
 * React root into a Mapbox popup rather than rendering through MapHub's own
 * tree. That is the whole reason it is shaped the way it is, and the reason
 * it is worth isolating — none of the usual props-flow applies inside here,
 * so the rules are local and easy to get wrong from a distance.
 *
 * The mutable `view` object plus `paint()` ARE the render path. Anything that
 * can change while the bubble is open — the forecast landing, the geocoded
 * name landing, the punter saving or unsaving the spot — mutates `view` and
 * calls `paint()`. There is exactly one render path on purpose.
 *
 * `inspectRootRef.current !== root` is the staleness guard, checked before
 * every render into the root. Two async things race a close: the lazily
 * imported popup chunk and the reverse geocode. Without the identity check, a
 * chunk that resolves after the punter has already tapped elsewhere paints
 * into an unmounted root, or worse, into the NEXT popup's root.
 *
 * Reverse geocoding is deliberately deferred to the moment the punter opens
 * the name editor. A real place name beats "20.2670°S, 148.7180°E" in the
 * saved list, but it is shown nowhere else, and this popup opens on every
 * inspect tap — eager geocoding would bill a lookup per tap for something
 * usually never seen.
 *
 * NOT state: the popup's data and loading flag live in refs. They were
 * `useState` in MapHub under `_`-prefixed names — written in six places and
 * read in none, so their only effect was to re-render a 7,000-line component
 * twice per inspect tap. Nothing renders from them, so refs preserve every
 * observable behaviour and drop the re-renders. They are kept rather than
 * deleted because they are the honest record of what the popup is doing.
 */

import { useCallback, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createRoot } from 'react-dom/client';
import { triggerHaptic } from '../../utils/system';
import { coordName } from './mapHubHelpers';
import type { PointWeatherData } from '../../services/weather/pointWeather';
import {
    buildRemoveLocationPatch,
    buildSaveLocationPatch,
    disambiguateSavedName,
    findSavedAt,
    toPlannerString,
} from '../../utils/savedLocations';

// WeatherInspectPopup is rendered imperatively via createRoot — use direct dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _WeatherInspectPopup: React.ComponentType<any> | null = null;
const getWeatherInspectPopup = async () => {
    if (!_WeatherInspectPopup) {
        const mod = await import('./WeatherInspectPopup');
        _WeatherInspectPopup = mod.WeatherInspectPopup;
    }
    return _WeatherInspectPopup;
};

/** The slice of settings the popup's save row reads, through a ref so the
 *  detached root never closes over a stale render. */
interface InspectSettings {
    savedLocations?: string[];
    savedLocationCoords?: Record<string, { lat: number; lon: number }>;
}

export interface WeatherInspectPopup {
    /** Open the bubble at a tapped position, replacing any open one. */
    showWeatherInspect: (lat: number, lon: number) => void;
    /** Tear the bubble down — used when a clean planning surface takes over. */
    closeWeatherInspect: () => void;
}

export function useWeatherInspectPopup(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    settingsRef: { readonly current: InspectSettings },
    updateSettings: (patch: Record<string, unknown>) => void,
): WeatherInspectPopup {
    const inspectDataRef = useRef<PointWeatherData | null>(null);
    const inspectLoadingRef = useRef(false);
    const inspectPopupRef = useRef<mapboxgl.Popup | null>(null);
    const inspectRootRef = useRef<ReturnType<typeof createRoot> | null>(null);

    const closeWeatherInspect = useCallback(() => {
        if (inspectPopupRef.current) {
            inspectPopupRef.current.remove();
            inspectPopupRef.current = null;
        }
        if (inspectRootRef.current) {
            inspectRootRef.current.unmount();
            inspectRootRef.current = null;
        }
        inspectDataRef.current = null;
        inspectLoadingRef.current = false;
    }, []);

    const showWeatherInspect = useCallback(
        (lat: number, lon: number): void => {
            const map = mapRef.current;
            if (!map) return;
            // Close any existing inspect popup
            closeWeatherInspect();

            const container = document.createElement('div');
            container.style.minWidth = '240px';
            const root = createRoot(container);
            inspectRootRef.current = root;

            inspectDataRef.current = null;
            inspectLoadingRef.current = true;

            const closePopup = () => {
                closeWeatherInspect();
            };

            // Everything the popup shows lives here so any of it can change
            // (weather lands, the geocoded name lands, the user saves) and
            // re-render through one path — the popup is an imperative root,
            // it has no props-flow of its own.
            const view: {
                data: PointWeatherData | null;
                loading: boolean;
                error: string | null;
                suggestedName: string;
                savedAs: string | null;
            } = {
                data: null,
                loading: true,
                error: null,
                suggestedName: coordName(lat, lon),
                savedAs: findSavedAt(settingsRef.current.savedLocationCoords, lat, lon),
            };

            // Reverse geocode ONCE, and only when the punter opens the name
            // editor. A real place name beats "20.2670°S, 148.7180°E" in the
            // saved list, but the name is never shown anywhere else — and
            // this popup opens on every inspect tap, so geocoding eagerly
            // would bill a lookup per tap for something usually unseen.
            // Offshore taps legitimately have no name; the coord string stays.
            let nameRequested = false;
            const ensureName = (): void => {
                if (nameRequested) return;
                nameRequested = true;
                void import('../../services/weatherService')
                    .then(({ reverseGeocode }) => reverseGeocode(lat, lon))
                    .then((name) => {
                        if (inspectRootRef.current !== root || !name) return;
                        view.suggestedName = name;
                        paint();
                    })
                    .catch(() => {
                        /* keep the coord fallback */
                    });
            };

            const paint = (): void => {
                void getWeatherInspectPopup().then((WIP) => {
                    // The popup may have closed while the chunk loaded.
                    if (inspectRootRef.current !== root) return;
                    root.render(
                        <WIP
                            data={view.data}
                            loading={view.loading}
                            error={view.error}
                            onRetry={() => loadWeather()}
                            onClose={closePopup}
                            save={{
                                suggestedName: view.suggestedName,
                                savedAs: view.savedAs,
                                onRequestName: ensureName,
                                onSave: (name: string) => {
                                    const s = settingsRef.current;
                                    // The store is name-keyed but this popup asks
                                    // by coords, and geocoding is locality-level —
                                    // without this, a second anchorage in the same
                                    // bay overwrites the first (see
                                    // disambiguateSavedName).
                                    const unique = disambiguateSavedName(
                                        s.savedLocations,
                                        s.savedLocationCoords,
                                        name,
                                        lat,
                                        lon,
                                    );
                                    const planner = toPlannerString({ name: unique, lat, lon });
                                    const patch = buildSaveLocationPatch(
                                        s.savedLocations,
                                        s.savedLocationCoords,
                                        planner,
                                    );
                                    if (!patch) return;
                                    updateSettings(patch);
                                    triggerHaptic('light');
                                    // Optimistic: the settings write propagates
                                    // asynchronously, but the tap must land now.
                                    // Show the name actually stored, suffix and all.
                                    view.savedAs = unique;
                                    paint();
                                },
                                onUnsave: (name: string) => {
                                    const s = settingsRef.current;
                                    updateSettings(
                                        buildRemoveLocationPatch(s.savedLocations, s.savedLocationCoords, name),
                                    );
                                    triggerHaptic('light');
                                    view.savedAs = null;
                                    paint();
                                },
                            }}
                        />,
                    );
                });
            };

            paint();

            const popup = new mapboxgl.Popup({
                closeButton: false,
                closeOnClick: true,
                className: 'weather-inspect-popup',
                maxWidth: '300px',
                offset: 8,
            })
                .setLngLat([lon, lat])
                .setDOMContent(container)
                .addTo(map);

            inspectPopupRef.current = popup;
            popup.on('close', () => {
                if (inspectRootRef.current) {
                    inspectRootRef.current.unmount();
                    inspectRootRef.current = null;
                }
                inspectPopupRef.current = null;
                inspectDataRef.current = null;
                inspectLoadingRef.current = false;
            });

            const loadWeather = (): void => {
                if (inspectRootRef.current !== root) return;
                view.loading = true;
                view.error = null;
                inspectLoadingRef.current = true;
                paint();
                void import('../../services/weather/pointWeather')
                    .then(({ fetchPointWeather }) => fetchPointWeather(lat, lon))
                    .then((data) => {
                        if (inspectRootRef.current !== root || !inspectPopupRef.current) return;
                        if (!data) throw new Error('No atmospheric report was returned for this position.');
                        inspectDataRef.current = data;
                        inspectLoadingRef.current = false;
                        view.data = data;
                        view.loading = false;
                        view.error = null;
                        paint();
                    })
                    .catch((cause: unknown) => {
                        if (inspectRootRef.current !== root || !inspectPopupRef.current) return;
                        inspectLoadingRef.current = false;
                        view.loading = false;
                        view.error =
                            cause instanceof Error && cause.message.includes('No atmospheric report')
                                ? cause.message
                                : 'Check the internet connection and try this point again.';
                        paint();
                    });
            };

            loadWeather();
        },
        [mapRef, settingsRef, updateSettings, closeWeatherInspect],
    );

    return { showWeatherInspect, closeWeatherInspect };
}
