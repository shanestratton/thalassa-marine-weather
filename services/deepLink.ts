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
let pendingTracerOpen = false;

export function requestTracerOpen(): void {
    pendingTracerOpen = true;
    try {
        window.dispatchEvent(new CustomEvent('thalassa:trace-mode'));
    } catch {
        /* flag alone still does the job on next MapHub mount */
    }
}

export function consumeTracerOpenRequest(): boolean {
    const was = pendingTracerOpen;
    pendingTracerOpen = false;
    return was;
}
