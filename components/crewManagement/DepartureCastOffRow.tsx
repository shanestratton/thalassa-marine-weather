/**
 * DepartureCastOffRow — the departure-date input and the Cast Off CTA that
 * share one row above the readiness cards.
 *
 * Moved verbatim out of components/CrewManagement.tsx. The
 * `selectedPassageId && isSelectedPassageOwner` guard stays at the call site,
 * so this renders only where it rendered before.
 *
 * 2026-10-06, the page's tier-1 look: Cast Off is the emerald primary once
 * every readiness card is green, and inert glass (label still legible) until.
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
    /**
     * Ownership is painted from this device's last verified answer while the
     * check runs again (cache-first, 2026-10-06): the date waits for the
     * verified one, since only it may change the passage.
     */
    verifying?: boolean;
}

export const DepartureCastOffRow: React.FC<DepartureCastOffRowProps> = ({
    planDeparture,
    handleDepartureDateChange,
    scopeStillOwnsPage,
    renderScope,
    setShowCastOff,
    allCardsReady,
    verifying = false,
}) => {
    return (
        <div className="mb-5 flex items-end gap-2">
            {/* Departure date — date only, time decided later */}
            <div className="flex-1 min-w-0">
                <label className="crew-eyebrow mb-1.5 flex items-center gap-1.5">
                    <CalendarGridIcon className="w-3 h-3" />
                    <span>Departure Date</span>
                </label>
                <input
                    type="date"
                    aria-label="Departure Date"
                    value={planDeparture ? planDeparture.slice(0, 10) : ''}
                    min={localDateValue(nextDepartureSlot())}
                    disabled={verifying}
                    onChange={(event) => handleDepartureDateChange(event.target.value)}
                    className="crew-input scheme-dark [.display-light_&]:scheme-light"
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
                disabled={!allCardsReady || verifying}
                // Locked reads as inert, not invisible: opacity-30 over
                // gray-500 left the label unreadable in sunlight, so the
                // skipper could not see what the gate was even called.
                // The page's emerald primary once it is ready (styles/crew-page.css).
                className={`crew-cta uppercase tracking-widest ${allCardsReady && !verifying ? '' : 'crew-cta--locked'}`}
            >
                <AnchorIcon className="w-4 h-4" />
                <span>Cast Off</span>
            </button>
        </div>
    );
};
