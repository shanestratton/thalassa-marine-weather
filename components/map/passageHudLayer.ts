import { useEffect, useRef } from 'react';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import { setPassageOverlay } from '../../stores/chartPassageOverlay';
import {
    isPassageHudEnabled,
    usePassageHudActivation,
    setPassageHudEnabled,
    setPassageHudOpen,
    stopPassageLookAhead,
} from '../../stores/passageHudStore';
import type { RadialHelmMenuProps } from './RadialHelmMenu';
import type { useWeatherLayers } from './useWeatherLayers';

type ChartSource = NonNullable<NonNullable<RadialHelmMenuProps['chartsState']>['sources']>[number];

interface PassageHudLayerArgs {
    isFollowing: boolean;
    hasRecording?: boolean;
    routeCoords: ReadonlyArray<{ lat: number; lon: number }>;
    enabled: boolean;
    weather: Pick<ReturnType<typeof useWeatherLayers>, 'setLayerVisibility'>;
    setWeatherInspectMode: (visible: boolean) => void;
    closeWeatherInspect: () => void;
    setLightningVisible: (visible: boolean) => void;
    setCycloneVisible: (visible: boolean) => void;
    setSquallVisible: (visible: boolean) => void;
    setAisVisible: (visible: boolean) => void;
}

/** Apply the initial instruments/weather layers once per HUD activation. */
export function usePassageHudLayerActivation(args: PassageHudLayerArgs): void {
    const active = args.enabled && (args.hasRecording || (args.isFollowing && args.routeCoords.length >= 2));
    const activation = usePassageHudActivation();
    const activatedRef = useRef<number | null>(null);
    useEffect(() => {
        if (!active || activatedRef.current === activation) return;
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
    }, [active, activation, args]);
}

/** The manual switch for instruments around a followed route or current recording. */
export function passageHudLayerSources(args: PassageHudLayerArgs): ChartSource[] {
    if (!args.hasRecording && (!args.isFollowing || args.routeCoords.length < 2)) return [];
    return [
        {
            id: 'passage-hud',
            label: 'Passage HUD',
            iconKind: 'generic',
            enabled: args.enabled,
            onToggle: () => {
                if (isPassageHudEnabled()) {
                    setPassageHudEnabled(false);
                    setPassageHudOpen(false);
                    stopPassageLookAhead();
                    return;
                }
                setPassageHudEnabled(true);
                setPassageHudOpen(true);
            },
        },
    ];
}
