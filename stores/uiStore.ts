/**
 * UI Store — Zustand replacement for UIContext.
 *
 * Manages page navigation (view/transition direction) and offline status.
 * The transition logic determines push/pop/tab animations.
 *
 * The write-only `debugLogs` array was removed on 2026-09-03: nothing ever
 * read it, but its fifteen writers in settingsStore each pushed a store
 * update through every whole-store `useUI()` subscriber (seventeen of them).
 * The settings diagnostics now go to the tagged logger instead.
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
    'sightings',
    'compass',
    'skipperReference',
    'inventory',
    'maintenance',
    'polars',
    'nmea',
    'glass',
    'avnav',
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
    setPage: (page: string) => void;
}

// Deep links (thalassawx.app/plan → the desktop passage builder) seed
// the boot view directly so there's no flash of the default page before
// the map mounts. Native serves from '/', which resolves to the default.
//
// Default is THE GLASS (Shane, 2026-08-10): the app must open on the
// Glass tab, nowhere else. NAMING TRAP: the Glass tab is the
// 'dashboard' view (App.tsx NavButton label "The Glass"). The registry
// key 'glass' is TheGlassPage — the fullscreen NMEA "Instrument Panel",
// a Vessel child — and booting there is exactly the wrong-panel launch
// Shane reported on 2026-08-10 after this line briefly said 'glass'.
// Only an EXPLICIT web deep link overrides this; the native app always
// serves '/' and therefore always opens on the Glass tab.
const bootView = initialViewFromUrl() ?? 'dashboard';

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
}));

// The boot's own page change (the tablet start, App.tsx), held back from the
// crumb until the session watch has read the previous session's from it.
let bootViewCrumb: string | null = null;
let sessionCrumbRead = false;

/**
 * Open `page` as part of starting up, not as a navigation. The crumb still
 * names where the LAST session was until useAppBootstrap's session watch has
 * read it (services/webContentKill.ts detectAbnormalExit: "this runs before
 * anything has navigated"); a kill on the Log must not be booked to the chart
 * the next start opened. Written the moment it has been read.
 */
export function showBootView(page: string): void {
    const prev = useUIStore.getState().currentView;
    useUIStore.setState({ currentView: page, previousView: prev, transitionDirection: 'tab' });
    if (sessionCrumbRead) writeLastView(page);
    else bootViewCrumb = page;
}

/** The session watch has read the last session's crumb: record the boot's page now. */
export function sessionCrumbConsumed(): void {
    sessionCrumbRead = true;
    const page = bootViewCrumb;
    bootViewCrumb = null;
    // A real navigation since has written its own crumb.
    if (page && useUIStore.getState().currentView === page) writeLastView(page);
}

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
