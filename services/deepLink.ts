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
        if (isBuilderDeepLink()) return 'map';
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
    | { kind: 'load-voyage'; choice: import('./shiplog/RoutesAndTracks').SeaVoyageChoice }
    /** Plot the NEXT leg of a trip: pin 1 pre-dropped + LOCKED at the
     *  previous leg's exact final coordinates (Shane 2026-07-17). */
    | { kind: 'new-leg'; fromId: string };

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

// These handoffs can contain private saved-route ids and voyage labels. The
// auth store flips this fence before publishing the next user, so remove every
// reference synchronously rather than waiting for a React consumer to remount.
subscribeAuthIdentityScope(() => {
    pendingTracerRequest = null;
    approvedTracerRequest = null;
});
