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
import { MobService } from '../../services/MobService';
import { isBlitzortungEnabled } from '../../services/weather/api/lightningLicence';
import { useActiveCyclones } from './useActiveCyclones';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';

export function useMapHubLayerVisibility({
    mapRef,
    planningSurface,
}: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    planningSurface: boolean;
}) {
    // OBS starts clean on each fresh map. The app keeps this map alive across
    // tab switches, so deliberate toggles still survive ordinary navigation.
    // Never restore yesterday's overlays from device storage.
    const [aisVisible, setAisVisible] = useState(false);
    const [chokepointVisible, setChokepointVisible] = useState(false);
    const [cycloneVisible, setCycloneVisible] = useState(false);
    const [squallVisible, setSquallVisible] = useState(false);
    // Ownship is the one thing the clean starting view must show.
    const vesselTrackingVisible = true;
    const [seamarkVisible, setSeamarkVisible] = useState(false);
    const [anchorageVisible, setAnchorageVisible] = useState(false);
    const [mooringsVisible, setMooringsVisible] = useState(false);
    // Active-MOB flag for the radial menu's MOB item highlight. MobService
    // emits ~1 Hz while active; setState with an unchanged boolean bails
    // before re-render, so this costs nothing in steady state.
    const [mobActive, setMobActive] = useState<boolean>(() => MobService.isActive());
    useEffect(() => MobService.subscribe((s) => setMobActive(s.active !== null)), []);
    const [tideStationsVisible, setTideStationsVisible] = useState(false);
    const [lightningVisible, setLightningVisible] = useState(false);

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
    const browseMooringsVisible = mooringsVisible && !planningSurface;
    const browseTideStationsVisible = tideStationsVisible && !planningSurface;
    // The flag first: only its menu item can turn lightning on, and a build
    // with it off then drops the strike layer's credit strip as well.
    const browseLightningVisible = isBlitzortungEnabled() && lightningVisible && !planningSurface;

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
        mooringsVisible,
        setMooringsVisible,
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
        browseMooringsVisible,
        browseTideStationsVisible,
        browseLightningVisible,
    };
}
