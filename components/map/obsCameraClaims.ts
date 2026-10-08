/**
 * Who has the chart camera: a flight or a framing the skipper asked for.
 *
 * Find-boat's flight, Locate me, and (build 124) a surface's 'Show on map'
 * (ENC library, ENC cell manager: useMapFitRequest) each tell the Obs startup
 * camera that the skipper has the camera now, so it stands down rather than
 * putting the chart back on the boat over what he asked to see. Told directly
 * rather than through the camera's own events: Mapbox fires no movestart for
 * a flight that begins while the camera is already easing (a layer's zoom
 * frame), and a framing applied while Obs is hidden fires nothing Obs hears.
 *
 * Dependency-free on purpose: useMapFitRequest must not pull the position
 * chain (obsCentre) in with it.
 */
import type mapboxgl from 'mapbox-gl';

const claims = new Set<(map: mapboxgl.Map) => void>();

/** Hear each claim on the camera, with the map it was made on. */
export function onObsCameraClaim(listener: (map: mapboxgl.Map) => void): () => void {
    claims.add(listener);
    return () => {
        claims.delete(listener);
    };
}

/** The skipper asked for this camera move (a flight, or a framing): Obs's own centring stands down. */
export function claimObsCamera(map: mapboxgl.Map): void {
    for (const listener of [...claims]) listener(map);
}
