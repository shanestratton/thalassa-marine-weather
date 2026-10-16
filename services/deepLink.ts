/**
 * URL → app-state deep links (Route Tracer masterplan Phase 5.1).
 *
 * The SPA has no router — navigation is uiStore.setPage() in-memory
 * state, and until now every visit booted to the dashboard no matter
 * the path. Vercel's catch-all rewrite already serves index.html for
 * any dotless path, so thalassawx.app/plan lands here with the path
 * intact; these helpers turn it into an initial view plus a pending
 * "open the tracer" request that MapHub consumes on mount (or via the
 * 'thalassa:trace-mode' window event when it's already mounted).
 *
 * On native the WebView serves from '/', so everything below no-ops.
 */

import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

/** The desktop passage-builder front door(s) — linked from every
 *  yacht's public voyage-log page. */
const BUILDER_PATHS = new Set(['/plan', '/builder']);

/** Views reachable via ?view= — a deliberate, small allowlist (NOT the
 *  whole VIEW_REGISTRY: deep links are a public surface). */
const VIEW_PARAM_ALLOWLIST = new Set(['dashboard', 'map', 'voyage', 'vessel', 'chat']);

export function isBuilderDeepLink(): boolean {
    try {
        const path = window.location.pathname.replace(/\/+$/, '');
        return BUILDER_PATHS.has(path);
    } catch {
        return false;
    }
}

/** Initial view for uiStore's boot state; null → the normal dashboard. */
export function initialViewFromUrl(): string | null {
    try {
        // The planner FRONT DOOR, not the bare chart: booting /plan straight
        // onto the map skipped the Trip·Legs picker, departure time and the
        // saved-route/past-voyage entries — there was no way to start a new
        // leg on the web (Shane, 2026-09-02: "we need something like this at
        // the beginning otherwise we cannot start a new leg"). The pre-flight
        // is fully pointer-driven, and its slide hands off to the tracer
        // exactly as on the phone.
        if (isBuilderDeepLink()) return 'voyage';
        const v = new URLSearchParams(window.location.search).get('view');
        if (v && VIEW_PARAM_ALLOWLIST.has(v)) return v;
    } catch {
        /* jsdom / exotic WebView — normal boot */
    }
    return null;
}

// ── Pending tracer-open request ────────────────────────────────────
// Two consumers because of a mount race: if MapHub is already up the
// window event opens the tracer immediately; if the request fires
// before MapHub mounts (auth check finishing first), the flag survives
// until MapHub's mount effect consumes it.

/** Optional follow-up the tracer performs right after opening — the PLAN
 *  page's front-door entries (Shane 2026-07-16): load a picked saved route or
 *  past voyage STRAIGHT into the tracer (the punter already chose it in the
 *  PLAN-page modal), or paste a mate's coords. */
export type TracerOpenAction =
    | { kind: 'paste' }
    | { kind: 'load-saved'; id: string }
    /** Open a historical planned-route mirror from the Plan library. The
     *  voyage id is resolved to exact geometry only after MapHub consumes this
     *  identity-owned request. */
    | { kind: 'load-logbook-route'; voyageId: string }
    /** Open a derived "(Passage)" rollup — the trip's legs stitched at read
     *  time (never a stored row; see buildTripPassageRollups). */
    | { kind: 'load-trip-passage'; tripId: string }
    | { kind: 'load-voyage'; choice: import('./shiplog/RoutesAndTracks').SeaVoyageChoice }
    /** Plot the NEXT leg of a trip: pin 1 pre-dropped + LOCKED at the
     *  previous leg's exact final coordinates (Shane 2026-07-17). */
    | { kind: 'new-leg'; fromId: string }
    /** Add the next leg after saved leg `afterId` as a COPY of saved line
     *  `sourceId`, sailed as it is or the other way (126-16a): locked to the
     *  previous arrival, checked and written by the tracer's own Save. Ids
     *  only; the source is only read. */
    | { kind: 'add-leg'; afterId: string; sourceId: string; direction: 'forward' | 'reverse' }
    /** Plan the trip home (Shane 2026-10-07): a NEW trip whose leg 1 is
     *  outbound leg `fromOrdinal` (default the last) reversed, built one
     *  checked leg at a time. The outbound trip is only read. */
    | { kind: 'return-trip'; tripId: string; fromOrdinal?: number }
    | PlotDayAction;

/**
 * Plan Your Day's hand-over to the chart (build 124; 127-PYD-3). Never a
 * straight line: the routed line (her stop routed by Auto's provider, "Use on
 * the main chart"), or her own saved route that joins the two, as an UNSAVED
 * draft in the MANUAL plotter; with neither, `frame` and no points: her start
 * and the stop as two marks and why ("Plot by hand"). The Route report checks
 * whatever she plots. It carries the boat's position, so it is
 * identity-fenced like the rest.
 */
export interface PlotDayAction {
    kind: 'plot-day';
    points: { lat: number; lon: number }[];
    /** "Day out: Cid Harbour", "Overnight: Cid Harbour". */
    name: string;
    /** The stop's name, for the chart's one-line note. */
    stop: string;
    /** Set when the pins are the skipper's saved route. */
    savedRoute?: string;
    /** The pins are the line Thalassa routed for this stop (127-PYD-3). */
    routed?: true;
    /** A routed line whose satellite land check didn't run: why (may be empty). A caution, not a gate. */
    unchecked?: string;
    /** No line to plot: her start and the stop, and why; `points` is empty. */
    frame?: { from: PlotDayMark; to: PlotDayMark; why: string };
}
export type PlotDayMark = { lat: number; lon: number; name: string };

/** The most points a saved route may hold (saved_routes and
 *  AUTOROUTING_PROPOSAL_MAX_POINTS): an Auto route runs to hundreds. */
export const SAVED_ROUTE_MAX_POINTS = 10_000;
/** A saved route out and turned round for home (the stop not twice): the most
 *  a plot-day request can honestly need. Over this it is refused. */
export const PLOT_DAY_MAX_POINTS = 2 * SAVED_ROUTE_MAX_POINTS - 1;

const realPoint = (p: { lat: number; lon: number } | null | undefined): p is { lat: number; lon: number } =>
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180;

/** What the chart accepts from a plot-day request: two to
 *  PLOT_DAY_MAX_POINTS real positions and a name, or no positions and a
 *  frame of two real marks. Null when it is not usable. */
export function plotDayPins(action: PlotDayAction): {
    points: { lat: number; lon: number }[];
    name: string;
    stop: string;
    savedRoute: string | null;
    routed: boolean;
    frame: { from: PlotDayMark; to: PlotDayMark; why: string } | null;
    unchecked: string | null;
} | null {
    const points = Array.isArray(action?.points) ? action.points : [];
    const frame = action?.frame;
    if (
        frame
            ? points.length || !realPoint(frame.from) || !realPoint(frame.to)
            : points.length < 2 || points.length > PLOT_DAY_MAX_POINTS || !points.every(realPoint)
    )
        return null;
    const text = (value: unknown, fallback: string, max = 120) =>
        (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, max);
    const stop = text(action.stop, 'the stop');
    const mark = (p: PlotDayMark, fallback: string) => ({ lat: p.lat, lon: p.lon, name: text(p.name, fallback) });
    return {
        points: points.map((p) => ({ lat: p.lat, lon: p.lon })),
        name: text(action.name, 'Day out'),
        stop,
        savedRoute: typeof action.savedRoute === 'string' && action.savedRoute.trim() ? action.savedRoute.trim() : null,
        routed: action.routed === true,
        frame: frame
            ? { from: mark(frame.from, 'Start'), to: mark(frame.to, stop), why: text(frame.why, '', 400) }
            : null,
        unchecked:
            action.routed === true && typeof action.unchecked === 'string' ? text(action.unchecked, '', 300) : null,
    };
}

export interface TracerOpenEventDetail {
    readonly requestId: number;
    readonly identity: AuthIdentityScope;
}

interface PendingTracerRequest extends TracerOpenEventDetail {
    readonly action: TracerOpenAction | null;
}

let nextTracerRequestId = 0;
let pendingTracerRequest: PendingTracerRequest | null = null;
let approvedTracerRequest: PendingTracerRequest | null = null;
const dispatchingTracerRequestIds: number[] = [];

// ── Pending Saved Routes library request ─────────────────────────
// Vessel's Passage Planning card navigates to the Plan tab and asks its
// existing modal to open. The Plan component is normally not mounted at the
// time of the tap, so this is a one-shot identity-owned intent rather than a
// window event. It contains no route geometry, but even the fact that an
// account has private routes belongs to the same auth-generation fence.
let pendingSavedRoutesLibraryIdentity: AuthIdentityScope | null = null;
let pendingTrackRouteLibraryIdentity: AuthIdentityScope | null = null;

function sameIdentity(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

function eventMatchesRequest(event: Event | undefined, request: PendingTracerRequest): boolean {
    if (!event) {
        const activeRequestId = dispatchingTracerRequestIds.at(-1);
        return activeRequestId === undefined || activeRequestId === request.requestId;
    }
    if (!(event instanceof CustomEvent)) return false;
    const detail = event.detail as Partial<TracerOpenEventDetail> | null;
    return (
        detail?.requestId === request.requestId && !!detail.identity && sameIdentity(detail.identity, request.identity)
    );
}

/**
 * Stage an identity-owned tracer handoff. The optional expected scope lets an
 * async picker reject a click/result that belongs to the generation it began
 * under rather than re-labelling private route/voyage identity as the account
 * that happens to be active when it finishes.
 */
export function requestTracerOpen(
    action: TracerOpenAction | null = null,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return;

    const request: PendingTracerRequest = {
        requestId: ++nextTracerRequestId,
        identity: expectedScope,
        action,
    };
    pendingTracerRequest = request;
    approvedTracerRequest = null;
    try {
        // Keep a synchronous dispatch context as well as tagged event detail.
        // This protects existing listeners that have not yet been upgraded to
        // pass the Event into consumeTracerOpenRequest().
        dispatchingTracerRequestIds.push(request.requestId);
        window.dispatchEvent(
            new CustomEvent<TracerOpenEventDetail>('thalassa:trace-mode', {
                detail: { requestId: request.requestId, identity: request.identity },
            }),
        );
    } catch {
        /* flag alone still does the job on next MapHub mount */
    } finally {
        dispatchingTracerRequestIds.pop();
    }
}

/**
 * Whether the current identity has a tracer request waiting to be consumed.
 * Used only for first-render presentation so a cold Plan → Map handoff starts
 * clean instead of briefly painting the skipper's Chart overlays.
 */
export function peekTracerOpenRequest(): boolean {
    const request = pendingTracerRequest;
    return !!request && isAuthIdentityScopeCurrent(request.identity);
}

/**
 * Claim the current identity's request. Event-driven consumers should pass the
 * event so a delayed/replayed A event can never claim a newer B request.
 */
export function consumeTracerOpenRequest(event?: Event): boolean {
    const request = pendingTracerRequest;
    if (!request) return false;
    if (!isAuthIdentityScopeCurrent(request.identity)) {
        pendingTracerRequest = null;
        approvedTracerRequest = null;
        return false;
    }

    if (!eventMatchesRequest(event, request)) return false;

    pendingTracerRequest = null;
    approvedTracerRequest = request;
    return true;
}

export function consumeTracerAction(): TracerOpenAction | null {
    const request = approvedTracerRequest;
    approvedTracerRequest = null;
    if (!request || !isAuthIdentityScopeCurrent(request.identity)) return null;
    return request.action;
}

/**
 * Ask the next/current Plan front door to open its Saved Routes library.
 * A delayed caller may pass the identity it began under; stale producers are
 * ignored rather than relabelled as the currently active account.
 */
export function requestSavedRoutesLibraryOpen(expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return;
    pendingSavedRoutesLibraryIdentity = expectedScope;
}

/** Consume the current identity's one-shot Saved Routes library intent. */
export function consumeSavedRoutesLibraryOpen(): boolean {
    const identity = pendingSavedRoutesLibraryIdentity;
    if (!identity) return false;
    pendingSavedRoutesLibraryIdentity = null;
    return isAuthIdentityScopeCurrent(identity);
}

/** Log's overflow action opens Plan's existing past-voyage picker; no geometry crosses this handoff. */
export function requestTrackRouteLibraryOpen(expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
    if (isAuthIdentityScopeCurrent(expectedScope)) pendingTrackRouteLibraryIdentity = expectedScope;
}
export function consumeTrackRouteLibraryOpen(): boolean {
    const scope = pendingTrackRouteLibraryIdentity;
    pendingTrackRouteLibraryIdentity = null;
    return !!scope && isAuthIdentityScopeCurrent(scope);
}

// These handoffs can contain private saved-route ids and voyage labels. The
// auth store flips this fence before publishing the next user, so remove every
// reference synchronously rather than waiting for a React consumer to remount.
subscribeAuthIdentityScope(() => {
    pendingTracerRequest = null;
    approvedTracerRequest = null;
    pendingSavedRoutesLibraryIdentity = null;
    pendingTrackRouteLibraryIdentity = null;
});
