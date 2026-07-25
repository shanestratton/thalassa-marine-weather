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

    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={label}
            className="pointer-events-none absolute left-1/2 top-1/2 z-[520] flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full border border-white/10 bg-slate-950/85 px-4 py-2 text-xs font-bold text-sky-100 shadow-lg shadow-black/30 backdrop-blur-md"
        >
            <span
                aria-hidden
                className="h-3 w-3 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300"
            />
            Loading
        </div>
    );
}
