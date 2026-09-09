import { useCallback, useState } from 'react';
import type { MapBaseKind } from './MapBaseSelector';

/**
 * Default the OBS background to the resolved display mode, not the raw auto
 * setting. Keep deliberate choices for each mode during this map session so a
 * theme change or weather refresh cannot erase the skipper's selection.
 * Nothing is persisted: a newly mounted map starts with its mode's default.
 */
export function useMapBase(daylightMode: boolean) {
    const mode = daylightMode ? 'day' : 'dark';
    const [choices, setChoices] = useState<Partial<Record<'day' | 'dark', MapBaseKind>>>({});
    const mapBase = choices[mode] ?? (daylightMode ? 'ocean' : 'satellite');
    const setMapBase = useCallback(
        (value: MapBaseKind) => setChoices((current) => ({ ...current, [mode]: value })),
        [mode],
    );

    return { mapBase, setMapBase };
}
