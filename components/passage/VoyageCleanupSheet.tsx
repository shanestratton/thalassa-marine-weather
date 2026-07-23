/**
 * VoyageCleanupSheet — admin-style "Manage saved trips" surface.
 *
 * The normal drafts dropdown filters to status='planning' and the
 * logbook UI groups by voyageId with a 2+ entries minimum, so a test
 * passage saved into the wrong status, or an orphan voyages-table
 * row with no shiplog entries, can become invisible to both. This
 * sheet shows EVERYTHING for the signed-in user:
 *
 *   - Every voyage row (any status — planning, active, completed,
 *     aborted) from the voyages table
 *   - Every planned route in the shiplog (routes whose voyageId
 *     starts with `planned_`)
 *
 * Each row has its own delete button. Voyage rows go through
 * VoyageService.deleteVoyageById; planned-route rows go through
 * ShipLogService.deleteVoyage which already cascades to the
 * voyages-table draft + active voyage if the names match.
 *
 * Accessible from the LegPickerDropdown's footer link.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { triggerHaptic } from '../../utils/system';
import { deleteVoyageById, getAllVoyagesForUser, type Voyage, type VoyageStatus } from '../../services/VoyageService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';

interface VoyageCleanupSheetProps {
    isOpen: boolean;
    onClose: () => void;
    /** Fired after a successful delete so parents (LegPicker, etc.) can refresh. */
    onChanged?: () => void;
}

interface SavedRoute {
    /** Logbook voyageId (e.g. "planned_<ts>_<rand>"). */
    id: string;
    /** Display label — first → last waypointName from the entries. */
    label: string;
    /** Subtitle: distance + date. */
    sublabel: string;
}

const STATUS_STYLE: Record<VoyageStatus, string> = {
    planning: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
    active: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    completed: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    aborted: 'bg-red-500/10 text-red-300 border-red-500/20',
};

export const VoyageCleanupSheet: React.FC<VoyageCleanupSheetProps> = ({ isOpen, onClose, onChanged }) => {
    const [voyages, setVoyages] = useState<Voyage[]>([]);
    const [routes, setRoutes] = useState<SavedRoute[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const refreshRequestRef = useRef(0);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    const refresh = useCallback(async () => {
        const operationScope = getAuthIdentityScope();
        const requestId = ++refreshRequestRef.current;
        const requestIsCurrent = () =>
            requestId === refreshRequestRef.current && isAuthIdentityScopeCurrent(operationScope);
        setLoading(true);
        try {
            const [allVoyages, { fetchRoutesAndTracks }] = await Promise.all([
                getAllVoyagesForUser(),
                import('../../services/shiplog/RoutesAndTracks'),
            ]);
            if (!requestIsCurrent()) return;
            const ra = await fetchRoutesAndTracks(true);
            if (!requestIsCurrent()) return;
            setVoyages(allVoyages);
            setRoutes(
                ra.routes.map((r) => ({
                    id: r.id,
                    label: r.label,
                    sublabel: r.sublabel,
                })),
            );
        } catch (e) {
            if (!requestIsCurrent()) return;
            console.warn('[VoyageCleanup] refresh failed:', e);
        }
        if (requestIsCurrent()) setLoading(false);
    }, []);

    useEffect(() => {
        if (isOpen) void refresh();
        return () => {
            refreshRequestRef.current += 1;
        };
    }, [isOpen, refresh]);

    const handleDeleteVoyage = useCallback(
        async (voyage: Voyage) => {
            const operationScope = getAuthIdentityScope();
            setBusyId(voyage.id);
            triggerHaptic('medium');
            const ok = await deleteVoyageById(voyage.id);
            if (!isAuthIdentityScopeCurrent(operationScope)) return;
            if (ok) {
                setVoyages((prev) => prev.filter((v) => v.id !== voyage.id));
                onChanged?.();
            }
            setBusyId(null);
            setConfirmId(null);
        },
        [onChanged],
    );

    const handleDeleteRoute = useCallback(
        async (route: SavedRoute) => {
            const operationScope = getAuthIdentityScope();
            const operationIsCurrent = () => isAuthIdentityScopeCurrent(operationScope);
            setBusyId(route.id);
            triggerHaptic('medium');
            try {
                const { ShipLogService } = await import('../../services/ShipLogService');
                if (!operationIsCurrent()) return;
                const ok = await ShipLogService.deleteVoyage(route.id);
                if (!operationIsCurrent()) return;
                if (ok) {
                    setRoutes((prev) => prev.filter((r) => r.id !== route.id));
                    // Route delete cascades to the matching voyage row
                    // (EntryCrud.deleteVoyage handles that), so re-fetch
                    // voyages so the cleanup view stays consistent.
                    const all = await getAllVoyagesForUser();
                    if (!operationIsCurrent()) return;
                    setVoyages(all);
                    onChanged?.();
                }
            } catch (e) {
                if (!operationIsCurrent()) return;
                console.warn('[VoyageCleanup] route delete failed:', e);
            }
            if (!operationIsCurrent()) return;
            setBusyId(null);
            setConfirmId(null);
        },
        [onChanged],
    );

    if (!isOpen) return null;

    const combinedCount = voyages.length + routes.length;

    return (
        <OverlayPortal className="bg-black/80 flex items-stretch justify-center" onClick={onClose} role="presentation">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="voyage-cleanup-title"
                className="w-full max-w-lg bg-[#0a0e14] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/[0.06] shrink-0">
                    <div>
                        <h2 id="voyage-cleanup-title" className="text-base font-black text-white">
                            Manage Saved Trips
                        </h2>
                        <p className="text-[11px] text-amber-400/60 uppercase tracking-widest mt-0.5">
                            {loading ? 'Loading…' : `${combinedCount} saved`}
                        </p>
                    </div>
                    <button
                        ref={closeButtonRef}
                        onClick={onClose}
                        className="w-9 h-9 rounded-full bg-white/5 text-gray-400 flex items-center justify-center hover:bg-white/10"
                        aria-label="Close cleanup sheet"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-5">
                    {/* Empty state */}
                    {!loading && combinedCount === 0 && (
                        <div className="text-center py-12">
                            <p className="text-2xl mb-2">⚓</p>
                            <p className="text-sm text-gray-400">No saved trips found.</p>
                        </div>
                    )}

                    {/* ── Voyages table ── */}
                    {voyages.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest px-1">
                                Voyages ({voyages.length})
                            </h3>
                            <p className="text-[11px] text-gray-500 px-1 leading-snug">
                                Trip records — each row is a draft, active, completed, or aborted voyage. Deleting a row
                                removes ONLY this trip record (not its planned route in the log book — those are listed
                                separately below).
                            </p>
                            {voyages.map((v) => (
                                <div
                                    key={v.id}
                                    className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-2"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-white truncate">{v.voyage_name}</p>
                                            <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                                                {v.departure_port || '?'} → {v.destination_port || '?'}
                                            </p>
                                            <p className="text-[10px] text-gray-500 mt-0.5">
                                                {new Date(v.created_at).toLocaleDateString()} · ID {v.id.slice(0, 8)}…
                                            </p>
                                        </div>
                                        <span
                                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border shrink-0 ${STATUS_STYLE[v.status]}`}
                                        >
                                            {v.status}
                                        </span>
                                    </div>
                                    {confirmId === `voyage:${v.id}` ? (
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleDeleteVoyage(v)}
                                                disabled={busyId === v.id}
                                                className="flex-1 py-2 rounded-lg bg-red-500/15 border border-red-500/25 text-red-300 text-[11px] font-bold uppercase tracking-wider hover:bg-red-500/25 active:scale-[0.97] disabled:opacity-40"
                                            >
                                                {busyId === v.id ? 'Deleting…' : 'Confirm Delete'}
                                            </button>
                                            <button
                                                onClick={() => setConfirmId(null)}
                                                className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-300 text-[11px] font-bold uppercase tracking-wider hover:bg-white/[0.08] active:scale-[0.97]"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => setConfirmId(`voyage:${v.id}`)}
                                            className="w-full py-2 rounded-lg bg-red-500/[0.06] border border-red-500/15 text-red-300/90 text-[11px] font-bold uppercase tracking-wider hover:bg-red-500/[0.12] active:scale-[0.97]"
                                        >
                                            🗑 Delete
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ── Logbook routes ── */}
                    {routes.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest px-1">
                                Logbook Planned Routes ({routes.length})
                            </h3>
                            <p className="text-[11px] text-gray-500 px-1 leading-snug">
                                Saved planned routes (the polylines shown on the chart). Deleting a route also removes
                                its matching voyage row above and ends any active voyage with the same name.
                            </p>
                            {routes.map((r) => (
                                <div
                                    key={r.id}
                                    className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-2"
                                >
                                    <div>
                                        <p className="text-sm font-bold text-white truncate">{r.label}</p>
                                        <p className="text-[11px] text-gray-400 mt-0.5 truncate">{r.sublabel}</p>
                                        <p className="text-[10px] text-gray-500 mt-0.5">ID {r.id.slice(0, 24)}…</p>
                                    </div>
                                    {confirmId === `route:${r.id}` ? (
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleDeleteRoute(r)}
                                                disabled={busyId === r.id}
                                                className="flex-1 py-2 rounded-lg bg-red-500/15 border border-red-500/25 text-red-300 text-[11px] font-bold uppercase tracking-wider hover:bg-red-500/25 active:scale-[0.97] disabled:opacity-40"
                                            >
                                                {busyId === r.id ? 'Deleting…' : 'Confirm Delete'}
                                            </button>
                                            <button
                                                onClick={() => setConfirmId(null)}
                                                className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-300 text-[11px] font-bold uppercase tracking-wider hover:bg-white/[0.08] active:scale-[0.97]"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => setConfirmId(`route:${r.id}`)}
                                            className="w-full py-2 rounded-lg bg-red-500/[0.06] border border-red-500/15 text-red-300/90 text-[11px] font-bold uppercase tracking-wider hover:bg-red-500/[0.12] active:scale-[0.97]"
                                        >
                                            🗑 Delete (cascades to voyage row)
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-white/[0.06] p-3 shrink-0">
                    <button
                        onClick={refresh}
                        disabled={loading}
                        className="w-full py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-300 text-[11px] font-bold uppercase tracking-wider hover:bg-white/[0.08] active:scale-[0.97] disabled:opacity-50"
                    >
                        {loading ? 'Refreshing…' : '↻ Refresh'}
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
