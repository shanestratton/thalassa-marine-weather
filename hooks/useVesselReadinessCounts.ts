/**
 * useVesselReadinessCounts — live badge counts for the Vessel-tab Boat
 * Binder tiles: maintenance OVERDUE, documents EXPIRING, equipment
 * WARRANTY-soon.
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
 *      changes synced from another device while backgrounded).
 *
 * Maintenance pulls from BOTH the offline-first local cache AND the
 * cloud, merged newest-`updated_at`-wins via mergeByUpdatedAt — so a
 * fresh local tick beats the stale cloud row (and vice-versa). See
 * utils/mergeByUpdatedAt for the full rationale.
 */
import { useEffect, useState } from 'react';
import { DATA_EVENTS } from '../utils/dataChangeEvents';
import { mergeByUpdatedAt } from '../utils/mergeByUpdatedAt';

/** Expiry look-ahead window for docs + equipment warranty badges. */
const EXPIRY_WINDOW_MS = 30 * 86_400_000; // 30 days

export interface VesselReadinessCounts {
    overdueCount: number;
    expiringDocsCount: number;
    expiringEquipCount: number;
}

export function useVesselReadinessCounts(): VesselReadinessCounts {
    const [overdueCount, setOverdueCount] = useState(0);
    const [expiringDocsCount, setExpiringDocsCount] = useState(0);
    const [expiringEquipCount, setExpiringEquipCount] = useState(0);

    useEffect(() => {
        let cancelled = false;

        const refetchMaintenance = async () => {
            try {
                const [{ LocalMaintenanceService }, { MaintenanceService }] = await Promise.all([
                    import('../services/vessel/LocalMaintenanceService'),
                    import('../services/MaintenanceService'),
                ]);
                if (cancelled) return;

                const localTasks = LocalMaintenanceService.getTasks();
                let cloudTasks: typeof localTasks = [];
                try {
                    cloudTasks = await MaintenanceService.getTasks();
                } catch {
                    /* offline — local-only count */
                }
                if (cancelled) return;

                // Newest-wins merge so a fresh local tick isn't clobbered
                // by a stale cloud row (the original "1 Overdue" bug).
                const merged = mergeByUpdatedAt(localTasks, cloudTasks);
                const now = Date.now();
                const overdue = merged.filter(
                    (t) => t.is_active && t.next_due_date && Date.parse(t.next_due_date) < now,
                ).length;
                setOverdueCount(overdue);
            } catch {
                /* both sources unavailable — leave previous count */
            }
        };

        const refetchDocs = async () => {
            try {
                const { LocalDocumentService } = await import('../services/vessel/LocalDocumentService');
                const docs = LocalDocumentService.getAll();
                if (cancelled) return;
                const cutoff = Date.now() + EXPIRY_WINDOW_MS;
                setExpiringDocsCount(docs.filter((d) => d.expiry_date && Date.parse(d.expiry_date) <= cutoff).length);
            } catch {
                /* offline — no badge */
            }
        };

        const refetchEquip = async () => {
            try {
                const { LocalEquipmentService } = await import('../services/vessel/LocalEquipmentService');
                const items = LocalEquipmentService.getAll();
                if (cancelled) return;
                const cutoff = Date.now() + EXPIRY_WINDOW_MS;
                setExpiringEquipCount(
                    items.filter((e) => e.warranty_expiry && Date.parse(e.warranty_expiry) <= cutoff).length,
                );
            } catch {
                /* offline — no badge */
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

        if (typeof window !== 'undefined') {
            window.addEventListener(DATA_EVENTS.MAINTENANCE, onMaintenance);
            window.addEventListener(DATA_EVENTS.DOCUMENTS, onDocs);
            window.addEventListener(DATA_EVENTS.EQUIPMENT, onEquip);
            document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
            cancelled = true;
            if (typeof window !== 'undefined') {
                window.removeEventListener(DATA_EVENTS.MAINTENANCE, onMaintenance);
                window.removeEventListener(DATA_EVENTS.DOCUMENTS, onDocs);
                window.removeEventListener(DATA_EVENTS.EQUIPMENT, onEquip);
                document.removeEventListener('visibilitychange', onVisibility);
            }
        };
    }, []);

    return { overdueCount, expiringDocsCount, expiringEquipCount };
}
