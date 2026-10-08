/**
 * The Log page's side of the background route re-check (build 124, B3/B4).
 *
 * The queue (services/traceBackgroundCheck) runs only while this page is
 * mounted, so the page says when it is; and the page supplies the two lazy
 * triggers — the "Following a route?" sheet opening (recover from the server
 * first, then queue its amber rows in sheet order) and ten seconds visible
 * and idle (queue the amber traces the sheet would show). There is no
 * app-boot trigger until the cost is measured on the phone.
 */
import React, { useSyncExternalStore } from 'react';
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../../services/authIdentityScope';
import {
    enqueueTraceChecks,
    getTraceCheckReport,
    getTraceCheckSnapshot,
    setLogPageActive,
    subscribeTraceChecks,
    type TraceCheckSnapshot,
} from '../../services/traceBackgroundCheck';
import { savedTraceFollowStatus } from '../../services/traceDirectUseGate';
import type { RecheckReport } from '../../services/traceRecheck';

const IDLE_MS = 10_000;

const amber = (ids: readonly string[]) => ids.filter((id) => savedTraceFollowStatus(id).tone === 'unchecked');

export function useTraceBackgroundChecks(opts: {
    identityScope: AuthIdentityScope;
    /** Trace ids of the open sheet's rows, in sheet order; null when closed. */
    sheetTraceIds: readonly string[] | null;
    /** Trace ids of every planned route the sheet would show. */
    plannedTraceIds: readonly string[];
    /** A check landed (or was recovered): re-read the rows' statuses. */
    onStatusesChanged: () => void;
    /** A red row's report is ready to acknowledge in place. */
    onReport: (savedRouteId: string, report: RecheckReport) => void;
}): { snapshot: TraceCheckSnapshot; review: (savedRouteId: string) => void } {
    const { identityScope, sheetTraceIds, plannedTraceIds, onStatusesChanged, onReport } = opts;
    const snapshot = useSyncExternalStore(subscribeTraceChecks, getTraceCheckSnapshot, getTraceCheckSnapshot);
    const latest = React.useRef({ onStatusesChanged, onReport, plannedTraceIds });
    latest.current = { onStatusesChanged, onReport, plannedTraceIds };

    React.useEffect(() => {
        setLogPageActive(true);
        return () => setLogPageActive(false);
    }, []);

    // Sheet opens: recover lost checks from the passage mirrors (one query, no
    // grading), then queue what is still amber — trip legs in leg order.
    const sheetKey = sheetTraceIds?.join('|') ?? null;
    React.useEffect(() => {
        if (sheetKey === null) return;
        const ids = sheetKey ? sheetKey.split('|') : [];
        latest.current.onStatusesChanged();
        if (ids.length === 0) return;
        let live = true;
        void import('../../services/traceCheckRecovery')
            .then(({ recoverTraceChecks }) => recoverTraceChecks(identityScope, ids))
            .catch(() => 0)
            .then(() => {
                if (!live || !isAuthIdentityScopeCurrent(identityScope)) return;
                latest.current.onStatusesChanged();
                enqueueTraceChecks(amber(ids), 'sheet');
            });
        return () => {
            live = false;
        };
    }, [sheetKey, identityScope]);

    // Ten seconds visible and untouched: queue the amber traces the sheet
    // would show. Once per visit, and again after coming back to the app.
    React.useEffect(() => {
        let lastTouch = Date.now();
        let timer: number | undefined;
        const arm = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                if (document.visibilityState !== 'visible') return;
                const quietFor = Date.now() - lastTouch;
                if (quietFor < IDLE_MS) return arm();
                const ids = amber(latest.current.plannedTraceIds);
                if (ids.length > 0) enqueueTraceChecks(ids, 'idle');
            }, IDLE_MS);
        };
        const touch = () => {
            lastTouch = Date.now();
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') {
                lastTouch = Date.now();
                arm();
            }
        };
        window.addEventListener('pointerdown', touch, { passive: true });
        window.addEventListener('keydown', touch);
        document.addEventListener('visibilitychange', onVisibility);
        arm();
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('pointerdown', touch);
            window.removeEventListener('keydown', touch);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, []);

    // A check finished: the rows re-read their status (progress ticks don't).
    const settled = [...snapshot.states].map(([id, state]) => (state.phase === 'done' ? `${id}:${state.result}` : id));
    const settledKey = settled.join('|');
    React.useEffect(() => {
        latest.current.onStatusesChanged();
    }, [settledKey]);

    // Review: open the finding's report in place — re-running the check
    // first when this session no longer holds it.
    const [pendingReview, setPendingReview] = React.useState<string | null>(null);
    const review = React.useCallback((savedRouteId: string) => {
        const report = getTraceCheckReport(savedRouteId);
        if (report) return latest.current.onReport(savedRouteId, report);
        setPendingReview(savedRouteId);
        enqueueTraceChecks([savedRouteId], 'review');
    }, []);
    const pendingState = pendingReview ? snapshot.states.get(pendingReview) : undefined;
    React.useEffect(() => {
        if (!pendingReview || pendingState?.phase !== 'done') return;
        setPendingReview(null);
        const report = pendingState.result === 'finding' ? getTraceCheckReport(pendingReview) : undefined;
        if (report) latest.current.onReport(pendingReview, report);
    }, [pendingReview, pendingState]);

    return { snapshot, review };
}
