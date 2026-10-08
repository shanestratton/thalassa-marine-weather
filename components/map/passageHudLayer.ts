import { useEffect, useRef } from 'react';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import { setPassageOverlay } from '../../stores/chartPassageOverlay';
import { usePassageHudActivation } from '../../stores/passageHudStore';
import type { useWeatherLayers } from './useWeatherLayers';

interface PassageHudLayerArgs {
    /** The HUD is on this chart: a followed route, a recording or a previewed route (MapHub's passageHudOnChart). */
    available: boolean;
    /**
     * A recording, running or paused, is on this chart. Activations come only
     * from recordings, and the counter is never consumed off the chart: a
     * recording started and stopped in Log before Obs was first opened must not
     * replay for the first route later pulled up on Obs.
     */
    recording: boolean;
    weather: Pick<ReturnType<typeof useWeatherLayers>, 'setLayerVisibility'>;
    setWeatherInspectMode: (visible: boolean) => void;
    closeWeatherInspect: () => void;
    setLightningVisible: (visible: boolean) => void;
    setCycloneVisible: (visible: boolean) => void;
    setSquallVisible: (visible: boolean) => void;
    setAisVisible: (visible: boolean) => void;
}

/**
 * Apply the initial instruments/weather layers once per HUD activation — a
 * recording starting (stores/passageHudStore, activatePassageHudForRecording).
 *
 * There is no switch any more (build 124): the HUD is simply on the chart for a
 * followed route, a recording or a previewed route. Being there is NOT an
 * activation, so a launch with a followed route, or a route pulled up on Obs,
 * opens no weather layer on the skipper's behalf: Obs starts clean.
 */
export function usePassageHudLayerActivation(args: PassageHudLayerArgs): void {
    const activation = usePassageHudActivation();
    const activatedRef = useRef<number | null>(null);
    useEffect(() => {
        if (!args.available || !args.recording || activation === 0 || activatedRef.current === activation) return;
        // Mark first: the setters below re-render MapHub. Later manual weather
        // choices must remain choices, not get reapplied by this effect.
        activatedRef.current = activation;
        args.setWeatherInspectMode(false);
        args.closeWeatherInspect();
        // Wind excludes lightning; squall excludes the cyclone takeover.
        args.setLightningVisible(false);
        args.setCycloneVisible(false);
        args.setAisVisible(true);
        args.weather.setLayerVisibility('wind', true);
        // Availability is the configured, permitted pipeline, not rainReady:
        // the existing rain loader only obtains its first frames after ON.
        if (!satelliteModeBlocks('raster')) {
            args.weather.setLayerVisibility('rain', true);
            if (import.meta.env.VITE_SUPABASE_URL) args.setSquallVisible(true);
        }
        setPassageOverlay(true);
        // Preserve the restored open/collapsed preference; only the FAB opens it.
    }, [args.available, args.recording, activation, args]);
}
