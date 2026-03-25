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
const GroceryListPage = lazyRetry(
    () => import('./components/vessel/GroceryListPage').then((m) => ({ default: m.GroceryListPage })),
    'GroceryListPage',
);
const GuardianPage = lazyRetry(
    () => import('./components/GuardianPage').then((m) => ({ default: m.GuardianPage })),
    'GuardianPage',
);
const RadioConsolePage = lazyRetry(
    () => import('./components/vessel/RadioConsolePage').then((m) => ({ default: m.RadioConsolePage })),
    'RadioConsolePage',
);

// ── Types ────────────────────────────────────────────────────────────────────

/** Context passed to each view's getProps function. */
export interface ViewContext {
    setPage: (view: string) => void;
    setIsUpgradeOpen: (open: boolean) => void;
    settings: Record<string, unknown>;
    updateSettings: (updates: Record<string, unknown>) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleFavoriteSelect: (...args: any[]) => void;
    weatherAlerts: unknown[];
}

/** Configuration for a single registered view. */
export interface ViewConfig {
    /** The lazy-loaded React component for this view. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: React.LazyExoticComponent<React.ComponentType<any>>;
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
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const VIEW_REGISTRY: Record<string, ViewConfig> = {
    // ── Standalone pages ─────────────────────────────────────────────────
    voyage: {
        component: VoyagePlanner,
        boundaryName: 'VoyagePlanner',
        group: 'standalone',
        getProps: (ctx) => ({ onTriggerUpgrade: () => ctx.setIsUpgradeOpen(true) }),
    },
    settings: {
        component: SettingsView,
        boundaryName: 'Settings',
        group: 'standalone',
        getProps: (ctx) => {
            // Check if we came from radio console
            const returnTo = typeof window !== 'undefined' ? localStorage.getItem('thalassa_settings_return_to') : null;
            return {
                settings: ctx.settings,
                onSave: ctx.updateSettings,
                onLocationSelect: ctx.handleFavoriteSelect,
                onBack: () => {
                    if (returnTo) {
                        localStorage.removeItem('thalassa_settings_return_to');
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
        group: 'standalone',
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
    details: {
        component: LogPage,
        boundaryName: 'LogPage',
        group: 'vessel',
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    compass: {
        component: AnchorWatchPage,
        boundaryName: 'AnchorWatch',
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
        getProps: (ctx) => ({ onBack: () => ctx.setPage('vessel') }),
    },
    route: {
        component: VoyagePlanner,
        boundaryName: 'RoutePlanner',
        group: 'vessel',
        getProps: (ctx) => ({
            onTriggerUpgrade: () => ctx.setIsUpgradeOpen(true),
            onBack: () => ctx.setPage('vessel'),
        }),
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
    grocery: {
        component: GroceryListPage,
        boundaryName: 'GroceryList',
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
    galley: {
        component: GalleyPage,
        boundaryName: 'Galley',
        group: 'vessel',
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
