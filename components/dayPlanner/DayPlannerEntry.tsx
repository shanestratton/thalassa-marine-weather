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
}: {
    vessel: VesselProfile | null;
    mapboxToken: string;
    onOpenSaved: (id: string) => void;
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
                onClick={() => runWithConfirmedDraft('day-plan', () => setOpen(true))}
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
            {open && (
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
