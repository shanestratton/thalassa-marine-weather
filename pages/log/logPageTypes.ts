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

export const NO_FOLLOWED_ROUTE: readonly RouteCoordinate[] = [];
export const FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS = 10_000;
export const TRACE_ROUTE_USE_BLOCK_PREFIX = 'TRACE_ROUTE_USE_BLOCKED:';
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
 *  follow gate's verdict: null = pickable, a string = shown disabled with that
 *  reason. */
export type FollowSheetChoice = ReturnType<typeof collapseReversedRoutes<VoyageSummary>>[number] & {
    savedRouteId: string | null;
    blockReason: string | null;
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

/** The sheet's running order: a passage heading, or one route choice. */
export type FollowPromptRow =
    | { type: 'passage'; key: string; name: string }
    | { type: 'choice'; key: string; row: FollowPromptOrderedRow };
