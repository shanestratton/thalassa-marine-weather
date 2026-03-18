/**
 * AisGuardZone — Virtual radar guard zone for collision avoidance.
 *
 * Monitors AIS targets against a configurable radius around own vessel.
 * When any target enters the zone, triggers a haptic + visual alert.
 *
 * State persisted in localStorage for session continuity.
 */

const STORAGE_KEY = 'thalassa_guard_zone';
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

// ── Singleton ──

let state: GuardZoneState = loadState();
const listeners = new Set<Listener>();
const activeAlertMmsis = new Set<number>(); // Tracks which MMSIs have been alerted (debounce)

function loadState(): GuardZoneState {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            return {
                enabled: parsed.enabled ?? false,
                radiusNm: parsed.radiusNm ?? DEFAULT_RADIUS_NM,
                alerts: [], // Don't persist alerts
            };
        }
    } catch { /* ignore */ }
    return { enabled: false, radiusNm: DEFAULT_RADIUS_NM, alerts: [] };
}

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            enabled: state.enabled,
            radiusNm: state.radiusNm,
        }));
    } catch { /* ignore */ }
}

function notify() {
    listeners.forEach((fn) => fn({ ...state }));
}

// ── Haversine distance (NM) ──
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const DEG = Math.PI / 180;
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065;
}

function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const DEG = Math.PI / 180;
    const dLon = (lon2 - lon1) * DEG;
    const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
    const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
        Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
    return (Math.atan2(y, x) / DEG + 360) % 360;
}

// ── Public API ──

export const AisGuardZone = {
    getState(): GuardZoneState {
        return { ...state };
    },

    setEnabled(enabled: boolean) {
        state = { ...state, enabled };
        if (!enabled) {
            state.alerts = [];
            activeAlertMmsis.clear();
        }
        persist();
        notify();
    },

    setRadius(radiusNm: number) {
        state = { ...state, radiusNm: Math.max(0.1, Math.min(50, radiusNm)) };
        persist();
        notify();
    },

    /**
     * Check AIS features against the guard zone.
     * Called from useAisStreamLayer on every merge cycle.
     * Returns new alerts (vessels that just entered the zone).
     */
    checkFeatures(
        ownLat: number,
        ownLon: number,
        features: GeoJSON.Feature[],
    ): GuardAlert[] {
        if (!state.enabled) return [];

        const newAlerts: GuardAlert[] = [];
        const currentMmsis = new Set<number>();

        for (const feat of features) {
            const p = feat.properties;
            if (!p) continue;

            // Skip own vessel (local NMEA) and stale ghosts
            if (p.source === 'local') continue;
            if ((p.staleMinutes ?? 0) > 30) continue;

            const coords = (feat.geometry as GeoJSON.Point)?.coordinates;
            if (!coords || coords.length < 2) continue;

            const [lon, lat] = coords;
            const dist = haversineNm(ownLat, ownLon, lat, lon);

            if (dist <= state.radiusNm) {
                const mmsi = Number(p.mmsi);
                currentMmsis.add(mmsi);

                // Only alert once per vessel entry (not every cycle)
                if (!activeAlertMmsis.has(mmsi)) {
                    activeAlertMmsis.add(mmsi);
                    const alert: GuardAlert = {
                        mmsi,
                        name: p.name || `MMSI ${mmsi}`,
                        distanceNm: Math.round(dist * 100) / 100,
                        bearing: Math.round(initialBearing(ownLat, ownLon, lat, lon)),
                        sog: Number(p.sog ?? 0),
                        cog: Number(p.cog ?? 0),
                        shipType: p.shipType ? String(p.shipType) : '0',
                        timestamp: Date.now(),
                    };
                    newAlerts.push(alert);
                }
            }
        }

        // Clear alerts for vessels that left the zone
        for (const mmsi of activeAlertMmsis) {
            if (!currentMmsis.has(mmsi)) {
                activeAlertMmsis.delete(mmsi);
            }
        }

        // Update state with current in-zone alerts
        if (newAlerts.length > 0) {
            state = {
                ...state,
                alerts: [...newAlerts, ...state.alerts].slice(0, 10), // Keep last 10
            };
            notify();
        }

        return newAlerts;
    },

    clearAlerts() {
        state = { ...state, alerts: [] };
        activeAlertMmsis.clear();
        notify();
    },

    subscribe(fn: Listener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
};
