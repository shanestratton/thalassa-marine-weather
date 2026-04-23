import React, { Suspense, useState, useEffect, useRef } from 'react';
import { useWeather } from './context/WeatherContext';
import { useSettings } from './context/SettingsContext';
import { useUI } from './context/UIContext';
import { useLocationStore } from './stores/LocationStore';
import { useAppController } from './hooks/useAppController';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { Dashboard } from './components/Dashboard';
import { SearchIcon, MapIcon, StarIcon } from './components/Icons';
import { SkeletonDashboard } from './components/SkeletonLoader';
import { NotificationManager } from './components/NotificationManager';
import { ProcessOverlay } from './components/ProcessOverlay';
import { PaywallGate } from './components/PaywallGate';
import { PullToRefresh } from './components/PullToRefresh';
import { NavButton } from './components/NavButton';
import { NAV_ICON_MAP, NAV_ICON_CHAT, NAV_ICON_VESSEL } from './components/icons/NavIconAssets';
import { StormGlassNavIcon } from './components/icons/StormGlassNavIcon';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SystemStatusButton } from './components/SystemStatusButton';
import { ToastPortal, toast } from './components/Toast';
import { ConnectivityBanner } from './components/ui/ConnectivityBanner';
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

    // Track if map was opened from WX page (auto-return) vs tab bar (stay on map)
    const mapFromWxRef = useRef(false);
    const [mapPickerActive, setMapPickerActive] = useState(false);

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

                {/* CONNECTIVITY BANNER — offline/reconnect awareness */}
                <ConnectivityBanner />

                {/* GLOBAL TOAST PORTAL */}
                <ToastPortal />

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
                                <img src="/thalassa-icon.png" alt="" className="w-10 h-10 rounded-lg" />
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
                                    <p className="text-[11px] text-sky-200 uppercase tracking-widest shadow-black drop-shadow-md">
                                        The Sailor's Assistant
                                    </p>
                                </div>
                            </div>

                            {/* System status ℹ button — replaces all individual badges */}
                            <div className="flex flex-col items-end gap-1 pointer-events-auto">
                                <SystemStatusButton
                                    currentView={currentView}
                                    onNavigateAnchor={() => setPage('compass')}
                                />
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
                        {/* System status ℹ button — floating on map view, aligned with layer FAB row (top-14 = 56px) */}
                        <div
                            className="absolute z-[601] pointer-events-auto"
                            style={{
                                top: '56px',
                                right: '16px',
                            }}
                        >
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
                            <NavButton
                                icon={
                                    <img
                                        src={NAV_ICON_CHAT}
                                        alt=""
                                        draggable={false}
                                        className="w-full h-full object-contain"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    />
                                }
                                label="Scuttlebutt"
                                active={currentView === 'chat'}
                                onClick={() => setPage('chat')}
                                badge={chatUnread > 0 ? chatUnread : undefined}
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
                                label="Nav Station"
                                active={isVesselView}
                                onClick={() => setPage('vessel')}
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
