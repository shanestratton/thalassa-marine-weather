/**
 * UI Store — Zustand replacement for UIContext.
 *
 * Manages page navigation (view/transition direction), offline status,
 * and debug logs. The transition logic determines push/pop/tab animations.
 */

import { create } from 'zustand';
import type { TransitionDirection } from '../components/ui/PageTransition';
import { initialViewFromUrl } from '../services/deepLink';

// The Week-2 five-tab IA: Glass / OBS / Plan / Log / Vessel. 'chat'
// (Scuttlebutt) moved under Vessel → Wardroom, and 'voyage' (Plan) +
// 'details' (Log) were promoted from overlay/child pages to tabs — this
// set drifted behind that restructure, so Plan/Log transitions animated
// as pushes and chat still slid like a tab.
const TAB_PAGES = new Set(['dashboard', 'map', 'voyage', 'details', 'vessel']);
const VESSEL_CHILDREN = new Set([
    'chat',
    'compass',
    'weatherWindow',
    'skipperReference',
    'inventory',
    'maintenance',
    'polars',
    'nmea',
    'glass',
    'avnav',
    'encLibrary',
    'notices',
    'gpx-import',
    'equipment',
    'documents',
    'diary',
    'crew',
    'checklists',
    'guardian',
    'radio',
    'mob',
    'galley',
]);
const OVERLAY_PAGES = new Set(['settings', 'warnings']);

interface UIState {
    currentView: string;
    previousView: string;
    transitionDirection: TransitionDirection;
    isOffline: boolean;
    debugLogs: string[];
    setPage: (page: string) => void;
    addDebugLog: (msg: string) => void;
}

// Deep links (thalassawx.app/plan → the desktop passage builder) seed
// the boot view directly so there's no flash of the default page before
// the map mounts. Native serves from '/', which resolves to the default.
//
// Default is THE GLASS (Shane, 2026-08-10): the app must open on the
// instrument page, nowhere else. Aboard, the phone in the cockpit mount
// is an instrument display first — booting to the weather dashboard (the
// old default) meant a tap-tap-tap to reach the numbers every time the
// app relaunched. Only an EXPLICIT web deep link overrides this; the
// native app always serves '/' and therefore always opens on Glass.
const bootView = initialViewFromUrl() ?? 'glass';

/**
 * Where the skipper was, written on every navigation.
 *
 * Deliberately localStorage and deliberately SYNCHRONOUS. A WebContent kill
 * arrives with no warning and no unload event — anything async (Preferences,
 * IndexedDB) may never flush, and a breadcrumb that isn't written before the
 * process dies is no breadcrumb at all.
 *
 * This is only a record. It does NOT change cold-boot behaviour: bootView is
 * still the deep link or the dashboard. Restoring from it happens exactly once,
 * after the native side confirms the web layer was killed — see
 * services/webContentKill.ts. Restoring on every launch would undo the
 * deliberate "cold open paints the dashboard" behaviour protected in d812494a.
 */
const LAST_VIEW_KEY = 'thalassa.lastView';

export interface LastViewCrumb {
    view: string;
    at: number;
}

function writeLastView(view: string): void {
    // Overlays are not places you return to — landing in Settings after a
    // crash would be more disorienting than landing on the dashboard.
    if (OVERLAY_PAGES.has(view)) return;
    try {
        localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ view, at: Date.now() }));
    } catch {
        // Private mode / quota. A missing breadcrumb costs a restore, not a
        // navigation, so there is nothing to report.
    }
}

/** The last view the skipper was on, or null if there isn't a usable one. */
export function readLastView(): LastViewCrumb | null {
    try {
        const raw = localStorage.getItem(LAST_VIEW_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<LastViewCrumb>;
        if (typeof parsed.view !== 'string' || typeof parsed.at !== 'number') return null;
        if (OVERLAY_PAGES.has(parsed.view)) return null;
        return { view: parsed.view, at: parsed.at };
    } catch {
        return null;
    }
}

export const useUIStore = create<UIState>()((set, get) => ({
    currentView: bootView,
    previousView: bootView,
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

        writeLastView(page);
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
