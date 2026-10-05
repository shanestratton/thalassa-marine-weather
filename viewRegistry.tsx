/**
 * View Registry — Declarative configuration for all App views.
 *
 * Each view is defined by a ViewConfig entry. App.tsx uses the registry to:
 *  1. Determine which component to render (via `component`)
 *  2. Derive UI flags (isVesselView, showSearchBar, etc.) from `group`
 *  3. Build props dynamically via `getProps(ctx)`
 *
 * To add a new view: add a single entry here. No need to edit App.tsx.
 *
 * NOTE: 'dashboard' and 'map' are NOT in the registry — they have unique
 * rendering logic (error/loading states, picker overlay, etc.) that stays
 * in App.tsx.
 */
import React from 'react';
import { Button } from './components/ui/Button';
import { UnavailablePage } from './components/ui/UnavailableNotice';
import { LockIcon, MoonIcon } from './components/Icons';
import { MusicIcon } from './components/music/musicPage/icons';
import { lazyRetry } from './utils/lazyRetry';
import type { Feature } from './services/SubscriptionService';
import { authScopedStorageKey } from './services/authIdentityScope';
import { FEATURE_VISIBILITY } from './utils/featureVisibility';

// ── Lazy-loaded components ───────────────────────────────────────────────────
const GalleyPage = lazyRetry(
    () => import('./components/vessel/GalleyPage').then((m) => ({ default: m.GalleyPage })),
    'GalleyPage',
);
const VoyagePlanner = lazyRetry(
    () => import('./components/RoutePlanner').then((m) => ({ default: m.RoutePlanner })),
    'RoutePlanner',
);
const SettingsView = lazyRetry(
    () => import('./components/SettingsModal').then((m) => ({ default: m.SettingsView })),
    'SettingsView',
);
const VesselHub = lazyRetry(
    () => import('./components/VesselHub').then((m) => ({ default: m.VesselHub })),
    'VesselHub',
);
const ShipStoresPage = lazyRetry(
    () => import('./components/vessel/InventoryList').then((m) => ({ default: m.InventoryList })),
    'ShipStoresList',
);
const MaintenancePage = lazyRetry(
    () => import('./components/vessel/MaintenanceHub').then((m) => ({ default: m.MaintenanceHub })),
    'MaintenanceHub',
);
const EquipmentPage = lazyRetry(
    () => import('./components/vessel/EquipmentList').then((m) => ({ default: m.EquipmentList })),
    'EquipmentList',
);
const DocumentsPage = lazyRetry(
    () => import('./components/vessel/DocumentsHub').then((m) => ({ default: m.DocumentsHub })),
    'DocumentsHub',
);
const NmeaGatewayPage = lazyRetry(
    () => import('./components/vessel/NmeaPage').then((m) => ({ default: m.NmeaPage })),
    'NmeaPage',
);
const PolarPage = lazyRetry(
    () => import('./components/vessel/PolarPage').then((m) => ({ default: m.PolarPage })),
    'PolarPage',
);
const WarningDetails = lazyRetry(
    () => import('./components/WarningDetails').then((m) => ({ default: m.WarningDetails })),
    'WarningDetails',
);
const AnchorWatchPage = lazyRetry(
    () => import('./components/AnchorWatchPage').then((m) => ({ default: m.AnchorWatchPage })),
    'AnchorWatchPage',
);
const ChatPage = lazyRetry(() => import('./components/ChatPage').then((m) => ({ default: m.ChatPage })), 'ChatPage');
const SightingsPage = lazyRetry(
    () => import('./components/sightings/SightingsPage').then((m) => ({ default: m.SightingsPage })),
    'SightingsPage',
);
const LiveBosunConsolePage = lazyRetry(
    () => import('./components/voice/BosunConsole').then((m) => ({ default: m.BosunConsole })),
    'BosunConsole',
);
// ── Where Back goes, in words ────────────────────────────────────────────────

/**
 * The name each view goes by on screen: its tab label, or its page title.
 * Pages whose Back returns to the view that opened them (MOB, Calypso, Music)
 * name that view on the chevron and in the crumb, the way their
 * fixed-parent siblings say 'Back to Vessel' (UX scorecard run 9: they were a
 * bare 'Go back'). A view missing here keeps the plain 'Go back' rather than
 * a guessed name.
 */
const VIEW_NAMES: Record<string, string> = {
    dashboard: 'The Glass',
    map: 'Obs',
    voyage: 'Plan',
    details: 'Log',
    vessel: 'Vessel',
    settings: 'Settings',
    warnings: 'Forecast alerts',
    // Scuttlebutt is a page Calypso or Music can be opened over; without it
    // their Back read a bare 'Go back' with no crumb (UX scorecard run 10).
    chat: 'Scuttlebutt',
    sightings: 'Sightings',
    voice: 'Calypso',
    music: 'Apple Music',
    compass: 'Anchor Watch',
    radio: 'Radio Console',
    nmea: 'NMEA Gateway',
    mob: 'Man Overboard',
    guardian: 'Guardian',
};

/** The name of the view Back returns to, or undefined when it has none worth saying. */
function viewName(view: string | null | undefined): string | undefined {
    return view ? VIEW_NAMES[view] : undefined;
}

/**
 * The chevron's name and the crumb trail for a page whose Back goes to
 * `destination`: 'Back to Vessel' over a VESSEL crumb. Both come from the one
 * view Back really goes to, so the words cannot promise a different place.
 */
function backTo(destination: string | null | undefined, pageTitle: string) {
    const name = viewName(destination);
    return name ? { backLabel: `Back to ${name}`, breadcrumbs: [name, pageTitle] } : {};
}

/**
 * Calypso is parked (FEATURE_VISIBILITY.calypsoConsole, 2026-08-09). The mic
 * buttons are hidden, but a persisted `currentView` or a stale `previousView`
 * can still resolve to 'voice', so the route itself must be closed rather than
 * merely unreachable — otherwise a returning skipper lands on a live console
 * that is supposed to be off.
 *
 * Deliberately explicit about what is NOT affected. "Voice is off" would read
 * as MAYDAY read-out being off too, and it is not.
 */
const CalypsoParkedPage: React.FC<{
    onBack: () => void;
    onNavigate?: (page: string) => void;
    backLabel?: string;
    breadcrumbs?: string[];
}> = ({ onBack, onNavigate, backLabel, breadcrumbs }) => (
    <UnavailablePage
        pageTitle="Calypso"
        pageSubtitle="Voice assistant"
        onBack={onBack}
        backLabel={backLabel}
        breadcrumbs={breadcrumbs}
        icon={<MoonIcon className="h-5 w-5" />}
        // A plain heading; the whimsy lives in the body (UX scorecard run 7).
        title="Calypso is switched off"
        actions={
            // The copy names the Radio and MOB pages, so the page goes there
            // instead of leaving the skipper to find them (UX scorecard run 6).
            onNavigate && (
                <>
                    <Button variant="secondary" onClick={() => onNavigate('radio')} className="text-white">
                        Open Radio
                    </Button>
                    <Button variant="secondary" onClick={() => onNavigate('mob')} className="text-white">
                        Open MOB
                    </Button>
                </>
            )
        }
    >
        {/* Paragraphs longer than two lines read left-aligned, not centred.
            'right one.' is held together: with text-pretty gone from the
            notice (run 9), 'one.' sat alone on the last line at 375 and 393. */}
        <p className="text-left">
            Calypso is having a lie down while we improve how it hears you. It misheard too often, and a wrong answer
            sounded just as sure as a right&nbsp;one.
        </p>
        {/* Only the MOB MAYDAY is still spoken; the Radio page stopped
            speaking on 2026-08-28 and sets its calls out to read on VHF. One
            casing for the procedure word: MAYDAY. */}
        <p className="text-left">
            MAYDAY calls, DSC and radio position reports are unaffected. The MOB page still reads the MAYDAY aloud in
            Calypso&rsquo;s voice, and the Radio page sets out your calls to read on VHF.
        </p>
    </UnavailablePage>
);
const BosunConsolePage = FEATURE_VISIBILITY.calypsoConsole ? LiveBosunConsolePage : CalypsoParkedPage;
// RELEASED 2026-08-10: the MusicKit capability is live on the App ID and the
// flag is on, so the real page ships. The held placeholder below stays in the
// source deliberately — it is the OFF branch if the flag ever goes back, and
// the beta-readiness gate requires both surfaces to exist so the flip is
// always a one-line profile change, never a rewiring.
const LiveMusicPage = lazyRetry(
    () => import('./components/music/MusicPage').then((m) => ({ default: m.MusicPage })),
    'MusicPage',
);
const HeldMusicPage: React.FC<{ onBack: () => void; backLabel?: string; breadcrumbs?: string[] }> = ({
    onBack,
    backLabel,
    breadcrumbs,
}) => (
    <UnavailablePage
        pageTitle="Apple Music"
        onBack={onBack}
        backLabel={backLabel}
        breadcrumbs={breadcrumbs}
        tone="amber"
        icon={<MusicIcon className="h-5 w-5" />}
        title="Apple Music unavailable in public beta"
    >
        <p>
            Music controls remain held until the production MusicKit capability and signed-device playback are verified.
            Calypso voice and the rest of Thalassa continue normally.
        </p>
    </UnavailablePage>
);
// The flag is a build-time constant, so the untaken branch tree-shakes out of
// the bundle exactly as the old hand-excised versions did.
const MusicPageView = FEATURE_VISIBILITY.appleMusic ? LiveMusicPage : HeldMusicPage;
const LogPage = lazyRetry(() => import('./pages/LogPage').then((m) => ({ default: m.LogPage })), 'LogPage');
const DiaryPage = lazyRetry(
    () => import('./components/DiaryPage').then((m) => ({ default: m.DiaryPage })),
    'DiaryPage',
);
const CrewPage = lazyRetry(
    () => import('./components/CrewManagement').then((m) => ({ default: m.CrewManagement })),
    'CrewManagement',
);
const ChecklistsPage = lazyRetry(
    () => import('./components/vessel/ChecklistsPage').then((m) => ({ default: m.ChecklistsPage })),
    'ChecklistsPage',
);
const WeatherWindowCheckPage = lazyRetry(
    () => import('./components/weatherWindow/WeatherWindowCheck').then((m) => ({ default: m.WeatherWindowCheck })),
    'WeatherWindowCheck',
);
const SkipperReferencePage = lazyRetry(
    () => import('./components/reference/SkipperReference').then((m) => ({ default: m.SkipperReference })),
    'SkipperReference',
);

const LiveGuardianPage = lazyRetry(
    () => import('./components/GuardianPage').then((m) => ({ default: m.GuardianPage })),
    'GuardianPage',
);
const GuardianBetaHoldPage: React.FC<{ onBack: () => void }> = ({ onBack }) => (
    <UnavailablePage
        pageTitle="Guardian"
        onBack={onBack}
        breadcrumbs={['Vessel', 'Guardian']}
        tone="amber"
        icon={<LockIcon className="h-5 w-5" />}
        title="Guardian is held for public beta"
    >
        <p>
            Nearby-vessel discovery and broadcasts remain off while Thalassa completes the server-side location privacy
            redesign. Anchor Watch, MOB and Radio remain available.
        </p>
    </UnavailablePage>
);
const GuardianPage = FEATURE_VISIBILITY.guardian ? LiveGuardianPage : GuardianBetaHoldPage;
const RadioConsolePage = lazyRetry(
    () => import('./components/vessel/RadioConsolePage').then((m) => ({ default: m.RadioConsolePage })),
    'RadioConsolePage',
);
const MobPage = lazyRetry(() => import('./components/vessel/MobPage').then((m) => ({ default: m.MobPage })), 'MobPage');
const AvNavPage = lazyRetry(
    () => import('./components/vessel/AvNavPage').then((m) => ({ default: m.AvNavPage })),
    'AvNavPage',
);
const EncLibraryPage = lazyRetry(
    () => import('./components/vessel/EncLibraryPage').then((m) => ({ default: m.EncLibraryPage })),
    'EncLibraryPage',
);
// NoticesPage retired with its route (binder review 2026-09-02):
// notices live on the OBS chart layer (useNoticeLayer) — perishable,
// spatial data has no standalone drawer. components/vessel/NoticesPage.tsx
// remains on disk for git history only.
const GpxImportPage = lazyRetry(
    () => import('./components/vessel/GpxImportPage').then((m) => ({ default: m.GpxImportPage })),
    'GpxImportPage',
);
const TheGlassPage = lazyRetry(
    () => import('./components/nmea/TheGlassPage').then((m) => ({ default: m.TheGlassPage })),
    'TheGlassPage',
);

// ── Types ────────────────────────────────────────────────────────────────────

/** Context passed to each view's getProps function. */
export interface ViewContext {
    setPage: (view: string) => void;
    /** View immediately below the current routed page, used by global
     * surfaces such as Calypso and Music to return where they were opened. */
    previousView: string;
    setIsUpgradeOpen: (open: boolean) => void;
    settings: Record<string, unknown>;
    updateSettings: (updates: Record<string, unknown>) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleFavoriteSelect: (...args: any[]) => void;
    weatherAlerts: unknown[];
    /** When the report behind those alerts was generated — the Warnings page says when it last checked. */
    weatherGeneratedAt?: string;
    /** Place the current forecast is for — the Warnings page names it. */
    weatherLocationName?: string;
    /** Unread Scuttlebutt DMs, the Vessel tab's badge; the Vessel page's
     *  Scuttlebutt card says it too. */
    chatUnread?: number;
}

/** Configuration for a single registered view. */
export interface ViewConfig {
    /** The renderable React component for this view (normally lazy-loaded). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: React.ComponentType<any> | React.LazyExoticComponent<React.ComponentType<any>>;
    /** Name for the ErrorBoundary wrapping this view. */
    boundaryName: string;
    /**
     * View group — determines nav-bar highlighting and layout behavior:
     *  - 'vessel': vessel sub-pages (shows Vessel tab as active, adds onBack)
     *  - 'standalone': top-level pages (chat, voyage, settings, warnings)
     */
    group: 'vessel' | 'standalone';
    /** If true, the search bar is shown in the header for this view. Default: false. */
    showSearchBar?: boolean;
    /** Build the props object for this view. */
    getProps?: (ctx: ViewContext) => Record<string, unknown>;
    /**
     * If set, the view is gated behind this entitlement. App.tsx wraps
     * the rendered component with <PaywallGate feature={gatedFeature}>
     * which shows an upsell card to non-entitled users.
     */
    gatedFeature?: Feature;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const VIEW_REGISTRY: Record<string, ViewConfig> = {
    // ── Standalone pages ─────────────────────────────────────────────────
    voyage: {
        component: VoyagePlanner,
        boundaryName: 'VoyagePlanner',
        group: 'standalone',
        // No onBack: the Route Planner is a top-level page with nowhere to go
        // back to, so the header arrow only ever bounced to the dashboard
        // (Shane 2026-09-08: "remove that as it is a top level page"). The
        // prop stays on RoutePlanner for the embedded/sub-page uses.
        getProps: (ctx) => ({
            onTriggerUpgrade: () => ctx.setIsUpgradeOpen(true),
        }),
    },
    settings: {
        component: SettingsView,
        boundaryName: 'Settings',
        group: 'standalone',
        getProps: (ctx) => {
            // Check if we came from a page that asked to be returned to (the
            // radio console). Guardian no longer detours here to sign in: its
            // card opens the sign-in sheet in place (UX scorecard run 10).
            const returnKey = authScopedStorageKey('thalassa_settings_return_to');
            const returnTo = typeof window !== 'undefined' ? localStorage.getItem(returnKey) : null;
            return {
                settings: ctx.settings,
                onSave: ctx.updateSettings,
                onLocationSelect: ctx.handleFavoriteSelect,
                onBack: () => {
                    localStorage.removeItem(returnKey);
                    ctx.setPage(returnTo || 'vessel');
                },
            };
        },
    },
    warnings: {
        component: WarningDetails,
        boundaryName: 'Warnings',
        group: 'standalone',
        getProps: (ctx) => ({
            alerts: ctx.weatherAlerts,
            checkedAt: ctx.weatherGeneratedAt,
            placeName: ctx.weatherLocationName,
        }),
    },
    chat: {
        component: ChatPage,
        boundaryName: 'Chat',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    // Sightings (Shane 2026-10-05: "call it sightings"): entered from
    // Scuttlebutt's card, so Back returns to Scuttlebutt and says so.
    sightings: {
        component: SightingsPage,
        boundaryName: 'Sightings',
        group: 'vessel',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('chat'),
            ...backTo('chat', 'Sightings'),
        }),
    },
    voice: {
        component: BosunConsolePage,
        boundaryName: 'BosunConsole',
        group: 'standalone',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage(ctx.previousView || 'dashboard'),
            ...backTo(ctx.previousView || 'dashboard', 'Calypso'),
            // The parked page's Open Radio / Open MOB buttons.
            onNavigate: (page: string) => ctx.setPage(page),
        }),
    },
    music: {
        component: MusicPageView,
        boundaryName: 'MusicPage',
        group: 'standalone',
        gatedFeature: FEATURE_VISIBILITY.appleMusic ? 'calypsoMusic' : undefined,
        // Music is a global surface (Calypso and the now-playing pod can open
        // it from any tab), so Back returns to the actual caller.
        getProps: (ctx) => ({
            onBack: () => ctx.setPage(ctx.previousView || 'dashboard'),
            ...backTo(ctx.previousView || 'dashboard', 'Apple Music'),
        }),
    },

    // ── Vessel hub ───────────────────────────────────────────────────────
    vessel: {
        component: VesselHub,
        boundaryName: 'VesselHub',
        group: 'vessel',
        getProps: (ctx) => ({
            onNavigate: ctx.setPage,
            settings: ctx.settings,
            onSave: ctx.updateSettings,
            chatUnread: ctx.chatUnread ?? 0,
        }),
    },

    // ── Vessel sub-pages ─────────────────────────────────────────────────
    // NOTE: `details` (LogPage) is now `group: 'standalone'` because the
    // 5-tab nav restructure (Week 2) promoted Log to a top-level bottom
    // tab — same level as Glass / Charts / Plan / Vessel. Keeping it
    // grouped as `vessel` would highlight the Vessel tab when on Log
    // and clash with the dedicated Log tab. As a top-level tab it does not
    // render a synthetic Back button.
    details: {
        component: LogPage,
        boundaryName: 'LogPage',
        group: 'standalone',
        getProps: () => ({}),
    },
    compass: {
        component: AnchorWatchPage,
        boundaryName: 'AnchorWatch',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    weatherWindow: {
        component: WeatherWindowCheckPage,
        boundaryName: 'WeatherWindow',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    skipperReference: {
        component: SkipperReferencePage,
        boundaryName: 'SkipperReference',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    inventory: {
        component: ShipStoresPage,
        boundaryName: "Ship's Stores",
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    maintenance: {
        component: MaintenancePage,
        boundaryName: 'Maintenance',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    polars: {
        component: PolarPage,
        boundaryName: 'Polars',
        group: 'vessel',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('vessel'),
            onNavigateToNmea: () => ctx.setPage('nmea'),
            onOpenVesselProfile: () => ctx.setPage('settings'),
        }),
    },
    nmea: {
        component: NmeaGatewayPage,
        boundaryName: 'NmeaGateway',
        group: 'vessel',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('vessel'),
            onNavigateToGlass: () => ctx.setPage('glass'),
        }),
    },
    glass: {
        component: TheGlassPage,
        boundaryName: 'TheGlass',
        group: 'vessel',
        // Only NMEA Gateway opens the Instrument Panel, and Back always goes
        // there, so the chevron and crumb name it from that same fixed view
        // (UX scorecard run 10: the only Vessel sub-page with a bare 'Go back'
        // and no crumb).
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('nmea'),
            ...backTo('nmea', 'Instrument Panel'),
        }),
    },
    avnav: {
        component: AvNavPage,
        boundaryName: 'AvNavCharts',
        group: 'vessel',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('vessel'),
            onOpenEncLibrary: () => ctx.setPage('encLibrary'),
        }),
    },
    encLibrary: {
        component: EncLibraryPage,
        boundaryName: 'EncLibrary',
        group: 'vessel',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('vessel'),
            onOpenMap: () => ctx.setPage('map'),
        }),
    },
    'gpx-import': {
        component: GpxImportPage,
        boundaryName: 'GpxImport',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    equipment: {
        component: EquipmentPage,
        boundaryName: 'Equipment',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    documents: {
        component: DocumentsPage,
        boundaryName: 'Documents',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    diary: {
        component: DiaryPage,
        boundaryName: 'Diary',
        group: 'vessel',
        gatedFeature: 'diary',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    crew: {
        component: CrewPage,
        boundaryName: 'Crew',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    checklists: {
        component: ChecklistsPage,
        boundaryName: 'Checklists',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },

    guardian: {
        component: GuardianPage,
        boundaryName: 'Guardian',
        group: 'vessel',
        // The signed-out card opens the sign-in sheet in place, as Crew,
        // Galley and Scuttlebutt do, so there is no detour to Settings to wire
        // (UX scorecard run 10).
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('vessel'),
        }),
    },
    radio: {
        component: RadioConsolePage,
        boundaryName: 'RadioConsole',
        group: 'vessel',
        getProps: (ctx) => ({
            onBack: () => ctx.setPage('vessel'),
            onNavigate: (page: string) => ctx.setPage(page),
        }),
    },
    mob: {
        component: MobPage,
        boundaryName: 'MobPage',
        group: 'vessel',
        getProps: (ctx) => ({
            // Return where MOB was OPENED from, not always Vessel (Shane
            // 2026-08-07). MOB is reachable from the OBS chart's always-visible
            // red button as well as the Vessel safety row, and being thrown to
            // Vessel after marking from the chart loses the chart you were
            // working — exactly when you least want to go hunting for it.
            // Falls back to Vessel, which is where the feature lives.
            onBack: () => ctx.setPage(ctx.previousView || 'vessel'),
            // The chevron and crumb say where that is ('Back to Obs' from the
            // chart's red button, 'Back to Vessel' from the safety row).
            ...backTo(ctx.previousView || 'vessel', 'Man Overboard'),
            onNavigate: (page: string) => ctx.setPage(page),
        }),
    },
    galley: {
        component: GalleyPage,
        boundaryName: 'Galley',
        group: 'vessel',
        gatedFeature: 'galley',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
};

// ── Derived sets (precomputed for O(1) lookups) ──────────────────────────────

/** Views that belong to the "vessel" group (nav tab stays highlighted). */
export const VESSEL_VIEWS = new Set(
    Object.entries(VIEW_REGISTRY)
        .filter(([, cfg]) => cfg.group === 'vessel')
        .map(([key]) => key),
);

/** Views that show the search bar in the header. */
export const SEARCH_BAR_VIEWS = new Set(
    Object.entries(VIEW_REGISTRY)
        .filter(([, cfg]) => cfg.showSearchBar)
        .map(([key]) => key),
);

/** Views where pull-to-refresh is disabled (all registered views). */
export const PULL_REFRESH_DISABLED_VIEWS = new Set(Object.keys(VIEW_REGISTRY));
