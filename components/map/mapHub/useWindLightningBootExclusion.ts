/**
 * The boot-time wind/lightning exclusion — moved out of MapHub.tsx verbatim.
 */
import { useEffect, useRef } from 'react';
import type { WeatherLayer } from '../mapConstants';

export function useWindLightningBootExclusion(
    mapReady: boolean,
    planningSurface: boolean,
    lightningVisible: boolean,
    activeLayers: ReadonlySet<WeatherLayer>,
    setLightningVisible: (visible: boolean) => void,
): void {
    // Resolve the wind/lightning exclusion ONCE AT BOOT.
    //
    // The toggle handlers enforce it going forward, but they only fire when
    // something is tapped — and lightningVisible is PERSISTED
    // ('thalassa_map_lightning_visible') while wind is on by default. So a
    // session that ever left lightning on came back with both up, which is the
    // state Shane screenshotted on 2026-07-22 minutes after the exclusion
    // landed. A rule enforced only on transitions is not a rule.
    //
    // Wind wins: it is the default overlay and the one the model chips and
    // scrubber below are driving. Lightning is one tap away.
    const bootExclusionRef = useRef(false);
    useEffect(() => {
        // A Plan-owned MapHub must never resolve a Chart preference conflict:
        // doing so would mutate persisted browsing state from a surface where
        // neither layer is even rendered. Defer the one-shot until this map is
        // genuinely back in Chart browsing mode.
        if (!mapReady || planningSurface || bootExclusionRef.current) return;
        bootExclusionRef.current = true;
        if (lightningVisible && (activeLayers.has('wind') || activeLayers.has('velocity'))) {
            setLightningVisible(false);
        }
        // Boot-only: deps deliberately exclude the values it reads, so a later
        // legitimate toggle is not undone by this effect re-running.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, planningSurface]);
}
