/**
 * ServiceLogSheet — Bottom sheet for recording a maintenance service event.
 * Extracted from MaintenanceHub to reduce component size.
 */
import React, { useId, useRef } from 'react';
import { isLocalToday, type TaskWithStatus } from '../../../services/MaintenanceService';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { OverlayPortal } from '../../ui/OverlayPortal';
import { CheckIcon, EditIcon } from '../../icons/UIIcons';
// One traffic-light palette for the card and the sheet — a local copy had
// drifted to a different amber for the same status.
import { LIGHT_COLORS, readableStatusLabel } from './SwipeableTaskCard';

interface ServiceLogSheetProps {
    task: TaskWithStatus;
    /** null until the skipper has entered engine hours — never shown as 0. */
    engineHours: number | null;
    notes: string;
    onNotesChange: (v: string) => void;
    saving: boolean;
    onLog: () => void;
    onHistory: () => void;
    onEdit: () => void;
    onClose: () => void;
}

/**
 * '7:34 pm' when the task was last logged earlier today (local day), else
 * null. Logging again stays allowed: this only says it has been done, which
 * the sheet never did (a daily check was logged nine times on 2026-10-02).
 * The clock form is the one FoundingSkipperInbox uses ('Updated 7:34 pm').
 */
function loggedTodayAt(lastCompleted: string | null | undefined): string | null {
    if (!lastCompleted || !isLocalToday(lastCompleted)) return null;
    const at = new Date(lastCompleted);
    return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

export const ServiceLogSheet: React.FC<ServiceLogSheetProps> = ({
    task,
    engineHours,
    notes,
    onNotesChange,
    saving,
    onLog,
    onHistory,
    onEdit,
    onClose,
}) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const notesId = useId();
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });
    const alreadyLoggedAt = loggedTodayAt(task.last_completed);

    return (
        <OverlayPortal className="flex items-center justify-center p-4" onClick={onClose} role="presentation">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60" />

            {/* Sheet */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="service-log-title"
                className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-5 animate-in fade-in zoom-in-95 duration-300 max-h-[calc(100dvh-12rem)] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Close X */}
                <button
                    ref={closeButtonRef}
                    onClick={onClose}
                    className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                    aria-label="Close service sheet"
                >
                    <svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>

                {/* Task info */}
                <div className="flex items-center gap-3 mb-5 pr-12">
                    <div
                        aria-hidden="true"
                        className={`w-3 h-3 shrink-0 rounded-full ${LIGHT_COLORS[task.status].dot}`}
                    />
                    <div className="flex-1 min-w-0">
                        <h3 id="service-log-title" className="text-lg font-black text-white">
                            {task.title}
                        </h3>
                        <p className={`text-xs font-bold ${LIGHT_COLORS[task.status].text}`}>
                            {readableStatusLabel(task.statusLabel)}
                        </p>
                    </div>
                </div>

                {/* Engine hours snapshot — only for engine-based tasks */}
                {task.trigger_type === 'engine_hours' && (
                    <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest mb-1">
                            Engine hours at service
                        </p>
                        {engineHours === null ? (
                            <>
                                <p className="text-xl font-black text-gray-400">—</p>
                                <p className="text-xs text-gray-400">
                                    Not entered — the next service is scheduled once you enter engine hours
                                </p>
                            </>
                        ) : (
                            <p className="text-xl font-black text-white">{engineHours.toLocaleString()} hrs</p>
                        )}
                    </div>
                )}

                {/* Notes */}
                <div className="mb-4">
                    <label
                        htmlFor={notesId}
                        className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1"
                    >
                        Notes (optional)
                    </label>
                    <textarea
                        id={notesId}
                        value={notes}
                        onChange={(e) => onNotesChange(e.target.value)}
                        placeholder="Found slight weeping on raw water pump gasket..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white placeholder-gray-500 resize-none h-20 outline-hidden focus:border-sky-500/30"
                    />
                </div>

                {alreadyLoggedAt && (
                    <p className="mb-3 text-xs font-semibold text-emerald-400">
                        Already logged today at {alreadyLoggedAt}
                    </p>
                )}

                {/* Action buttons */}
                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={onHistory}
                        className="min-h-[44px] px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-gray-300 hover:bg-white/10 transition-colors"
                    >
                        History
                    </button>
                    <button
                        type="button"
                        aria-label="Edit task"
                        onClick={onEdit}
                        className="flex min-h-[44px] items-center gap-1.5 px-4 py-3 bg-sky-500/10 border border-sky-500/20 rounded-xl text-xs font-bold text-sky-400 hover:bg-sky-500/20 transition-colors"
                    >
                        <EditIcon className="h-3.5 w-3.5 shrink-0" />
                        Edit
                    </button>
                    <button
                        aria-label={saving ? 'Logging service' : 'Log service'}
                        onClick={onLog}
                        disabled={saving}
                        className="flex flex-1 min-h-[44px] items-center justify-center gap-2 py-3.5 bg-linear-to-r from-emerald-600 to-emerald-600 rounded-xl text-sm font-black text-white shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500 transition-all active:scale-[0.97] disabled:opacity-50"
                    >
                        {saving ? (
                            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
                        ) : (
                            <>
                                <CheckIcon className="h-4 w-4 shrink-0" />
                                Log service
                            </>
                        )}
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};
