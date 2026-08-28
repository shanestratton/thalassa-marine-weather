/**
 * anchorPiHandoff — hands the shore watch to the boat's Pi.
 *
 * Shane 2026-08-29: a skipper should need a Pi OR a tablet aboard, not both.
 * The Pi is the better watchkeeper — mains powered, wired to the bus, never
 * backgrounded by iOS, and it does not leave the boat in someone's pocket.
 *
 * THREE THINGS HAVE TO LINE UP, and this module owns all three so no caller
 * has to remember the order:
 *
 *   1. AUTHORISE. The signed-in app tells the anchor-relay Edge Function that
 *      this Pi may broadcast to this session code. The relay credential proves
 *      WHICH PI is calling and nothing about which channel it may reach, and
 *      anchor-watch sessions exist only on the devices — so without this a
 *      compromised Pi could broadcast a fabricated position to any code it
 *      could guess.
 *
 *   2. ASSIGN. The Pi is told what it is watching: the session code, where the
 *      anchor is, and how big the swing circle is. The Pi has GPS and the bus;
 *      it does not know where the skipper dropped the hook.
 *
 *   3. RENEW. The authorisation is deliberately short-lived — the schema caps
 *      it at 48 hours and the function issues six. A standing permission to
 *      broadcast where someone's boat is lying is not a thing to hand out, so
 *      the app refreshes it while the watch runs and it lapses when the watch
 *      stops, without anyone having to remember to revoke it.
 *
 * ORDER MATTERS. Authorise BEFORE assigning: a Pi that starts broadcasting
 * into an unauthorised channel just collects 403s, and the first thing the
 * skipper would see is a shore watch that does not work.
 */
import { pinnedPiRequest } from './PiPairingService';
import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AnchorPiHandoff');

/** Comfortably inside the six hours the relay grants, so a missed refresh is
 *  survivable and a sleeping phone does not end the watch. */
export const RENEW_INTERVAL_MS = 60 * 60 * 1000;

export interface PiWatchAssignment {
    sessionCode: string;
    anchorLat: number;
    anchorLon: number;
    swingRadius: number;
}

function relayFunctionUrl(): string | null {
    const base = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
    return base ? `${base}/functions/v1/anchor-relay` : null;
}

/**
 * Step 1. Returns false rather than throwing: a failed handoff must degrade to
 * the phone keeping the watch itself, never to no watch at all.
 */
export async function authoriseRelay(relayId: string, sessionCode: string): Promise<boolean> {
    const url = relayFunctionUrl();
    if (!url || !supabase) return false;
    try {
        const { data: session } = await supabase.auth.getSession();
        const token = session?.session?.access_token;
        if (!token) return false;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'authorise', relay_id: relayId, session_code: sessionCode }),
        });
        if (!response.ok) {
            log.warn(`Relay authorisation refused (HTTP ${response.status})`);
            return false;
        }
        return true;
    } catch (err) {
        log.warn(`Relay authorisation failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/** Step 2. Over the pinned boat-LAN channel — the Pi is a local device. */
export async function assignWatchToPi(assignment: PiWatchAssignment, piBaseUrl: string): Promise<boolean> {
    try {
        await pinnedPiRequest({
            url: `${piBaseUrl.replace(/\/$/, '')}/api/anchor/watch`,
            method: 'POST',
            data: assignment,
        });
        return true;
    } catch (err) {
        log.warn(`Pi would not take the watch: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/** Tell the Pi to stop. Best effort — the authorisation lapsing is the
 *  backstop, so a Pi that missed this cannot broadcast for long. */
export async function clearWatchOnPi(piBaseUrl: string): Promise<void> {
    try {
        await pinnedPiRequest({ url: `${piBaseUrl.replace(/\/$/, '')}/api/anchor/watch`, method: 'DELETE' });
    } catch {
        /* the six-hour authorisation expiry is what actually guarantees this */
    }
}

/**
 * The whole handoff, in the one order that works.
 *
 * Returns whether the PI is now keeping the watch. False means the phone
 * should carry on doing it itself — which is the existing behaviour, and is
 * why nothing here throws.
 */
export async function handOffToPi(assignment: PiWatchAssignment, relayId: string, piBaseUrl: string): Promise<boolean> {
    if (!(await authoriseRelay(relayId, assignment.sessionCode))) return false;
    return assignWatchToPi(assignment, piBaseUrl);
}
