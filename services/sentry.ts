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
const SENSITIVE_FIELD = /lat|lon|lng|coord|location|mmsi|email|phone|address|gps|token|authorization|cookie/i;
const VOICE_DIAGNOSTIC = /\[(?:DG|SR)\]/;
const EMBEDDED_URL = /https?:\/\/[^\s<>"']+/gi;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const COORDINATE_PAIR = /-?\d{1,3}\.\d{3,}\s*°?\s*[NS]?\s*[,;/]\s*-?\d{1,3}\.\d{3,}\s*°?\s*[EW]?/gi;
const LABELED_COORDINATE = /\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]?\s*-?\d{1,3}(?:\.\d+)?/gi;
const BEARER_OR_JWT = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;
const PHONE_NUMBER = /\+\d[\d\s().-]{7,}\d/g;
const NINE_DIGIT_IDENTIFIER = /\b\d{9}\b/g;

function stripUrlDetails(value: string): string {
    return value.replace(EMBEDDED_URL, (rawUrl) => {
        try {
            const parsed = new URL(rawUrl);
            return `[url:${parsed.pathname || '/'}]`;
        } catch {
            return '[redacted-url]';
        }
    });
}

function sanitizeTelemetryString(value: string): string {
    return stripUrlDetails(value)
        .replace(EMAIL_ADDRESS, '[redacted-email]')
        .replace(COORDINATE_PAIR, '[redacted-coordinates]')
        .replace(LABELED_COORDINATE, '[redacted-coordinate]')
        .replace(BEARER_OR_JWT, '[redacted-token]')
        .replace(PHONE_NUMBER, '[redacted-phone]')
        .replace(NINE_DIGIT_IDENTIFIER, '[redacted-identifier]');
}

function sanitizeTelemetryValue(value: unknown, key = '', depth = 0): unknown {
    if (SENSITIVE_FIELD.test(key)) return '[redacted]';
    if (typeof value === 'string') return sanitizeTelemetryString(value);
    if (value === null || typeof value !== 'object' || depth >= 6) return value;
    if (Array.isArray(value)) return value.map((item) => sanitizeTelemetryValue(item, '', depth + 1));

    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        output[childKey] = sanitizeTelemetryValue(childValue, childKey, depth + 1);
    }
    return output;
}

function sanitizeBreadcrumb(crumb: SentryBreadcrumb): SentryBreadcrumb | null {
    // Production console output is not a telemetry API. Routine diagnostics
    // throughout the app can contain positions, vessel names, diary titles,
    // typed searches, LAN hosts, and hardware identifiers. Keep only the
    // explicit breadcrumbs callers intentionally submit through this module.
    if (IS_PROD && crumb.category === 'console') return null;
    if (crumb.category === 'console' && VOICE_DIAGNOSTIC.test(crumb.message ?? '')) {
        return { ...crumb, message: '[voice diagnostic redacted]', data: undefined };
    }
    return {
        ...crumb,
        message: crumb.message ? sanitizeTelemetryString(crumb.message) : crumb.message,
        data: crumb.data ? (sanitizeTelemetryValue(crumb.data) as Record<string, unknown>) : crumb.data,
    };
}

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
                sendDefaultPii: false,
                tracesSampleRate: IS_PROD ? 0.05 : 0,
                // Public beta deliberately ships without screen/session
                // replay. A marine screen can contain exact tracks, vessel
                // identity, messages, and private log entries.
                replaysSessionSampleRate: 0,
                replaysOnErrorSampleRate: 0,
                maxBreadcrumbs: 50,

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
                    if (event.request?.url) event.request.url = stripUrlDetails(event.request.url);
                    if (event.request?.headers) {
                        event.request.headers = sanitizeTelemetryValue(event.request.headers) as Record<string, string>;
                    }
                    event.user = event.user?.id ? { id: String(event.user.id) } : undefined;
                    if (event.message) event.message = sanitizeTelemetryString(event.message);
                    if (event.logentry?.message) {
                        event.logentry.message = sanitizeTelemetryString(event.logentry.message);
                    }
                    for (const exception of event.exception?.values ?? []) {
                        if (exception.value) exception.value = sanitizeTelemetryString(exception.value);
                    }
                    if (event.tags) event.tags = sanitizeTelemetryValue(event.tags) as typeof event.tags;
                    if (event.extra) event.extra = sanitizeTelemetryValue(event.extra) as typeof event.extra;
                    if (event.contexts)
                        event.contexts = sanitizeTelemetryValue(event.contexts) as typeof event.contexts;
                    if (event.breadcrumbs) {
                        event.breadcrumbs = event.breadcrumbs
                            .map(sanitizeBreadcrumb)
                            .filter((crumb): crumb is SentryBreadcrumb => crumb !== null);
                    }
                    return event;
                },

                beforeBreadcrumb(breadcrumb) {
                    return sanitizeBreadcrumb(breadcrumb);
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
    const safeMessage = sanitizeTelemetryString(msg);
    if (_sentry) {
        _sentry.captureMessage(safeMessage);
    } else {
        void loadSentry()
            .then((s) => s.captureMessage(safeMessage))
            .catch(() => undefined);
    }
};

export const addBreadcrumb = (crumb: SentryBreadcrumb) => {
    if (!DSN) return;
    const safeCrumb = sanitizeBreadcrumb(crumb);
    if (!safeCrumb) return;
    if (_sentry) {
        _sentry.addBreadcrumb(safeCrumb);
    } else {
        void loadSentry()
            .then((s) => s.addBreadcrumb(safeCrumb))
            .catch(() => undefined);
    }
};

export const setUser = (user: { id?: string } | null) => {
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
