/**
 * useOnlineStatus — Reactive online/offline status hook.
 *
 * Uses the app's probe-verified WAN state. `navigator.onLine` only proves a
 * network interface exists; on a boat it is commonly true while connected to
 * a Pi/router with no internet. uiStore reacts immediately to the authoritative
 * `offline` event and only clears it after internetProbe reaches the WAN.
 */
import { useUIStore } from '../stores/uiStore';

export function useOnlineStatus(): boolean {
    return !useUIStore((state) => state.isOffline);
}
