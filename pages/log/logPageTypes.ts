/**
 * Types + module constants for LogPage — extracted from pages/LogPage.tsx.
 *
 * Constants only. The mutable module-scope guards (confirmedFollowVoyages,
 * dismissedFollowVoyages, acquiringSince, liveMapExpandedMemo,
 * showArchivedMemo) deliberately stay in pages/LogPage.tsx: two of them are
 * reassigned `let`s, and an ESM import binding cannot be assigned from another
 * module.
 */

import type { ShipLogEntry } from '../../types';
import type { RouteCoordinate } from '../../utils/routeCoordinates';
import type { collapseReversedRoutes } from '../../services/shiplog/collapseReversedRoutes';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import type { TraceFollowCode, TraceFollowStatus } from '../../services/traceVerification';

export const NO_FOLLOWED_ROUTE: readonly RouteCoordinate[] = [];
export const FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS = 10_000;
export const TRACE_ROUTE_USE_BLOCK_PREFIX = 'TRACE_ROUTE_USE_BLOCKED:';
/** A check that passed on a phone whose storage refused to keep it (build 124). */
export const TRACE_CHECK_STORAGE_FULL = 'Checked, but this phone’s storage is full. Couldn’t save the result.';
/** The one quiet line after following an amber route that was never checked. */
export const FOLLOWING_UNCHECKED_NOTICE = 'Following, not checked yet. Keep a good lookout.';

type AmberWhy = 'never' | 'stale' | 'failed' | 'nodraft';
const amberWhy = (code: TraceFollowCode | undefined): AmberWhy =>
    code === 'aged' || code === 'draft'
        ? 'stale'
        : code === 'unavailable' || code === 'tide' || code === 'nochart'
          ? 'failed'
          : code === 'nodraft'
            ? 'nodraft'
            : 'never';

/** The quiet line after following an amber route, worded by WHY it is amber:
 *  a route checked on 4 Sep is not "not checked yet". */
export function followingNotice(code: TraceFollowCode | undefined): string {
    return {
        never: FOLLOWING_UNCHECKED_NOTICE,
        stale: 'Following, but its check is out of date. Keep a good lookout.',
        failed: 'Following, but it couldn’t be checked. Keep a good lookout.',
        nodraft: 'Following, not checked: set your draft so it can be. Keep a good lookout.',
    }[amberWhy(code)];
}

/** The Cast Off caution card's title for a followed amber or red route. */
export function followingCautionTitle(tone: 'unchecked' | 'finding', code: TraceFollowCode | undefined): string {
    if (tone === 'finding') return 'Following — the check found a problem';
    return {
        never: 'Following — route not checked yet',
        stale: 'Following — check out of date',
        failed: 'Following — couldn’t be checked',
        nodraft: 'Following — no draft set',
    }[amberWhy(code)];
}
export const SYSTEM_LOG_ENDPOINT_NAMES = new Set(['Voyage Start', 'Voyage End', 'Latest Position']);

export type TrackingStartFailure = {
    kind: 'permission' | 'services-off' | 'no-provider' | 'no-fix';
    title: string;
    detail: string;
    actionable: boolean;
};

/** Stable empty list so memo(VoyageCard) / memo(LiveMiniMap) see one identity. */
export const NO_ENTRIES: ShipLogEntry[] = [];

/** One row of the cast-off "Following a route?" sheet. Each row carries the
 *  follow status (build 124): null = an ordinary plan with no trace; green
 *  checked, amber unchecked (followable), or red finding (two taps). */
export type FollowSheetChoice = ReturnType<typeof collapseReversedRoutes<VoyageSummary>>[number] & {
    savedRouteId: string | null;
    followStatus: TraceFollowStatus | null;
    /** Trip grouping, so this sheet can wear the Plan page's layout —
     *  passages first with their legs beneath. Absent on a day sail. */
    tripId?: string;
    legOrdinal?: number;
    tripName?: string;
    legName?: string;
};

/** A choice wrapped in the shape services/savedRouteOrder can order. */
export type FollowPromptOrderedRow = {
    choice: FollowSheetChoice;
    kind: 'leg' | 'standalone';
    groupKey: string;
    legOrdinal: number | undefined;
    stamp: number;
};

/**
 * A leg of a trip the sheet shows that has no planned-route row to offer —
 * saved in Route Tracer, never mirrored into the log (an offline save, a
 * timed-out mirror). Shane 2026-09-08: "it is not showing me the last leg?"
 * The row is shown disabled, in its ordinal place, with the fix named.
 */
export interface MissingTripLeg {
    tripId: string;
    legOrdinal: number;
    name: string;
    savedRouteId: string;
    stamp: number;
}

/** The sheet's running order: a passage heading, one route choice, or a leg the log has not got yet. */
export type FollowPromptRow =
    | { type: 'passage'; key: string; name: string }
    | { type: 'choice'; key: string; row: FollowPromptOrderedRow }
    | { type: 'missing-leg'; key: string; leg: MissingTripLeg };
