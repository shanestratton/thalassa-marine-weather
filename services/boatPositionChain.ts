/**
 * Which GPS the app believes, in order.
 *
 * Shane 2026-09-03: "a: garmin gps b: usb gps c: phone gps."
 *
 *   a — THE INSTRUMENT BUS, read straight off the gateway. The Garmin's fix,
 *       and the one every other instrument on the boat is steering by; a
 *       position that disagrees with the plotter is worse than a slightly
 *       older one that agrees.
 *   b — THE PI. Its Signal K sees the same bus AND the USB stick plugged into
 *       it, and it now chooses between them by source rather than by whoever
 *       wrote last (see anchorBroadcaster.rankSource). So this rung is the
 *       Garmin when the gateway is merely unreachable from the phone, and the
 *       USB stick when the bus itself is quiet.
 *   c — THE PHONE. Last, always. It is below decks in a pocket, it is the one
 *       receiver that leaves the boat, and it is the only one that can be
 *       somewhere the vessel is not.
 *
 * Nothing here throws. Every rung that cannot answer returns null and the next
 * one is tried, which is what makes this safe to put in front of code that
 * previously went straight to the phone.
 */
import { NmeaGpsProvider } from './NmeaGpsProvider';
import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('BoatPosition');

export type BoatFixRung = 'bus' | 'pi' | 'cloud' | 'phone';

export interface BoatFix {
    latitude: number;
    longitude: number;
    timestamp: number;
    /** Which rung answered, for the UI to be honest about. */
    rung: BoatFixRung;
    /** Signal K's own source id when the Pi answered, e.g. 'ydwg-tcp.YD'. */
    source?: string | null;
}

/** Rung a: the bus, straight off the gateway. */
export function busFix(): BoatFix | null {
    const pos = NmeaGpsProvider.getPosition();
    if (!pos) return null;
    return {
        latitude: pos.latitude,
        longitude: pos.longitude,
        timestamp: pos.timestamp,
        rung: 'bus',
        source: 'nmea-gateway',
    };
}

/** Rung b: the Pi, which has already chosen between the bus and its USB stick. */
export async function piFix(timeoutMs = 4_000): Promise<BoatFix | null> {
    const baseUrl = piCache.getBaseUrl();
    if (!baseUrl || !piCache.getStatus().reachable) return null;
    try {
        const { pinnedPiRequest } = await import('./PiPairingService');
        const res = await pinnedPiRequest({ url: `${baseUrl}/api/gps`, readTimeout: timeoutMs, responseType: 'text' });
        if (res.status < 200 || res.status >= 300) return null;
        const body = typeof res.data === 'string' ? (JSON.parse(res.data) as Record<string, unknown>) : null;
        if (!body || body.available !== true) return null;
        const latitude = Number(body.latitude);
        const longitude = Number(body.longitude);
        const timestamp = Number(body.timestamp);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
            latitude,
            longitude,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            rung: 'pi',
            source: typeof body.source === 'string' ? body.source : null,
        };
    } catch {
        // An older Pi has no /api/gps, and a sleeping one answers nothing.
        return null;
    }
}

/** The Pi's cloud row is the boat's position for this long; after that it is where she WAS. */
export const CLOUD_FIX_MAX_AGE_MS = 60_000;

/**
 * Rung c — FOR THE WEATHER ONLY: the row the Pi keeps in the cloud, the boat
 * seen from a distance. It is up to a minute old and the phone reading it may
 * be a hundred miles from her, so it is deliberately NOT part of boatFix():
 * Anchor Watch and the Ship's Log must never take it. The weather may — a
 * forecast for where the boat is, read from the kitchen table, is exactly
 * what Shane asked for (2026-09-07: the Glass read PHONE at Newport while the
 * Pi was publishing from the hardstand).
 */
export async function cloudFix(now = Date.now()): Promise<BoatFix | null> {
    try {
        const { CloudTelemetryService } = await import('./CloudTelemetryService');
        const t = await CloudTelemetryService.readOnce();
        if (!t || t.snapshot.lat === null || t.snapshot.lon === null) return null;
        if (now - t.reportedAt > CLOUD_FIX_MAX_AGE_MS) return null;
        return {
            latitude: t.snapshot.lat,
            longitude: t.snapshot.lon,
            timestamp: t.reportedAt,
            rung: 'cloud',
            source: t.source === 'device' ? 'skipper-phone' : 'pi-cloud',
        };
    } catch {
        return null;
    }
}

/**
 * The boat's position from the best source that will answer.
 *
 * Returns null when no BOAT source can — the caller then decides whether the
 * phone is an acceptable stand-in, which is a decision about what the position
 * is FOR (a track point, no; a rough weather lookup, yes) and not one this
 * function should make silently.
 */
export async function boatFix(): Promise<BoatFix | null> {
    const bus = busFix();
    if (bus) return bus;
    const pi = await piFix();
    if (pi) {
        log.info(`Boat position from the Pi (${pi.source ?? 'unknown source'})`);
        return pi;
    }
    return null;
}

/** How to say which receiver answered, in words a skipper would use. */
export function describeRung(fix: BoatFix | null): string {
    if (!fix) return 'Phone GPS';
    if (fix.rung === 'bus') return 'Boat GPS';
    if (fix.rung === 'pi') return fix.source?.toLowerCase().includes('ublox') ? 'USB GPS (Pi)' : 'Boat GPS (via Pi)';
    if (fix.rung === 'cloud') return 'Boat GPS (via cloud)';
    return 'Phone GPS';
}
