import React, { Suspense, useCallback, useState, useSyncExternalStore } from 'react';
import type { VesselProfile } from '../../types/vessel';
import { lazyRetry } from '../../utils/lazyRetry';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { runWithConfirmedDraft } from '../../stores/draftConfirmStore';
import { isAutorouteTrialOn, PLAN_YOUR_DAY_TRIAL_OFF, useAutorouteTrialOn } from '../../services/autorouteTrialSwitch';
import './DayPlanner.css';

const DayPlannerSheet = lazyRetry(() => import('./DayPlannerSheet'));

export function DayPlannerEntry({
    vessel,
    mapboxToken,
    onOpenSaved,
    isPro,
    onUpgrade,
}: {
    vessel: VesselProfile | null;
    mapboxToken: string;
    onOpenSaved: (id: string) => void;
    /** Plan Your Day routes every leg with Thalassa's router, as Auto does:
     *  Pro route planning, like Auto (review fix-up, 2026-10-01). It used to
     *  be held to Shane's account by the retired autorouting trial's server
     *  allowlist; a free account now gets the upgrade prompt. */
    isPro: boolean;
    onUpgrade: () => void;
}) {
    const [open, setOpen] = useState(false);
    // Opt-in (2026-10-01): Plan Your Day routes with Auto route (trial),
    // off by default in Settings → Preferences. Pro alone is every beta
    // account, so a Pro tap with the switch off says where the switch is
    // and opens nothing; switched off while open, the planner shuts.
    const trialOn = useAutorouteTrialOn();
    const [askedWhileOff, setAskedWhileOff] = useState(false);
    // Any change of the switch starts the entry afresh: switched off, the
    // planner shuts and stays shut (switched on again it waits for a tap and
    // the draft check); switched on, the note goes.
    const [trialSeen, setTrialSeen] = useState(trialOn);
    if (trialSeen !== trialOn) {
        setTrialSeen(trialOn);
        setOpen(false);
        setAskedWhileOff(false);
    }
    const close = useCallback(() => setOpen(false), []);
    const openSaved = useCallback(
        (id: string) => {
            setOpen(false);
            onOpenSaved(id);
        },
        [onOpenSaved],
    );
    const scope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope);
    return (
        <>
            <button
                type="button"
                className="day-plan-entry"
                aria-haspopup="dialog"
                aria-expanded={open}
                // Every plan is worked out against the draft: it opens once the
                // skipper has confirmed it (Shane 2026-09-29), at once if so.
                // Pro only (2026-10-01): a free account is offered the upgrade.
                // Then the Auto route (trial) switch, the same day.
                onClick={() => {
                    if (!isPro) onUpgrade();
                    else if (!trialOn) setAskedWhileOff(true);
                    // Still on once the draft is confirmed, or it stays shut.
                    else runWithConfirmedDraft('day-plan', () => setOpen(isAutorouteTrialOn()));
                }}
            >
                <span className="day-plan-entry-icon" aria-hidden="true">
                    ☀
                </span>
                <span className="day-plan-entry-copy">
                    <strong>Plan Your Day</strong>
                    <span>Find a stop. Make a day of it.</span>
                </span>
                <span className="day-plan-entry-arrow" aria-hidden="true">
                    ↗
                </span>
            </button>
            {askedWhileOff && isPro && !trialOn && (
                <p role="status" className="day-plan-notice">
                    {PLAN_YOUR_DAY_TRIAL_OFF}
                </p>
            )}
            {open && isPro && trialOn && (
                <Suspense
                    fallback={
                        <p role="status" className="text-sm text-cyan-300">
                            Opening day planner…
                        </p>
                    }
                >
                    <DayPlannerSheet
                        key={`${scope.key}:${scope.generation}:${JSON.stringify(vessel)}`}
                        vessel={vessel}
                        mapboxToken={mapboxToken}
                        onClose={close}
                        onOpenSaved={openSaved}
                    />
                </Suspense>
            )}
        </>
    );
}
