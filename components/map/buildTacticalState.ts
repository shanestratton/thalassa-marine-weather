/**
 * buildTacticalState — pure builder for RadialHelmMenu's `tacticalState` prop.
 *
 * Extracted verbatim from MapHub.tsx (the inline `tacticalState={{...}}` JSX
 * object literal) as part of the MapHub decomposition. Closure captures became
 * the `deps` parameter; no logic changes.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { RadialHelmMenuProps } from './RadialHelmMenu';
import type { useWeatherLayers } from './useWeatherLayers';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { isMpaEnabled } from './useMpaLayer';

export interface BuildTacticalStateDeps {
    aisVisible: boolean;
    setAisVisible: Dispatch<SetStateAction<boolean>>;
    cycloneVisible: boolean;
    setCycloneVisible: Dispatch<SetStateAction<boolean>>;
    squallVisible: boolean;
    setSquallVisible: Dispatch<SetStateAction<boolean>>;
    allCyclones: ActiveCyclone[];
    cyclonePickerPendingRef: MutableRefObject<boolean>;
    setStormPickerOpen: Dispatch<SetStateAction<boolean>>;
    setChokepointVisible: Dispatch<SetStateAction<boolean>>;
    seamarkVisible: boolean;
    setSeamarkVisible: Dispatch<SetStateAction<boolean>>;
    tideStationsVisible: boolean;
    setTideStationsVisible: Dispatch<SetStateAction<boolean>>;
    anchorageVisible: boolean;
    setAnchorageVisible: Dispatch<SetStateAction<boolean>>;
    lightningVisible: boolean;
    setLightningVisible: Dispatch<SetStateAction<boolean>>;
    weatherInspectMode: boolean;
    setWeatherInspectMode: Dispatch<SetStateAction<boolean>>;
    weather: Pick<
        ReturnType<typeof useWeatherLayers>,
        'setActiveLayer' | 'activeLayers' | 'toggleLayer' | 'mpaVisible' | 'setMpaVisible'
    >;
    mobActive: boolean;
    setPage: (page: string) => void;
}

export function buildTacticalState(deps: BuildTacticalStateDeps): NonNullable<RadialHelmMenuProps['tacticalState']> {
    const {
        aisVisible,
        setAisVisible,
        cycloneVisible,
        setCycloneVisible,
        squallVisible,
        setSquallVisible,
        allCyclones,
        cyclonePickerPendingRef,
        setStormPickerOpen,
        setChokepointVisible,
        seamarkVisible,
        setSeamarkVisible,
        tideStationsVisible,
        setTideStationsVisible,
        anchorageVisible,
        setAnchorageVisible,
        lightningVisible,
        setLightningVisible,
        weatherInspectMode,
        setWeatherInspectMode,
        weather,
        mobActive,
        setPage,
    } = deps;

    return {
        aisVisible,
        onToggleAis: () => {
            setAisVisible((v) => {
                if (!v) {
                    setSquallVisible(false);
                    setCycloneVisible(false);
                }
                return !v;
            });
        },
        cycloneVisible,
        onToggleCyclones: () => {
            // When MULTIPLE cyclones are active, open the picker modal
            // instead of just toggling — otherwise the user has no way
            // to switch between storms (previous behaviour auto-focused
            // only the closest one). With 0 or 1 storms, fall back to
            // the simple toggle.
            if (allCyclones.length > 1) {
                cyclonePickerPendingRef.current = false;
                setStormPickerOpen(true);
                // Also enable the layer if it's off so the picked storm
                // becomes visible immediately.
                if (!cycloneVisible) {
                    setCycloneVisible(true);
                    setSquallVisible(false);
                    setAisVisible(false);
                    setChokepointVisible(false);
                    setSeamarkVisible(false);
                    setTideStationsVisible(false);
                    setWeatherInspectMode(false);
                    weather.setActiveLayer('none');
                }
                return;
            }
            // Single- or zero-storm case — plain toggle (existing behaviour)
            const willBeVisible = !cycloneVisible;
            cyclonePickerPendingRef.current = willBeVisible;
            setCycloneVisible(willBeVisible);
            if (willBeVisible) {
                setSquallVisible(false);
                setAisVisible(false);
                setChokepointVisible(false);
                setSeamarkVisible(false);
                setTideStationsVisible(false);
                setWeatherInspectMode(false);
                weather.setActiveLayer('none');
            }
        },
        squallVisible,
        onToggleSquall: () => {
            const willBeVisible = !squallVisible;
            setSquallVisible(willBeVisible);
            if (willBeVisible) {
                setCycloneVisible(false);
                setAisVisible(false);
                setChokepointVisible(false);
                setSeamarkVisible(false);
                setTideStationsVisible(false);
                setWeatherInspectMode(false);
                weather.setActiveLayer('none');
            }
        },
        lightningVisible,
        onToggleLightning: () => {
            const next = !lightningVisible;
            // The other half of the wind/lightning exclusion
            // wired on toggleLayer above. 'velocity' is a
            // legacy alias for the same overlay, so both
            // keys have to be cleared or the particles
            // survive under a different name.
            if (next) {
                if (weather.activeLayers.has('wind')) weather.toggleLayer('wind');
                if (weather.activeLayers.has('velocity')) weather.toggleLayer('velocity');
            }
            setLightningVisible(next);
        },
        weatherInspectMode,
        onToggleWeatherInspect: () => {
            setWeatherInspectMode((v) => {
                if (!v) {
                    setSquallVisible(false);
                    setCycloneVisible(false);
                }
                return !v;
            });
        },
        seamarkVisible,
        onToggleSeamark: () => {
            setSeamarkVisible((v) => {
                if (!v) {
                    setSquallVisible(false);
                    setCycloneVisible(false);
                }
                return !v;
            });
        },
        tideStationsVisible,
        onToggleTideStations: () => {
            setTideStationsVisible((v) => {
                if (!v) {
                    setSquallVisible(false);
                    setCycloneVisible(false);
                }
                return !v;
            });
        },
        anchorageVisible,
        onToggleAnchorage: () => setAnchorageVisible((v) => !v),
        onOpenWeatherWindow: () => setPage('weatherWindow'),
        mobActive,
        onOpenMob: () => setPage('mob'),
        // Marine Protected Areas — only surface in the
        // radial menu when the feature flag is on, so
        // the button doesn't taunt users on builds
        // without the data pipeline live yet.
        ...(isMpaEnabled()
            ? {
                  mpaVisible: weather.mpaVisible,
                  onToggleMpa: () => weather.setMpaVisible(!weather.mpaVisible),
              }
            : {}),
    };
}
