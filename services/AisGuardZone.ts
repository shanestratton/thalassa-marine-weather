/**
 * AisGuardZone — Virtual radar guard zone for collision avoidance.
 *
 * Monitors AIS targets against a configurable radius around own vessel.
 * When any target enters the zone, triggers a haptic + visual alert.
 *
 * State persisted in localStorage for session continuity.
 */

import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

const STORAGE_KEY = 'thalassa_guard_zone';
const STORAGE_VERSION = 2;
const DEFAULT_RADIUS_NM = 2;

export interface GuardAlert {
    mmsi: number;
    name: string;
    distanceNm: number;
    bearing: number;
    sog: number;
    cog: number;
    shipType: string;
    timestamp: number;
}

export interface GuardZoneState {
    enabled: boolean;
    radiusNm: number;
    alerts: GuardAlert[];
}

type Listener = (state: GuardZoneState) => void;

interface PersistedGuardZone {
    version: typeof STORAGE_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    enabled: boolean;
    radiusNm: number;
}

function defaultState(): GuardZoneState {
    return { enabled: false, radiusNm: DEFAULT_RADIUS_NM, alerts: [] };
}

function cloneState(state: GuardZoneState): GuardZoneState {
    return { ...state, alerts: state.alerts.map((alert) => ({ ...alert })) };
}

function clampRadius(radiusNm: number): number {
    if (!Number.isFinite(radiusNm)) return DEFAULT_RADIUS_NM;
    return Math.max(0.1, Math.min(50, radiusNm));
}

// ── Haversine distance (NM) ──
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const DEG = Math.PI / 180;
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065;
}

function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const DEG = Math.PI / 180;
    const dLon = (lon2 - lon1) * DEG;
    const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
    const x =
        Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
    return (Math.atan2(y, x) / DEG + 360) % 360;
}

// ── Singleton state ──

/**
 * Keep each identity's configuration separate in memory. Enabled zones stay
 * in this map across auth transitions so an account switch cannot silently
 * disarm a collision watch that is already protecting the physical vessel.
 * Only the current identity's state is exposed through getState/subscribe.
 */
const statesByOwnerKey = new Map<string, GuardZoneState>();
const activeAlertMmsisByOwnerKey = new Map<string, Set<number>>();
const listeners = new Set<Listener>();

function loadState(scope: AuthIdentityScope): GuardZoneState {
    try {
        // The historic global key is intentionally ignored. It has no owner
        // attribution, so restoring it could expose another skipper's config.
        const saved = localStorage.getItem(authScopedStorageKey(STORAGE_KEY, scope));
        if (!saved) return defaultState();

        const parsed = JSON.parse(saved) as Partial<PersistedGuardZone>;
        if (
            parsed.version !== STORAGE_VERSION ||
            parsed.ownerKey !== scope.key ||
            parsed.ownerUserId !== scope.userId ||
            typeof parsed.enabled !== 'boolean' ||
            typeof parsed.radiusNm !== 'number' ||
            !Number.isFinite(parsed.radiusNm)
        ) {
            localStorage.removeItem(authScopedStorageKey(STORAGE_KEY, scope));
            return defaultState();
        }

        return {
            enabled: parsed.enabled,
            radiusNm: clampRadius(parsed.radiusNm),
            alerts: [], // Alerts are intentionally process-local.
        };
    } catch {
        return defaultState();
    }
}

function ensureState(scope: AuthIdentityScope = getAuthIdentityScope()): GuardZoneState {
    const existing = statesByOwnerKey.get(scope.key);
    if (existing) return existing;

    const loaded = loadState(scope);
    statesByOwnerKey.set(scope.key, loaded);
    activeAlertMmsisByOwnerKey.set(scope.key, new Set());
    return loaded;
}

function persist(scope: AuthIdentityScope): void {
    const state = statesByOwnerKey.get(scope.key);
    if (!state) return;
    const persisted: PersistedGuardZone = {
        version: STORAGE_VERSION,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        enabled: state.enabled,
        radiusNm: state.radiusNm,
    };
    try {
        localStorage.setItem(authScopedStorageKey(STORAGE_KEY, scope), JSON.stringify(persisted));
    } catch {
        /* Storage is best effort; the active in-memory safety watch continues. */
    }
}

function notify(): void {
    const visibleState = cloneState(ensureState());
    listeners.forEach((fn) => {
        try {
            fn(cloneState(visibleState));
        } catch {
            // One UI listener must not prevent the remaining safety displays
            // from receiving an identity transition or collision alert.
        }
    });
}

ensureState();
subscribeAuthIdentityScope((next) => {
    // Load/hide synchronously before account B can render account A's config.
    ensureState(next);
    notify();
});

// ── Public API ──

export const AisGuardZone = {
    getState(): GuardZoneState {
        return cloneState(ensureState());
    },

    setEnabled(enabled: boolean, expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!isAuthIdentityScopeCurrent(expectedScope)) return;
        let state = ensureState(expectedScope);
        state = { ...state, enabled };
        if (!enabled) {
            state.alerts = [];
            activeAlertMmsisByOwnerKey.get(expectedScope.key)?.clear();
        }
        statesByOwnerKey.set(expectedScope.key, state);
        persist(expectedScope);
        notify();
    },

    setRadius(radiusNm: number, expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!isAuthIdentityScopeCurrent(expectedScope)) return;
        const state = ensureState(expectedScope);
        statesByOwnerKey.set(expectedScope.key, { ...state, radiusNm: clampRadius(radiusNm) });
        persist(expectedScope);
        notify();
    },

    /**
     * Check AIS features against the guard zone.
     * Called from useAisStreamLayer on every merge cycle.
     * Returns new alerts (vessels that just entered the zone).
     */
    checkFeatures(ownLat: number, ownLon: number, features: GeoJSON.Feature[]): GuardAlert[] {
        if (
            !Number.isFinite(ownLat) ||
            ownLat < -90 ||
            ownLat > 90 ||
            !Number.isFinite(ownLon) ||
            ownLon < -180 ||
            ownLon > 180
        ) {
            return [];
        }

        const returnedAlerts = new Map<number, GuardAlert>();
        let visibleStateChanged = false;
        const currentScope = getAuthIdentityScope();

        for (const [ownerKey, existingState] of statesByOwnerKey) {
            if (!existingState.enabled) continue;

            const newAlerts: GuardAlert[] = [];
            const currentMmsis = new Set<number>();
            const activeAlertMmsis = activeAlertMmsisByOwnerKey.get(ownerKey) ?? new Set<number>();
            activeAlertMmsisByOwnerKey.set(ownerKey, activeAlertMmsis);

            for (const feat of features) {
                const p = feat.properties;
                if (!p) continue;

                // Skip own vessel (local NMEA) and stale ghosts
                if (p.source === 'local') continue;
                if (Number(p.staleMinutes ?? 0) > 30) continue;

                const coords = (feat.geometry as GeoJSON.Point)?.coordinates;
                if (!coords || coords.length < 2) continue;

                const [lon, lat] = coords;
                if (
                    !Number.isFinite(lat) ||
                    lat < -90 ||
                    lat > 90 ||
                    !Number.isFinite(lon) ||
                    lon < -180 ||
                    lon > 180
                ) {
                    continue;
                }
                const dist = haversineNm(ownLat, ownLon, lat, lon);
                if (dist > existingState.radiusNm) continue;

                const mmsi = Number(p.mmsi);
                if (!Number.isFinite(mmsi) || mmsi <= 0) continue;
                currentMmsis.add(mmsi);

                // Only alert once per vessel entry (not every cycle)
                if (!activeAlertMmsis.has(mmsi)) {
                    activeAlertMmsis.add(mmsi);
                    const sog = Number(p.sog ?? 0);
                    const cog = Number(p.cog ?? 0);
                    const alert: GuardAlert = {
                        mmsi,
                        name: p.name ? String(p.name) : `MMSI ${mmsi}`,
                        distanceNm: Math.round(dist * 100) / 100,
                        bearing: Math.round(initialBearing(ownLat, ownLon, lat, lon)),
                        sog: Number.isFinite(sog) ? sog : 0,
                        cog: Number.isFinite(cog) ? cog : 0,
                        shipType: p.shipType ? String(p.shipType) : '0',
                        timestamp: Date.now(),
                    };
                    newAlerts.push(alert);
                    if (!returnedAlerts.has(mmsi)) returnedAlerts.set(mmsi, { ...alert });
                }
            }

            // Clear debounce entries for vessels that left this owner's zone.
            for (const mmsi of activeAlertMmsis) {
                if (!currentMmsis.has(mmsi)) {
                    activeAlertMmsis.delete(mmsi);
                }
            }

            if (newAlerts.length > 0) {
                statesByOwnerKey.set(ownerKey, {
                    ...existingState,
                    alerts: [...newAlerts, ...existingState.alerts].slice(0, 10),
                });
                if (ownerKey === currentScope.key) visibleStateChanged = true;
            }
        }

        if (visibleStateChanged) notify();
        return [...returnedAlerts.values()];
    },

    clearAlerts(expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!isAuthIdentityScopeCurrent(expectedScope)) return;
        const state = ensureState(expectedScope);
        statesByOwnerKey.set(expectedScope.key, { ...state, alerts: [] });
        activeAlertMmsisByOwnerKey.get(expectedScope.key)?.clear();
        notify();
    },

    subscribe(fn: Listener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
};
