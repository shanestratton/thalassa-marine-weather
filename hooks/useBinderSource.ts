/**
 * useBinderSource — whose binder a Boat Binder page is showing, live.
 *
 * Shared binders (2026-10-02): while the sailor is crew on a skipper's boat,
 * a register the skipper shares shows the skipper's rows (sharedBinders.ts).
 * This hook gives a page that source, re-renders when it changes hands, and
 * calls the page's own reload when it does, and after a background sync
 * changes rows, so a binder never sits on a stale list until it is remounted
 * (even when realtime missed the change: the socket was down).
 *
 * `fetchingSkipperBinder` is true while a shared binder has no rows yet and a
 * full reconciliation is still bringing them in: the page says "Bringing in
 * <boat>'s binder…" instead of an empty state that reads like "nothing here".
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    getBinderSource,
    getSharedBindersState,
    subscribeSharedBinders,
    type BinderRegister,
    type BinderSource,
} from '../services/vessel/sharedBinders';
import { isFullReconciliationPending, onStatusChange, onSyncComplete } from '../services/vessel/SyncService';
import { useOnlineStatus } from './useOnlineStatus';

export interface UseBinderSourceOptions {
    /** The page's own list reload. */
    reload?: () => void;
    /** Rows the page currently lists for this binder. */
    rowCount?: number;
}

export interface BinderSourceState {
    source: BinderSource;
    fetchingSkipperBinder: boolean;
}

export function useBinderSource(register: BinderRegister, options: UseBinderSourceOptions = {}): BinderSourceState {
    const state = useSyncExternalStore(subscribeSharedBinders, getSharedBindersState, getSharedBindersState);
    // `state` is a new object on every change a viewer could see (and on an
    // account switch), so it is the right memo key for the derived source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const source = useMemo(() => getBinderSource(register), [state, register]);
    const online = useOnlineStatus();
    const reloadRef = useRef(options.reload);
    reloadRef.current = options.reload;
    const [, setSyncTick] = useState(0);

    // Reload when the binder changes hands, not on the first render (the page
    // loads itself on mount).
    const firstStateRef = useRef(state);
    useEffect(() => {
        if (firstStateRef.current === state) return;
        reloadRef.current?.();
    }, [state]);

    useEffect(() => {
        const offStatus = onStatusChange(() => setSyncTick((tick) => tick + 1));
        const offComplete = onSyncComplete((result) => {
            setSyncTick((tick) => tick + 1);
            // Any cycle that changed local rows: pulled, pruned (deleted on
            // another device, or no longer shared), dropped or re-homed.
            if (
                result.pulled > 0 ||
                (result.pruned ?? 0) > 0 ||
                (result.discardedShared ?? 0) > 0 ||
                (result.rehomedShared ?? 0) > 0
            ) {
                reloadRef.current?.();
            }
        });
        return () => {
            offStatus();
            offComplete();
        };
    }, []);

    const fetchingSkipperBinder =
        source.mode === 'shared' && (options.rowCount ?? 0) === 0 && online && isFullReconciliationPending();
    return { source, fetchingSkipperBinder };
}
