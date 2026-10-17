/**
 * "Only her own devices can command the Pi" (129-12): the Pi settings row's half.
 *
 * GET /api/pi-lock (Pi update 4, pi-cache/src/piCommandLock.ts) says where the
 * switch is, whether it is in force (a Pi with no device set up answers
 * everyone), how many devices are set up, whether this one is, and, by route,
 * the calls from devices not set up since the Pi started. A Pi that does not
 * answer it (today's Pi: a 404) or cannot be asked has no lock to show: null,
 * and the row is hidden, never broken.
 *
 * POST /api/pi-lock { mode } turns it on or off. The Pi takes it only from a
 * phone set up for her, on her own Wi-Fi, and not on while none is set up; a
 * refusal comes back as the Pi's own words.
 */
import { piCache } from './PiCacheService';
import { getPairing, pinnedPiRequest } from './PiPairingService';

export interface PiLockView {
    mode: 'observe' | 'enforce';
    enforcing: boolean;
    devices: number;
    thisDevice: 'set-up' | 'not-set-up' | 'removed';
    /** What devices not set up tried, in the skipper's words, most first. */
    seen: { words: string; calls: number }[];
}

const ROUTE_WORDS: Record<string, string> = {
    'POST /api/ais-watch': 'stand the night watch down',
    'POST /api/ais-watch/test': 'send a test from the Pi',
    'POST /api/anchor/watch': 'move the anchor watch',
    'DELETE /api/anchor/watch': 'stop the anchor watch',
    'POST /api/configure': 'change her settings',
    'POST /api/remote-access/enable': 'turn on remote access',
    'POST /api/remote-access/disable': 'turn off remote access',
    'POST /api/diary/entries': 'post to the diary',
};

function viewOf(text: string): PiLockView | null {
    let body: Record<string, unknown> | null;
    try {
        body = JSON.parse(text) as Record<string, unknown> | null;
    } catch {
        return null;
    }
    if (body?.capability !== 'pi-command-lock' || (body.mode !== 'observe' && body.mode !== 'enforce')) return null;
    const seen = new Map<string, number>();
    for (const row of Array.isArray(body.unenrolled)
        ? (body.unenrolled as { route?: unknown; calls?: unknown }[])
        : []) {
        const calls = Number(row?.calls);
        if (!Number.isInteger(calls) || calls <= 0) continue;
        const words = ROUTE_WORDS[String(row?.route)] ?? 'other changes';
        seen.set(words, (seen.get(words) ?? 0) + calls);
    }
    const devices = Number(body.devices);
    return {
        mode: body.mode,
        enforcing: body.enforcing === true,
        devices: Number.isInteger(devices) && devices > 0 ? devices : 0,
        thisDevice: body.thisDevice === 'set-up' || body.thisDevice === 'removed' ? body.thisDevice : 'not-set-up',
        seen: [...seen].map(([words, calls]) => ({ words, calls })).sort((a, b) => b.calls - a.calls),
    };
}

/** The lock as her Pi reports it, or null: no lock to show. Never throws. */
export async function loadPiLock(): Promise<PiLockView | null> {
    try {
        const res = await pinnedPiRequest({
            url: `${piCache.baseUrl}/api/pi-lock`,
            connectTimeout: 4000,
            readTimeout: 8000,
            responseType: 'text',
        });
        return res.status === 200 ? viewOf(res.data) : null;
    } catch {
        return null;
    }
}

/** Turn it on or off: the Pi's new answer, or the Pi's own words when it says no. Never throws. */
export async function setPiLockMode(mode: 'observe' | 'enforce'): Promise<PiLockView | { said: string }> {
    const fallback = {
        said: `${getPairing()?.boatName?.trim() || 'Your boat'}'s Pi couldn't change that just now. Try again in a minute.`,
    };
    try {
        const res = await pinnedPiRequest({
            url: `${piCache.baseUrl}/api/pi-lock`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { mode },
            connectTimeout: 4000,
            readTimeout: 8000,
            responseType: 'text',
        });
        if (res.status >= 200 && res.status < 300) return viewOf(res.data) ?? fallback;
        const error = (JSON.parse(res.data) as { error?: unknown } | null)?.error;
        return typeof error === 'string' && error.length > 0 && error.length <= 200 ? { said: error } : fallback;
    } catch {
        return fallback;
    }
}
