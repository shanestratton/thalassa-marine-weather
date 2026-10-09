/**
 * anchorPhoneHeartbeat — the boat's phone checks in while it keeps a shared
 * anchor watch (126-03b), so the server can tell the crew when it goes quiet.
 *
 * A phone-kept watch broadcasts straight over Realtime, so the server saw
 * nothing, and a locked shore phone heard nothing when the boat's phone died.
 * Now the phone calls record_anchor_watch_heartbeat about once a minute while
 * it keeps the watch, and the server pages every Shore Watch phone after five
 * quiet minutes (check_anchor_phone_watch_health).
 *
 *  - Beats while this phone is the VESSEL of a session and its watch is
 *    watching or alarming. A paused (blocked) watch sends nothing, so the
 *    crew are told: a blocked watch is not keeping watch.
 *  - Three clocks, as the watch itself: every state notice (every fix), the
 *    BgGeo heartbeat (iOS keeps that alive in the background) and a 60 s
 *    timer. At most one beat per 50 s.
 *  - When the watch stands down (anchor weighed, or the watch handed to the
 *    Pi) it says 'ended' at once, so the server never pages about it. A
 *    failed 'ended' is kept, per account, and retried on the next activity.
 *  - The first beat of a watch is the probe: a server without the RPC (before
 *    the DB push) is not asked again for that watch. A REFUSAL is not that: a
 *    lapsed sign-in sends the call as anon and is refused too, so a refused
 *    beat or end is simply tried again (review 2026-10-10).
 *  - 'ended' waits for a check-in still on its way, so that check-in cannot
 *    land last and leave the server thinking the phone still watches.
 *  - An identity switch drops everything for the old account and sends
 *    nothing on its behalf.
 *
 * Logs carry reasons only, never a session code; log.warn because info() is
 * silent in production builds.
 */
import { AnchorWatchService } from './AnchorWatchService';
import { AnchorWatchSyncService, type SyncState } from './AnchorWatchSyncService';
import { BgGeoManager } from './BgGeoManager';
import { supabase } from './supabase';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AnchorPhoneHeartbeat');

const BEAT_EVERY_MS = 60_000;
const MIN_GAP_MS = 50_000;
/** A session cannot outlive this without a beat, so an older pending end is moot. */
const PENDING_END_MAX_AGE_MS = 24 * 60 * 60_000;
const PENDING_END_KEY = 'thalassa_anchor_phone_watch_pending_end';

type Outcome = 'ok' | 'unavailable' | 'failed';
type Watch = { scope: AuthIdentityScope; sessionCode: string };

/**
 * The server has no heartbeat yet (before the DB push). Never a refusal
 * (42501): supabase-js sends the anon key when a lapsed token cannot be
 * refreshed, so a passing auth fault must not switch the watchdog off.
 */
const unavailable = (error: { code?: string; message?: string }) =>
    ['PGRST202', '42883'].includes(error.code ?? '') ||
    /could not find the function|function .* does not exist/i.test(error.message ?? '');

async function call(sessionCode: string, state: 'watching' | 'ended'): Promise<Outcome> {
    if (!supabase) return 'unavailable';
    const what = state === 'ended' ? 'Anchor watch end' : 'Anchor watch check-in';
    try {
        const { error } = await supabase.rpc('record_anchor_watch_heartbeat', {
            p_session_code: sessionCode,
            p_state: state,
        });
        if (!error) return 'ok';
        if (unavailable(error)) {
            log.warn(`${what} not available on this server (${error.code ?? 'no code'})`);
            return 'unavailable';
        }
        log.warn(
            error.code === '42501'
                ? `${what} refused: signed out, or this account is not the watch's vessel (a shore device on the same account?); will retry`
                : `${what} failed (${error.code ?? 'no code'}); will retry`,
        );
    } catch {
        log.warn(`${what} failed (network); will retry`);
    }
    return 'failed';
}

/** Closure-built so the bundle carries short local names (126-03b's JS budget). */
export function createAnchorPhoneHeartbeat() {
    let stops: Array<() => void> = [];
    let timer: ReturnType<typeof setInterval> | null = null;
    let sync: SyncState | null = null;
    let watchState = 'idle';
    /** The watch this phone has been beating for. */
    let beating: Watch | null = null;
    /** Sessions the server cannot take a beat for (see unavailable()). */
    const noServer = new Set<string>();
    let lastBeatAt = 0;
    /** The check-in on its way, which an 'ended' must wait for. */
    let beatInFlight: Promise<void> | null = null;
    let endInFlight = false;
    /** The end still owed to the server, mirrored to storage so a kill cannot lose it. */
    let pending: { scopeKey: string; sessionCode: string; at: number } | null = null;
    let loadedScopeKey: string | null = null;

    const setTimer = (on: boolean) => {
        if (on && !timer) timer = setInterval(evaluate, BEAT_EVERY_MS);
        else if (!on && timer) {
            clearInterval(timer);
            timer = null;
        }
    };

    const clearPendingEnd = (scope: AuthIdentityScope, sessionCode: string) => {
        if (pending?.scopeKey === scope.key) {
            // Only the end that was owed: a later watch's end may have replaced it.
            if (pending.sessionCode !== sessionCode) return;
            pending = null;
        }
        try {
            localStorage.removeItem(authScopedStorageKey(PENDING_END_KEY, scope));
        } catch {
            /* nothing to clear */
        }
    };

    const readPendingEnd = (scope: AuthIdentityScope) => {
        if (!scope.userId) return null;
        if (loadedScopeKey !== scope.key) {
            // Once per account: what an earlier launch could not send.
            loadedScopeKey = scope.key;
            pending = null;
            try {
                const raw = localStorage.getItem(authScopedStorageKey(PENDING_END_KEY, scope));
                const value = raw ? (JSON.parse(raw) as { sessionCode?: unknown; at?: unknown }) : null;
                if (value && typeof value.sessionCode === 'string' && typeof value.at === 'number') {
                    pending = { scopeKey: scope.key, sessionCode: value.sessionCode, at: value.at };
                }
            } catch {
                /* unreadable or unavailable storage: nothing owed from before */
            }
        }
        if (pending && Date.now() - pending.at > PENDING_END_MAX_AGE_MS) clearPendingEnd(scope, pending.sessionCode);
        return pending?.scopeKey === scope.key ? pending : null;
    };

    const savePendingEnd = ({ scope, sessionCode }: Watch) => {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        readPendingEnd(scope);
        pending = { scopeKey: scope.key, sessionCode, at: Date.now() };
        try {
            localStorage.setItem(
                authScopedStorageKey(PENDING_END_KEY, scope),
                JSON.stringify({ sessionCode, at: pending.at }),
            );
        } catch {
            /* private mode: still owed in memory, just not across a kill */
        }
    };

    const sendPendingEnd = async () => {
        const scope = getAuthIdentityScope();
        if (!readPendingEnd(scope) || endInFlight) return;
        endInFlight = true;
        try {
            // A check-in still on its way lands first, never after the end.
            await beatInFlight;
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const owed = readPendingEnd(scope);
            if (!owed) return;
            // The same watch running again on this phone is not ended.
            if (beating?.sessionCode === owed.sessionCode) return clearPendingEnd(scope, owed.sessionCode);
            const outcome = await call(owed.sessionCode, 'ended');
            if (isAuthIdentityScopeCurrent(scope) && outcome !== 'failed') clearPendingEnd(scope, owed.sessionCode);
        } finally {
            endInFlight = false;
        }
    };

    const beat = (watch: Watch) => {
        if (beatInFlight || Date.now() - lastBeatAt < MIN_GAP_MS) return;
        lastBeatAt = Date.now();
        beatInFlight = call(watch.sessionCode, 'watching').then((outcome) => {
            beatInFlight = null;
            if (outcome === 'unavailable') noServer.add(watch.sessionCode);
        });
    };

    function evaluate(): void {
        if (!sync) return;
        const scope = getAuthIdentityScope();
        if (beating && !isAuthIdentityScopeCurrent(beating.scope)) {
            // Another account: nothing more is sent for the old one.
            beating = null;
            lastBeatAt = 0;
        }
        const code = sync.sessionCode;
        const keeping =
            !!scope.userId && sync.role === 'vessel' && !!code && (watchState === 'watching' || watchState === 'alarm');

        // Blocked (paused) is not ended: no beat, and the crew are told.
        if (
            beating &&
            (!keeping || beating.sessionCode !== code) &&
            !(watchState === 'paused' && code === beating.sessionCode)
        ) {
            if (!noServer.has(beating.sessionCode)) savePendingEnd(beating);
            beating = null;
        }
        if (keeping && !beating) {
            beating = { scope, sessionCode: code };
            lastBeatAt = 0;
        }

        void sendPendingEnd();
        if (keeping && beating && !noServer.has(beating.sessionCode)) beat(beating);
        setTimer(!!beating || readPendingEnd(scope) !== null);
    }

    return {
        start(): void {
            if (stops.length) return;
            // Each subscribe calls back once at once; only the last evaluates.
            stops = [
                AnchorWatchService.subscribe((snapshot) => {
                    watchState = snapshot.state;
                    evaluate();
                }),
                BgGeoManager.subscribeHeartbeat(evaluate),
                AnchorWatchSyncService.onStateChange((state) => {
                    sync = state;
                    evaluate();
                }),
            ];
        },
        /** Tests and teardown only: the app keeps it for its lifetime. */
        stop(): void {
            stops.forEach((stop) => stop());
            stops = [];
            setTimer(false);
            beating = null;
            sync = null;
        },
    };
}

export const AnchorPhoneHeartbeat = createAnchorPhoneHeartbeat();
