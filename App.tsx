
import React, { Suspense, useState, useEffect, useCallback } from 'react';
import { useWeather } from './context/WeatherContext';
import { initLocalDatabase, startSyncEngine, stopSyncEngine } from './services/vessel';
import { useSettings } from './context/SettingsContext';
import { useUI } from './context/UIContext';
import { useAppController } from './hooks/useAppController';
import { Dashboard } from './components/Dashboard';
import { SearchIcon, WindIcon, GearIcon, MapIcon, ShipWheelIcon, BoatIcon, ServerIcon, StarIcon, AnchorIcon, ChatIcon } from './components/Icons';
import { SkeletonDashboard } from './components/SkeletonLoader';
const ForecastSheet = lazyRetry(() => import('./components/ForecastSheet').then(m => ({ default: m.ForecastSheet })));
import { NotificationManager } from './components/NotificationManager';
import { ProcessOverlay } from './components/ProcessOverlay';
import { PullToRefresh } from './components/PullToRefresh';
import { NavButton } from './components/NavButton';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GpsTrackingIndicator } from './components/GpsTrackingIndicator';
import { AnchorStatusIndicator } from './components/AnchorStatusIndicator';
import { NmeaGpsIndicator } from './components/NmeaGpsIndicator';
import { NmeaGpsProvider } from './services/NmeaGpsProvider';
import { PushNotificationService } from './services/PushNotificationService';
import { ToastPortal, toast } from './components/Toast';
import { PageTransition } from './components/ui/PageTransition';



// --- LAZY LOAD HEAVY COMPONENTS ---
// Retry wrapper: if a dynamic import fails (stale Vite module hash after HMR/restart),
// reload the page once to fetch fresh module URLs. Prevents "Failed to fetch dynamically
// imported module" errors from crashing the app.
function lazyRetry<T extends React.ComponentType<any>>(
    factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
    return React.lazy(() =>
        factory().catch((err: Error) => {
            // Only retry once per session to avoid infinite reload loops
            const key = 'lazyRetryReloaded';
            if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, '1');
                window.location.reload();
                // Return a never-resolving promise to stop React rendering during reload
                return new Promise<{ default: T }>(() => { });
            }
            // If we already retried, re-throw so ErrorBoundary catches it
            sessionStorage.removeItem(key);
            throw err;
        })
    );
}

const VoyagePlanner = lazyRetry(() => import('./components/RoutePlanner').then(module => ({ default: module.RoutePlanner })));
const SettingsView = lazyRetry(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsView })));
const UpgradeModal = lazyRetry(() => import('./components/UpgradeModal').then(module => ({ default: module.UpgradeModal })));
const VesselHub = lazyRetry(() => import('./components/VesselHub').then(module => ({ default: module.VesselHub })));
const InventoryPage = lazyRetry(() => import('./components/vessel/InventoryList').then(m => ({ default: m.InventoryList })));
const MaintenancePage = lazyRetry(() => import('./components/vessel/MaintenanceHub').then(m => ({ default: m.MaintenanceHub })));
const EquipmentPage = lazyRetry(() => import('./components/vessel/EquipmentList').then(m => ({ default: m.EquipmentList })));
const DocumentsPage = lazyRetry(() => import('./components/vessel/DocumentsHub').then(m => ({ default: m.DocumentsHub })));
const NmeaGatewayPage = lazyRetry(() => import('./components/vessel/NmeaPage').then(m => ({ default: m.NmeaPage })));
const PolarPage = lazyRetry(() => import('./components/vessel/PolarPage').then(m => ({ default: m.PolarPage })));
const WeatherMap = lazyRetry(() => import('./components/WeatherMap').then(module => ({ default: module.WeatherMap })));
const MapHub = lazyRetry(() => import('./components/map/MapHub').then(m => ({ default: m.MapHub })));
const OnboardingWizard = lazyRetry(() => import('./components/OnboardingWizard').then(module => ({ default: module.OnboardingWizard })));
const WarningDetails = lazyRetry(() => import('./components/WarningDetails').then(module => ({ default: module.WarningDetails })));
const AnchorWatchPage = lazyRetry(() => import('./components/AnchorWatchPage').then(module => ({ default: module.AnchorWatchPage })));
const ChatPage = lazyRetry(() => import('./components/ChatPage').then(module => ({ default: module.ChatPage })));
const LogPage = lazyRetry(() => import('./pages/LogPage').then(module => ({ default: module.LogPage })));
const DiaryPage = lazyRetry(() => import('./components/DiaryPage').then(module => ({ default: module.DiaryPage })));
const CrewPage = lazyRetry(() => import('./components/CrewManagement').then(m => ({ default: m.CrewManagement })));
const IOSInstallPrompt = React.lazy(() => import('./components/IOSInstallPrompt').then(m => ({ default: m.IOSInstallPrompt })));
const OnboardingOverlay = React.lazy(() => import('./components/ui/OnboardingOverlay').then(m => ({ default: m.OnboardingOverlay })));

const App: React.FC = () => {
    // 1. DATA STATE
    const { weatherData, loading, loadingMessage, error, fetchWeather, refreshData } = useWeather();
    const { settings, togglePro, updateSettings, loading: settingsLoading } = useSettings();
    const { currentView, previousView, setPage, isOffline, transitionDirection } = useUI();
    const isVesselView = currentView === 'vessel' || currentView === 'details' || currentView === 'voyage' || currentView === 'compass' || currentView === 'inventory' || currentView === 'maintenance' || currentView === 'polars' || currentView === 'nmea' || currentView === 'equipment' || currentView === 'documents' || currentView === 'diary' || currentView === 'route' || currentView === 'crew';

    // 2. APP LOGIC / CONTROLLER
    const {
        query, bgImage, showOnboarding,
        handleSearchSubmit, handleOnboardingComplete,
        handleLocate, toggleFavorite, handleFavoriteSelect, handleMapTargetSelect,
        effectiveMode,
        sheetOpen, setSheetOpen, sheetData, setSheetData,
        isUpgradeOpen, setIsUpgradeOpen, isMobileLandscape,
        handleTabDashboard, handleTabMetrics, handleTabPassage, handleTabMap, handleTabSettings
    } = useAppController();

    const isFavorite = weatherData ? settings.savedLocations.includes(weatherData.locationName) : false;

    // Early restore: re-establish anchor watch GPS + geofence on app boot,
    // even if user opens dashboard first (AnchorWatchPage is lazy-loaded).
    useEffect(() => {
        import('./services/AnchorWatchService').then(m => m.AnchorWatchService.restoreWatchState()).catch(() => { /* Non-critical */ });
    }, []);

    // Initialize local-first database and start background sync engine.
    useEffect(() => {
        initLocalDatabase()
            .then(() => startSyncEngine())
            .catch(e => console.error('[App] Local DB init failed:', e));
        return () => stopSyncEngine();
    }, []);

    // Wire Push Notification callbacks for in-app handling + deep navigation
    useEffect(() => {
        // Gap 3: Show in-app toast when push arrives while app is in foreground
        PushNotificationService.onForegroundPush = (notification) => {
            const title = notification.title || 'Notification';
            toast.info(title);
        };

        // Gap 4: Navigate to the correct page when user taps a push notification
        PushNotificationService.onNotificationTap = (data) => {
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
                default:
                    setPage('dashboard');
                    break;
            }
        };

        return () => {
            PushNotificationService.onForegroundPush = null;
            PushNotificationService.onNotificationTap = null;
        };
    }, [setPage]);

    // Global keyboard dismiss — mimics native iOS behaviour.
    // Tapping outside an input/textarea/select blurs the active element,
    // which dismisses the on-screen keyboard.
    // Exception: don't dismiss when scrolling inside a modal sheet.
    useEffect(() => {
        const dismissKeyboard = (e: TouchEvent) => {
            const active = document.activeElement as HTMLElement | null;
            if (!active) return;
            const tag = active.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;

            const target = e.target as HTMLElement;
            // Don't blur if they tapped another input (keyboard stays for the new field)
            const targetTag = target.tagName;
            if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT') return;
            // Don't blur if they tapped inside a label (could be toggling a checkbox/radio)
            if (target.closest('label')) return;
            // Don't blur if they're scrolling inside a modal sheet
            if (target.closest('[data-modal-sheet]')) return;

            active.blur();
        };

        document.addEventListener('touchstart', dismissKeyboard, { passive: true });
        return () => document.removeEventListener('touchstart', dismissKeyboard);
    }, []);

    // Loading State
    if (settingsLoading) {
        return (
            <div className="flex items-center justify-center h-screen w-full bg-slate-950 text-sky-500 flex-col gap-4">
                <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    const isLight = effectiveMode === 'light';
    const containerClasses = effectiveMode === 'night' ? 'bg-black text-red-600' : isLight ? 'bg-slate-200 text-slate-900' : 'bg-black text-white';

    // Header Title Logic
    // Show the location name as-is when it's a real place name.
    // Only prepend "WP" for raw decimal coordinates (e.g. "-27.47, 153.03").
    // Cardinal formats (e.g. "27.47°S, 153.03°E") are already human-readable — leave them.
    const rawTitle = weatherData ? weatherData.locationName : (query || settings.defaultLocation || "Select Location");
    let displayTitle = rawTitle;

    // Only catch truly raw/generic names:
    // 1. Starts with "Location" (generic placeholder)
    // 2. Starts with a raw decimal coordinate (digit or minus, NOT followed by degree symbol)
    //    e.g. "-27.47, 153.03" or "27.4700" but NOT "27.47°S" (already formatted)
    const isRawCoordinate = /^-?\d+\.?\d*\s*,\s*-?\d/.test(rawTitle);
    const isGenericName = /^(Location|Waypoint)\b/i.test(rawTitle);
    const needsWpPrefix = (isRawCoordinate || isGenericName) && !rawTitle.startsWith("WP");

    if (needsWpPrefix) {
        // Reconstruct as cardinal coordinate WP name
        if (weatherData?.coordinates) {
            const latStr = Math.abs(weatherData.coordinates.lat).toFixed(4) + (weatherData.coordinates.lat >= 0 ? "°N" : "°S");
            const lonStr = Math.abs(weatherData.coordinates.lon).toFixed(4) + (weatherData.coordinates.lon >= 0 ? "°E" : "°W");
            displayTitle = `WP ${latStr} ${lonStr}`;
        } else {
            displayTitle = `WP ${rawTitle}`;
        }
    }

    const showBackgroundImage = false; // Background images disabled — all modes use solid backgrounds
    const showHeader = !['map', 'warnings'].includes(currentView);
    const isDashboard = currentView === 'dashboard';

    return (
        <div className={`relative h-screen supports-[height:100dvh]:h-[100dvh] w-full overflow-hidden font-sans transition-colors duration-500 ${containerClasses} ${isLight ? 'display-light' : ''} flex flex-col`}>

            {/* MODALS & OVERLAYS */}
            <Suspense fallback={null}>
                {showOnboarding && <OnboardingWizard onComplete={handleOnboardingComplete} />}
                <UpgradeModal isOpen={isUpgradeOpen} onClose={() => setIsUpgradeOpen(false)} onUpgrade={togglePro} />
            </Suspense>

            <Suspense fallback={null}><IOSInstallPrompt /></Suspense>
            <NotificationManager onNotify={(msg) => toast.info(msg)} />

            {/* BACKGROUND */}
            {showBackgroundImage ? (
                <div className="absolute inset-0 z-0 bg-cover bg-center transition-all duration-1000 transform scale-105" style={{ backgroundImage: `url(${bgImage})` }}>
                    <div className="absolute inset-0 bg-black/30"></div>
                    <div className="absolute inset-0 bg-gradient-to-b from-slate-900/90 via-slate-900/40 to-slate-900/90"></div>
                </div>
            ) : (
                <div className={`absolute inset-0 z-0 ${isLight ? 'bg-slate-200' : effectiveMode === 'night' ? 'bg-black' : 'bg-slate-950'}`}></div>
            )}

            {loading && <ProcessOverlay message={loadingMessage} />}
            <Suspense fallback={null}><OnboardingOverlay /></Suspense>

            <div className="relative z-10 flex flex-col h-full overflow-hidden">
                {/* OFFLINE BANNER */}
                {isOffline && (
                    <div className="bg-orange-600/90 text-white text-xs font-bold uppercase tracking-widest text-center py-2 px-4 shadow-lg flex items-center justify-center gap-2 pt-[max(0.5rem,env(safe-area-inset-top))] shrink-0">
                        <ServerIcon className="w-4 h-4" /> OFFLINE MODE
                    </div>
                )}

                {/* GLOBAL TOAST PORTAL */}
                <ToastPortal />



                {/* HEADER */}
                {showHeader && (
                    <header
                        className={`px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 ${isDashboard ? `fixed top-0 left-0 right-0 z-[105] ${isLight ? 'bg-slate-200' : 'bg-black'}` : `${isMobileLandscape ? 'py-1' : 'py-2'}`} ${!isOffline && 'pt-[max(1rem,env(safe-area-inset-top))]'}`}
                        style={{ paddingBottom: isDashboard ? 0 : undefined, gap: '8px' }}
                    >
                        {/* Logo row — same style on all pages */}
                        <div className="flex items-start justify-between pointer-events-auto">
                            <div className="flex items-center space-x-2">
                                <img src="/thalassa-icon.png" alt="" className="w-10 h-10 rounded-lg" />
                                <div>
                                    <div className="flex items-center gap-1">
                                        <h2 className="text-xl font-bold tracking-wider uppercase shadow-black drop-shadow-lg">Thalassa</h2>
                                        {settings.isPro && <span className="px-1.5 py-0.5 rounded bg-gradient-to-r from-sky-500 to-blue-600 text-[9px] font-bold text-white uppercase tracking-wider shadow-lg">PRO</span>}
                                    </div>
                                    <p className="text-[10px] text-sky-200 uppercase tracking-widest shadow-black drop-shadow-md">
                                        Officer on Watch Assistant
                                    </p>
                                </div>
                            </div>

                            {/* Badge cluster — right-aligned, 2 rows */}
                            <div className="flex flex-col items-end gap-1 pointer-events-auto">
                                {/* Row 1: Logbook + Anchor */}
                                <div className="flex items-center gap-1.5">
                                    <GpsTrackingIndicator />
                                    <AnchorStatusIndicator
                                        currentView={currentView}
                                        onNavigate={() => setPage('compass')}
                                    />
                                </div>
                                {/* Row 2: EXT GPS under anchor */}
                                <div className="flex items-center">
                                    <NmeaGpsIndicator />
                                </div>
                            </div>
                        </div>

                        {currentView !== 'details' && currentView !== 'compass' && currentView !== 'chat' && currentView !== 'voyage' && currentView !== 'polars' && currentView !== 'nmea' && currentView !== 'vessel' && currentView !== 'inventory' && currentView !== 'maintenance' && currentView !== 'equipment' && currentView !== 'documents' && currentView !== 'diary' && currentView !== 'route' && currentView !== 'crew' && (
                            <div className={`flex items-center gap-3 w-full md:w-auto ${isMobileLandscape ? 'h-8' : 'h-12'} pointer-events-auto`}>
                                <div className="relative flex-grow md:w-96 group h-full">
                                    <form onSubmit={(e) => e.preventDefault()} className="relative w-full h-full">
                                        <input
                                            type="text"
                                            value={query}
                                            readOnly
                                            placeholder="Select via Map..."
                                            className={`w-full h-full text-white placeholder-gray-400 rounded-2xl pl-12 pr-12 outline-none transition-all shadow-2xl font-bold text-xl tracking-tight cursor-default ${isOffline ? 'bg-white/5 opacity-50' : 'bg-slate-900/60 border border-white/10'}`}
                                            onClick={() => setPage('map')}
                                        />
                                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-sky-400 bg-sky-500/10 p-1 rounded-md"><SearchIcon className="w-4 h-4" /></div>
                                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={toggleFavorite}
                                                className="p-1.5 rounded-full hover:bg-white/10 text-gray-300 hover:text-yellow-400 transition-colors"
                                            >
                                                <StarIcon className={`w-4 h-4 ${isFavorite ? 'text-yellow-400' : ''}`} filled={isFavorite} />
                                            </button>
                                            <div className="w-px h-4 bg-white/20 mx-1"></div>
                                            <button
                                                type="button"
                                                onClick={() => setPage('map')}
                                                className="p-1.5 hover:bg-white/10 rounded-full text-gray-300 hover:text-emerald-400 transition-colors"
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

                {/* MAIN CONTENT AREA */}
                {currentView !== 'map' ? (
                    <PullToRefresh onRefresh={() => refreshData()} disabled={currentView === 'dashboard' || currentView === 'voyage' || currentView === 'details' || currentView === 'compass' || currentView === 'chat' || currentView === 'route' || currentView === 'polars' || currentView === 'diary' || currentView === 'inventory' || currentView === 'nmea' || currentView === 'maintenance' || currentView === 'equipment' || currentView === 'documents' || currentView === 'crew'}>
                        <main className={`flex-grow relative flex flex-col ${isLight ? 'bg-slate-200' : 'bg-black'} ${!showHeader ? 'pt-[max(2rem,env(safe-area-inset-top))]' : 'pt-0'} ${['settings', 'warnings'].includes(currentView) ? 'overflow-y-auto' : 'overflow-hidden'}`}>
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
                                                {currentView === 'dashboard' && (
                                                    <>
                                                        {error ? (
                                                            <div className="p-8 bg-red-500/20 border border-red-500/30 rounded-2xl text-center max-w-lg mx-auto mt-20">
                                                                <h3 className="text-xl font-bold text-red-200 mb-2">Error</h3>
                                                                <p className="text-white/80">{error}</p>
                                                                <button onClick={() => fetchWeather(query || settings.defaultLocation || '')} className="mt-6 px-6 py-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors">Retry</button>
                                                            </div>
                                                        ) : (!weatherData) ? (
                                                            <div className="flex-1 w-full h-full bg-slate-950 flex items-center justify-center">
                                                                <ProcessOverlay message={loadingMessage || "Loading Marine Data..."} />
                                                            </div>
                                                        ) : (
                                                            <Dashboard
                                                                onOpenMap={() => setPage('map')}
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

                                                {currentView === 'voyage' && <ErrorBoundary boundaryName="VoyagePlanner"><VoyagePlanner onTriggerUpgrade={() => setIsUpgradeOpen(true)} /></ErrorBoundary>}

                                                {currentView === 'settings' && (
                                                    <ErrorBoundary boundaryName="Settings">
                                                        <SettingsView
                                                            settings={settings}
                                                            onSave={updateSettings}
                                                            onLocationSelect={handleFavoriteSelect}
                                                        />
                                                    </ErrorBoundary>
                                                )}

                                                {currentView === 'warnings' && <ErrorBoundary boundaryName="Warnings"><WarningDetails alerts={weatherData?.alerts || []} /></ErrorBoundary>}

                                                {currentView === 'chat' && <ErrorBoundary boundaryName="Chat"><ChatPage /></ErrorBoundary>}

                                                {currentView === 'vessel' && <ErrorBoundary boundaryName="VesselHub"><VesselHub onNavigate={setPage} settings={settings as unknown as Record<string, unknown>} onSave={(u) => updateSettings(u as Partial<typeof settings>)} /></ErrorBoundary>}

                                                {/* Vessel sub-pages — full-screen push on all devices */}
                                                {isVesselView && currentView !== 'vessel' && (
                                                    <>
                                                        {currentView === 'details' && <ErrorBoundary boundaryName="LogPage"><LogPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'compass' && <ErrorBoundary boundaryName="AnchorWatch"><AnchorWatchPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'inventory' && <ErrorBoundary boundaryName="Inventory"><InventoryPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'maintenance' && <ErrorBoundary boundaryName="Maintenance"><MaintenancePage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'polars' && <ErrorBoundary boundaryName="Polars"><PolarPage onBack={() => setPage('vessel')} onNavigateToNmea={() => setPage('nmea')} /></ErrorBoundary>}
                                                        {currentView === 'nmea' && <ErrorBoundary boundaryName="NmeaGateway"><NmeaGatewayPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'equipment' && <ErrorBoundary boundaryName="Equipment"><EquipmentPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'documents' && <ErrorBoundary boundaryName="Documents"><DocumentsPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'diary' && <ErrorBoundary boundaryName="Diary"><DiaryPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'route' && <ErrorBoundary boundaryName="RoutePlanner"><VoyagePlanner onTriggerUpgrade={() => setIsUpgradeOpen(true)} onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                        {currentView === 'crew' && <ErrorBoundary boundaryName="Crew"><CrewPage onBack={() => setPage('vessel')} /></ErrorBoundary>}
                                                    </>
                                                )}
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
                            <Suspense fallback={<div className="flex items-center justify-center h-full text-white"><div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div></div>}>
                                <MapHub
                                    mapboxToken={settings.mapboxToken}
                                    homePort={settings.defaultLocation}
                                    onLocationSelect={handleMapTargetSelect}
                                />
                            </Suspense>
                        </ErrorBoundary>
                        {/* Back chevron — middle-left of screen */}
                        <div className="absolute z-[601] px-3" style={{ top: '50%', transform: 'translateY(-50%)' }}>
                            <button
                                onClick={() => {
                                    // Clear pin-view state when leaving map
                                    delete (window as any).__thalassaPinView;
                                    // Go back to wherever we came from
                                    setPage(previousView || 'dashboard');
                                }}
                                aria-label="Back"
                                className="w-10 h-10 bg-slate-900/90 hover:bg-slate-800 rounded-full flex items-center justify-center border border-white/20 shadow-2xl transition-all hover:scale-110 active:scale-95"
                            >
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
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
                    <div className={`fixed bottom-0 left-0 right-0 z-[900] border-t pb-[env(safe-area-inset-bottom)] ${isLight ? 'bg-slate-200/95 border-slate-300' : 'bg-slate-900 border-white/10'}`}>
                        <div className="flex justify-around items-center h-16 mx-auto px-4 relative" role="tablist" aria-label="Main navigation">
                            <NavButton icon={<WindIcon className="w-6 h-6" />} label="Wx" active={currentView === 'dashboard'} onClick={handleTabDashboard} />
                            <NavButton icon={<MapIcon className="w-6 h-6" />} label="Map" active={currentView === 'map'} onClick={handleTabMap} />
                            <NavButton icon={<ChatIcon className="w-6 h-6" />} label="Chat" active={currentView === 'chat'} onClick={() => setPage('chat')} />
                            <NavButton icon={<ShipWheelIcon className="w-6 h-6" />} label="Vessel" active={isVesselView} onClick={() => setPage('vessel')} />
                        </div>
                    </div>
                )}

            </div>


            {effectiveMode === 'night' && (
                <div className="fixed inset-0 z-[9999] pointer-events-none touch-none bg-red-950/40 mix-blend-multiply"></div>
            )}


        </div>
    );
};

export default App;
