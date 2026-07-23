/**
 * Sentry — Lazy-loaded error tracking & performance monitoring
 * ─────────────────────────────────────────────────────────────────
 * This module provides thin wrappers that defer loading @sentry/react
 * (158KB) until after initial paint. The Sentry SDK is imported dynamically
 * on first use or after a short delay, whichever comes first.
 *
 * Usage remains identical to the static version:
 *   import { captureException, setUser } from './services/sentry';
 */

type SentryModule = typeof import('@sentry/react');
type SentryBreadcrumb = Parameters<SentryModule['addBreadcrumb']>[0];

let _sentry: SentryModule | null = null;
let _loading: Promise<SentryModule> | null = null;

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const IS_PROD = import.meta.env.PROD;

/**
 * Lazily load and initialize Sentry SDK. Resolves immediately
 * after first successful load. Safe to call multiple times.
 */
function loadSentry(): Promise<SentryModule> {
    if (_sentry) return Promise.resolve(_sentry);
    if (_loading) return _loading;

    _loading = import('@sentry/react').then((mod) => {
        _sentry = mod;

        if (DSN) {
            mod.init({
                dsn: DSN,
                environment: IS_PROD ? 'production' : 'development',
                release: `thalassa@${import.meta.env.VITE_APP_VERSION || '0.0.0'}`,
                tracesSampleRate: IS_PROD ? 0.2 : 1.0,
                replaysSessionSampleRate: IS_PROD ? 0.1 : 0,
                replaysOnErrorSampleRate: 1.0,

                beforeSend(event) {
                    const message = event.exception?.values?.[0]?.value || '';
                    if (message.includes('readonly property')) {
                        // Log as breadcrumb instead of discarding silently —
                        // helps crash investigations see if readonly errors preceded a real crash
                        mod.addBreadcrumb({
                            category: 'security',
                            message: 'Suppressed iOS readonly TypeError',
                            level: 'debug',
                        });
                        return null;
                    }
                    if (message.includes('ResizeObserver')) return null;
                    if (message.includes('Failed to fetch') && !navigator.onLine) return null;
                    return event;
                },

                initialScope: {
                    tags: { app: 'thalassa', platform: 'web' },
                },
            });
        }

        return mod;
    });

    return _loading;
}

// Kick off loading well after the interactive shell is available. Errors still
// load the SDK immediately through the wrappers below; the delayed path is only
// proactive telemetry initialization and must not compete with first paint.
if (typeof window !== 'undefined' && DSN) {
    setTimeout(() => {
        void loadSentry().catch(() => {
            /* Telemetry must never affect app availability. */
        });
    }, 10_000);
}

// ── Thin async wrappers ─────────────────────────────────────

export const captureException = (err: unknown, scope?: Record<string, unknown>) => {
    if (!DSN) return;
    if (_sentry) {
        _sentry.captureException(err, scope);
    } else {
        // Do not log through createLogger here. createLogger.error forwards
        // back to captureException, so doing so before the SDK resolves forms
        // an asynchronous recursion that can exhaust the heap during an early
        // startup/network failure.
        void loadSentry()
            .then((s) => s.captureException(err, scope))
            .catch(() => {
                /* The originating logger already emitted the error. */
            });
    }
};

export const captureMessage = (msg: string) => {
    if (!DSN) return;
    if (_sentry) {
        _sentry.captureMessage(msg);
    } else {
        void loadSentry()
            .then((s) => s.captureMessage(msg))
            .catch(() => undefined);
    }
};

export const addBreadcrumb = (crumb: SentryBreadcrumb) => {
    if (!DSN) return;
    if (_sentry) {
        _sentry.addBreadcrumb(crumb);
    } else {
        void loadSentry()
            .then((s) => s.addBreadcrumb(crumb))
            .catch(() => undefined);
    }
};

export const setUser = (user: { id?: string; email?: string; username?: string } | null) => {
    if (!DSN) return;
    if (_sentry) {
        _sentry.setUser(user);
    } else {
        void loadSentry()
            .then((s) => s.setUser(user))
            .catch(() => undefined);
    }
};

export const setTag = (key: string, value: string) => {
    if (!DSN) return;
    if (_sentry) {
        _sentry.setTag(key, value);
    } else {
        void loadSentry()
            .then((s) => s.setTag(key, value))
            .catch(() => undefined);
    }
};

// ErrorBoundary — provide a simple fallback until Sentry loads
export { loadSentry as ensureSentryLoaded };
