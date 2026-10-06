/**
 * phoneLastFix — where the phone last was, kept for the day it has no fix.
 *
 * Shane 2026-10-06, on Obs following Current Location: "If there is no gps
 * from their phone then the last known location with a clear message telling
 * them that." The phone's live fix only ever lived in memory (GpsService's
 * watch tap), so after a relaunch with Location off there was nothing to show.
 *
 * Kept per account on this device (authScopedStorageKey), as the boat's held
 * fix is: where one account's phone was is not the next account's business.
 * Throttled as the boat's is: a moving phone rewrites, a still one does not.
 * Storage only, and no imports beyond the identity scope, so GpsService can
 * write it without a cycle.
 */
import { authScopedStorageKey, getAuthIdentityScope } from './authIdentityScope';

const LAST_PHONE_FIX_KEY = 'thalassa_last_phone_fix';
/** Rewritten no more often than this unless the phone has moved. */
export const PHONE_REMEMBER_MIN_INTERVAL_MS = 60_000;
/** About 37 m, the boat's REMEMBER_MIN_MOVE_NM. */
export const PHONE_REMEMBER_MIN_MOVE_M = 37;
const FUTURE_FIX_TOLERANCE_MS = 5_000;

export interface PhoneLastFix {
    lat: number;
    lon: number;
    /** When the phone produced the fix. */
    timestamp: number;
}

let lastWrite: { scope: string; at: number; lat: number; lon: number; timestamp: number } | null = null;

function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function validFix(lat: unknown, lon: unknown, timestamp: unknown, now: number): boolean {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        typeof timestamp === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0) &&
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= now + FUTURE_FIX_TOLERANCE_MS
    );
}

/** Metres between two nearby points (equirectangular: plenty for a 37 m throttle). */
function metresApart(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const toRad = Math.PI / 180;
    const x = (bLon - aLon) * toRad * Math.cos(((aLat + bLat) / 2) * toRad);
    const y = (bLat - aLat) * toRad;
    return Math.hypot(x, y) * 6_371_000;
}

/** Keep the phone's latest fix. Never throws; unusable or older fixes are ignored. */
export function rememberPhoneFix(
    position: { latitude: number; longitude: number; timestamp: number } | null | undefined,
    now = Date.now(),
): void {
    try {
        if (!position) return;
        const { latitude: lat, longitude: lon, timestamp } = position;
        if (!validFix(lat, lon, timestamp, now)) return;
        const scope = getAuthIdentityScope().key;
        const last = lastWrite?.scope === scope ? lastWrite : null;
        if (last && timestamp <= last.timestamp) return;
        const moved = !last || metresApart(last.lat, last.lon, lat, lon) >= PHONE_REMEMBER_MIN_MOVE_M;
        if (!moved && now - last.at < PHONE_REMEMBER_MIN_INTERVAL_MS) return;
        const stored: PhoneLastFix = { lat, lon, timestamp };
        storage()?.setItem(authScopedStorageKey(LAST_PHONE_FIX_KEY), JSON.stringify(stored));
        lastWrite = { scope, at: now, lat, lon, timestamp };
    } catch {
        /* No storage: the fix simply will not survive a relaunch. */
    }
}

/** The phone's last kept fix for this account on this device, or null. */
export function storedPhoneFix(now = Date.now()): PhoneLastFix | null {
    try {
        const raw = storage()?.getItem(authScopedStorageKey(LAST_PHONE_FIX_KEY));
        if (!raw) return null;
        const stored = JSON.parse(raw) as Partial<PhoneLastFix> | null;
        if (!stored || !validFix(stored.lat, stored.lon, stored.timestamp, now)) return null;
        return { lat: stored.lat!, lon: stored.lon!, timestamp: stored.timestamp! };
    } catch {
        return null;
    }
}

/** Test seam: forget the write throttle. */
export function __resetPhoneLastFixForTests(): void {
    lastWrite = null;
}
