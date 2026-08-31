/**
 * The boat's always-on track, as the app sees it.
 *
 * Shane 2026-08-30: "why dont we have the pi, ALWAYS (assuming we ask it to)
 * track our course. at all times. so even if the punter forgets to start a
 * track or it crashes or their phone goes flat or over the side whatever."
 *
 * The Pi does all of the work; this is only the switch and the readout. Every
 * call rides the pinned-TLS transport, because the track is a record of
 * everywhere the vessel has ever been and has no business on an unverified
 * connection.
 *
 * Nothing here throws. A Pi that is off, ashore or mid-reboot is the ordinary
 * case on a boat, and a settings screen that explodes because the Pi is asleep
 * is worse than one that says "not reachable".
 */
import { createLogger } from '../utils/createLogger';
import { getPairing } from './PiPairingService';
import { piCache } from './PiCacheService';
import { isPinnedTransportAvailable, piRequest } from './piTls';

const log = createLogger('PiTrackRecorder');

const CONNECT_TIMEOUT_MS = 3_000;
const READ_TIMEOUT_MS = 5_000;

export interface PiTrackStatus {
    /** What the skipper asked for, and what the Pi will resume on boot. */
    enabled: boolean;
    /** Whether the loop is actually running right now. */
    running: boolean;
    lastOutcome: string | null;
    writtenThisSession: number;
    stored: { points: number; firstMs: number | null; lastMs: number | null; bytes: number };
}

/** Null means "we could not ask" — never "it is off". The distinction matters:
 *  showing a confident OFF for an unreachable Pi would invite a skipper to
 *  turn on something that was already recording. */
async function call(path: string, method: 'GET' | 'POST', data?: unknown): Promise<PiTrackStatus | null> {
    if (!isPinnedTransportAvailable()) return null;
    const pinnedSpki = getPairing()?.publicKeySpki;
    // No pairing, no pin, no request. The unpaired lane exists only for
    // /api/pair/info and must not be widened to carry the boat's track.
    if (!pinnedSpki) return null;

    try {
        const res = await piRequest({
            url: `${piCache.baseUrl}${path}`,
            method,
            data,
            headers: data ? { 'content-type': 'application/json' } : undefined,
            pinnedSpki,
            connectTimeout: CONNECT_TIMEOUT_MS,
            readTimeout: READ_TIMEOUT_MS,
            responseType: 'text',
        });
        if (res.status < 200 || res.status >= 300) {
            log.warn(`track ${method} ${path} → ${res.status}`);
            return null;
        }
        return JSON.parse(res.data) as PiTrackStatus;
    } catch (err) {
        log.warn(`track ${method} ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/** What the Pi is doing, and how much it holds. Null when it cannot be asked. */
export function getPiTrackStatus(): Promise<PiTrackStatus | null> {
    return call('/api/track/status', 'GET');
}

export interface PiRestingFix {
    lat: number;
    lon: number;
    atMs: number;
    sogKts: number | null;
}

/**
 * Where the boat was LYING when her instruments last spoke — the Pi's own
 * track, not anybody's phone.
 *
 * A skipper switches the bus off for the night and every live position source
 * goes dark, but the boat has not moved: her last fix at rest IS her berth
 * (Shane, 2026-08-31: "it STILL shows home and not the boats location" — the
 * instruments had been off since 22:12). Two gates keep this honest: the fix
 * must be recent enough that yard staff have not plausibly moved her, and she
 * must have been essentially stationary when last heard — a boat that went
 * silent while MOVING is emphatically not where the log says.
 */
export async function getPiLastRestingFix(maxAgeMs = 12 * 3_600_000): Promise<PiRestingFix | null> {
    const status = await getPiTrackStatus();
    const lastMs = status?.stored?.lastMs;
    if (typeof lastMs !== 'number' || !Number.isFinite(lastMs)) return null;
    if (Date.now() - lastMs > maxAgeMs) return null;

    // A tiny window around the known last timestamp — never a broad pull of
    // the log across the LAN just to read one point.
    const window = await callRaw(`/api/track/points?from=${lastMs - 300_000}&to=${lastMs + 1_000}&limit=500`);
    const points = Array.isArray(window?.points) ? (window.points as Record<string, unknown>[]) : [];
    let last: Record<string, unknown> | null = null;
    for (const p of points) {
        if (typeof p.at_ms !== 'number' || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
        if (!last || (p.at_ms as number) > (last.at_ms as number)) last = p;
    }
    if (!last) return null;
    const sog = typeof last.sog_kts === 'number' ? (last.sog_kts as number) : null;
    if (sog !== null && sog > 0.5) return null;
    return { lat: last.lat as number, lon: last.lon as number, atMs: last.at_ms as number, sogKts: sog };
}

/** Same transport ceremony as call(), for responses that are not a status. */
async function callRaw(path: string): Promise<Record<string, unknown> | null> {
    if (!isPinnedTransportAvailable()) return null;
    const pinnedSpki = getPairing()?.publicKeySpki;
    if (!pinnedSpki) return null;
    try {
        const res = await piRequest({
            url: `${piCache.baseUrl}${path}`,
            method: 'GET',
            pinnedSpki,
            connectTimeout: CONNECT_TIMEOUT_MS,
            readTimeout: READ_TIMEOUT_MS,
            responseType: 'text',
        });
        if (res.status < 200 || res.status >= 300) return null;
        return JSON.parse(res.data) as Record<string, unknown>;
    } catch (err) {
        log.warn(`track GET ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/**
 * Turn the recorder on or off.
 *
 * Returns the Pi's own view afterwards rather than echoing the request, so the
 * UI shows what the boat actually did — if the write landed but the loop failed
 * to start, the skipper should see that rather than a switch that looks happy.
 */
export function setPiTrackRecording(enabled: boolean): Promise<PiTrackStatus | null> {
    return call('/api/track/enable', 'POST', { enabled });
}
