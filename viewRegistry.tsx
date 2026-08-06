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
const BosunConsolePage = lazyRetry(
    () => import('./components/voice/BosunConsole').then((m) => ({ default: m.BosunConsole })),
    'BosunConsole',
);
const MusicPageView: React.FC<{ onBack: () => void }> = ({ onBack }) => (
    <div className="mx-auto max-w-2xl p-5 sm:p-8" role="status">
        <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 p-6 text-center">
            <h2 className="text-lg font-bold text-white">Apple Music unavailable in public beta</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-amber-100/80">
                Music controls remain held until the production MusicKit capability and signed-device playback are
                verified. Calypso voice and the rest of Thalassa continue normally.
            </p>
            <button
                type="button"
                onClick={onBack}
                className="mt-5 min-h-[44px] rounded-xl border border-white/10 bg-white/[0.06] px-5 text-sm font-bold text-white"
            >
                Back
            </button>
        </div>
    </div>
);
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
    <div className="mx-auto max-w-2xl p-5 sm:p-8" role="status">
        <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 p-6 text-center">
            <h2 className="text-lg font-bold text-white">Guardian is held for public beta</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-amber-100/80">
                Nearby-vessel discovery and broadcasts remain off while Thalassa completes the server-side location
                privacy redesign. Anchor Watch, MOB and Radio remain available.
            </p>
            <button
                type="button"
                onClick={onBack}
                className="mt-5 min-h-[44px] rounded-xl border border-white/10 bg-white/[0.06] px-5 text-sm font-bold text-white"
            >
                Back to vessel
            </button>
        </div>
    </div>
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
const NoticesPage = lazyRetry(
    () => import('./components/vessel/NoticesPage').then((m) => ({ default: m.NoticesPage })),
    'NoticesPage',
);
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
        getProps: (ctx) => ({
            onTriggerUpgrade: () => ctx.setIsUpgradeOpen(true),
            onBack: () => ctx.setPage('dashboard'),
        }),
    },
    settings: {
        component: SettingsView,
        boundaryName: 'Settings',
        group: 'standalone',
        getProps: (ctx) => {
            // Check if we came from radio console
            const returnKey = authScopedStorageKey('thalassa_settings_return_to');
            const returnTo = typeof window !== 'undefined' ? localStorage.getItem(returnKey) : null;
            return {
                settings: ctx.settings,
                onSave: ctx.updateSettings,
                onLocationSelect: ctx.handleFavoriteSelect,
                onBack: () => {
                    if (returnTo) {
                        localStorage.removeItem(returnKey);
                        ctx.setPage(returnTo);
                    } else {
                        ctx.setPage('vessel');
                    }
                },
            };
        },
    },
    warnings: {
        component: WarningDetails,
        boundaryName: 'Warnings',
        group: 'standalone',
        getProps: (ctx) => ({ alerts: ctx.weatherAlerts }),
    },
    chat: {
        component: ChatPage,
        boundaryName: 'Chat',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    voice: {
        component: BosunConsolePage,
        boundaryName: 'BosunConsole',
        group: 'standalone',
        getProps: (ctx) => ({ onBack: () => ctx.setPage(ctx.previousView || 'dashboard') }),
    },
    music: {
        component: MusicPageView,
        boundaryName: 'MusicPage',
        group: 'standalone',
        gatedFeature: FEATURE_VISIBILITY.appleMusic ? 'calypsoMusic' : undefined,
        // Music is a global surface (Calypso and the now-playing pod can open
        // it from any tab), so Back returns to the actual caller.
        getProps: (ctx) => ({ onBack: () => ctx.setPage(ctx.previousView || 'dashboard') }),
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
        getProps: (ctx) => ({ onBack: () => ctx.setPage('nmea') }),
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
    notices: {
        component: NoticesPage,
        boundaryName: 'Notices',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
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
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
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
