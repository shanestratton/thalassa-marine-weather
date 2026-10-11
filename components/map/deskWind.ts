/**
 * Wind on the desk (127-DESKMAP-b). Shane 2026-10-10: "can we include the
 * wind layer on the desktop.?? as an option??".
 *
 * The field is the chart's own: the Glass's five models (and GFS) through the
 * paid Open-Meteo customer API, whose key lives in the proxy-openmeteo edge
 * function and never in the browser (openMeteoProxy.ts), or NOAA's GRIB for
 * GFS. Nothing here fetches. It names the model on screen and credits it, as
 * the source licences ask: "Name whichever models you actually used".
 *
 * The switch itself is MapHub's session-only state (Shane 2026-09-05: layers
 * do not persist across restarts), so nothing here touches storage.
 */
import { useEffect, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { AVAILABLE_MODELS, type WeatherModelId } from '../../services/weather/MultiModelWeatherService';
import { SELECTABLE_MODELS, forecastDataCredit } from '../../services/weather/forecastModels';
import type { MapBaseToggle } from './MapBaseSelector';

const info = (id: WeatherModelId) => AVAILABLE_MODELS.find((m) => m.id === id);

/** The Glass's name for a wind model, as the chart's model chips show it (WindModelFieldSelector). */
export function windModelLabel(id: WeatherModelId): string {
    const m = info(id);
    return SELECTABLE_MODELS.find((g) => g.id === m?.openMeteoModel)?.label ?? m?.name ?? id;
}

/**
 * The wind model's licence credit: "Wind: ECMWF (CC BY 4.0) via Open-Meteo",
 * "Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo"; GFS comes from NOAA's
 * own GRIB, "Wind: NOAA (public domain)".
 */
export function windCreditLine(id: WeatherModelId): string {
    return `${forecastDataCredit([info(id)?.provider ?? id], 'Wind')}${id === 'gfs' ? '' : ' via Open-Meteo'}`;
}

/** The desk menu's Wind row, after Seamarks: "Model forecast · ECMWF". */
export function deskWindToggle(on: boolean, model: WeatherModelId, onToggle: () => void): MapBaseToggle {
    return { id: 'wind', label: 'Wind', detail: `Model forecast · ${windModelLabel(model)}`, on, onToggle };
}

/**
 * Where the desk asks the models whether they agree when nothing is pinned:
 * the middle of the map once it has been still for 1.5 s at zoom 5 or closer,
 * to the comparison's own 0.1° cell, so a pan inside one cell asks nothing.
 */
export function useStillCentre(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    on: boolean,
): { lat: number; lon: number } | null {
    const [centre, setCentre] = useState<{ lat: number; lon: number } | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!on || !map || !mapReady) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cell = (v: number) => Math.round(v * 10) / 10;
        const settle = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const { lat, lng } = map.getCenter();
                const next = map.getZoom() >= 5 ? { lat: cell(lat), lon: cell(lng) } : null;
                setCentre((prev) => (prev?.lat === next?.lat && prev?.lon === next?.lon ? prev : next));
            }, 1_500);
        };
        const hold = () => clearTimeout(timer);
        settle();
        map.on('movestart', hold);
        map.on('moveend', settle);
        return () => {
            clearTimeout(timer);
            map.off('movestart', hold);
            map.off('moveend', settle);
        };
    }, [mapRef, mapReady, on]);
    return on ? centre : null;
}
