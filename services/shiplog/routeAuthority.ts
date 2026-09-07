/**
 * routeAuthority — who may replace the followed route another device set.
 *
 * Ships DARK behind the `routeAuthority` setting (no UI yet). Default
 * 'confirm': any device on the account may replace, after a centred confirm
 * that names the device whose route stands. 'skipper' is Shane's "the
 * skipper's device is god" (2026-09-08): the device holding the skipper claim
 * replaces without asking, every other device is told the route is the
 * skipper's to change. Switching it on is Shane's call — no new hard gates
 * without his yes (memory: Cast Off is advisory).
 */
import { useSettingsStore } from '../../stores/settingsStore';
import { holdsClaim } from '../skipperDevice';

export type RouteAuthorityMode = 'confirm' | 'skipper';
export type RouteReplaceDecision = 'confirm' | 'replace' | 'refuse';

export const ROUTE_AUTHORITY_DEFAULT: RouteAuthorityMode = 'confirm';

/** Pure: mode + whether THIS device holds the skipper claim → what to do. */
export function routeReplaceDecision(
    mode: RouteAuthorityMode | undefined,
    holdsSkipperClaim: boolean,
): RouteReplaceDecision {
    if (mode === 'skipper') return holdsSkipperClaim ? 'replace' : 'refuse';
    return 'confirm';
}

export function currentRouteAuthorityMode(): RouteAuthorityMode {
    const mode = useSettingsStore.getState().settings.routeAuthority;
    return mode === 'skipper' ? 'skipper' : ROUTE_AUTHORITY_DEFAULT;
}

/** The decision for this device, right now. */
export function currentRouteReplaceDecision(): RouteReplaceDecision {
    const claim = useSettingsStore.getState().settings.skipperDevice ?? null;
    return routeReplaceDecision(currentRouteAuthorityMode(), holdsClaim(claim));
}

export const ROUTE_AUTHORITY_REFUSAL = "Only the skipper's device can change the published route.";
