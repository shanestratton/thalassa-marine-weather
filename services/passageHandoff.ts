/**
 * RoutePlanner → MapHub passage handoff (the "plan a route, see it on
 * the chart" hop).
 *
 * The hop used to be a bare fire-once window event dispatched 300 ms
 * after setPage('map'). That RACES the map view's lazy mount: on a
 * first-ever chart open (fresh app launch → PLAN → calculate) the
 * MapHub chunk is still loading when the event fires, no listener
 * exists yet, and the passage is silently lost — the chart sits on
 * "Tap the map to set departure and arrival points" forever (Shane
 * 2026-07-09: "not getting anything on the plan screen"). The same
 * loss repeats whenever the map view unmounts (any tab hop) because
 * the planner state dies with it.
 *
 * Fix: the same pending-request pattern services/deepLink.ts uses for
 * the tracer. The request is STICKY — it survives until the skipper
 * explicitly dismisses the passage (X on the chart) or a new request
 * replaces it — so a late-mounting, remounting, or revisited MapHub
 * can always re-consume it and recompute the route.
 */

export interface PassagePoint {
    lat: number;
    lon: number;
    name?: string;
}

export interface PassageHandoffDetail {
    departure?: PassagePoint;
    arrival?: PassagePoint;
    /** Intermediate waypoints (GPX import). */
    via?: PassagePoint[];
}

let pending: PassageHandoffDetail | null = null;

/**
 * Record a passage request and broadcast it. Already-mounted MapHubs
 * react to the event immediately; not-yet-mounted ones pick the
 * request up via peekPassageRequest() in their mount effect.
 */
export function requestPassageMode(detail: PassageHandoffDetail): void {
    pending = detail;
    try {
        window.dispatchEvent(new CustomEvent('thalassa:passage-mode', { detail }));
    } catch {
        /* jsdom/exotic WebView — the pending flag alone still works */
    }
}

/** The undismissed passage request, if any. Does NOT clear it. */
export function peekPassageRequest(): PassageHandoffDetail | null {
    return pending;
}

/** Skipper dismissed the passage (X on the chart) — stop resurrecting it. */
export function clearPassageRequest(): void {
    pending = null;
}
