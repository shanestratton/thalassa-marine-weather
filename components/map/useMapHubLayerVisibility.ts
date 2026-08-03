/**
 * useMapHubLayerVisibility — MapHub's browse-layer visibility state: the
 * per-layer toggles (AIS / chokepoint / cyclone / squall / vessel tracking /
 * seamark / anchorage / tide stations / lightning), the MOB highlight flag,
 * the storm picker + active-cyclone catalogue, the storm-select handler, and
 * the `browse*` derivations that gate every layer off planning surfaces.
 *
 * Extracted verbatim from MapHub.tsx as part of the MapHub decomposition.
 * Closure captures became parameters; no logic changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { usePersistedState } from '../../hooks/usePersistedState';
import { MobService } from '../../services/MobService';
import { useActiveCyclones } from './useActiveCyclones';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';

export function useMapHubLayerVisibility({
    mapRef,
    planningSurface,
}: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    planningSurface: boolean;
}) {
    // Map state persisted across Charts tab switches so the user comes
    // back to exactly what they left on. Time-critical overlays that
    // are meant to be session-only (cyclone / squall / weather inspect)
    // deliberately stay as plain useState.
    const [aisVisible, setAisVisible] = usePersistedState('thalassa_map_ais_visible', false);
    const [chokepointVisible, setChokepointVisible] = usePersistedState('thalassa_map_chokepoint_visible', false);
    const [cycloneVisible, setCycloneVisible] = useState(false);
    const [squallVisible, setSquallVisible] = useState(false);
    // Vessel tracking now defaults to TRUE so a new user always sees
    // their own boat on the chart from the first frame — without having
    // to discover the toggle in the radial menu. Existing users who
    // explicitly turned it off keep their preference (usePersistedState
    // reads localStorage first). Toggle still works to dim down to the
    // simpler GPS dot via useLocationDot.
    const [vesselTrackingVisible] = usePersistedState('thalassa_map_vessel_tracking_visible', true);
    const [seamarkVisible, setSeamarkVisible] = usePersistedState('thalassa_map_seamark_visible', false);
    const [anchorageVisible, setAnchorageVisible] = usePersistedState('thalassa_map_anchorage_visible', false);
    // Active-MOB flag for the radial menu's MOB item highlight. MobService
    // emits ~1 Hz while active; setState with an unchanged boolean bails
    // before re-render, so this costs nothing in steady state.
    const [mobActive, setMobActive] = useState<boolean>(() => MobService.isActive());
    useEffect(() => MobService.subscribe((s) => setMobActive(s.active !== null)), []);
    const [tideStationsVisible, setTideStationsVisible] = usePersistedState(
        'thalassa_map_tide_stations_visible',
        false,
    );
    const [lightningVisible, setLightningVisible] = usePersistedState('thalassa_map_lightning_visible', false);

    const [closestStorm, setClosestStorm] = useState<ActiveCyclone | null>(null);
    const skipAutoFlyRef = useRef(false);
    // Storm picker modal — opens when the user taps Storms in the radial menu
    // AND there are multiple active cyclones to choose from.
    const [stormPickerOpen, setStormPickerOpen] = useState(false);
    const { cyclones: allCyclones } = useActiveCyclones(
        !planningSurface && (cycloneVisible || squallVisible || stormPickerOpen),
    );
    // The catalogue is now demand-loaded. Remember a skipper's first Storms
    // tap while it arrives, so multiple systems still open the chooser on that
    // same tap rather than making them tap the radial control again.
    const cyclonePickerPendingRef = useRef(false);
    useEffect(() => {
        if (!cyclonePickerPendingRef.current || !cycloneVisible || allCyclones.length <= 1) return;
        cyclonePickerPendingRef.current = false;
        setStormPickerOpen(true);
    }, [allCyclones.length, cycloneVisible]);

    // Handle storm selection from the picker menu
    const handleSelectStorm = useCallback(
        (storm: ActiveCyclone) => {
            // Signal useCycloneLayer to skip its auto-fly on the next load.
            // We handle the flyTo here to the user-selected storm.
            skipAutoFlyRef.current = true;
            if (!cycloneVisible) setCycloneVisible(true);
            setSquallVisible(false); // Mutually exclusive with squall
            setClosestStorm(storm);
            const map = mapRef.current;
            if (map) {
                map.flyTo({
                    center: [storm.currentPosition.lon, storm.currentPosition.lat],
                    zoom: 4,
                    duration: 2000,
                    essential: true,
                });
            }
        },
        [mapRef, cycloneVisible],
    );

    const browseAisVisible = aisVisible && !planningSurface;
    const browseChokepointVisible = chokepointVisible && !planningSurface;
    const browseCycloneVisible = cycloneVisible && !planningSurface;
    const browseSquallVisible = squallVisible && !planningSurface;
    const browseSeamarkVisible = seamarkVisible && !planningSurface;
    const browseAnchorageVisible = anchorageVisible && !planningSurface;
    const browseTideStationsVisible = tideStationsVisible && !planningSurface;
    const browseLightningVisible = lightningVisible && !planningSurface;

    return {
        aisVisible,
        setAisVisible,
        chokepointVisible,
        setChokepointVisible,
        cycloneVisible,
        setCycloneVisible,
        squallVisible,
        setSquallVisible,
        vesselTrackingVisible,
        seamarkVisible,
        setSeamarkVisible,
        anchorageVisible,
        setAnchorageVisible,
        mobActive,
        tideStationsVisible,
        setTideStationsVisible,
        lightningVisible,
        setLightningVisible,
        closestStorm,
        setClosestStorm,
        skipAutoFlyRef,
        stormPickerOpen,
        setStormPickerOpen,
        allCyclones,
        cyclonePickerPendingRef,
        handleSelectStorm,
        browseAisVisible,
        browseChokepointVisible,
        browseCycloneVisible,
        browseSquallVisible,
        browseSeamarkVisible,
        browseAnchorageVisible,
        browseTideStationsVisible,
        browseLightningVisible,
    };
}
