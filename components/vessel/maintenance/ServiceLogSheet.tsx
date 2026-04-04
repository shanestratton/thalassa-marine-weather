/**
 * ServiceLogSheet — Bottom sheet for recording a maintenance service event.
 * Extracted from MaintenanceHub to reduce component size.
 */
import React from 'react';
import type { TaskWithStatus, TrafficLight } from '../../../services/MaintenanceService';

const LIGHT_COLORS: Record<TrafficLight, { dot: string; text: string }> = {
    red: { dot: 'bg-red-500', text: 'text-red-400' },
    yellow: { dot: 'bg-amber-400', text: 'text-amber-400' },
    green: { dot: 'bg-emerald-500', text: 'text-emerald-400' },
    grey: { dot: 'bg-gray-500', text: 'text-gray-400' },
};

interface ServiceLogSheetProps {
    task: TaskWithStatus;
    engineHours: number;
    notes: string;
    onNotesChange: (v: string) => void;
    saving: boolean;
    onLog: () => void;
    onHistory: () => void;
    onEdit: () => void;
    onClose: () => void;
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
}) => (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={onClose}>
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60" />

        {/* Sheet */}
        <div
            className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,20px))] animate-in fade-in zoom-in-95 duration-300 max-h-[calc(100dvh-6rem)]"
            onClick={(e) => e.stopPropagation()}
        >
            {/* Close X */}
            <button
                onClick={onClose}
                className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
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
            <div className="flex items-center gap-3 mb-5">
                <div className={`w-3 h-3 rounded-full ${LIGHT_COLORS[task.status].dot}`} />
                <div className="flex-1">
                    <h3 className="text-lg font-black text-white">{task.title}</h3>
                    <p className={`text-xs font-bold ${LIGHT_COLORS[task.status].text}`}>{task.statusLabel}</p>
                </div>
            </div>

            {/* Engine hours snapshot — only for engine-based tasks */}
            {task.trigger_type === 'engine_hours' && (
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                    <p className="text-label text-gray-400 font-bold uppercase tracking-widest mb-1">
                        Engine Hours at Service
                    </p>
                    <p className="text-xl font-black text-white">{engineHours.toLocaleString()} hrs</p>
                </div>
            )}

            {/* Notes */}
            <div className="mb-4">
                <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1">
                    Notes (Optional)
                </label>
                <textarea
                    value={notes}
                    onChange={(e) => onNotesChange(e.target.value)}
                    placeholder="Found slight weeping on raw water pump gasket..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white placeholder-gray-500 resize-none h-20 outline-none focus:border-sky-500/30"
                />
            </div>

            {/* Action buttons */}
            <div className="flex gap-3">
                <button
                    aria-label="View history"
                    onClick={onHistory}
                    className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-gray-400 hover:bg-white/10 transition-colors"
                >
                    History
                </button>
                <button
                    aria-label="Edit item details"
                    onClick={onEdit}
                    className="px-4 py-3 bg-sky-500/10 border border-sky-500/20 rounded-xl text-xs font-bold text-sky-400 hover:bg-sky-500/20 transition-colors"
                >
                    ✎ Edit
                </button>
                <button
                    aria-label="Open activity log"
                    onClick={onLog}
                    disabled={saving}
                    className="flex-1 py-3.5 bg-gradient-to-r from-emerald-600 to-emerald-600 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500 transition-all active:scale-[0.97] disabled:opacity-50"
                >
                    {saving ? (
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
                    ) : (
                        '✓ Log Service'
                    )}
                </button>
            </div>
        </div>
    </div>
);
