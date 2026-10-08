/**
 * The chart camera's padding: none, once a surface is done with it (build
 * 124, Obs camera centring).
 *
 * Mapbox GL 3 keeps a camera call's `padding` on the map unless the call says
 * `retainPadding: false`, and every later flight that names no padding of its
 * own is centred inside it. Plan and Obs share one map, so Plan's route fit
 * (padded clear of its route card) put Obs's find-boat 130 pt right of the
 * centre, and shrank getBounds() to the strip right of the card (Shane
 * 2026-10-08: "when i click the locate fab, it goes to the first image which
 * is not centred").
 *
 * Every padded camera call says `retainPadding: false` now
 * (tests/cameraPaddingGuard.test.ts). This clears whatever is left anyway,
 * when Obs shows and before each Obs move.
 */
import type mapboxgl from 'mapbox-gl';

export const NO_CAMERA_PADDING = { top: 0, right: 0, bottom: 0, left: 0 } as const;

/**
 * Give the chart its whole canvas back. Touches the camera only when a side
 * is padded (setPadding is a jump: it fires move events, with no
 * originalEvent, so nothing takes it for the skipper's gesture). True when
 * it cleared something.
 */
export function clearCameraPadding(map: mapboxgl.Map): boolean {
    try {
        const padding = typeof map.getPadding === 'function' ? map.getPadding() : null;
        if (!padding || !(padding.top || padding.right || padding.bottom || padding.left)) return false;
        map.setPadding({ ...NO_CAMERA_PADDING });
        return true;
    } catch {
        return false; // the map went away meanwhile
    }
}
