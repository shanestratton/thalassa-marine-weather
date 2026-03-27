/**
 * PassagePlanningPanel — Inline passage plan editor.
 *
 * Allows setting departure/ETA dates, ports, notes, and crew count
 * for the selected draft passage. Used within CrewManagement.
 */
import React from 'react';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';

export interface PassagePlanningPanelProps {
    planDeparture: string;
    planEta: string;
    planDeparturePort: string;
    planDestPort: string;
    planNotes: string;
    planCrewCount: number;
    savingPlan: boolean;
    onDepartureChange: (v: string) => void;
    onEtaChange: (v: string) => void;
    onDeparturePortChange: (v: string) => void;
    onDestPortChange: (v: string) => void;
    onNotesChange: (v: string) => void;
    onSave: () => void;
    onCancel: () => void;
}

export const PassagePlanningPanel: React.FC<PassagePlanningPanelProps> = ({
    planDeparture,
    planEta,
    planDeparturePort,
    planDestPort,
    planNotes,
    planCrewCount,
    savingPlan,
    onDepartureChange,
    onEtaChange,
    onDeparturePortChange,
    onDestPortChange,
    onNotesChange,
    onSave,
    onCancel,
}) => {
    return (
        <div className="bg-white/[0.02] border border-violet-500/15 rounded-xl p-4 space-y-3 animate-in slide-in-from-top-2 duration-200">
            {/* Crew count badge (read-only) */}
            <div className="flex items-center justify-between">
                <span className="text-[10px] font-black text-violet-400/60 uppercase tracking-widest">
                    Passage Details
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-[10px] font-bold text-sky-400">
                    👥 {planCrewCount} crew
                </span>
            </div>

            {/* Departure + ETA */}
            <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                        Departure
                    </label>
                    <input
                        type="date"
                        value={planDeparture ? planDeparture.slice(0, 10) : ''}
                        onChange={(e) => onDepartureChange(e.target.value ? e.target.value + 'T08:00' : '')}
                        onFocus={scrollInputAboveKeyboard}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-[11px] text-white focus:outline-none focus:border-violet-500/40 [color-scheme:dark]"
                    />
                </div>
                <div className="min-w-0">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                        ETA
                    </label>
                    <input
                        type="date"
                        value={planEta ? planEta.slice(0, 10) : ''}
                        onChange={(e) => onEtaChange(e.target.value ? e.target.value + 'T18:00' : '')}
                        onFocus={scrollInputAboveKeyboard}
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-[11px] text-white focus:outline-none focus:border-violet-500/40 [color-scheme:dark]"
                    />
                </div>
            </div>

            {/* Ports */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                        From
                    </label>
                    <input
                        type="text"
                        value={planDeparturePort}
                        onChange={(e) => onDeparturePortChange(e.target.value)}
                        onFocus={scrollInputAboveKeyboard}
                        placeholder="Departure port"
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/40"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                        To
                    </label>
                    <input
                        type="text"
                        value={planDestPort}
                        onChange={(e) => onDestPortChange(e.target.value)}
                        onFocus={scrollInputAboveKeyboard}
                        placeholder="Destination"
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/40"
                    />
                </div>
            </div>

            {/* Notes */}
            <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 block">
                    Notes
                </label>
                <textarea
                    value={planNotes}
                    onChange={(e) => onNotesChange(e.target.value)}
                    onFocus={scrollInputAboveKeyboard}
                    placeholder="Weather windows, tidal constraints, fuel stops…"
                    rows={2}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500/40 resize-none"
                />
            </div>

            {/* Readiness indicators */}
            {planDeparture && planEta && (
                <div className="flex gap-2 text-[10px]">
                    <span className="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/15 text-emerald-400 font-bold">
                        ✅ Dates set
                    </span>
                    <span
                        className={`px-2 py-1 rounded-lg font-bold ${
                            planCrewCount > 1
                                ? 'bg-emerald-500/10 border border-emerald-500/15 text-emerald-400'
                                : 'bg-amber-500/10 border border-amber-500/15 text-amber-400'
                        }`}
                    >
                        {planCrewCount > 1 ? '✅' : '⚠️'} {planCrewCount} crew
                    </span>
                </div>
            )}

            {/* Save + Cancel */}
            <div className="flex gap-2">
                <button
                    onClick={onSave}
                    disabled={savingPlan}
                    className="flex-1 py-2.5 bg-violet-500/15 border border-violet-500/25 rounded-xl text-[11px] font-bold text-violet-300 uppercase tracking-widest hover:bg-violet-500/25 transition-all active:scale-[0.97] disabled:opacity-40"
                >
                    {savingPlan ? '⏳ Saving…' : '💾 Save'}
                </button>
                <button
                    onClick={onCancel}
                    className="px-4 py-2.5 bg-white/[0.04] border border-white/[0.06] rounded-xl text-[11px] font-bold text-gray-400 hover:text-white transition-colors"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
};
