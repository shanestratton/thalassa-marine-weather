/**
 * Sentry — Error tracking & performance monitoring
 * ─────────────────────────────────────────────────────────────────
 * Import this module EARLY in index.tsx (before React renders).
 *
 * Configuration:
 *   Set VITE_SENTRY_DSN in .env or environment variables.
 *   If not set, Sentry is disabled (development mode).
 *
 * Usage:
 *   import './services/sentry';        // init (index.tsx)
 *   import * as Sentry from './services/sentry';
 *   Sentry.captureException(err);      // manual capture
 *   Sentry.addBreadcrumb({ ... });     // breadcrumb
 */

import * as SentryReact from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const IS_PROD = import.meta.env.PROD;

// Only initialize if DSN is configured
if (DSN) {
    SentryReact.init({
        dsn: DSN,
        environment: IS_PROD ? 'production' : 'development',
        release: `thalassa@${import.meta.env.VITE_APP_VERSION || '0.0.0'}`,

        // Performance: sample 20% of transactions in production
        tracesSampleRate: IS_PROD ? 0.2 : 1.0,

        // Session Replay: capture 10% of sessions, 100% on error
        replaysSessionSampleRate: IS_PROD ? 0.1 : 0,
        replaysOnErrorSampleRate: 1.0,

        // Filter out noisy errors
        beforeSend(event) {
            const message = event.exception?.values?.[0]?.value || '';

            // iOS WKWebView readonly property errors (harmless React 18 scroll events)
            if (message.includes('readonly property')) return null;

            // ResizeObserver loop limit exceeded (browser rendering artifact)
            if (message.includes('ResizeObserver')) return null;

            // Network errors from failed weather API calls (expected offline)
            if (message.includes('Failed to fetch') && !navigator.onLine) return null;

            return event;
        },

        // Tag all events
        initialScope: {
            tags: {
                app: 'thalassa',
                platform: 'web',
            },
        },
    });

    console.info('[Sentry] Initialized', IS_PROD ? '(production)' : '(development)');
} else {
    console.info('[Sentry] Disabled — no VITE_SENTRY_DSN configured');
}

// ── Re-exports for app usage ─────────────────────────────────

export const captureException = DSN
    ? SentryReact.captureException.bind(SentryReact)
    : (err: unknown) => {
          console.error('[Sentry:noop] captureException:', err);
      };

export const captureMessage = DSN
    ? SentryReact.captureMessage.bind(SentryReact)
    : (msg: string) => {
          console.info('[Sentry:noop] captureMessage:', msg);
      };

export const addBreadcrumb = DSN
    ? SentryReact.addBreadcrumb.bind(SentryReact)
    : (_crumb: SentryReact.Breadcrumb) => {
          // noop in dev
      };

export const setUser = DSN
    ? SentryReact.setUser.bind(SentryReact)
    : (_user: SentryReact.User | null) => {
          // noop in dev
      };

export const setTag = DSN
    ? SentryReact.setTag.bind(SentryReact)
    : (_key: string, _value: string) => {
          // noop in dev
      };

// Re-export the ErrorBoundary from Sentry for optional direct use
export const SentryErrorBoundary = SentryReact.ErrorBoundary;
