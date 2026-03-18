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
                    if (message.includes('readonly property')) return null;
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

// Kick off loading after initial paint (2s delay)
if (typeof window !== 'undefined') {
    setTimeout(() => loadSentry(), 2000);
}

// ── Thin async wrappers ─────────────────────────────────────

export const captureException = (err: unknown) => {
    if (_sentry) {
        _sentry.captureException(err);
    } else {
        loadSentry().then((s) => s.captureException(err));
        console.error('[Sentry:deferred]', err);
    }
};

export const captureMessage = (msg: string) => {
    if (_sentry) {
        _sentry.captureMessage(msg);
    } else {
        loadSentry().then((s) => s.captureMessage(msg));
    }
};

export const addBreadcrumb = (crumb: { category?: string; message?: string; level?: string }) => {
    if (_sentry) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sentry.addBreadcrumb(crumb as any);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        loadSentry().then((s) => s.addBreadcrumb(crumb as any));
    }
};

export const setUser = (user: { id?: string; email?: string; username?: string } | null) => {
    if (_sentry) {
        _sentry.setUser(user);
    } else {
        loadSentry().then((s) => s.setUser(user));
    }
};

export const setTag = (key: string, value: string) => {
    if (_sentry) {
        _sentry.setTag(key, value);
    } else {
        loadSentry().then((s) => s.setTag(key, value));
    }
};

// ErrorBoundary — provide a simple fallback until Sentry loads
export { loadSentry as ensureSentryLoaded };
