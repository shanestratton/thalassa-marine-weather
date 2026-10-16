import { useEffect, useSyncExternalStore, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { IsochroneResult, TurnWaypoint } from '../../services/isochrone/types';
import { readRouteReplan, subscribeRouteReplan, setRouteReplan } from '../../services/routing/routeReplanSession';

const SOURCE = 'underway-replan-original',
    LAYER = 'underway-replan-original-line';
export function clearRouteReplanReference(map: mapboxgl.Map | null): void {
    try {
        if (map?.getLayer(LAYER)) map.removeLayer(LAYER);
        if (map?.getSource(SOURCE)) map.removeSource(SOURCE);
    } catch {
        /* Disposed style. */
    }
}
/** Private reference line and final-verdict bridge; never a follow-store writer. */
export function useRouteReplanPreview(input: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    tokenRef: MutableRefObject<string | null>;
    show: boolean;
    verified: boolean;
    geometryKey: string | null;
    departureTime: string;
    speed: number;
    result: MutableRefObject<IsochroneResult | null>;
    turns: MutableRefObject<TurnWaypoint[]>;
    caveats: string[];
    cells: MutableRefObject<string[]>;
    invalidate: () => void;
}) {
    const invalidate = input.invalidate;
    const state = useSyncExternalStore(subscribeRouteReplan, readRouteReplan, readRouteReplan),
        base = state.base;
    useEffect(() => {
        if (
            base &&
            state.phase === 'ready' &&
            (!input.verified ||
                input.geometryKey !== state.candidate?.geometryKey ||
                input.departureTime !== base.departureTime ||
                input.speed !== base.speed)
        ) {
            setRouteReplan({
                ...state,
                phase: 'error',
                candidate: null,
                message: 'The displayed route or its clock changed. Keep the original and re-plan again.',
            });
        }
    }, [base, state, input.verified, input.geometryKey, input.departureTime, input.speed]);
    useEffect(() => {
        if (
            !base ||
            base.token !== input.tokenRef.current ||
            !input.show ||
            !['computing', 'ready'].includes(state.phase)
        )
            return;
        let disposed = false;
        const timer = setInterval(() => {
            void import('../../services/routing/routeReplan').then((api) => {
                if (
                    disposed ||
                    readRouteReplan().base?.token !== base.token ||
                    !['computing', 'ready'].includes(readRouteReplan().phase)
                )
                    return;
                if (
                    !api.replanContextCurrent(base) ||
                    (readRouteReplan().phase === 'computing' && Date.now() > base.deadlineMs) ||
                    Date.now() - Date.parse(base.departureTime) > 300000
                ) {
                    invalidate();
                    setRouteReplan({
                        ...readRouteReplan(),
                        phase: 'error',
                        candidate: null,
                        message:
                            'This candidate expired or its account, boat, authority or route changed. Keep the original route.',
                    });
                }
            });
        }, 250);
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [base, state.phase, input.show, input.tokenRef, invalidate]);
    useEffect(() => {
        const map = input.mapRef.current;
        if (!base || !map || !input.mapReady || base.token !== input.tokenRef.current || !input.show) return;
        const coordinates: number[][] = [];
        for (const point of base.oldCoords) {
            const previous = coordinates.at(-1)?.[0] ?? point.lon;
            coordinates.push([previous + ((((point.lon - previous + 180) % 360) + 360) % 360) - 180, point.lat]);
        }
        const data: GeoJSON.Feature<GeoJSON.LineString> = {
            type: 'Feature',
            properties: { role: 'original-followed-route' },
            geometry: { type: 'LineString', coordinates },
        };
        const draw = () => {
            try {
                if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data });
                if (!map.getLayer(LAYER))
                    map.addLayer({
                        id: LAYER,
                        type: 'line',
                        source: SOURCE,
                        paint: {
                            'line-color': '#cbd5e1',
                            'line-width': 3,
                            'line-dasharray': [2, 2],
                            'line-opacity': 0.8,
                        },
                    });
            } catch {
                /* A style reload will retry through styledata. */
            }
        };
        draw();
        map.on('styledata', draw);
        return () => {
            map.off('styledata', draw);
            try {
                if (map.getLayer(LAYER)) map.removeLayer(LAYER);
                if (map.getSource(SOURCE)) map.removeSource(SOURCE);
            } catch {
                /*disposed map*/
            }
        };
    }, [base, input.show, input.mapReady, input.mapRef, input.tokenRef]);
    useEffect(() => {
        if (
            !base ||
            base.token !== input.tokenRef.current ||
            state.phase !== 'computing' ||
            !input.verified ||
            !input.geometryKey ||
            !input.result.current
        )
            return;
        const token = base.token,
            result = input.result.current,
            geometryKey = input.geometryKey;
        void import('../../services/routing/routeReplan').then((api) => {
            if (input.tokenRef.current !== token || input.result.current !== result) return;
            api.offerRouteReplanCandidate(token, {
                result,
                geometryKey,
                turns: input.turns.current,
                caveats: input.caveats,
                cells: input.cells.current,
            });
        });
    }, [
        base,
        state.phase,
        input.verified,
        input.geometryKey,
        input.result,
        input.turns,
        input.tokenRef,
        input.caveats,
        input.cells,
    ]);
}
