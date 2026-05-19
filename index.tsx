// Sentry must be imported FIRST — before any other app code
import { captureException } from './services/sentry';

// JS BUILD-MARKER — landed via Preferences so it appears in Xcode
// console (console.warn from WKWebView is invisible to Xcode's
// native log stream). Pairs with [BUILD-MARKER-SWIFT] to confirm
// both halves of the build are fresh after ⌘B. Look for
// "[BUILD-MARKER-JS]" in Xcode at app boot — if it's missing or
// stale, the dist files in ios/App/App/public are stale; re-run
// `npx cap copy ios` and rebuild.

// ── BOOT DIAGNOSTIC ── uses Capacitor Preferences (visible in Xcode as native bridge calls)
// because console.error from WKWebView does NOT appear in Xcode's native console.
import { Preferences } from '@capacitor/preferences';
Preferences.set({
    key: 'BUILD_MARKER_JS',
    value: `[BUILD-MARKER-JS] thalassa ${new Date().toISOString()} (bundle freshness check)`,
}).catch(() => {});
Preferences.set({ key: 'BOOT_DIAG', value: `index.tsx loaded at ${new Date().toISOString()}` })
    .then(() => Preferences.get({ key: 'signalk_host' }))
    .then((r) => {
        // This will show as '⚡️  TO JS {"value":"..."}' in Xcode
        // Look for the signalk_host value in the Xcode log output
        Preferences.set({ key: 'BOOT_SK_HOST', value: `host=${r.value}` });
    })
    .catch(() => {});

// ── Global error capture ──
// Capacitor's bridge swallows exception details by default — Xcode just
// shows "⚡️ JS Eval error A JavaScript exception occurred" with no
// stack. These two listeners surface the actual error message + stack
// via Preferences (which DOES appear in Xcode as "⚡️ TO JS {value:...}")
// and route the exception to Sentry. Installed as early as possible so
// boot-time issues (loading order bugs, polyfill conflicts, plugin
// init failures) are no longer invisible.
//
// The ErrorBoundary further down catches React render errors; this
// catches everything ELSE — async rejections, unhandled timeouts,
// imperative throws from third-party libs.
if (typeof window !== 'undefined') {
    window.addEventListener('error', (event: ErrorEvent) => {
        // Stringify what we know about the error without losing detail
        const detail =
            event.error instanceof Error
                ? `${event.error.name}: ${event.error.message}\n${event.error.stack ?? ''}`
                : `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`;
        // Native console (Xcode) — the Preferences round-trip is the
        // only way to make a JS error reliably appear in the iOS logs.
        Preferences.set({ key: 'BOOT_ERR', value: `[window.error] ${detail.slice(0, 1500)}` }).catch(() => {});
        // Web console (in case anyone has the inspector attached)

        console.error('[GlobalErrorHandler]', detail);
        // Sentry — best-effort, swallow if Sentry isn't ready yet
        try {
            if (event.error instanceof Error) captureException(event.error, { tags: { source: 'window.error' } });
        } catch {
            /* sentry not ready */
        }
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        const detail =
            reason instanceof Error
                ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
                : `[unhandled rejection] ${typeof reason === 'object' ? JSON.stringify(reason) : String(reason)}`;
        Preferences.set({ key: 'BOOT_REJECT', value: detail.slice(0, 1500) }).catch(() => {});

        console.error('[UnhandledRejection]', detail);
        try {
            if (reason instanceof Error) captureException(reason, { tags: { source: 'unhandledrejection' } });
        } catch {
            /* sentry not ready */
        }
    });
}

import React, { ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThalassaProvider } from './context/ThalassaContext';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { CrewCountProvider } from './contexts/CrewCountContext';

// Show the iOS keyboard accessory bar (the strip with the
// up/down field-navigation chevrons and a Done button on the right).
// The Done button is a universally-useful dismiss affordance that the
// rest of the app's pages rely on. The Plan page used to look like
// the bar was "covering" the destination input — that turned out to
// be a form-sizing issue on that page (the form wasn't scrollable
// enough to lift the input above the accessory bar). Solved at the
// page level instead of by hiding the bar everywhere.
if (Capacitor.isNativePlatform()) {
    Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => {
        /* Keyboard API unavailable on web */
    });
}

// Wire Apple Watch reverse-direction events (mob trigger, alarm ack)
// + the weather snapshot push pipeline. No-op on web / Android.
// Lazy-imported so the watchBridge plugin doesn't load on web bundles.
import('./services/native/watchBridgeListeners')
    .then(({ initWatchBridgeListeners }) => initWatchBridgeListeners())
    .catch((e) => {
        // Bridge missing or watch not paired — silent ok, the watch is
        // optional and failure here mustn't block app boot.

        console.info('[index] watchBridgeListeners not initialised:', e);
    });

// Suppress Recharts "width(-1) and height(-1)" warnings — a known cosmetic issue
// that fires during the brief window between chart mount and layout stabilization.
const _origWarn = console.warn;
console.warn = (...args: unknown[]) => {
    if (
        typeof args[0] === 'string' &&
        args[0].includes('The width(') &&
        args[0].includes('of chart should be greater than 0')
    ) {
        return; // Silently suppress
    }
    _origWarn.apply(console, args);
};

// Diagnostic: intercept console.error to expose Error objects that serialize as {}
// This helps identify the source of "[error] - {}" messages in Capacitor logs
const _origError = console.error;
console.error = (...args: unknown[]) => {
    const enrichedArgs = args.map((arg) => {
        if (arg instanceof Error) {
            return `[Error: ${arg.message}] ${arg.stack || ''}`;
        }
        if (typeof arg === 'object' && arg !== null && Object.keys(arg).length === 0 && !(arg instanceof Array)) {
            // Empty object — try to extract more info
            try {
                return `[EmptyObj: ${arg.constructor?.name || 'Object'}] ${String(arg)}`;
            } catch (e) {
                console.warn('[index]', e);
                return arg;
            }
        }
        return arg;
    });
    _origError.apply(console, enrichedArgs);
};

// Service Worker Registration for PWA/Offline Support
const registerServiceWorker = async () => {
    if ('serviceWorker' in navigator) {
        // ── CAPACITOR NATIVE BYPASS ──
        // The native iOS / Android app bundles every asset into the .app
        // package and serves them from capacitor://localhost. There is
        // no network round-trip to cache and no "offline" failure mode
        // — the app IS the offline cache. The Service Worker's stale-
        // while-revalidate path was actively HARMING us: after a code
        // push + cap copy ios, WKWebView would load the SW first, the
        // SW would serve cached chunks from the previous session, and
        // the user would stay on stale JS even after Clean Build +
        // delete-and-reinstall. (Diagnosed 2026-05-15.) Native is
        // checked via the global Capacitor object rather than UA
        // sniffing — works in both runtime + Vite dev preview.
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cap = (globalThis as any).Capacitor;
            if (cap?.isNativePlatform?.()) {
                // Unregister any SW that may have been registered by a
                // previous build before this bypass landed, so the user
                // doesn't get stuck on the old SW serving stale chunks.
                const regs = await navigator.serviceWorker.getRegistrations();
                for (const reg of regs) {
                    await reg.unregister();
                    console.warn('[SW] native platform — unregistered SW so capacitor:// chunks load fresh');
                }
                // Also nuke any cache the previous SW left behind.
                if ('caches' in window) {
                    const keys = await caches.keys();
                    for (const key of keys) {
                        await caches.delete(key);
                    }
                    if (keys.length) console.warn(`[SW] native platform — purged ${keys.length} legacy cache(s)`);
                }
                return;
            }
        } catch {
            // Fall through to web path if Capacitor check throws.
        }

        // ── DEV MODE: Unregister stale SWs that intercept Vite HMR requests ──
        // A production SW cached in the browser will intercept localhost:3000
        // module requests and serve stale/failed responses, preventing code
        // changes from ever reaching the app.
        if (import.meta.env.DEV) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const reg of registrations) {
                await reg.unregister();
                console.warn('[SW] Unregistered stale service worker in dev mode');
            }
            return;
        }

        // 1. Check for Secure Context (HTTPS or Localhost)
        // Service Workers throw errors if registered in an insecure context (e.g. LAN IP on HTTP)
        if (!window.isSecureContext) {
            // Silently skip - no need to warn user in console for development/LAN access
            return;
        }

        // 2. Check for Preview Environments (skip to prevent errors)
        const hostname = window.location.hostname;
        const isPreview =
            hostname.includes('usercontent.goog') ||
            hostname.includes('webcontainer') ||
            hostname.includes('ai.studio');

        if (isPreview) {
            return;
        }

        // 3. Attempt Registration with Error Handling
        try {
            const _registration = await navigator.serviceWorker.register('./sw.js');
        } catch (err: unknown) {
            // Silently ignore known "origin" or "document" errors common in IFrames/Previews/WebViews
            const msg = err instanceof Error ? err.message : '';
            if (
                msg.includes('origin') ||
                msg.includes('document') ||
                msg.includes('security') ||
                msg.includes('environment')
            ) {
                return;
            }
        }
    }
};

window.addEventListener('load', registerServiceWorker);

interface ErrorBoundaryProps {
    children?: ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public state: ErrorBoundaryState;
    public props: ErrorBoundaryProps;

    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.props = props;
        this.state = {
            hasError: false,
            error: null,
        };
    }

    public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        // Send to Sentry with component stack context
        captureException(error, {
            contexts: {
                react: { componentStack: errorInfo.componentStack },
            },
            tags: { boundary: 'root' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div
                    style={{
                        padding: '40px',
                        backgroundColor: '#0f172a',
                        color: 'white',
                        minHeight: '100vh',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        fontFamily: 'system-ui, sans-serif',
                    }}
                >
                    <h1 style={{ fontSize: '2rem', marginBottom: '1rem', color: '#ef4444' }}>
                        Mayday! System Failure.
                    </h1>
                    <p style={{ maxWidth: '500px', marginBottom: '2rem', color: '#94a3b8' }}>
                        The navigational computer encountered a critical error. We are working to restore systems.
                    </p>
                    <div
                        style={{
                            padding: '1rem',
                            backgroundColor: 'rgba(0,0,0,0.3)',
                            borderRadius: '8px',
                            marginBottom: '2rem',
                            fontFamily: 'monospace',
                            fontSize: '0.8rem',
                            color: '#f87171',
                        }}
                    >
                        {this.state.error?.message || 'Unknown Error'}
                    </div>
                    <button
                        aria-label="Add"
                        onClick={() => {
                            localStorage.clear();
                            window.location.reload();
                        }}
                        style={{
                            padding: '12px 24px',
                            backgroundColor: '#38bdf8',
                            color: '#0f172a',
                            border: 'none',
                            borderRadius: '99px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                        }}
                    >
                        Factory Reset & Reboot
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
    <React.StrictMode>
        <ErrorBoundary>
            <ThalassaProvider>
                <CrewCountProvider>
                    <App />
                </CrewCountProvider>
            </ThalassaProvider>
        </ErrorBoundary>
    </React.StrictMode>,
);
