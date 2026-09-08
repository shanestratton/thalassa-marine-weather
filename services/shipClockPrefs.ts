/**
 * shipClockPrefs — the ship's bell clock's two preferences, shared between
 * the Instrument Panel (which keeps the clock and strikes the bells) and
 * Settings → Preferences (where the switches live since 2026-09-09: Shane
 * dropped the panel's Bells page — "get rid of the bells page" — and wants
 * most toggles in Preferences).
 *
 * The panel keeps reading these two localStorage keys itself (its clock-wiring
 * contract pins the literal reads); this module only names them, writes them,
 * and announces a change so an open panel follows without a relaunch.
 */
export const CLOCK_ZONE_KEY = 'thalassa_clock_zone';
export const CLOCK_BELLS_KEY = 'thalassa_clock_bells';
export const SHIP_ZONE_AUTO = 'auto';
export const SHIP_CLOCK_PREFS_EVENT = 'thalassa:ship-clock-prefs-changed';

export interface ShipClockPrefs {
    /** IANA zone, or SHIP_ZONE_AUTO to follow the boat's position. */
    zone: string;
    bellsOn: boolean;
}

export function readShipClockPrefs(): ShipClockPrefs {
    try {
        return {
            zone: localStorage.getItem(CLOCK_ZONE_KEY) || SHIP_ZONE_AUTO,
            bellsOn: localStorage.getItem(CLOCK_BELLS_KEY) === 'on',
        };
    } catch {
        return { zone: SHIP_ZONE_AUTO, bellsOn: false };
    }
}

export function writeShipClockPrefs(patch: Partial<ShipClockPrefs>): ShipClockPrefs {
    const next = { ...readShipClockPrefs(), ...patch };
    try {
        localStorage.setItem(CLOCK_ZONE_KEY, next.zone);
        localStorage.setItem(CLOCK_BELLS_KEY, next.bellsOn ? 'on' : 'off');
    } catch {
        /* private mode — the in-session state still follows via the event */
    }
    try {
        window.dispatchEvent(new CustomEvent(SHIP_CLOCK_PREFS_EVENT, { detail: next }));
    } catch {
        /* non-DOM host */
    }
    return next;
}
