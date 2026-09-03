/**
 * DepartureCastOffRow — the departure-date input and the Cast Off CTA that
 * share one row above the readiness cards.
 *
 * Moved verbatim out of components/CrewManagement.tsx. The
 * `selectedPassageId && isSelectedPassageOwner` guard stays at the call site,
 * so this renders only where it rendered before.
 */
import React from 'react';
import { AnchorIcon, CalendarGridIcon } from '../Icons';
import { triggerHaptic } from '../../utils/system';
import { localDateValue, nextDepartureSlot } from '../../services/passageSummarySchedule';
import { type AuthIdentityScope } from '../../services/authIdentityScope';

interface DepartureCastOffRowProps {
    planDeparture: string;
    handleDepartureDateChange: (value: string) => void;
    scopeStillOwnsPage: (scope: AuthIdentityScope) => boolean;
    renderScope: AuthIdentityScope;
    setShowCastOff: (open: boolean) => void;
    allCardsReady: boolean;
}

export const DepartureCastOffRow: React.FC<DepartureCastOffRowProps> = ({
    planDeparture,
    handleDepartureDateChange,
    scopeStillOwnsPage,
    renderScope,
    setShowCastOff,
    allCardsReady,
}) => {
    return (
        <div className="mb-4 flex items-end gap-2">
            {/* Departure date — date only, time decided later */}
            <div className="flex-1 min-w-0">
                <label className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-1 flex items-center gap-1.5">
                    <CalendarGridIcon className="w-3 h-3" />
                    <span>Departure Date</span>
                </label>
                <input
                    type="date"
                    aria-label="Departure Date"
                    value={planDeparture ? planDeparture.slice(0, 10) : ''}
                    min={localDateValue(nextDepartureSlot())}
                    onChange={(event) => handleDepartureDateChange(event.target.value)}
                    className="w-full bg-white/4 border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-hidden focus:border-violet-500/30 transition-colors scheme-dark"
                />
            </div>

            {/* Cast Off CTA */}
            <button
                onClick={() => {
                    if (!scopeStillOwnsPage(renderScope)) return;
                    setShowCastOff(true);
                    triggerHaptic('medium');
                }}
                // THE gate, and the ONLY gate (Shane 2026-08-26:
                // "happy for the cast off not to be green until
                // all of the below cards are green. i just dont
                // want any other hold up once the cast off button
                // is ready to push"). Readiness cards lock this
                // button; once it lights up, everything after it
                // — route check, GPS — is advisory or automatic.
                disabled={!allCardsReady}
                // Locked reads as inert, not invisible: opacity-30 over
                // gray-500 left the label unreadable in sunlight, so the
                // skipper could not see what the gate was even called.
                className={`shrink-0 px-5 py-2.5 rounded-xl text-sm font-bold uppercase tracking-widest border transition-all active:scale-[0.97] disabled:opacity-100 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 ${
                    allCardsReady
                        ? 'bg-linear-to-r from-emerald-500/10 to-teal-500/10 border-emerald-500/20 text-emerald-300 hover:from-emerald-500/20 hover:to-teal-500/20'
                        : 'bg-white/3 border-white/10 text-gray-400'
                } inline-flex items-center justify-center gap-2`}
            >
                <AnchorIcon className="w-4 h-4" />
                <span>Cast Off</span>
            </button>
        </div>
    );
};
