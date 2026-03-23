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

function computeRouteFromPlan(plan: VoyagePlan): { lat: number; lon: number }[] {
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

function saveToStorage(state: FollowRouteState) {
    try {
        const { isRefreshing, ...persist } = state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
    } catch {
        /* quota */
    }
}

function loadFromStorage(): FollowRouteState | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed.isFollowing && parsed.voyagePlan) return { ...parsed, isRefreshing: false };
    } catch {
        /* corrupted */
    }
    return null;
}

function clearStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* best effort */
    }
}

// ── Store ────────────────────────────────────────────────────────

export const useFollowRouteStore = create<FollowRouteState & FollowRouteActions>()((set, get) => ({
    ...(loadFromStorage() || INITIAL_STATE),

    startFollowing: (plan, voyageId) => {
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
        saveToStorage(newState);
    },

    stopFollowing: () => {
        log.info('Stopping follow mode');
        set(INITIAL_STATE);
        clearStorage();
    },

    refreshRoute: async () => {
        const s = get();
        if (!s.isFollowing || !s.voyagePlan) return;
        set({ isRefreshing: true });

        try {
            let updatedPlan = { ...s.voyagePlan };
            try {
                const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                const vessel = JSON.parse(localStorage.getItem('thalassa_settings') || '{}')?.vessel;
                if (vessel) {
                    updatedPlan = await enhanceVoyagePlanWithWeather(updatedPlan, vessel, updatedPlan.departureDate);
                }
            } catch (e) {
                log.warn('Weather re-routing failed:', e);
            }

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
            saveToStorage(newState);
            log.info(changed ? `Route changed: ${description}` : 'Route unchanged after refresh');
        } catch (err) {
            log.error('Route refresh failed:', err);
            set({ isRefreshing: false });
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
