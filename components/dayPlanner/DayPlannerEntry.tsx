import React, { Suspense, useCallback, useId, useState, useSyncExternalStore } from 'react';
import type { VesselProfile } from '../../types/vessel';
import type { TracerOpenAction } from '../../services/deepLink';
import { lazyRetry } from '../../utils/lazyRetry';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { SunIcon } from '../Icons';
import { PLAN_TILE_CLASS, PLAN_TILE_STYLE, PlanTileFace } from '../passage/PlanTile';

// Lazy: the planner (engine, loader and screens) loads on the first tap, so
// this tile adds nothing to the Plan page's own chunk.
const TodaySheet = lazyRetry(() => import('./TodaySheet'));

/**
 * The Plan page's Plan Your Day tile (build 124, "Today on the water"). A tap
 * opens the planner at once: no form, no switch and no draft check, because
 * it never routes and reads no depth. Pro only (owner decision 2026-10-01;
 * free during the public beta). Auto route (trial) still gates the Auto
 * workspace, not this.
 */
export function DayPlannerEntry({
    vessel,
    usingDefaultVessel,
    isPro,
    onUpgrade,
    onPlot,
    onOpenVessel,
}: {
    /** Always resolved: her profile, or the default boat (and it says so). */
    vessel: VesselProfile;
    usingDefaultVessel: boolean;
    isPro: boolean;
    onUpgrade: () => void;
    /** "Plot on chart": straight pins into the Manual plotter. */
    onPlot: (action: TracerOpenAction) => void;
    /** Settings → Vessel, from the default-boat notice. */
    onOpenVessel?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const plot = useCallback(
        (action: TracerOpenAction) => {
            setOpen(false);
            onPlot(action);
        },
        [onPlot],
    );
    const openVessel = useCallback(() => {
        setOpen(false);
        onOpenVessel?.();
    }, [onOpenVessel]);
    // A new account starts a new planner: nothing carries over.
    const scope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope);
    const subId = useId();
    return (
        <>
            {/* One tile language for all four ways in (Shane 2026-10-05), the
                sun as the drawn icon. Named by its title, the full line its
                description. */}
            <button
                type="button"
                className={`${PLAN_TILE_CLASS} plan-tile-day`}
                style={PLAN_TILE_STYLE}
                aria-label="Plan Your Day"
                aria-describedby={subId}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => (isPro ? setOpen(true) : onUpgrade())}
            >
                <PlanTileFace
                    icon={<SunIcon />}
                    title="Plan Your Day"
                    sub="Go or stay, when, and where to."
                    short="Where to?"
                    subId={subId}
                />
            </button>
            {open && isPro && (
                <Suspense
                    fallback={
                        <p role="status" className="plan-doors-note plan-doors-note-quiet text-sm text-cyan-300">
                            Opening day planner…
                        </p>
                    }
                >
                    <TodaySheet
                        key={`${scope.key}:${scope.generation}`}
                        vessel={vessel}
                        usingDefaultVessel={usingDefaultVessel}
                        onClose={close}
                        onPlot={plot}
                        onOpenVessel={onOpenVessel ? openVessel : undefined}
                    />
                </Suspense>
            )}
        </>
    );
}
