/**
 * TripLegPicker — the PLAN page's Trip · Legs tile (Shane 2026-07-17: "we
 * need to get our LEGS functioning").
 *
 * A tap opens the Trip sheet (components/passage/TripSheet.tsx, lazy): your
 * trips, then a trip's legs as cards, then "+ Add the Nth leg from <place>"
 * from any saved route or any leg of another trip (126-16a; Shane 2026-10-09:
 * "we need to be able to do that easily not just the first leg. but the 2nd
 * and 3rd and 4th etc."). It replaced a native select laid over the tile,
 * whose first option did nothing and whose modal offered a next leg only by
 * hand from the last leg.
 *
 * Grouping is STRUCTURAL (SavedTrace.tripId — legs of one trip share leg
 * 1's id), with the "(Nth Leg)" name badge as the display fallback for
 * routes whose fields were shed by the cloud round-trip.
 *
 * The way home (Shane 2026-10-07): "⇄ Plan the return trip" and the ⇄ chip on
 * each leg card open a NEW trip whose first leg is that leg reversed
 * (components/map/useReturnTripFlow.ts). The outbound trip is never edited.
 */
import React from 'react';
import { loadSavedTraces, groupTracesByTrip } from '../../services/routeTracer';
import { triggerHaptic } from '../../utils/system';
import { FlagIcon } from '../Icons';
import { PLAN_TILE_CLASS, PLAN_TILE_STYLE, PlanTileFace } from './PlanTile';
import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
// The sheet and its helpers load on the first tap, not with the Plan page.
import { LazyTripSheet } from './LazyTripSheet';

// Grouping is the SHARED helper (groupTracesByTrip) so this tile, the sheet and
// the tracer card's "open a saved route" list can never drift (2026-07-17).
const countTrips = (scope: AuthIdentityScope): number => groupTracesByTrip(loadSavedTraces(scope)).length;

export const TripLegPicker: React.FC<{ onOpenChart: () => void }> = ({ onOpenChart }) => {
    const [snapshot, setSnapshot] = React.useState(() => {
        const scope = getAuthIdentityScope();
        return { scope, count: countTrips(scope) };
    });
    // The scope the open sheet's rows belong to; null while it is closed.
    const [sheetScope, setSheetScope] = React.useState<AuthIdentityScope | null>(null);
    React.useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                // The trip count is private. Replace it at the synchronous
                // fence, and close the sheet: its rows are the last account's.
                setSnapshot({ scope: next, count: countTrips(next) });
                setSheetScope(null);
            }),
        [],
    );
    // A save, a delete or the cloud merge can change the count while the tile
    // is on screen (deleting leg 1 can even split a trip).
    React.useEffect(() => {
        const onSavedRoutesChanged = (event: Event): void => {
            const detail = (event as CustomEvent<{ scopeKey?: string; scopeGeneration?: number }>).detail;
            const scope = getAuthIdentityScope();
            if (
                detail?.scopeKey &&
                (detail.scopeKey !== scope.key ||
                    (detail.scopeGeneration !== undefined && detail.scopeGeneration !== scope.generation))
            ) {
                return;
            }
            setSnapshot({ scope, count: countTrips(scope) });
        };
        window.addEventListener('thalassa:saved-routes-changed', onSavedRoutesChanged);
        return () => window.removeEventListener('thalassa:saved-routes-changed', onSavedRoutesChanged);
    }, []);

    const countId = React.useId();
    const close = React.useCallback(() => setSheetScope(null), []);
    if (snapshot.count === 0) return null; // nothing saved yet — no empty furniture

    return (
        <>
            {/* The first of the Plan page's ways in (Shane 2026-10-05: "make
                it pop. cleaner"): a tile like its three neighbours. Named by
                its title (WCAG 2.5.3, so Voice Control's "Tap Trip Legs" finds
                it), the count of what is saved as its description. */}
            <button
                type="button"
                aria-label="Trip · Legs"
                aria-describedby={countId}
                aria-haspopup="dialog"
                aria-expanded={sheetScope !== null}
                onClick={() => {
                    triggerHaptic('light');
                    // Saved routes land from the cloud merge after mount: the
                    // sheet reads the library afresh under this exact scope.
                    const scope = getAuthIdentityScope();
                    setSnapshot({ scope, count: countTrips(scope) });
                    setSheetScope(scope);
                }}
                className={`${PLAN_TILE_CLASS} plan-tile-trip`}
                style={PLAN_TILE_STYLE}
            >
                <PlanTileFace
                    icon={<FlagIcon />}
                    title="Trip · Legs"
                    sub={`${snapshot.count} saved · pick one to continue`}
                    short={`${snapshot.count} saved`}
                    subId={countId}
                    go="pick"
                />
            </button>
            {sheetScope && <LazyTripSheet scope={sheetScope} onClose={close} onOpenChart={onOpenChart} />}
        </>
    );
};
