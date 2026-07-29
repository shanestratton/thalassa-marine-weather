/**
 * usePassageRouterEvents — MapHub's subscription to the passage router's
 * window event bus: isochrone progress and completion, passage notices, and
 * pin-drop-navigate from DM chat.
 *
 * Extracted from MapHub verbatim. All three effects have empty dep arrays and
 * read no render-captured React value — every payload arrives on
 * CustomEvent.detail at fire time, and the only outside handle is mapRef.
 * That is what makes them safe to lift together.
 *
 * The isochrone effect draws a PARTIAL route as the wavefronts expand, on its
 * own `route-preview` source, so the skipper watches the line grow instead of
 * staring at a still map. Statement order inside onProgress is load-bearing:
 * setIsoProgress runs FIRST, and only then does `if (!map) return` bail out of
 * the drawing. With no map yet the progress readout still counts. Swapping
 * those two lines looks like a tidy-up and silently changes behaviour.
 *
 * Passage notices exist because of a field bug (2026-06-12): refusals,
 * chart-gap rejections and too-short bails were dispatched with no listener,
 * so the map just stayed blank — indistinguishable from a hang.
 *
 * isoProgress and passageNotice stay as MapHub state and only their SETTERS
 * come in here. setIsoProgress has a second writer in MapHub carrying its own
 * dep suppression, and both values feed the passage banner's props.
 *
 * `route-preview` is created at FIRE time (on the first progress event that
 * carries a partial route), not at mount, so this hook's call site does not
 * affect its z-order. It is added with no beforeId and lands at the top of the
 * style; do not add one while moving.
 *
 * log.info here fires once per isochrone step and is silenced in production by
 * createLogger. Keep it as info — promoting it to warn floods the Xcode
 * console on the hot path.
 *
 * PRE-EXISTING LEAKS, CARRIED UNCHANGED: cleanup removes only the window
 * listeners, so an unmount mid-isochrone leaves the route-preview source and
 * layer on the map, and the pin-drop timers and marker are untracked. Both
 * want their own commits with their own device verification.
 */

// The identities named in the dep arrays below (mapRef and the two setters)
// are there only to satisfy exhaustive-deps, which can no longer see they are
// stable now that they arrive as parameters rather than as useRef/useState
// results in the same component. All three are stable for MapHub's lifetime,
// so every one of these effects still subscribes exactly once, on mount.
import { useEffect } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');

export interface PassageRouterEventDeps {
    /** Read at FIRE time only, never during render. */
    mapRef: React.RefObject<mapboxgl.Map | null>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setIsoProgress: (p: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPassageNotice: (n: any) => void;
}

export function usePassageRouterEvents({ mapRef, setIsoProgress, setPassageNotice }: PassageRouterEventDeps): void {
    // Listen for isochrone progress + completion events
    useEffect(() => {
        const onProgress = (e: Event) => {
            const d = (e as CustomEvent).detail;
            log.info('Isochrone progress:', d);
            if (d)
                setIsoProgress({
                    step: d.step,
                    closestNM: d.closestNM,
                    totalDistNM: d.totalDistNM,
                    elapsed: d.elapsed,
                    frontSize: d.frontSize,
                    phase: d.phase,
                });

            // ── Progressive route rendering ──
            // Draw the partial route as the wavefronts expand so the user
            // sees the line growing — use a separate preview source to avoid
            // wiping out the harbour leg features on 'route-line'.
            if (d?.partialRoute && d.partialRoute.length >= 2) {
                const map = mapRef.current;
                if (!map) return;
                // Lazily create preview source/layer
                if (!map.getSource('route-preview')) {
                    map.addSource('route-preview', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                    map.addLayer({
                        id: 'route-preview-layer',
                        type: 'line',
                        source: 'route-preview',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#00e676',
                            'line-width': 2,
                            'line-opacity': 0.5,
                            'line-dasharray': [4, 4],
                        },
                    });
                }
                const src = map.getSource('route-preview') as mapboxgl.GeoJSONSource;
                if (src) {
                    src.setData({
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: {},
                                geometry: {
                                    type: 'LineString',
                                    coordinates: d.partialRoute,
                                },
                            },
                        ],
                    });
                }
            }
        };
        const onComplete = () => {
            log.info('Isochrone complete — clearing progress');
            setIsoProgress(null);
            // Clean up the progressive preview layer
            const map = mapRef.current;
            if (map) {
                if (map.getLayer('route-preview-layer')) map.removeLayer('route-preview-layer');
                if (map.getSource('route-preview')) map.removeSource('route-preview');
            }
        };
        window.addEventListener('thalassa:isochrone-progress', onProgress);
        window.addEventListener('thalassa:isochrone-complete', onComplete);
        return () => {
            window.removeEventListener('thalassa:isochrone-progress', onProgress);
            window.removeEventListener('thalassa:isochrone-complete', onComplete);
        };
    }, [mapRef, setIsoProgress]);

    // Passage notices — refusals, chart-gap rejections, too-short bails.
    // Field bug 2026-06-12: these outcomes were dispatched (or only
    // logged) with no listener, so the map stayed blank with zero
    // feedback — indistinguishable from a hang.
    useEffect(() => {
        const onNotice = (e: Event) => {
            setPassageNotice((e as CustomEvent).detail ?? null);
        };
        const onTooShort = (e: Event) => {
            const d = (e as CustomEvent).detail;
            setPassageNotice({
                severity: 'warn',
                title: `Route too short for passage planning (${d?.distanceNM ?? '?'} NM)`,
                message: d?.message ?? 'Try Community Routes for local harbour exits and coastal legs.',
            });
        };
        window.addEventListener('thalassa:passage-notice', onNotice);
        window.addEventListener('thalassa:passage-too-short', onTooShort);
        return () => {
            window.removeEventListener('thalassa:passage-notice', onNotice);
            window.removeEventListener('thalassa:passage-too-short', onTooShort);
        };
    }, [setPassageNotice]);

    // Listen for pin-drop-navigate events from DM chat
    useEffect(() => {
        const onPinDrop = (e: Event) => {
            const { lat, lon, label } = (e as CustomEvent).detail;
            if (!isFinite(lat) || !isFinite(lon)) return;

            // Request tab switch to map via global event
            window.dispatchEvent(new CustomEvent('thalassa:navigate-tab', { detail: { tab: 'map' } }));

            // Fly to the pin location (delay gives map tab time to render)
            setTimeout(() => {
                const map = mapRef.current;
                if (!map) return;

                map.flyTo({ center: [lon, lat], zoom: 14, duration: 1500 });

                // Drop a temporary pin marker
                const el = document.createElement('div');
                el.className = 'pin-drop-marker';
                const wrapper = document.createElement('div');
                wrapper.style.cssText =
                    'display:flex;flex-direction:column;align-items:center;animation:pinDropBounce 0.5s ease-out';
                const pin = document.createElement('span');
                pin.style.cssText = 'font-size:28px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.4))';
                pin.textContent = '📍';
                wrapper.appendChild(pin);
                const lbl = document.createElement('span');
                lbl.style.cssText =
                    'font-size:10px;color:#38bdf8;font-weight:700;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:8px;margin-top:2px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis';
                lbl.textContent = label;
                wrapper.appendChild(lbl);
                el.appendChild(wrapper);

                const mapboxgl = window.mapboxgl;
                if (mapboxgl?.Marker) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const marker = new (mapboxgl as any).Marker({ element: el }).setLngLat([lon, lat]).addTo(map);

                    // Auto-remove after 10 seconds
                    setTimeout(() => {
                        try {
                            marker.remove();
                        } catch (e) {
                            console.warn('Suppressed:', e);
                            /* already removed */
                        }
                    }, 10_000);
                }
            }, 500);
        };

        window.addEventListener('pin-drop-navigate', onPinDrop);
        return () => window.removeEventListener('pin-drop-navigate', onPinDrop);
    }, [mapRef]);
}
