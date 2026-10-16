/** Offshore API wrapper: preserve the existing main-thread public depth query and progress event. */
import { GebcoDepthService } from './GebcoDepthService';
import { computeOffshoreKernel } from './isochrone/offshoreKernel';
export type {
    WindField,
    CurrentField,
    ExclusionField,
    WaveField,
    IsochroneConfig,
    IsochroneNode,
    Isochrone,
    IsochroneResult,
    TurnWaypoint,
} from './isochrone/types';
export { DEFAULT_ISOCHRONE_CONFIG } from './isochrone/types';
export { isochroneToGeoJSON, detectTurnWaypoints } from './isochrone/output';
export { _testableInternals } from './isochrone/offshoreKernel';
type Args = Parameters<typeof computeOffshoreKernel>;
export function computeIsochrones(
    origin: Args[0],
    destination: Args[1],
    departureTime: Args[2],
    polar: Args[3],
    windField: Args[4],
    config: Args[5] = {},
    bathyGrid?: Args[6],
    currentField?: Args[7],
    exclusionField?: Args[8],
    waveField?: Args[9],
): ReturnType<typeof computeOffshoreKernel> {
    return computeOffshoreKernel(
        origin,
        destination,
        departureTime,
        polar,
        windField,
        config,
        bathyGrid,
        currentField,
        exclusionField,
        waveField,
        {
            queryDepths: (points) => GebcoDepthService.queryDepths(points),
            progress: (detail) => {
                try {
                    window.dispatchEvent(new CustomEvent('thalassa:isochrone-progress', { detail }));
                } catch {
                    /* No page progress surface. */
                }
            },
        },
    );
}
