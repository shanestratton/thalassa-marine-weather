import { useEffect, useRef } from 'react';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import { setPassageOverlay } from '../../stores/chartPassageOverlay';
import {
    isPassageHudEnabled,
    setPassageHudEnabled,
    setPassageHudOpen,
    stopPassageLookAhead,
} from '../../stores/passageHudStore';
import type { RadialHelmMenuProps } from './RadialHelmMenu';
import type { useWeatherLayers } from './useWeatherLayers';

type ChartSource = NonNullable<NonNullable<RadialHelmMenuProps['chartsState']>['sources']>[number];

interface PassageHudLayerArgs {
    isFollowing: boolean;
    routeCoords: ReadonlyArray<{ lat: number; lon: number }>;
    enabled: boolean;
    weather: Pick<ReturnType<typeof useWeatherLayers>, 'setLayerVisibility'>;
    setWeatherInspectMode: (visible: boolean) => void;
    closeWeatherInspect: () => void;
    setLightningVisible: (visible: boolean) => void;
    setCycloneVisible: (visible: boolean) => void;
    setSquallVisible: (visible: boolean) => void;
}

/** Reconcile fresh toggles and restored preferences once per enabled passage session. */
export function usePassageHudLayerActivation(args: PassageHudLayerArgs): void {
    const active = args.enabled && args.isFollowing && args.routeCoords.length >= 2;
    const activatedRef = useRef(false);
    useEffect(() => {
        if (!active) {
            activatedRef.current = false;
            return;
        }
        if (activatedRef.current) return;
        // Mark first: the setters below re-render MapHub. Later manual weather
        // choices must remain choices, not get reapplied by this effect.
        activatedRef.current = true;
        args.setWeatherInspectMode(false);
        args.closeWeatherInspect();
        // Wind excludes lightning; squall excludes the cyclone takeover.
        args.setLightningVisible(false);
        args.setCycloneVisible(false);
        args.weather.setLayerVisibility('wind', true);
        // Availability is the configured, permitted pipeline, not rainReady:
        // the existing rain loader only obtains its first frames after ON.
        if (!satelliteModeBlocks('raster')) {
            args.weather.setLayerVisibility('rain', true);
            if (import.meta.env.VITE_SUPABASE_URL) args.setSquallVisible(true);
        }
        setPassageOverlay(true);
        // Preserve the restored open/collapsed preference; only the FAB opens it.
    }, [active, args]);
}

/** One explicit entry into passage instruments and the weather around the followed Log route. */
export function passageHudLayerSources(args: PassageHudLayerArgs): ChartSource[] {
    if (!args.isFollowing || args.routeCoords.length < 2) return [];
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
