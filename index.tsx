// Sentry must be imported FIRST — before any other app code
import { captureException } from './services/sentry';

// ── BOOT DIAGNOSTIC ── uses Capacitor Preferences (visible in Xcode as native bridge calls)
// because console.error from WKWebView does NOT appear in Xcode's native console.
import { Preferences } from '@capacitor/preferences';
Preferences.set({ key: 'BOOT_DIAG', value: `index.tsx loaded at ${new Date().toISOString()}` })
    .then(() => Preferences.get({ key: 'signalk_host' }))
    .then((r) => {
        // This will show as '⚡️  TO JS {"value":"..."}' in Xcode
        // Look for the signalk_host value in the Xcode log output
        Preferences.set({ key: 'BOOT_SK_HOST', value: `host=${r.value}` });
    })
    .catch(() => {});

import React, { ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThalassaProvider } from './context/ThalassaContext';
import { Keyboard } from '@capacitor/keyboard';
import { Capacitor } from '@capacitor/core';
import { CrewCountProvider } from './contexts/CrewCountContext';

// Enable iOS keyboard "Done" toolbar — lets you dismiss the keyboard
// without having to find somewhere else to tap
if (Capacitor.isNativePlatform()) {
    Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => {
        /* Keyboard API unavailable on web */
    });
}

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
