/**
 * WatchAssignSheet — Bottom-sheet picker for assigning a crew member
 * to a specific watch slot.
 *
 * Triggered by tapping a row in WatchScheduleCard. Lists the voyage's
 * accepted crew members + the skipper themselves, plus a "Clear" option
 * to unassign. On selection, calls onAssign with the chosen email/name
 * (or null/null for clear) and closes.
 */

import React from 'react';
import type { CrewMember, CrewRole } from '../../services/CrewService';

interface WatchAssignSheetProps {
    open: boolean;
    onClose: () => void;
    /** The watch slot being assigned (for the header) */
    watchLabel: string;
    watchTimeLabel: string;
    /** Currently-assigned crew email, if any */
    currentEmail: string | null;
    /** All accepted crew for this voyage */
    crew: CrewMember[];
    /** The skipper themselves (so they can take their own watch) */
    skipperEmail?: string;
    skipperName?: string;
    /** Called with email + display name (or null/null to clear) */
    onAssign: (email: string | null, name: string | null) => void;
}

const ROLE_LABEL: Record<CrewRole, string> = {
    'co-skipper': 'Co-Skipper',
    navigator: 'Navigator',
    deckhand: 'Deckhand',
    punter: 'Punter',
};

const ROLE_COLOR: Record<CrewRole, string> = {
    'co-skipper': 'text-amber-300',
    navigator: 'text-sky-300',
    deckhand: 'text-emerald-300',
    punter: 'text-slate-300',
};

/** Pull a friendly first-name display from an email if no other name. */
function emailToName(email: string): string {
    const local = email.split('@')[0];
    return local
        .split(/[._-]/)
        .filter(Boolean)
        .map((s) => s[0].toUpperCase() + s.slice(1))
        .join(' ');
}

export const WatchAssignSheet: React.FC<WatchAssignSheetProps> = ({
    open,
    onClose,
    watchLabel,
    watchTimeLabel,
    currentEmail,
    crew,
    skipperEmail,
    skipperName,
    onAssign,
}) => {
    if (!open) return null;

    const acceptedCrew = crew.filter((c) => c.status === 'accepted');
    const choose = (email: string | null, name: string | null) => {
        onAssign(email, name);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
            {/* Backdrop */}
            <button
                type="button"
                aria-label="Close watch assignment"
                onClick={onClose}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            />

            {/* Sheet */}
            <div className="relative w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-950 border-t border-x border-white/10 rounded-t-3xl shadow-2xl animate-in slide-in-from-bottom duration-200">
                {/* Drag handle */}
                <div className="flex-shrink-0 pt-2 pb-1 flex justify-center">
                    <div className="w-12 h-1 rounded-full bg-white/20" />
                </div>

                {/* Header */}
                <div className="flex-shrink-0 px-5 pt-2 pb-4 border-b border-white/5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-bold text-white">Assign Watch</h2>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                {watchLabel} · <span className="font-mono">{watchTimeLabel}</span>
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            type="button"
                            aria-label="Close"
                            className="shrink-0 p-2 -mr-2 -mt-1 text-slate-400 hover:text-white"
                        >
                            <svg
                                className="w-5 h-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-5 pt-2">
                    {/* Skipper option (always available) */}
                    {skipperEmail && (
                        <button
                            type="button"
                            onClick={() => choose(skipperEmail, skipperName ?? emailToName(skipperEmail))}
                            className={`w-full text-left px-3 py-3 rounded-xl border transition-all active:scale-[0.98] mb-1.5 ${
                                currentEmail === skipperEmail
                                    ? 'bg-amber-500/15 border-amber-500/35'
                                    : 'bg-white/[0.02] border-white/10 hover:bg-white/[0.05]'
                            }`}
                        >
                            <div className="flex items-center gap-3">
                                <span className="text-xl">⚓</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-white">
                                        {skipperName ?? emailToName(skipperEmail)}
                                    </p>
                                    <p className="text-[11px] text-amber-300/80">Skipper</p>
                                </div>
                                {currentEmail === skipperEmail && (
                                    <span className="text-amber-300 text-base font-bold">✓</span>
                                )}
                            </div>
                        </button>
                    )}

                    {/* Accepted crew */}
                    {acceptedCrew.length === 0 && !skipperEmail && (
                        <div className="px-3 py-12 text-center">
                            <span className="text-3xl">👥</span>
                            <p className="mt-2 text-xs text-slate-400">No crew yet — invite crew first</p>
                        </div>
                    )}
                    {acceptedCrew.map((c) => {
                        const displayName = emailToName(c.crew_email);
                        const selected = currentEmail === c.crew_email;
                        return (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => choose(c.crew_email, displayName)}
                                className={`w-full text-left px-3 py-3 rounded-xl border transition-all active:scale-[0.98] mb-1.5 ${
                                    selected
                                        ? 'bg-sky-500/15 border-sky-500/35'
                                        : 'bg-white/[0.02] border-white/10 hover:bg-white/[0.05]'
                                }`}
                            >
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">👤</span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-bold text-white truncate">{displayName}</p>
                                        <p className={`text-[11px] ${ROLE_COLOR[c.role]} truncate`}>
                                            {ROLE_LABEL[c.role]} · {c.crew_email}
                                        </p>
                                    </div>
                                    {selected && <span className="text-sky-300 text-base font-bold">✓</span>}
                                </div>
                            </button>
                        );
                    })}

                    {/* Clear option */}
                    {currentEmail && (
                        <>
                            <div className="my-3 px-3 text-[10px] text-slate-500 uppercase tracking-widest font-bold">
                                or
                            </div>
                            <button
                                type="button"
                                onClick={() => choose(null, null)}
                                className="w-full text-left px-3 py-3 rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition-all active:scale-[0.98]"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">🗑️</span>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-red-300">Clear assignment</p>
                                        <p className="text-[11px] text-red-400/70">Reset slot to unassigned</p>
                                    </div>
                                </div>
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
