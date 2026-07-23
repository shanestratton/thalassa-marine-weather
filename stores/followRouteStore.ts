/**
 * Follow Route Store — Zustand replacement for FollowRouteContext.
 *
 * Manages "Follow Route" mode: active route state, 3-hour weather
 * re-routing, change detection, and localStorage persistence.
 */

import { create } from 'zustand';
import type { VoyagePlan, Waypoint } from '../types';
import { generateSeaRoute } from '../utils/seaRoute';
import { createLogger } from '../utils/createLogger';
import { useSettingsStore } from './settingsStore';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const log = createLogger('FollowRoute');

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const STORAGE_KEY = 'thalassa_follow_route';
const WAYPOINT_CHANGE_THRESHOLD_KM = 2;

// ── Types ────────────────────────────────────────────────────────

export interface FollowRouteState {
    isFollowing: boolean;
    voyagePlan: VoyagePlan | null;
    routeCoords: { lat: number; lon: number }[];
    previousRouteCoords: { lat: number; lon: number }[];
    voyageId: string | null;
    startedAt: string | null;
    lastRefresh: string | null;
    routeChanged: boolean;
    changeDescription: string | null;
    isRefreshing: boolean;
}

interface FollowRouteActions {
    startFollowing: (plan: VoyagePlan, voyageId: string) => void;
    stopFollowing: () => void;
    refreshRoute: () => Promise<void>;
    acceptRouteChange: () => void;
    dismissRouteChange: () => void;
}

const INITIAL_STATE: FollowRouteState = {
    isFollowing: false,
    voyagePlan: null,
    routeCoords: [],
    previousRouteCoords: [],
    voyageId: null,
    startedAt: null,
    lastRefresh: null,
    routeChanged: false,
    changeDescription: null,
    isRefreshing: false,
};

// ── Helpers ────────────────────────────────────────────────────

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** A plan whose geometry came from the Route Tracer — the skipper validated
 *  the exact line, so it is locked against any downstream re-routing. */
function isTracedPlan(plan: VoyagePlan): boolean {
    return (plan.routeGeoJSON?.properties as Record<string, unknown> | null | undefined)?._source === 'route-tracer';
}

function computeRouteFromPlan(plan: VoyagePlan): { lat: number; lon: number }[] {
    // TRACED routes: the routeGeoJSON geometry is AUTHORITATIVE — the line
    // the skipper validated leg-by-leg must be followed exactly, never
    // re-derived from waypoints (Route Tracer prime directive #3: "the line
    // you validated is the line you sail"). Scoped to traced plans because
    // mergeWeatherRoute rewrites WAYPOINTS without touching routeGeoJSON —
    // preferring it unconditionally would show weather-refreshed planned
    // passages their STALE pre-optimisation line.
    const geo = plan.routeGeoJSON?.geometry?.coordinates;
    if (isTracedPlan(plan) && Array.isArray(geo) && geo.length >= 2) {
        return (geo as [number, number][]).map(([lon, lat]) => ({ lat, lon }));
    }
    const waypoints: { lat: number; lon: number }[] = [];
    if (plan.originCoordinates) waypoints.push(plan.originCoordinates);
    if (plan.waypoints && Array.isArray(plan.waypoints)) {
        plan.waypoints.forEach((wp) => {
            if (wp?.coordinates) waypoints.push(wp.coordinates);
        });
    }
    if (plan.destinationCoordinates) waypoints.push(plan.destinationCoordinates);
    if (waypoints.length < 2) return waypoints;
    try {
        return generateSeaRoute(waypoints);
    } catch {
        return waypoints;
    }
}

function diffRoutes(
    oldWaypoints: Waypoint[],
    newWaypoints: Waypoint[],
    oldOrigin?: { lat: number; lon: number },
    newOrigin?: { lat: number; lon: number },
    oldDest?: { lat: number; lon: number },
    newDest?: { lat: number; lon: number },
): { changed: boolean; description: string } {
    const changes: string[] = [];
    if (oldOrigin && newOrigin && haversineKm(oldOrigin, newOrigin) > WAYPOINT_CHANGE_THRESHOLD_KM) {
        changes.push('Departure point shifted');
    }
    if (oldDest && newDest && haversineKm(oldDest, newDest) > WAYPOINT_CHANGE_THRESHOLD_KM) {
        changes.push('Arrival point shifted');
    }
    if (oldWaypoints.length !== newWaypoints.length) {
        const diff = newWaypoints.length - oldWaypoints.length;
        changes.push(diff > 0 ? `${diff} new waypoint(s) added` : `${Math.abs(diff)} waypoint(s) removed`);
    }
    const minLen = Math.min(oldWaypoints.length, newWaypoints.length);
    let movedCount = 0;
    for (let i = 0; i < minLen; i++) {
        const oc = oldWaypoints[i]?.coordinates;
        const nc = newWaypoints[i]?.coordinates;
        if (oc && nc && haversineKm(oc, nc) > WAYPOINT_CHANGE_THRESHOLD_KM) movedCount++;
    }
    if (movedCount > 0) changes.push(`${movedCount} waypoint(s) repositioned due to weather`);
    for (let i = 0; i < minLen; i++) {
        const ow = oldWaypoints[i];
        const nw = newWaypoints[i];
        if (ow?.windSpeed && nw?.windSpeed && Math.abs((nw.windSpeed || 0) - (ow.windSpeed || 0)) >= 10) {
            changes.push(`Wind speeds changed significantly at WP-${i + 1}`);
            break;
        }
    }
    return { changed: changes.length > 0, description: changes.length > 0 ? changes.join('. ') + '.' : '' };
}

function storageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(STORAGE_KEY, scope);
}

function saveToStorage(state: FollowRouteState, scope: AuthIdentityScope = getAuthIdentityScope()) {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        const { isRefreshing, ...persist } = state;
        localStorage.setItem(storageKey(scope), JSON.stringify(persist));
    } catch {
        /* quota */
    }
}

/** A restored follow older than this is a zombie test sail, not a
 *  passage resume — mid-passage restarts are hours apart, never days
 *  (Shane 2026-07-11: a morning "Sail it" test kept painting its blue
 *  track + harbour dashes over the chart for days until manually
 *  cleared). Genuine multi-day passages refresh the route (lastRefresh
 *  bumps), so age off startedAt with a generous ceiling is safe. */
const FOLLOW_RESUME_MAX_AGE_MS = 7 * 24 * 3600_000;

function loadFromStorage(scope: AuthIdentityScope = getAuthIdentityScope()): FollowRouteState | null {
    try {
        // The legacy unscoped value has no durable owner marker. Do not
        // guess which skipper owns ports, timing and route geometry.
        const raw = localStorage.getItem(storageKey(scope));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed.isFollowing && parsed.voyagePlan) {
            const ageMs = Date.now() - new Date(parsed.startedAt ?? 0).getTime();
            if (!Number.isFinite(ageMs) || ageMs > FOLLOW_RESUME_MAX_AGE_MS) {
                clearStorage(scope); // zombie — drop rather than resume
                return null;
            }
            return { ...parsed, isRefreshing: false };
        }
    } catch {
        /* corrupted */
    }
    return null;
}

function clearStorage(scope: AuthIdentityScope = getAuthIdentityScope()) {
    try {
        localStorage.removeItem(storageKey(scope));
    } catch {
        /* best effort */
    }
}

// ── Store ────────────────────────────────────────────────────────

// Invalidates an in-flight weather refresh when the follow is stopped,
// replaced, or the authenticated identity changes.
let followMutationGeneration = 0;

export const useFollowRouteStore = create<FollowRouteState & FollowRouteActions>()((set, get) => ({
    ...(loadFromStorage() || INITIAL_STATE),

    startFollowing: (plan, voyageId) => {
        followMutationGeneration += 1;
        const scope = getAuthIdentityScope();
        log.info(`Starting follow mode: ${plan.origin} → ${plan.destination}`);
        const routeCoords = computeRouteFromPlan(plan);
        const newState: FollowRouteState = {
            isFollowing: true,
            voyagePlan: plan,
            routeCoords,
            previousRouteCoords: [],
            voyageId,
            startedAt: new Date().toISOString(),
            lastRefresh: new Date().toISOString(),
            routeChanged: false,
            changeDescription: null,
            isRefreshing: false,
        };
        set(newState);
        saveToStorage(newState, scope);
    },

    stopFollowing: () => {
        followMutationGeneration += 1;
        const scope = getAuthIdentityScope();
        log.info('Stopping follow mode');
        set(INITIAL_STATE);
        clearStorage(scope);
    },

    refreshRoute: async () => {
        const s = get();
        if (!s.isFollowing || !s.voyagePlan) return;
        const scope = getAuthIdentityScope();
        const refreshGeneration = followMutationGeneration;
        const refreshIsCurrent = () => {
            const current = get();
            return (
                isAuthIdentityScopeCurrent(scope) &&
                refreshGeneration === followMutationGeneration &&
                current.isFollowing &&
                current.startedAt === s.startedAt &&
                current.voyageId === s.voyageId
            );
        };

        // TRACED routes are GEOMETRY-LOCKED: the skipper validated that exact
        // line leg-by-leg, and the weather optimiser is allowed to move points
        // up to 30 NM off the centreline — running it here silently replaced a
        // validated trace with an unvalidated one (adversarial audit,
        // 2026-07-08). Weather refresh for traces is a timestamp-only no-op.
        if (isTracedPlan(s.voyagePlan)) {
            if (!refreshIsCurrent()) return;
            const newState: FollowRouteState = { ...get(), lastRefresh: new Date().toISOString(), isRefreshing: false };
            set(newState);
            saveToStorage(newState, scope);
            return;
        }
        set({ isRefreshing: true });

        try {
            let updatedPlan = { ...s.voyagePlan };
            try {
                const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                if (!refreshIsCurrent()) return;
                const vessel = useSettingsStore.getState().settings.vessel;
                if (vessel) {
                    updatedPlan = await enhanceVoyagePlanWithWeather(updatedPlan, vessel, updatedPlan.departureDate);
                }
            } catch (e) {
                log.warn('Weather re-routing failed:', e);
            }

            if (!refreshIsCurrent()) return;
            const { changed, description } = diffRoutes(
                s.voyagePlan.waypoints || [],
                updatedPlan.waypoints || [],
                s.voyagePlan.originCoordinates,
                updatedPlan.originCoordinates,
                s.voyagePlan.destinationCoordinates,
                updatedPlan.destinationCoordinates,
            );

            const newRouteCoords = computeRouteFromPlan(updatedPlan);
            const newState: FollowRouteState = {
                ...get(),
                voyagePlan: updatedPlan,
                previousRouteCoords: changed ? s.routeCoords : [],
                routeCoords: newRouteCoords,
                lastRefresh: new Date().toISOString(),
                routeChanged: changed,
                changeDescription: changed ? description : null,
                isRefreshing: false,
            };
            set(newState);
            saveToStorage(newState, scope);
            log.info(changed ? `Route changed: ${description}` : 'Route unchanged after refresh');
        } catch (err) {
            log.error('Route refresh failed:', err);
            if (refreshIsCurrent()) set({ isRefreshing: false });
        }
    },

    acceptRouteChange: () => {
        set({ previousRouteCoords: [], routeChanged: false, changeDescription: null });
        saveToStorage(get());
    },

    dismissRouteChange: () => {
        set({ routeChanged: false, changeDescription: null });
        saveToStorage(get());
    },
}));

// ── 3-hour auto-refresh timer ────────────────────────────────────
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

useFollowRouteStore.subscribe((state) => {
    if (_refreshTimer) {
        clearInterval(_refreshTimer);
        _refreshTimer = null;
    }
    if (state.isFollowing) {
        _refreshTimer = setInterval(() => {
            log.info('Auto-refreshing route weather (3h interval)');
            useFollowRouteStore.getState().refreshRoute();
        }, REFRESH_INTERVAL_MS);
    }
});

// Zustand stores live for the life of the app. Swap their complete data
// snapshot synchronously with authStore's identity fence so account B never
// renders account A's followed route, even during an offline transition.
subscribeAuthIdentityScope((next) => {
    followMutationGeneration += 1;
    useFollowRouteStore.setState(loadFromStorage(next) || INITIAL_STATE);
});
