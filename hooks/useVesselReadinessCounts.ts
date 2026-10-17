/**
 * useVesselReadinessCounts — live badge counts for the Vessel-tab Boat
 * Binder tiles: maintenance OVERDUE, documents EXPIRED and EXPIRING,
 * equipment WARRANTY ending soon.
 *
 * Extracted from VesselHub (2026-05-20) so the mutation→event→refetch
 * propagation path is independently testable. This is the exact path
 * behind the "1 Overdue still showing after I ticked it off" bug — the
 * effect:
 *   1. fetches each count on mount,
 *   2. re-fetches when the matching data-change window event fires
 *      (dispatched by the maintenance / document / equipment services
 *      on every mutation),
 *   3. re-fetches everything on `visibilitychange` → visible (catches
 *      changes synced from another device while backgrounded),
 *   4. re-fetches everything when the binders on show change hands
 *      (sharedBinders: crewing on a skipper's boat) and after a background
 *      sync pulls rows, so the badges count the same binder the lists show.
 *
 * Maintenance pulls from BOTH the offline-first local cache AND the
 * cloud, merged newest-`updated_at`-wins via mergeByUpdatedAt — so a
 * fresh local tick beats the stale cloud row (and vice-versa). See
 * utils/mergeByUpdatedAt for the full rationale.
 *
 * 131-B12 (binder audit BH-1, EQ-3, BH-2, BH-3, BH-5):
 *   - documents and warranties are counted by the cards' own rules, on the
 *     local day (services/vessel/binderDue): papers split into expired and
 *     expiring, and only warranties ending in the next 30 days, not ones
 *     that ended years ago;
 *   - the overdue count shows from the phone's own binder straight away and
 *     is refined when the cloud answers, which can take seconds or never
 *     come at sea;
 *   - every count waits for the local database to open for this account
 *     before reading it, as R&M and Stores do. On a cold start the Vessel
 *     page could ask first, the read threw, and the badge stayed blank until
 *     something changed. When it can't be read, the log says so.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { DATA_EVENTS } from '../utils/dataChangeEvents';
import { mergeByUpdatedAt } from '../utils/mergeByUpdatedAt';
import { createLogger } from '../utils/createLogger';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import { subscribeSharedBinders } from '../services/vessel/sharedBinders';
// Already in the first load (authStore opens it at sign-in), so a static import costs nothing.
import { initLocalDatabase } from '../services/vessel/LocalDatabase';
import { documentsDue, warrantiesEndingSoon } from '../services/vessel/binderDue';
import type { MaintenanceTask } from '../types';

const log = createLogger('VesselReadiness');

export interface VesselReadinessCounts {
    overdueCount: number;
    /** Papers past their last day. */
    expiredDocsCount: number;
    /** Papers still valid that expire within 30 days. */
    expiringDocsCount: number;
    /** Warranties in force that end within 30 days. */
    expiringEquipCount: number;
}

const EMPTY_COUNTS: VesselReadinessCounts = {
    overdueCount: 0,
    expiredDocsCount: 0,
    expiringDocsCount: 0,
    expiringEquipCount: 0,
};
const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

/** Why a badge was not counted, without naming any row. */
const reason = (error: unknown): unknown => (error instanceof Error ? error.message : error);

/**
 * The phone's binder, open for this account, before any synchronous read
 * (131-B12, BH-5): joins the same file switch R&M and Stores wait for. False,
 * and a line in the log, when it can't be opened.
 */
async function localBinderReady(scope: AuthIdentityScope, badge: string): Promise<boolean> {
    try {
        // A count asked for by the account that has just signed out (its
        // listener can still fire before the page moves on) must never
        // switch the files back to it.
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        await initLocalDatabase(scope.userId);
        return true;
    } catch (error) {
        log.warn(`${badge} badge: the binder on this phone could not be opened`, reason(error));
        return false;
    }
}

export function useVesselReadinessCounts(): VesselReadinessCounts {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    const [scopedCounts, setScopedCounts] = useState<{
        scope: AuthIdentityScope;
        counts: VesselReadinessCounts;
    }>(() => ({ scope: identityScope, counts: EMPTY_COUNTS }));
    const countsBelongToCurrentIdentity =
        scopedCounts.scope.key === identityScope.key &&
        scopedCounts.scope.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(scopedCounts.scope);

    useEffect(() => {
        let cancelled = false;
        const actionScope = identityScope;
        let maintenanceEpoch = 0;
        let documentsEpoch = 0;
        let equipmentEpoch = 0;
        setScopedCounts({ scope: actionScope, counts: EMPTY_COUNTS });

        const setCounts = (counts: Partial<VesselReadinessCounts>) =>
            setScopedCounts((current) => ({
                scope: actionScope,
                counts: { ...(current.scope === actionScope ? current.counts : EMPTY_COUNTS), ...counts },
            }));

        const refetchMaintenance = async () => {
            const requestEpoch = ++maintenanceEpoch;
            const stale = () =>
                cancelled || requestEpoch !== maintenanceEpoch || !isAuthIdentityScopeCurrent(actionScope);
            try {
                const [
                    { LocalMaintenanceService },
                    { MaintenanceService, statusWithReading },
                    { LocalEngineHoursService },
                    localReady,
                ] = await Promise.all([
                    import('../services/vessel/LocalMaintenanceService'),
                    import('../services/MaintenanceService'),
                    import('../services/vessel/LocalEngineHoursService'),
                    localBinderReady(actionScope, 'Maintenance'),
                ]);
                if (stale()) return;

                // The same red R&M shows, by R&M's own rule (statusWithReading,
                // 132-B15): overdue by LOCAL calendar day, so a task due at
                // 7:34 pm today is "Due today" in both places rather than
                // overdue here from 7:35, and overdue by engine hours too,
                // counted from the R&M binder's shared reading. With no
                // reading, hour-based tasks are judged on their date alone. A
                // pre-trip check waits for a trip and an open repair is to
                // fix: neither is ever overdue, so neither lights the badge.
                const engineHours = LocalEngineHoursService.getReading(actionScope).hours;
                const now = new Date();
                const countOverdue = (tasks: MaintenanceTask[]) =>
                    tasks.filter((t) => t.is_active && statusWithReading(t, engineHours, now).status === 'red').length;

                // The phone's own count first (BH-3): it is there at once,
                // offline included, where the cloud can take seconds or never
                // answer at sea.
                const localTasks = localReady ? LocalMaintenanceService.getTasks() : [];
                if (localReady) setCounts({ overdueCount: countOverdue(localTasks) });

                let cloudTasks: MaintenanceTask[] | null = null;
                try {
                    cloudTasks = await MaintenanceService.getTasks();
                } catch {
                    /* offline — the phone's count stands */
                }
                if (stale() || cloudTasks === null) return;

                // Then refined by the cloud: newest-wins merge so a fresh
                // local tick isn't clobbered by a stale cloud row (the
                // original "1 Overdue" bug).
                setCounts({ overdueCount: countOverdue(mergeByUpdatedAt(localTasks, cloudTasks)) });
            } catch (error) {
                // Nothing counted: the badge keeps what it showed.
                log.warn('Maintenance badge not counted', reason(error));
            }
        };

        const refetchDocs = async () => {
            const requestEpoch = ++documentsEpoch;
            try {
                const [{ LocalDocumentService }, localReady] = await Promise.all([
                    import('../services/vessel/LocalDocumentService'),
                    localBinderReady(actionScope, 'Documents'),
                ]);
                if (cancelled || requestEpoch !== documentsEpoch || !isAuthIdentityScopeCurrent(actionScope)) return;
                if (!localReady) return;
                // '1 expired · 1 expiring', by the cards' own rule (BH-2).
                const { expired, expiring } = documentsDue(LocalDocumentService.getAll());
                setCounts({ expiredDocsCount: expired, expiringDocsCount: expiring });
            } catch (error) {
                log.warn('Documents badge not counted', reason(error));
            }
        };

        const refetchEquip = async () => {
            const requestEpoch = ++equipmentEpoch;
            try {
                const [{ LocalEquipmentService }, localReady] = await Promise.all([
                    import('../services/vessel/LocalEquipmentService'),
                    localBinderReady(actionScope, 'Equipment'),
                ]);
                if (cancelled || requestEpoch !== equipmentEpoch || !isAuthIdentityScopeCurrent(actionScope)) return;
                if (!localReady) return;
                // Ending in the next 30 days, not ended years ago (BH-1, EQ-3).
                setCounts({ expiringEquipCount: warrantiesEndingSoon(LocalEquipmentService.getAll()) });
            } catch (error) {
                log.warn('Equipment badge not counted', reason(error));
            }
        };

        // Initial fetch.
        void refetchMaintenance();
        void refetchDocs();
        void refetchEquip();

        // Per-source listeners — fire only when their data changes.
        const onMaintenance = () => void refetchMaintenance();
        const onDocs = () => void refetchDocs();
        const onEquip = () => void refetchEquip();

        // Visibility change refetches everything in case the user mutated
        // state on another device while this one was backgrounded.
        const onVisibility = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            void refetchMaintenance();
            void refetchDocs();
            void refetchEquip();
        };

        const refetchAll = () => {
            void refetchMaintenance();
            void refetchDocs();
            void refetchEquip();
        };
        const unsubscribeBinders = subscribeSharedBinders(refetchAll);
        let unsubscribeSync: (() => void) | null = null;
        void import('../services/vessel/SyncService')
            .then(({ onSyncComplete }) => {
                if (cancelled) return;
                unsubscribeSync = onSyncComplete((result) => {
                    // Pruned too: an overdue task deleted on another device
                    // must leave the badge without a remount.
                    if (result.pulled > 0 || (result.pruned ?? 0) > 0 || (result.discardedShared ?? 0) > 0) {
                        refetchAll();
                    }
                });
            })
            .catch(() => {
                /* no background sync in this build: the other triggers still apply */
            });

        if (typeof window !== 'undefined') {
            window.addEventListener(DATA_EVENTS.MAINTENANCE, onMaintenance);
            window.addEventListener(DATA_EVENTS.DOCUMENTS, onDocs);
            window.addEventListener(DATA_EVENTS.EQUIPMENT, onEquip);
            document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
            cancelled = true;
            unsubscribeBinders();
            unsubscribeSync?.();
            maintenanceEpoch++;
            documentsEpoch++;
            equipmentEpoch++;
            if (typeof window !== 'undefined') {
                window.removeEventListener(DATA_EVENTS.MAINTENANCE, onMaintenance);
                window.removeEventListener(DATA_EVENTS.DOCUMENTS, onDocs);
                window.removeEventListener(DATA_EVENTS.EQUIPMENT, onEquip);
                document.removeEventListener('visibilitychange', onVisibility);
            }
        };
    }, [identityScope]);

    return countsBelongToCurrentIdentity ? scopedCounts.counts : EMPTY_COUNTS;
}
