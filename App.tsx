import React, { Suspense, useState, useEffect, useRef } from 'react';
import { useWeather } from './context/WeatherContext';
import { useSettings } from './context/SettingsContext';
import { useUI } from './context/UIContext';
import { useLocationStore } from './stores/LocationStore';
// authStore is no longer imported here — App.tsx is browse-free, no
// boot-time auth check. Save-point sheets and the Settings → Account
// entry import useAuthStore + SignInScreen directly where they need it.
import { useAppController } from './hooks/useAppController';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { Dashboard } from './components/Dashboard';
import { SearchIcon, MapIcon, StarIcon, RouteIcon, ClipboardIcon } from './components/Icons';
import { SkeletonDashboard } from './components/SkeletonLoader';
import { NotificationManager } from './components/NotificationManager';
import { ProcessOverlay } from './components/ProcessOverlay';
// FollowRouteBadge unmounted 2026-05-19 — stop-following lives in the
// SystemStatusButton i-card now. See comment block in JSX below for
// the rationale.
import { PaywallGate } from './components/PaywallGate';
import { PullToRefresh } from './components/PullToRefresh';
import { NavButton } from './components/NavButton';
// NAV_ICON_CHAT no longer imported — Scuttlebutt was demoted off the
// bottom nav in the Week 2 5-tab restructure. Chat is still
// reachable via the Vessel hub's Wardroom section and any
// setPage('chat') call sites (push notification tap-target, etc).
import { NAV_ICON_MAP, NAV_ICON_VESSEL } from './components/icons/NavIconAssets';
import { StormGlassNavIcon } from './components/icons/StormGlassNavIcon';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SystemStatusButton } from './components/SystemStatusButton';
import { canAccess } from './services/SubscriptionService';
import { AlertMonitorService } from './services/AlertMonitorService';
import { ToastPortal, toast } from './components/Toast';
import { PushToast } from './components/PushToast';
import { PageTransition } from './components/ui/PageTransition';
import { checkDisclaimerAccepted } from './modules/LegalGuard';
import { DisclaimerOverlay } from './modules/DisclaimerOverlay';
import { lazyRetry } from './utils/lazyRetry';
import { VIEW_REGISTRY, VESSEL_VIEWS, PULL_REFRESH_DISABLED_VIEWS, type ViewContext } from './viewRegistry';
import { TIER_INFO } from './services/SubscriptionService';

// Only components NOT in the registry are lazy-loaded here
const ForecastSheet = lazyRetry(() => import('./components/ForecastSheet').then((m) => ({ default: m.ForecastSheet })));
const UpgradeModal = lazyRetry(
    () => import('./components/UpgradeModal').then((module) => ({ default: module.UpgradeModal })),
    'UpgradeModal',
);
const MapHub = lazyRetry(() => import('./components/map/MapHub').then((m) => ({ default: m.MapHub })), 'MapHub');
const OnboardingWizard = lazyRetry(
    () => import('./components/OnboardingWizard').then((module) => ({ default: module.OnboardingWizard })),
    'OnboardingWizard',
);
const IOSInstallPrompt = lazyRetry(
    () => import('./components/IOSInstallPrompt').then((m) => ({ default: m.IOSInstallPrompt })),
    'IOSInstallPrompt',
);
const OnboardingOverlay = lazyRetry(
    () => import('./components/ui/OnboardingOverlay').then((m) => ({ default: m.OnboardingOverlay })),
    'OnboardingOverlay',
);
// SignInScreen is no longer lazy-imported here — it's rendered by
// the save-point sheets and the Settings → Account entry in their
// own modules where each can lazy-load it on demand.
// Global now-playing bar — floats above the bottom nav on every
// page while music is playing. Lazy because the vast majority of
// app time has nothing in the queue and the bar's polling shouldn't
// even start on the dashboard.
const GlobalNowPlayingBar = lazyRetry(
    () => import('./components/music/GlobalNowPlayingBar').then((m) => ({ default: m.GlobalNowPlayingBar })),
    'GlobalNowPlayingBar',
);

const App: React.FC = () => {
    // 1. DATA STATE
    const { weatherData, loading, loadingMessage, error, fetchWeather, refreshData } = useWeather();
    const { settings, togglePro, updateSettings, loading: settingsLoading } = useSettings();
    const { setTier } = useSettings();
    const { currentView, previousView, setPage, isOffline, transitionDirection } = useUI();
    const isVesselView = VESSEL_VIEWS.has(currentView);

    // Resolve the active view config from the registry (null for dashboard/map)
    const activeViewConfig = VIEW_REGISTRY[currentView] ?? null;

    // --- LEGAL DISCLAIMER GATE ---
    const [disclaimerAccepted, setDisclaimerAccepted] = useState(() => checkDisclaimerAccepted());

    // --- AUTH: deferred to save-time, not boot-time. ---
    // authStore is consumed wherever identity matters (SignInScreen at
    // save points, useAppController's onboarding gate, the voyage log
    // publish flow, etc.). App.tsx itself no longer reads the auth
    // state — browsing is free, sign-in is the user's deliberate
    // choice when they hit an action that needs identity. See the
    // longer note above the JSX return below.

    // Track if map was opened from WX page (auto-return) vs tab bar (stay on map)
    const mapFromWxRef = useRef(false);
    const [mapPickerActive, setMapPickerActive] = useState(false);

    // Bosun voice console — registered as the 'voice' page in
    // viewRegistry. The mic button in the app header (and the floating
    // mic on the map) just call setPage('voice'); navigating to any
    // other tab fully unmounts it like every other registered view.
    // Gated to Skipper (owner) tier — top tier only, since the voice
    // console wraps the most expensive features (Pi AI, cloud Haiku,
    // ElevenLabs TTS, Cloudflare Worker proxy + Deepgram).
    const canUseBosunVoice = canAccess(settings.subscriptionTier, 'bosunVoice');

    // ── Bootstrap: chat badge, push notifications, keyboard, DB sync, etc. ──
    const { chatUnread } = useAppBootstrap();

    // 2. APP LOGIC / CONTROLLER
    const {
        query,
        bgImage,
        showOnboarding,
        handleOnboardingComplete,
        toggleFavorite,
        handleFavoriteSelect,
        handleMapTargetSelect,
        handleMapStaySelect,
        effectiveMode,
        handleLocateLite,
        sheetOpen,
        setSheetOpen,
        sheetData,
        isUpgradeOpen,
        setIsUpgradeOpen,
        isMobileLandscape,
        handleTabDashboard,
        handleTabMap,
    } = useAppController();

    const isFavorite = weatherData ? settings.savedLocations.includes(weatherData.locationName) : false;

    // Compute display mode BEFORE any early returns — needed by useEffect below
    const isLight = effectiveMode === 'light';

    // Sync display-light class to document root — ensures portaled components
    // (ModalSheet, toasts, etc.) rendered via createPortal(…, document.body)
    // inherit the light theme CSS overrides from index.css.
    useEffect(() => {
        if (isLight) {
            document.documentElement.classList.add('display-light');
        } else {
            document.documentElement.classList.remove('display-light');
        }
        return () => document.documentElement.classList.remove('display-light');
    }, [isLight]);

    // Global navigation event listener — used by components that can't thread setPage via props
    useEffect(() => {
        const handler = (e: Event) => {
            const tab = (e as CustomEvent).detail?.tab;
            if (tab) setPage(tab);
        };
        window.addEventListener('thalassa:navigate', handler);
        return () => window.removeEventListener('thalassa:navigate', handler);
    }, [setPage]);

    // Global "open upgrade modal" event — used by PaywallGate when it
    // renders deep inside a tree that doesn't have direct access to
    // setIsUpgradeOpen (e.g. MarketplacePage inside ChatPage).
    useEffect(() => {
        const handler = () => setIsUpgradeOpen(true);
        window.addEventListener('thalassa:openUpgrade', handler);
        return () => window.removeEventListener('thalassa:openUpgrade', handler);
    }, [setIsUpgradeOpen]);

    // One-shot personal-port directory sync. Pulls the user's saved
    // ports from Supabase and merges them into the local cache so a
    // route the user planned on the iPad resolves instantly on the
    // iPhone (and vice versa). No-ops gracefully when the user is
    // signed out or offline. Fire-and-forget — the page renders
    // immediately and the merge populates as it lands.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { syncPortsFromCloud } = await import('./services/PersonalPortDirectory');
                if (cancelled) return;
                await syncPortsFromCloud();
            } catch {
                /* non-critical — local cache still works */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Calypso "speak up" alerts — singleton AlertMonitorService runs as
    // long as the toggle is on AND the user has Skipper-tier access.
    // The service subscribes to NmeaStore and dispatches AlertEvents
    // through AlertNotifier (chime + voice + page takeover + history).
    // Tearing down on tier loss (subscription expiry) stops the alerts
    // immediately — no waiting for the user to flip the toggle off.
    const alertsToggle = settings.calypsoAlertsEnabled ?? false;
    const alertsAllowed = canAccess(settings.subscriptionTier, 'calypsoAlerts');
    useEffect(() => {
        if (alertsToggle && alertsAllowed) {
            AlertMonitorService.start();
            return () => AlertMonitorService.stop();
        }
        // If we're not running, ensure any prior session is torn down.
        AlertMonitorService.stop();
        return undefined;
    }, [alertsToggle, alertsAllowed]);

    // Live GPS-derived location name — subscribed here (above the
    // conditional early return) so React's rules-of-hooks are happy.
    // The useLiveLocationName hook on the Dashboard writes to
    // LocationStore via setFromGPS on each successful reverse-geocode,
    // so subscribing here lets the header title update within ~1s of a
    // fresh GPS fix — even when the cached weather's locationName is
    // stale or was a bad forward-geocode from onboarding (e.g. 'Old
    // Aust Road, England' for a user who typed 'Newport' but meant
    // Newport, QLD).
    const locationStore = useLocationStore();
    const livePreferred = locationStore.source === 'gps' && locationStore.name ? locationStore.name : null;

    // Loading State
    if (settingsLoading) {
        return (
            <div className="flex items-center justify-center h-screen w-full bg-slate-950 text-sky-500 flex-col gap-4">
                <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    const containerClasses =
        effectiveMode === 'night'
            ? 'bg-black text-red-600'
            : isLight
              ? 'bg-slate-200 text-slate-900'
              : 'bg-black text-white';

    // Header Title Logic
    // Show the location name as-is when it's a real place name.
    // Only prepend "WP" for raw decimal coordinates (e.g. "-27.47, 153.03").
    // Cardinal formats (e.g. "27.47°S, 153.03°E") are already human-readable — leave them.
    const rawTitle =
        livePreferred ||
        (weatherData ? weatherData.locationName : query || settings.defaultLocation || 'Select Location');
    let displayTitle = rawTitle;

    // Only catch truly raw/generic names:
    // 1. Starts with "Location" (generic placeholder)
    // 2. Starts with a raw decimal coordinate (digit or minus, NOT followed by degree symbol)
    //    e.g. "-27.47, 153.03" or "27.4700" but NOT "27.47°S" (already formatted)
    const isRawCoordinate = /^-?\d+\.?\d*\s*,\s*-?\d/.test(rawTitle);
    const isGenericName = /^(Location|Waypoint)\b/i.test(rawTitle);
    const needsWpPrefix = (isRawCoordinate || isGenericName) && !rawTitle.startsWith('WP');

    if (needsWpPrefix) {
        // Reconstruct as cardinal coordinate WP name
        if (weatherData?.coordinates) {
            const latStr =
                Math.abs(weatherData.coordinates.lat).toFixed(4) + (weatherData.coordinates.lat >= 0 ? '°N' : '°S');
            const lonStr =
                Math.abs(weatherData.coordinates.lon).toFixed(4) + (weatherData.coordinates.lon >= 0 ? '°E' : '°W');
            displayTitle = `WP ${latStr} ${lonStr}`;
        } else {
            displayTitle = `WP ${rawTitle}`;
        }
    }

    const showBackgroundImage = false; // Background images disabled — all modes use solid backgrounds
    const showHeader = !['map', 'warnings'].includes(currentView);
    const isDashboard = currentView === 'dashboard';

    // --- DISCLAIMER GATE: block app until accepted ---
    if (!disclaimerAccepted) {
        return <DisclaimerOverlay onAccepted={() => setDisclaimerAccepted(true)} />;
    }

    // --- AUTH: deferred to action-time, NOT boot-time ---
    // The previous hard gate (boot → SignInScreen) traded a real UX cost
    // (a stranger downloads the app, sees an auth wall, bounces) for a
    // real engineering benefit (no duplicate-vessel race on fresh
    // install). The engineering side now lives at the SAVE moment —
    // saving a passage plan, posting a voyage log, starting a shared
    // anchor watch — where identity actually has product meaning.
    //
    // Browsing is free. The Glass, Charts, planning a passage, looking
    // at notices — none of those require an account. Sign-in becomes a
    // contextual sheet the FIRST time the user commits to something
    // identity-bearing. See SignInScreen consumers and the
    // useAppController onboarding gate (which still requires authedUser
    // before showing the wizard — un-authed users have no cloud
    // account to attach a vessel to, so the wizard would dead-end).
    //
    // Note we DON'T render anything during the brief !authChecked
    // window any more either. The session probe is async (≤200ms in
    // practice), so blocking the entire first paint for it makes the
    // app feel slower than it is. Once the session resolves, settings/
    // boat/vessel data flows in via the existing useEffect chain.
    // authedUser is still consumed elsewhere; downstream code already
    // handles null gracefully (it's a normal React subscribe pattern).
    // SignInScreen is intentionally NOT removed from this file's
    // imports — it'll be rendered inline by save-point sheets and the
    // Settings → Account entry in subsequent PRs.

    return (
        <div
            className={`relative h-screen supports-[height:100dvh]:h-[100dvh] w-full overflow-hidden font-sans transition-colors duration-500 ${containerClasses} ${isLight ? 'display-light' : ''} flex flex-col`}
        >
            {/* MODALS & OVERLAYS */}
            <Suspense fallback={null}>
                {showOnboarding && <OnboardingWizard onComplete={handleOnboardingComplete} />}
                <UpgradeModal
                    isOpen={isUpgradeOpen}
                    onClose={() => setIsUpgradeOpen(false)}
                    onUpgrade={(tier) => {
                        if (tier) setTier(tier);
                        else togglePro();
                    }}
                />
            </Suspense>

            <Suspense fallback={null}>
                <IOSInstallPrompt />
            </Suspense>
            <NotificationManager onNotify={(msg) => toast.info(msg)} />

            {/* Active-route banner removed 2026-05-19 — it floated
                above EVERY tab and ate prime screen real estate even
                when the user wasn't looking at the chart. The Stop-
                Following control lives in the SystemStatusButton ("i"
                card) on every page, with the same confirmation modal,
                so users can still kill an active follow from anywhere
                — they just open the i-card instead of dismissing a
                always-on banner. Active-route state remains visible
                in the i-card's "Following Route" row.

                Keeping the mount commented (not deleted) so the next
                person investigating "where did the banner go" can see
                the rationale. The component itself stays exported in
                case we want to revive it in a less aggressive form
                (e.g. only on the chart tab) later.

                <div
                    className="fixed left-0 right-0 z-[900] pointer-events-none"
                    style={{ top: 'calc(env(safe-area-inset-top) + 80px)' }}
                >
                    <div className="pointer-events-auto">
                        <FollowRouteBadge />
                    </div>
                </div>
            */}

            {/* BACKGROUND */}
            {showBackgroundImage ? (
                <div
                    className="absolute inset-0 z-0 bg-cover bg-center transition-all duration-1000 transform scale-105"
                    style={{ backgroundImage: `url(${bgImage})` }}
                >
                    <div className="absolute inset-0 bg-black/30"></div>
                    <div className="absolute inset-0 bg-gradient-to-b from-slate-900/90 via-slate-900/40 to-slate-900/90"></div>
                </div>
            ) : (
                <div
                    className={`absolute inset-0 z-0 ${isLight ? 'bg-slate-200' : effectiveMode === 'night' ? 'bg-black' : 'bg-slate-950'}`}
                ></div>
            )}

            {loading && <ProcessOverlay message={loadingMessage} />}
            <Suspense fallback={null}>
                <OnboardingOverlay />
            </Suspense>

            <div className="relative z-10 flex flex-col h-full overflow-hidden">
                {/* Skip to content — keyboard accessibility */}
                <a
                    href="#main-content"
                    className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-sky-600 focus:text-white focus:rounded-lg focus:text-sm focus:font-bold focus:outline-none focus:ring-2 focus:ring-white"
                >
                    Skip to content
                </a>

                {/* The full-width strip ConnectivityBanner used to live here.
                    Removed 2026-05-08 — three concrete problems it was causing:
                      (a) On Dashboard, the strip took ~70px of flex flow,
                          which pushed `<main>`'s PageTransition wrapper down.
                          PageTransition uses `transform`, which creates a
                          containing block for `position: fixed` children, so
                          every fixed-position widget inside the Glass page
                          (CompactHeaderRow, HeroHeader, conditions card,
                          hero container) shifted down by the banner height —
                          surfacing as a huge black gap between the location
                          pill and the warnings row.
                      (b) On Scuttlebutt + NavStation it was just visually
                          loud — a full-width "● NO SIGNAL" amber bar at the
                          top of an otherwise-tidy page.
                      (c) The Glass page already shows a tasteful wifi-slash
                          chip inside the location pill; the strip was
                          redundant on top of that.
                    Replaced with a small wifi-slash icon next to the "The
                    Sailor's Assistant" subtitle (see header below) and a
                    matching tiny chip on the map page. The map's floating
                    `<ConnectivityBanner variant="floating" />` is also
                    removed (see map block lower in this file). */}

                {/* GLOBAL TOAST PORTAL */}
                <ToastPortal />

                {/* Bosun voice console is now the 'voice' registered view —
                    selected via setPage('voice') from the mic button. No
                    global overlay; the registry handles mount/unmount on
                    navigation just like every other page. */}

                {/* PUSH NOTIFICATION FOREGROUND TOAST */}
                <PushToast
                    onTap={(data) => {
                        const type = data.notification_type as string;
                        switch (type) {
                            case 'dm':
                                setPage('chat');
                                break;
                            case 'weather_alert':
                                setPage('dashboard');
                                break;
                            case 'anchor_alarm':
                                setPage('map');
                                break;
                            case 'bolo_alert':
                            case 'suspicious_alert':
                            case 'drag_warning':
                            case 'geofence_alert':
                            case 'hail':
                                setPage('guardian');
                                break;
                            default:
                                setPage('dashboard');
                                break;
                        }
                    }}
                />

                {/* HEADER */}
                {showHeader && (
                    <header
                        className={`px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 ${isDashboard ? `fixed top-0 left-0 right-0 z-[105] ${isLight ? 'bg-slate-200' : 'bg-black'}` : `${isMobileLandscape ? 'py-1' : 'py-2'}`} pt-[max(1rem,env(safe-area-inset-top))]`}
                        style={{ paddingBottom: isDashboard ? 0 : undefined, gap: '8px' }}
                    >
                        {/* Logo row — same style on all pages */}
                        <div className="flex items-start justify-between pointer-events-auto">
                            <div className="flex items-center space-x-2">
                                {/* Bumped 40 → 46 → 51 → 64 px (2026-05-19).
                                    Combined with the app-icon SVG mark-scale
                                    bump (0.49 → 0.55), the in-app header now
                                    has a properly sized compass that doesn't
                                    drown next to the wordmark + Skipper pill. */}
                                <img src="/thalassa-icon.png" alt="" className="w-[64px] h-[64px] rounded-lg" />
                                <div>
                                    <div className="flex items-center gap-1">
                                        <h2 className="text-xl font-bold tracking-wider uppercase shadow-black drop-shadow-lg">
                                            Thalassa
                                        </h2>
                                        {settings.subscriptionTier && settings.subscriptionTier !== 'free' && (
                                            <span
                                                className={`px-1.5 py-0.5 rounded text-[11px] font-bold text-white uppercase tracking-wider shadow-lg ${
                                                    settings.subscriptionTier === 'owner'
                                                        ? 'bg-gradient-to-r from-amber-500 to-orange-500'
                                                        : 'bg-gradient-to-r from-cyan-500 to-blue-600'
                                                }`}
                                            >
                                                {TIER_INFO[settings.subscriptionTier].badge}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-sky-200 uppercase tracking-widest shadow-black drop-shadow-md flex items-center gap-1.5">
                                        The Sailor's Assistant
                                        {/* Subtle offline indicator — tiny amber wifi-slash next
                                            to the tagline, matching the chip already inside the
                                            Glass page's location pill. Replaces the loud
                                            full-width "NO SIGNAL" strip. */}
                                        {isOffline && (
                                            <span
                                                className="inline-flex items-center gap-1 text-amber-400/80"
                                                title="Offline — using cached data"
                                                aria-label="Offline"
                                            >
                                                <svg
                                                    className="w-3 h-3"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                >
                                                    <path d="M1 1l22 22" />
                                                    <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
                                                    <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
                                                    <path d="M10.71 5.05A16 16 0 0122.58 9" />
                                                    <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
                                                    <path d="M8.53 16.11a6 6 0 016.95 0" />
                                                    <line x1="12" y1="20" x2="12.01" y2="20" />
                                                </svg>
                                            </span>
                                        )}
                                    </p>
                                </div>
                            </div>

                            {/* Bosun mic (Skipper-tier) + System status ℹ — paired top-right */}
                            <div className="flex items-center gap-2 pointer-events-auto">
                                {canUseBosunVoice && (
                                    <button
                                        onClick={() => setPage('voice')}
                                        className="w-11 h-11 rounded-full bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center justify-center text-sky-400 transition-colors backdrop-blur-md"
                                        aria-label="Open Bosun voice console"
                                        title="Talk to Bosun"
                                    >
                                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                                            <path d="M19 11h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72z" />
                                        </svg>
                                    </button>
                                )}
                                <div className="flex flex-col items-end gap-1">
                                    <SystemStatusButton
                                        currentView={currentView}
                                        onNavigateAnchor={() => setPage('compass')}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Search bar — only shown on dashboard (non-registered views without explicit flag) */}
                        {!activeViewConfig && currentView !== 'map' && (
                            <div
                                className={`flex items-center gap-3 w-full md:w-auto ${isMobileLandscape ? 'h-8' : 'h-12'} pointer-events-auto`}
                            >
                                <div className="relative flex-grow md:w-96 group h-full">
                                    <form onSubmit={(e) => e.preventDefault()} className="relative w-full h-full">
                                        <input
                                            type="text"
                                            value={query}
                                            readOnly
                                            placeholder="Select via Map..."
                                            aria-label="Current location"
                                            // Offline styling kept at the same contrast as online —
                                            // a deliberate but subtle ring change instead of the
                                            // previous opacity fade (which made the bar nearly
                                            // invisible). The offline state is communicated via
                                            // the amber wifi-off chip on the left, so the bar
                                            // itself doesn't need to shout.
                                            className={`w-full h-full text-white placeholder-gray-400 rounded-2xl pl-12 pr-12 outline-none transition-all shadow-2xl font-bold text-xl tracking-tight cursor-default bg-slate-900/60 border ${isOffline ? 'border-amber-500/40' : 'border-white/10'}`}
                                            onClick={() => {
                                                mapFromWxRef.current = true;
                                                setMapPickerActive(true);
                                                setPage('map');
                                            }}
                                        />
                                        {/* Left adornment: swap between the usual search icon
                                            and a wifi-off glyph when offline. Keeps the layout
                                            stable (same slot) while giving a clear visual cue. */}
                                        {isOffline ? (
                                            <div
                                                className="absolute left-4 top-1/2 -translate-y-1/2 text-amber-400 bg-amber-500/15 p-1 rounded-md"
                                                title="Offline — showing cached data"
                                                aria-label="Offline"
                                            >
                                                <svg
                                                    className="w-4 h-4"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                >
                                                    {/* Wifi arcs with slash through — universal "no signal" glyph */}
                                                    <path d="M1 1l22 22" />
                                                    <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
                                                    <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
                                                    <path d="M10.71 5.05A16 16 0 0122.58 9" />
                                                    <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
                                                    <path d="M8.53 16.11a6 6 0 016.95 0" />
                                                    <line x1="12" y1="20" x2="12.01" y2="20" />
                                                </svg>
                                            </div>
                                        ) : (
                                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-sky-400 bg-sky-500/10 p-1 rounded-md">
                                                <SearchIcon className="w-4 h-4" />
                                            </div>
                                        )}
                                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={toggleFavorite}
                                                aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                                                className="p-1.5 rounded-full hover:bg-white/10 text-gray-300 hover:text-yellow-400 transition-colors"
                                            >
                                                <StarIcon
                                                    className={`w-4 h-4 ${isFavorite ? 'text-yellow-400' : ''}`}
                                                    filled={isFavorite}
                                                />
                                            </button>
                                            <div className="w-px h-4 bg-white/20 mx-1"></div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    mapFromWxRef.current = true;
                                                    setMapPickerActive(true);
                                                    setPage('map');
                                                }}
                                                className="p-1.5 hover:bg-white/10 rounded-full text-gray-300 hover:text-emerald-400 transition-colors"
                                                aria-label="Open map"
                                            >
                                                <MapIcon className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </form>
                                </div>
                            </div>
                        )}
                    </header>
                )}

                {/* System status now handled by SystemStatusButton in header */}

                {/* MAIN CONTENT AREA */}
                {currentView !== 'map' ? (
                    <PullToRefresh
                        onRefresh={() => refreshData()}
                        disabled={currentView === 'dashboard' || PULL_REFRESH_DISABLED_VIEWS.has(currentView)}
                    >
                        <main
                            id="main-content"
                            className={`flex-grow relative flex flex-col ${isLight ? 'bg-slate-200' : 'bg-black'} ${!showHeader ? 'pt-[max(2rem,env(safe-area-inset-top))]' : 'pt-0'} ${['settings', 'warnings'].includes(currentView) ? 'overflow-y-auto' : 'overflow-hidden'}`}
                        >
                            <ErrorBoundary boundaryName="MainContent">
                                <Suspense fallback={<SkeletonDashboard />}>
                                    <div className="relative flex-1 overflow-hidden">
                                        <PageTransition
                                            pageKey={currentView}
                                            direction={transitionDirection}
                                            canSwipeBack={false}
                                            onSwipeBack={() => setPage('vessel')}
                                        >
                                            <div className="h-full overflow-y-auto overflow-x-hidden">
                                                {/* Dashboard — special case with error/loading states */}
                                                {currentView === 'dashboard' && (
                                                    <>
                                                        {error ? (
                                                            <div className="p-8 bg-red-500/20 border border-red-500/30 rounded-2xl text-center max-w-lg mx-auto mt-20">
                                                                <h3 className="text-xl font-bold text-red-200 mb-2">
                                                                    Error
                                                                </h3>
                                                                <p className="text-white/80">{error}</p>
                                                                <button
                                                                    aria-label="Retry loading weather data"
                                                                    onClick={() =>
                                                                        fetchWeather(
                                                                            query || settings.defaultLocation || '',
                                                                        )
                                                                    }
                                                                    className="mt-6 px-6 py-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
                                                                >
                                                                    Retry
                                                                </button>
                                                            </div>
                                                        ) : !weatherData && !loading && !settings.defaultLocation ? (
                                                            // True empty state — no location set, nothing
                                                            // loading. Trust the OS GPS flow (one-tap
                                                            // "Use my location" → iOS permission prompt
                                                            // → reverse-geocode → live local weather) and
                                                            // give a manual "Choose a port" fallback. No
                                                            // dummy data, no Sydney conditions painted
                                                            // for a Brisbane user. This matches what
                                                            // Apple Weather / Windy / Predict Wind / Yr.no
                                                            // all do — empty-state-with-intent beats fake
                                                            // data every time.
                                                            <div className="flex-1 w-full h-full bg-slate-950 flex items-center justify-center px-6">
                                                                <div className="max-w-sm w-full">
                                                                    <div className="text-center mb-8">
                                                                        <div
                                                                            className="text-5xl mb-3"
                                                                            aria-hidden="true"
                                                                        >
                                                                            ⛵
                                                                        </div>
                                                                        <h2 className="text-xl font-bold text-white mb-2">
                                                                            Welcome aboard
                                                                        </h2>
                                                                        <p className="text-sm text-slate-400 leading-relaxed">
                                                                            Set your location to see live marine
                                                                            conditions — wind, tide, swell, weather.
                                                                        </p>
                                                                    </div>
                                                                    <div className="space-y-3">
                                                                        <button
                                                                            type="button"
                                                                            onClick={handleLocateLite}
                                                                            disabled={isOffline}
                                                                            className="w-full h-12 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold text-sm transition-colors shadow-lg flex items-center justify-center gap-2"
                                                                        >
                                                                            <svg
                                                                                className="w-4 h-4"
                                                                                viewBox="0 0 24 24"
                                                                                fill="none"
                                                                                stroke="currentColor"
                                                                                strokeWidth={2}
                                                                                strokeLinecap="round"
                                                                                strokeLinejoin="round"
                                                                            >
                                                                                <circle cx="12" cy="12" r="3" />
                                                                                <path d="M12 1v6m0 6v6M1 12h6m6 0h6" />
                                                                            </svg>
                                                                            {isOffline
                                                                                ? 'Offline — needs network'
                                                                                : 'Use my location'}
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => {
                                                                                mapFromWxRef.current = true;
                                                                                setMapPickerActive(true);
                                                                                setPage('map');
                                                                            }}
                                                                            className="w-full h-12 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-white font-semibold text-sm transition-colors border border-white/10 flex items-center justify-center gap-2"
                                                                        >
                                                                            <MapIcon className="w-4 h-4 text-emerald-400" />
                                                                            Choose a port on the map
                                                                        </button>
                                                                    </div>
                                                                    <p className="text-[11px] text-center text-slate-500 mt-4 leading-relaxed">
                                                                        Your location stays on this device until you
                                                                        sign in to sync it across boats.
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        ) : !weatherData ? (
                                                            <div className="flex-1 w-full h-full bg-slate-950 flex items-center justify-center">
                                                                <ProcessOverlay
                                                                    message={loadingMessage || 'Loading Marine Data...'}
                                                                />
                                                            </div>
                                                        ) : (
                                                            <Dashboard
                                                                onOpenMap={() => {
                                                                    mapFromWxRef.current = true;
                                                                    setMapPickerActive(true);
                                                                    setPage('map');
                                                                }}
                                                                onTriggerUpgrade={() => setIsUpgradeOpen(true)}
                                                                displayTitle={displayTitle}
                                                                timeZone={weatherData?.timeZone}
                                                                utcOffset={weatherData?.utcOffset}
                                                                timeDisplaySetting={settings.timeDisplay}
                                                                onToggleFavorite={toggleFavorite}
                                                                favorites={settings.savedLocations}
                                                                isRefreshing={loading}
                                                                isNightMode={effectiveMode === 'night'}
                                                                isMobileLandscape={isMobileLandscape}
                                                                viewMode={'overview'}
                                                                mapboxToken={settings.mapboxToken}
                                                                onLocationSelect={handleMapTargetSelect}
                                                            />
                                                        )}
                                                    </>
                                                )}

                                                {/* Registry-driven views — all non-dashboard/non-map pages */}
                                                {activeViewConfig &&
                                                    (() => {
                                                        const ViewComponent = activeViewConfig.component;
                                                        const viewCtx: ViewContext = {
                                                            setPage,
                                                            setIsUpgradeOpen,
                                                            settings: settings as unknown as Record<string, unknown>,
                                                            updateSettings: updateSettings as unknown as (
                                                                u: Record<string, unknown>,
                                                            ) => void,
                                                            handleFavoriteSelect,
                                                            weatherAlerts: weatherData?.alerts || [],
                                                        };
                                                        const viewProps = activeViewConfig.getProps?.(viewCtx) ?? {};
                                                        const rendered = <ViewComponent {...viewProps} />;
                                                        // If this view is gated, PaywallGate decides whether to
                                                        // render the page or the upsell card based on the user's
                                                        // subscription tier. See services/SubscriptionService for
                                                        // the FEATURE_GATES table.
                                                        const gated = activeViewConfig.gatedFeature ? (
                                                            <PaywallGate
                                                                feature={activeViewConfig.gatedFeature}
                                                                onUpgrade={() => setIsUpgradeOpen(true)}
                                                                onBack={() => setPage('vessel')}
                                                            >
                                                                {rendered}
                                                            </PaywallGate>
                                                        ) : (
                                                            rendered
                                                        );
                                                        return (
                                                            <ErrorBoundary boundaryName={activeViewConfig.boundaryName}>
                                                                {gated}
                                                            </ErrorBoundary>
                                                        );
                                                    })()}
                                            </div>
                                        </PageTransition>
                                    </div>
                                </Suspense>
                            </ErrorBoundary>
                        </main>
                    </PullToRefresh>
                ) : (
                    <div className="flex-grow w-full relative bg-slate-900 overflow-hidden">
                        <ErrorBoundary boundaryName="MapView">
                            <Suspense
                                fallback={
                                    <div className="flex items-center justify-center h-full text-white">
                                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                                    </div>
                                }
                            >
                                <MapHub
                                    mapboxToken={settings.mapboxToken}
                                    homePort={settings.defaultLocation}
                                    pickerMode={mapPickerActive}
                                    onLocationSelect={(lat: number, lon: number, name?: string) => {
                                        if (mapFromWxRef.current) {
                                            mapFromWxRef.current = false;
                                            setMapPickerActive(false);
                                            handleMapTargetSelect(lat, lon, name);
                                        } else {
                                            handleMapStaySelect(lat, lon, name);
                                        }
                                    }}
                                />
                            </Suspense>
                        </ErrorBoundary>
                        {/* Offline chip — matches the wifi-slash chip in the App header
                            and the Glass page's location-pill chip. Sits at top-left, only
                            visible when offline. Replaces the previous full-width amber
                            "NO SIGNAL" floating pill which clashed with the subtle treatment
                            on every other page. */}
                        {isOffline && (
                            <div
                                className="absolute z-[601] pointer-events-auto flex items-center gap-1.5 px-2 py-1.5 bg-amber-500/15 border border-amber-500/25 rounded-lg backdrop-blur-md text-amber-400"
                                style={{
                                    top: '56px',
                                    left: '16px',
                                }}
                                title="Offline — using cached charts"
                                aria-label="Offline"
                            >
                                <svg
                                    className="w-4 h-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M1 1l22 22" />
                                    <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
                                    <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
                                    <path d="M10.71 5.05A16 16 0 0122.58 9" />
                                    <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
                                    <path d="M8.53 16.11a6 6 0 016.95 0" />
                                    <line x1="12" y1="20" x2="12.01" y2="20" />
                                </svg>
                            </div>
                        )}
                        {/* Bosun mic (Skipper-tier) + System status ℹ — paired top-right on map view */}
                        <div
                            className="absolute z-[601] pointer-events-auto flex items-center gap-2"
                            style={{
                                top: '56px',
                                right: '16px',
                            }}
                        >
                            {canUseBosunVoice && (
                                <button
                                    onClick={() => setPage('voice')}
                                    className="w-11 h-11 rounded-full bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center justify-center text-sky-400 transition-colors backdrop-blur-md shadow-lg"
                                    aria-label="Open Bosun voice console"
                                    title="Talk to Bosun"
                                >
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                                        <path d="M19 11h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72z" />
                                    </svg>
                                </button>
                            )}
                            <SystemStatusButton currentView={currentView} onNavigateAnchor={() => setPage('compass')} />
                        </div>
                        {/* Back chevron — middle-left of screen */}
                        <div className="absolute z-[601] px-3" style={{ top: '50%', transform: 'translateY(-50%)' }}>
                            <button
                                onClick={() => {
                                    // Clear pin-view state when leaving map

                                    delete window.__thalassaPinView;
                                    // Go back to wherever we came from
                                    setPage(previousView || 'dashboard');
                                }}
                                aria-label="Back"
                                className="w-10 h-10 bg-slate-900/90 hover:bg-slate-800 rounded-full flex items-center justify-center border border-white/20 shadow-2xl transition-all hover:scale-110 active:scale-95"
                            >
                                <svg
                                    className="w-5 h-5 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.75 19.5L8.25 12l7.5-7.5"
                                    />
                                </svg>
                            </button>
                        </div>
                    </div>
                )}

                {/* BOTTOM FADE removed — was obscuring Start Tracking button on Log page */}

                <Suspense fallback={null}>
                    <ForecastSheet
                        data={sheetData}
                        isLoading={false}
                        units={settings.units}
                        isOpen={sheetOpen}
                        onClose={() => setSheetOpen(false)}
                        onViewFull={() => {
                            setSheetOpen(false);
                            setPage('dashboard');
                            if (sheetData) fetchWeather(sheetData.locationName);
                        }}
                    />
                </Suspense>

                {/* Global now-playing bar — floats above the bottom nav
                    on every page when music is queued, so the punter can
                    pause/dismiss without going back to the Music page.
                    Auto-hides on the music page itself (in-page bar
                    handles it) and when nothing's queued. */}
                <Suspense fallback={null}>
                    <GlobalNowPlayingBar />
                </Suspense>

                {!isMobileLandscape && (
                    <nav
                        className="fixed bottom-0 left-0 right-0 z-[900] border-t pb-[env(safe-area-inset-bottom)]"
                        style={{
                            background: 'rgba(10, 15, 20, 0.95)',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                            borderColor: 'rgba(0, 230, 118, 0.1)',
                        }}
                        aria-label="Main"
                    >
                        <div
                            className="flex justify-around items-center h-16 mx-auto px-4 relative"
                            role="tablist"
                            aria-label="Main navigation"
                        >
                            <NavButton
                                icon={
                                    <StormGlassNavIcon
                                        className="w-full h-full object-contain"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    />
                                }
                                label="The Glass"
                                active={currentView === 'dashboard'}
                                onClick={handleTabDashboard}
                            />
                            <NavButton
                                icon={
                                    <img
                                        src={NAV_ICON_MAP}
                                        alt=""
                                        draggable={false}
                                        className="w-full h-full object-contain"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    />
                                }
                                label="Charts"
                                active={currentView === 'map'}
                                onClick={() => {
                                    mapFromWxRef.current = false;
                                    handleTabMap();
                                }}
                            />
                            {/* Plan — was: Scuttlebutt (chat). The 5-tab
                                restructure (Week 2) replaces the social
                                tab with the dedicated route planner.
                                Scuttlebutt is reachable from the Vessel
                                hub's Wardroom section. Icon `color` set
                                inline to #67E8F9 (cyan-300) so the
                                SVG's currentColor stroke matches the
                                cyan hue baked into the PNG nav icons
                                (Glass, Charts, Vessel). */}
                            <NavButton
                                icon={
                                    <div
                                        className="w-full h-full flex items-center justify-center"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            color: '#67E8F9',
                                        }}
                                    >
                                        <RouteIcon className="w-7 h-7" />
                                    </div>
                                }
                                label="Plan"
                                active={currentView === 'voyage'}
                                onClick={() => setPage('voyage')}
                            />
                            {/* Log — promoted from a Vessel sub-page (was
                                reached via Nav Station → Log Book) to a
                                top-level tab in the Week 2 restructure.
                                Plan → Sail → Share → Hear → Trust order
                                means Log sits directly between Plan and
                                Vessel in the nav. Same #67E8F9 cyan as
                                Plan so the two new SVG tabs visually
                                pair with the PNG nav icons. */}
                            <NavButton
                                icon={
                                    <div
                                        className="w-full h-full flex items-center justify-center"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            color: '#67E8F9',
                                        }}
                                    >
                                        <ClipboardIcon className="w-7 h-7" />
                                    </div>
                                }
                                label="Log"
                                active={currentView === 'details'}
                                onClick={() => setPage('details')}
                            />
                            <NavButton
                                icon={
                                    <img
                                        src={NAV_ICON_VESSEL}
                                        alt=""
                                        draggable={false}
                                        className="w-full h-full object-contain"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    />
                                }
                                label="Vessel"
                                active={isVesselView || currentView === 'chat'}
                                onClick={() => setPage('vessel')}
                                // chatUnread badge moves to Vessel — chat
                                // now lives under Vessel → Wardroom →
                                // Scuttlebutt. Showing the unread count
                                // on Vessel surfaces new DMs / community
                                // activity at the same visibility as
                                // before, just one nav layer deeper.
                                badge={chatUnread > 0 ? chatUnread : undefined}
                            />
                        </div>
                    </nav>
                )}
            </div>

            {effectiveMode === 'night' && (
                <div
                    className="fixed inset-0 z-[9999] pointer-events-none touch-none"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)' }}
                    aria-hidden="true"
                ></div>
            )}
        </div>
    );
};

export default App;
