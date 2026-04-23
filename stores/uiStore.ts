/**
 * UI Store — Zustand replacement for UIContext.
 *
 * Manages page navigation (view/transition direction), offline status,
 * and debug logs. The transition logic determines push/pop/tab animations.
 */

import { create } from 'zustand';
import type { TransitionDirection } from '../components/ui/PageTransition';

const TAB_PAGES = new Set(['dashboard', 'map', 'chat', 'vessel']);
const VESSEL_CHILDREN = new Set([
    'details',
    'compass',
    'inventory',
    'maintenance',
    'polars',
    'nmea',
    'equipment',
    'documents',
    'diary',
    'route',
]);
const OVERLAY_PAGES = new Set(['settings', 'warnings', 'voyage']);

interface UIState {
    currentView: string;
    previousView: string;
    transitionDirection: TransitionDirection;
    isOffline: boolean;
    debugLogs: string[];
    setPage: (page: string) => void;
    addDebugLog: (msg: string) => void;
}

export const useUIStore = create<UIState>()((set, get) => ({
    currentView: 'dashboard',
    previousView: 'dashboard',
    transitionDirection: 'tab' as TransitionDirection,
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    debugLogs: [],

    setPage: (page: string) => {
        const prev = get().currentView;
        let direction: TransitionDirection = 'tab';

        if (TAB_PAGES.has(page) && TAB_PAGES.has(prev)) {
            direction = 'tab';
        } else if (OVERLAY_PAGES.has(page)) {
            direction = 'push';
        } else if (TAB_PAGES.has(page) && (VESSEL_CHILDREN.has(prev) || OVERLAY_PAGES.has(prev))) {
            direction = 'pop';
        } else if (VESSEL_CHILDREN.has(page) && TAB_PAGES.has(prev)) {
            direction = 'push';
        } else if (VESSEL_CHILDREN.has(page) && VESSEL_CHILDREN.has(prev)) {
            direction = 'push';
        }

        set({ currentView: page, previousView: prev, transitionDirection: direction });
    },

    addDebugLog: (msg: string) => {
        set((state) => ({
            debugLogs: [`[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`, ...state.debugLogs].slice(0, 20),
        }));
    },
}));

// Offline listener — a definite "offline" from navigator is authoritative
// (link layer is physically down), so we react immediately. The reverse
// signal ("online") is NOT authoritative though — you can be on a WiFi
// whose router has no WAN uplink (e.g. boat LAN hosting the Pi). Clearing
// isOffline on 'online' events would falsely dismiss the banner in that
// case, so the upgrade back to "online" is instead driven by
// services/internetProbe.ts, which actually verifies WAN reachability.
if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => useUIStore.setState({ isOffline: true }));
}
