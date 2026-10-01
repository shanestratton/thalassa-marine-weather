import React, { Suspense, useCallback, useState, useSyncExternalStore } from 'react';
import type { VesselProfile } from '../../types/vessel';
import { lazyRetry } from '../../utils/lazyRetry';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { runWithConfirmedDraft } from '../../stores/draftConfirmStore';
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
                onClick={() => (isPro ? runWithConfirmedDraft('day-plan', () => setOpen(true)) : onUpgrade())}
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
            {open && isPro && (
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
