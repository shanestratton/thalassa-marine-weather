import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/** Browser events are not a reliable native WebView resume signal. Register
 * both, deduplicating requests in the caller, and clean up late registrations. */
export function subscribePressureRefresh(refresh: () => void): () => void {
    let disposed = false;
    let removeNative: (() => Promise<void>) | undefined;
    const visibleRefresh = () => {
        if (!disposed && document.visibilityState !== 'hidden') refresh();
    };
    const interval = setInterval(visibleRefresh, 60_000);
    window.addEventListener('focus', visibleRefresh);
    window.addEventListener('online', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    if (Capacitor.isNativePlatform()) {
        void App.addListener('appStateChange', ({ isActive }) => {
            // Native isActive is authoritative even if WebView visibility has
            // not caught up yet. The caller must not filter it a second time.
            if (isActive && !disposed) refresh();
        })
            .then((handle) => {
                if (disposed) void handle.remove();
                else removeNative = () => handle.remove();
            })
            .catch(() => {
                /* browser listeners remain available */
            });
    }
    return () => {
        disposed = true;
        clearInterval(interval);
        window.removeEventListener('focus', visibleRefresh);
        window.removeEventListener('online', visibleRefresh);
        document.removeEventListener('visibilitychange', visibleRefresh);
        if (removeNative) void removeNative();
    };
}

/** The same browser/native foreground signals also serve other weather maps. */
export const subscribeWeatherRefresh = subscribePressureRefresh;

/** Includes fallback batching/session lookup, not just each individual fetch.
 * A hung request must not own the refresh lock for the rest of the session. */
export async function boundedPressureRequest<T>(request: Promise<T>, timeoutMs = 120_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            request,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Pressure refresh timed out')), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
