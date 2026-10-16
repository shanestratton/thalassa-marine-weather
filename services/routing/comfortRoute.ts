import { computeIsochrones } from '../IsochroneRouter';
import { runComfortAttempts } from '../isochrone/comfortKernel';

/** The page and Worker share the same bounded wave-only retry policy. */
export function computeComfortIsochrones(
    ...args: Parameters<typeof computeIsochrones>
): ReturnType<typeof computeIsochrones> {
    return runComfortAttempts(computeIsochrones, ...args);
}
