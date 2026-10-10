/**
 * navGridWorkerHost — the tracer's grids, off the main thread.
 *
 * `buildNavGridAsync(...)` mirrors buildNavGrid's signature but runs the heavy
 * build off the main thread (the 2026-07-15 sync-freeze crash fix). Since
 * 127-ROUTE-W2 it runs in a SECOND instance of the route worker
 * (services/routing/routeWorkerHost runGridJobHosted), the engine chunk
 * itself, so the bundle carries one copy of the grid code instead of two (the
 * navGrid worker's own build was 35,001 B), a tracer grid never waits behind a
 * route, and a route never waits behind a grid. The grid is built by the same
 * buildNavGrid, so it is the same grid, byte for byte
 * (tests/navGridFold.parity.test.ts).
 *
 * On ANYTHING going wrong (no Worker global, a spawn failure, a crash, a
 * thrown build, an un-postable message, or three crashes this session) it
 * FALLS BACK to the synchronous buildNavGrid on the main thread, as it always
 * has, so a trace always grades (the tracer has no "fast version" to hold,
 * unlike the glaze worker).
 */
import { ROUTE_ENGINE } from '../routing/routeJob';
import { runGridJobHosted } from '../routing/routeWorkerHost';
import type { InshoreLayers, NavGrid, RelaxZone } from './types';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('navGridWorkerHost');

export function buildNavGridAsync(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare = false,
    relaxZones: RelaxZone[] = [],
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect' = 'safest',
): Promise<NavGrid> {
    const runSync = (): NavGrid =>
        ROUTE_ENGINE.grid(
            layers,
            bbox,
            resolutionM,
            draftM,
            safetyM,
            obstructionBufferM,
            relaxedLndare,
            relaxZones,
            routeProfile,
        );

    const hosted = runGridJobHosted({
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
        routeProfile,
    });
    if (!hosted) return Promise.resolve(runSync());
    return hosted.catch((err: Error) => {
        // Any worker-side failure → synchronous fallback so grading never stalls.
        log.warn(`navGrid worker failed (${err.message}) — synchronous fallback`);
        return runSync();
    });
}
