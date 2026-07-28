import type React from 'react';
import type { WeatherLayer } from './mapConstants';

type ObsLayerLoadingKind = 'wind' | 'rain' | 'weather';

interface ObsLayerLoadingPillProps {
    activeLayers: ReadonlySet<WeatherLayer>;
    windLoading: boolean;
    windReady: boolean;
    windError: unknown;
    rainLoading: boolean;
    rainImageLoading: boolean;
}

/**
 * One truthful, map-centred loading state for the OBS surface. The timeline
 * controls deliberately do not own this: opening their lazy chunk is not the
 * same thing as the weather imagery becoming usable.
 */
export function getObsLayerLoadingKind({
    activeLayers,
    windLoading,
    windReady,
    windError,
    rainLoading,
    rainImageLoading,
}: ObsLayerLoadingPillProps): ObsLayerLoadingKind | null {
    const windActive = activeLayers.has('wind') || activeLayers.has('velocity');
    const windIsLoading = windActive && !windError && (windLoading || !windReady);
    const rainIsLoading = activeLayers.has('rain') && (rainLoading || rainImageLoading);

    if (windIsLoading && rainIsLoading) return 'weather';
    if (windIsLoading) return 'wind';
    if (rainIsLoading) return 'rain';
    return null;
}

export function ObsLayerLoadingPill(props: ObsLayerLoadingPillProps): React.ReactElement | null {
    const loadingKind = getObsLayerLoadingKind(props);
    if (!loadingKind) return null;

    const label = loadingKind === 'weather' ? 'Loading weather layers' : `Loading ${loadingKind} layer`;

    // Amber, not sky: sky-100 on a dark chart sat in the same blue register as
    // the water, the wind arrows and half the UI, so it disappeared into its
    // own background. Amber is the one hue the map never uses, and it reads
    // over both blue water and green land. Doubled in size for the same
    // reason — this is a mid-map status, not a chrome detail.
    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={label}
            className="pointer-events-none absolute left-1/2 top-1/2 z-[520] flex -translate-x-1/2 -translate-y-1/2 items-center gap-4 rounded-full border-2 border-amber-400/40 bg-slate-950/90 px-8 py-4 text-base font-bold text-amber-200 shadow-xl shadow-amber-500/20 backdrop-blur-md"
        >
            <span
                aria-hidden
                className="h-6 w-6 animate-spin rounded-full border-4 border-amber-300/25 border-t-amber-300"
            />
            {label}
        </div>
    );
}
