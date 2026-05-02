/**
 * PositionResolver — pure functions over the cached `lastBgLocation`.
 *
 * Three callers across the orchestrator and EntrySave needed:
 *   - `getBestPosition`: full GPS-acquisition policy (NMEA → cached fresh
 *     → native fresh fetch → web fresh fetch). Used before saving a log
 *     entry.
 *   - `getGpsStatus`: 'locked' / 'stale' / 'none' enum for the SR strip.
 *   - `getGpsNavData`: { sogKts, cogDeg } for dashboard read-outs.
 *
 * All three needed `this.lastBgLocation` and `this.isNative` from the
 * orchestrator. By making them free functions that take the cached fix
 * as a parameter, the orchestrator just owns the data and forwards it
 * — no dependency injection ceremony.
 */
import type { CachedPosition } from '../BgGeoManager';
import { BgGeoManager } from '../BgGeoManager';
import { GpsService } from '../GpsService';
import { NmeaGpsProvider } from '../NmeaGpsProvider';
import { webGetFreshPosition } from './EntrySave';

const GPS_STALE_LIMIT_MS = 60_000;
const GPS_VERY_STALE_MS = 5 * 60 * 1000;
const MS_TO_KTS = 1.94384;

export type GpsStatus = 'locked' | 'stale' | 'none';

/**
 * Get the best available GPS position for a log entry.
 *
 * Priority order:
 *   1. NMEA / external GPS (highest accuracy when present)
 *   2. Cached BgGeo position if < 60s old
 *   3. Native: BgGeoManager.getFreshPosition (15s timeout)
 *      Web:    GpsService.getCurrentPosition (15s timeout)
 *
 * `cachedFix` is the orchestrator's `lastBgLocation`. It changes as new
 * GPS fixes stream in. Pass null if no cached fix is available yet.
 */
export async function getBestPosition(
    cachedFix: CachedPosition | null,
    isNative: boolean,
): Promise<CachedPosition | null> {
    // 1. NMEA / external GPS (the precision tracker prefers it)
    const nmeaPos = NmeaGpsProvider.getPosition();
    if (nmeaPos) {
        return {
            latitude: nmeaPos.latitude,
            longitude: nmeaPos.longitude,
            accuracy: nmeaPos.accuracy,
            heading: nmeaPos.heading,
            speed: nmeaPos.speed / MS_TO_KTS, // SOG kts → m/s
            timestamp: nmeaPos.timestamp,
            receivedAt: Date.now(),
            altitude: null,
        } as CachedPosition;
    }

    // 2. Cached phone GPS (battery-friendly; the onLocation stream keeps
    //    this fresh while tracking is on).
    if (cachedFix) {
        const age = Date.now() - cachedFix.receivedAt;
        if (age < GPS_STALE_LIMIT_MS) {
            return cachedFix;
        }
    }

    // 3. Cache stale or empty — fetch fresh. Native goes through
    //    BgGeoManager (the Transistorsoft plugin); web uses the helper
    //    re-exported from EntrySave to keep one source of truth for
    //    the navigator.geolocation prompt path.
    if (isNative) {
        return BgGeoManager.getFreshPosition(GPS_STALE_LIMIT_MS, 15);
    }
    const webPos = await GpsService.getCurrentPosition({
        staleLimitMs: GPS_STALE_LIMIT_MS,
        timeoutSec: 15,
    });
    if (!webPos) return null;
    return {
        latitude: webPos.latitude,
        longitude: webPos.longitude,
        accuracy: webPos.accuracy,
        altitude: webPos.altitude,
        heading: webPos.heading ?? 0,
        speed: webPos.speed,
        timestamp: webPos.timestamp,
        receivedAt: Date.now(),
    } as CachedPosition;
}

/**
 * Returns the current GPS fix quality.
 *  - `'locked'` — fresh fix within the last 60 seconds
 *  - `'stale'`  — cached fix older than 60 seconds but younger than 5 minutes
 *  - `'none'`   — no fix at all, or older than 5 minutes
 *
 * Falls back to `BgGeoManager.getLastPosition()` on native if the
 * orchestrator's cache is empty — there are paths (cold start, between
 * voyages) where BgGeo's internal cache outlives ours.
 */
export function getGpsStatus(cachedFix: CachedPosition | null, isNative: boolean): GpsStatus {
    const pos = cachedFix || (isNative ? BgGeoManager.getLastPosition() : null);
    if (!pos) return 'none';

    const ageMs = Date.now() - pos.receivedAt;
    if (ageMs < GPS_STALE_LIMIT_MS) return 'locked';
    if (ageMs < GPS_VERY_STALE_MS) return 'stale';
    return 'none';
}

/**
 * Get GPS navigation data for the dashboard.
 * Returns null fields if the cached fix is older than the staleness limit
 * — the dashboard renders "—" when null instead of stale numbers.
 */
export function getGpsNavData(
    cachedFix: CachedPosition | null,
    isNative: boolean,
): { sogKts: number | null; cogDeg: number | null } {
    const pos = cachedFix || (isNative ? BgGeoManager.getLastPosition() : null);
    if (!pos) return { sogKts: null, cogDeg: null };

    const ageMs = Date.now() - pos.receivedAt;
    if (ageMs > GPS_STALE_LIMIT_MS) return { sogKts: null, cogDeg: null };

    const sogKts =
        pos.speed != null && pos.speed >= 0
            ? parseFloat((pos.speed * MS_TO_KTS).toFixed(1)) // m/s → knots
            : null;
    const cogDeg = pos.heading != null && pos.heading >= 0 ? Math.round(pos.heading) : null;
    return { sogKts, cogDeg };
}
