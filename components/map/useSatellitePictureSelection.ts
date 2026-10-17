import { useCallback, useEffect, useState } from 'react';
import type { WeatherLayer } from './mapConstants';

/** Ephemeral Obs choice; the existing hourly layer and sharper imagery never run together. */
export function useSatellitePictureSelection(admitted: boolean, hourlySelected: boolean, toggleHourly: () => void) {
    const [requested, setRequested] = useState(false);
    const clearSharper = useCallback(() => setRequested(false), []);
    const useHourly = useCallback(() => {
        setRequested(false);
        if (!hourlySelected) toggleHourly();
    }, [hourlySelected, toggleHourly]);
    const toggleSharper = useCallback(() => {
        if (!admitted) return;
        if (!requested && hourlySelected) toggleHourly();
        setRequested(!requested);
    }, [admitted, requested, hourlySelected, toggleHourly]);
    // Includes non-menu hourly activation (for example an explicitly applied HUD).
    // The derived flag already retires sharper before this effect clears intent.
    useEffect(() => {
        if (!admitted || hourlySelected) setRequested(false);
    }, [admitted, hourlySelected]);
    const weatherAction = useCallback((layer: WeatherLayer) => {
        if (layer === 'satIR' || layer === 'none') setRequested(false);
    }, []);
    return {
        sharperVisible: admitted && requested && !hourlySelected,
        toggleSharper,
        useHourly,
        clearSharper,
        weatherAction,
    };
}
