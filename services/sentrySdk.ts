/**
 * The only Sentry APIs used by our lazy telemetry adapter.
 *
 * Import this facade dynamically, rather than retaining the package's entire
 * namespace: otherwise unused replay, router and Redux integrations are kept
 * in the installed bundle. Keep React's init so SDK metadata and default crash
 * integrations remain unchanged. Session replay stays disabled in sentry.ts.
 */
export { init, captureException, captureMessage, addBreadcrumb, setUser, setTag } from '@sentry/react';
