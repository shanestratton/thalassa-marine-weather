/**
 * Inshore Router — the Pi's entry point to the app's routing engine.
 *
 * The engine is the phone's own (services/inshoreRouterEngine.ts and every
 * module it imports), copied into ../routerEngine/ by
 * scripts/sync-router-engine.mjs. Those files are generated: never edit them
 * here. Until 2026-10-04 this file was a hand-merged single-file copy, last
 * synced 2026-05-21; the engine has since grown to ~35 modules.
 *
 * To re-sync after an engine change on master (from the repo root):
 *   node pi-cache/scripts/sync-router-engine.mjs           # rewrite the copy
 *   node pi-cache/scripts/sync-router-engine.mjs --check   # exit 1 if it drifted
 * then build and test pi-cache, and stage a Pi deploy.
 * ROUTER_ENGINE_SYNCED_FROM says which app commit the copy came from.
 *
 * The phone routes on-device (CLOUD_ROUTER_ENABLED is false in
 * services/InshoreRouter.ts). The Pi keeps POST /api/enc/route and
 * /api/enc/route-prepped for external/CLI callers and a future cloud path.
 * This file adds one thing in front of the engine: the Pi's resource boundary,
 * as defence in depth for direct callers. The HTTP handlers check the same
 * boundary before they read any chart, and nothing here allocates a grid until
 * it passes.
 */
import { routeInshore as routeWithEngine } from '../routerEngine/services/inshoreRouterEngine.js';
import type {
    InshoreLayers,
    RouteFailure as EngineRouteFailure,
    RouteRequest,
    RouteResult,
} from '../routerEngine/services/inshoreRouterEngine.js';
import { validateInshoreRouteBoundary, type RouteBoundaryCode } from '../inshoreRouteBoundary.js';

export type {
    InshoreLayers,
    RouteDebug,
    RouteRequest,
    RouteResult,
    RelaxZone,
} from '../routerEngine/services/inshoreRouterEngine.js';
export { ROUTER_ENGINE_SYNCED_FROM } from '../routerEngine/syncedFrom.js';

/** The engine's failure, or the Pi boundary's refusal (checked first). */
export interface RouteFailure extends Omit<EngineRouteFailure, 'code'> {
    code?: EngineRouteFailure['code'] | RouteBoundaryCode;
}

export function routeInshore(layers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
    const boundaryIssue = validateInshoreRouteBoundary(req);
    if (boundaryIssue) return { error: boundaryIssue.error, code: boundaryIssue.code };
    return routeWithEngine(layers, req);
}
