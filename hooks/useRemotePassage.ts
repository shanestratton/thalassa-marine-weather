/**
 * useRemotePassage — the Log page's view of a passage the account is running
 * on ANOTHER device (services/shiplog/remotePassage.ts).
 *
 * Polls only while the page is visible, once a minute, plus on focus, on
 * reconnect and whenever any door changes the followed-route link. The cached
 * answer paints first so the card is there before the network answers, and
 * survives an offline open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRemotePassage, readRemotePassageCache, type RemotePassage } from '../services/shiplog/remotePassage';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../services/authIdentityScope';

export const REMOTE_PASSAGE_POLL_MS = 60_000;

export interface UseRemotePassage {
    remote: RemotePassage | null;
    /** Ask the server again now (after joining the recording, after a re-link). */
    refresh: () => void;
}

export function useRemotePassage(opts: {
    /** Signed in. Nothing is asked while signed out. */
    enabled: boolean;
    /** The voyage THIS device is recording, if any — that one is never "remote". */
    trackingVoyageId: string | null;
    pollMs?: number;
}): UseRemotePassage {
    const { enabled, trackingVoyageId } = opts;
    const pollMs = opts.pollMs ?? REMOTE_PASSAGE_POLL_MS;
    const [remote, setRemote] = useState<RemotePassage | null>(() => (enabled ? readRemotePassageCache() : null));
    const inFlight = useRef(false);
    const trackingRef = useRef(trackingVoyageId);
    trackingRef.current = trackingVoyageId;

    const refresh = useCallback(() => {
        if (!enabled || inFlight.current) return;
        const scope = getAuthIdentityScope();
        if (!scope.userId) return;
        inFlight.current = true;
        void fetchRemotePassage(trackingRef.current)
            .then((result) => {
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (result.ok) setRemote(result.passage);
                // A failed read keeps the last answer: offline the cached
                // card is still the best thing to show.
            })
            .finally(() => {
                inFlight.current = false;
            });
    }, [enabled]);

    useEffect(() => {
        if (!enabled) {
            setRemote(null);
            return;
        }
        setRemote(readRemotePassageCache());
        refresh();
        const onVisible = () => {
            if (document.visibilityState === 'visible') refresh();
        };
        const timer = setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
        }, pollMs);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', refresh);
        window.addEventListener('thalassa:voyage-plan-link-changed', refresh);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('online', refresh);
            window.removeEventListener('thalassa:voyage-plan-link-changed', refresh);
        };
    }, [enabled, pollMs, refresh]);

    // This device started or stopped recording: the same server rows now mean
    // something different (its own voyage is never remote).
    useEffect(() => {
        if (enabled) refresh();
    }, [enabled, trackingVoyageId, refresh]);

    // A remote passage this device has since started recording is no longer
    // remote — drop it at once rather than on the next poll.
    const shown = remote && remote.voyageId === trackingVoyageId ? null : remote;
    return { remote: shown, refresh };
}
