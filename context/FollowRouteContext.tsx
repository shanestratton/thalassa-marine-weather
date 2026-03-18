/**
 * FollowRouteContext — Global state for "Follow Route" mode.
 *
 * When a user activates follow-route from a planned route in the logbook,
 * this context stores the active route, renders overlays on all maps,
 * and auto-refreshes weather every 3 hours with change detection.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { VoyagePlan, Waypoint } from '../types';
import { generateSeaRoute } from '../utils/seaRoute';
import { createLogger } from '../utils/createLogger';

const log = createLogger('FollowRoute');

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const STORAGE_KEY = 'thalassa_follow_route';
const WAYPOINT_CHANGE_THRESHOLD_KM = 2; // 2km drift = significant change

// ── Types ──────────────────────────────────────────────────────

export interface FollowRouteState {
    isFollowing: boolean;
    voyagePlan: VoyagePlan | null;
    routeCoords: { lat: number; lon: number }[];
    previousRouteCoords: { lat: number; lon: number }[]; // old route (gray) when changed
    voyageId: string | null;
    startedAt: string | null;
    lastRefresh: string | null;
    routeChanged: boolean;
    changeDescription: string | null;
    isRefreshing: boolean;
}

interface FollowRouteContextValue extends FollowRouteState {
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

    // Check origin shift
    if (oldOrigin && newOrigin && haversineKm(oldOrigin, newOrigin) > WAYPOINT_CHANGE_THRESHOLD_KM) {
        changes.push('Departure point shifted');
    }

    // Check destination shift
    if (oldDest && newDest && haversineKm(oldDest, newDest) > WAYPOINT_CHANGE_THRESHOLD_KM) {
        changes.push('Arrival point shifted');
    }

    // Check waypoint count
    if (oldWaypoints.length !== newWaypoints.length) {
        const diff = newWaypoints.length - oldWaypoints.length;
        changes.push(diff > 0 ? `${diff} new waypoint(s) added` : `${Math.abs(diff)} waypoint(s) removed`);
    }

    // Check individual waypoint drift
    const minLen = Math.min(oldWaypoints.length, newWaypoints.length);
    let movedCount = 0;
    for (let i = 0; i < minLen; i++) {
        const oc = oldWaypoints[i]?.coordinates;
        const nc = newWaypoints[i]?.coordinates;
        if (oc && nc && haversineKm(oc, nc) > WAYPOINT_CHANGE_THRESHOLD_KM) {
            movedCount++;
        }
    }
    if (movedCount > 0) {
        changes.push(`${movedCount} waypoint(s) repositioned due to weather`);
    }

    // Check weather condition changes
    for (let i = 0; i < minLen; i++) {
        const ow = oldWaypoints[i];
        const nw = newWaypoints[i];
        if (ow?.windSpeed && nw?.windSpeed) {
            const diff = Math.abs((nw.windSpeed || 0) - (ow.windSpeed || 0));
            if (diff >= 10) {
                changes.push(`Wind speeds changed significantly at WP-${i + 1}`);
                break;
            }
        }
    }

    return {
        changed: changes.length > 0,
        description: changes.length > 0 ? changes.join('. ') + '.' : '',
    };
}

// ── Persistence ────────────────────────────────────────────────

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
        if (parsed.isFollowing && parsed.voyagePlan) {
            return { ...parsed, isRefreshing: false };
        }
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

// ── Context ────────────────────────────────────────────────────

const FollowRouteContext = createContext<FollowRouteContextValue | null>(null);

export const useFollowRoute = (): FollowRouteContextValue => {
    const ctx = useContext(FollowRouteContext);
    if (!ctx) throw new Error('useFollowRoute must be used within FollowRouteProvider');
    return ctx;
};

export const FollowRouteProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [state, setState] = useState<FollowRouteState>(() => {
        return loadFromStorage() || INITIAL_STATE;
    });

    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // ── Persist on change ──
    useEffect(() => {
        if (state.isFollowing) {
            saveToStorage(state);
        }
    }, [state]);

    // ── Start Following ──
    const startFollowing = useCallback((plan: VoyagePlan, voyageId: string) => {
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
        setState(newState);
    }, []);

    // ── Stop Following ──
    const stopFollowing = useCallback(() => {
        log.info('Stopping follow mode');
        setState(INITIAL_STATE);
        clearStorage();
    }, []);

    // ── Refresh Route (weather re-routing) ──
    const refreshRoute = useCallback(async () => {
        if (!state.isFollowing || !state.voyagePlan) return;

        setState((s) => ({ ...s, isRefreshing: true }));
        const plan = state.voyagePlan;

        try {
            let updatedPlan = { ...plan };

            // Step 1: Re-run weather routing
            try {
                const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                const vessel = JSON.parse(localStorage.getItem('thalassa_settings') || '{}')?.vessel;
                if (vessel) {
                    updatedPlan = await enhanceVoyagePlanWithWeather(updatedPlan, vessel, updatedPlan.departureDate);
                }
            } catch (e) {
                log.warn('Weather re-routing failed:', e);
            }

            // Step 2: Diff old vs new
            const { changed, description } = diffRoutes(
                plan.waypoints || [],
                updatedPlan.waypoints || [],
                plan.originCoordinates,
                updatedPlan.originCoordinates,
                plan.destinationCoordinates,
                updatedPlan.destinationCoordinates,
            );

            const newRouteCoords = computeRouteFromPlan(updatedPlan);

            setState((s) => ({
                ...s,
                voyagePlan: updatedPlan,
                previousRouteCoords: changed ? s.routeCoords : [],
                routeCoords: newRouteCoords,
                lastRefresh: new Date().toISOString(),
                routeChanged: changed,
                changeDescription: changed ? description : null,
                isRefreshing: false,
            }));

            if (changed) {
                log.info('Route changed after weather refresh:', description);
            } else {
                log.info('Route unchanged after weather refresh');
            }
        } catch (err) {
            log.error('Route refresh failed:', err);
            setState((s) => ({ ...s, isRefreshing: false }));
        }
    }, [state.isFollowing, state.voyagePlan]);

    // ── Accept route change (user acknowledges + switches to new route) ──
    const acceptRouteChange = useCallback(() => {
        setState((s) => ({
            ...s,
            previousRouteCoords: [],
            routeChanged: false,
            changeDescription: null,
        }));
    }, []);

    // ── Dismiss route change notification (keep showing both routes) ──
    const dismissRouteChange = useCallback(() => {
        setState((s) => ({
            ...s,
            routeChanged: false,
            changeDescription: null,
        }));
    }, []);

    // ── 3-hour auto-refresh timer ──
    useEffect(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }

        if (state.isFollowing) {
            timerRef.current = setInterval(() => {
                log.info('Auto-refreshing route weather (3h interval)');
                refreshRoute();
            }, REFRESH_INTERVAL_MS);
        }

        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [state.isFollowing, refreshRoute]);

    const value: FollowRouteContextValue = {
        ...state,
        startFollowing,
        stopFollowing,
        refreshRoute,
        acceptRouteChange,
        dismissRouteChange,
    };

    return <FollowRouteContext.Provider value={value}>{children}</FollowRouteContext.Provider>;
};
