
import React, { Suspense, useState, useEffect, useCallback } from 'react';
import { useWeather } from './context/WeatherContext';
import { AnchorWatchService } from './services/AnchorWatchService';
import { initLocalDatabase, startSyncEngine, stopSyncEngine } from './services/vessel';
import { useSettings } from './context/SettingsContext';
import { useUI } from './context/UIContext';
import { useAppController } from './hooks/useAppController';
import { Dashboard } from './components/Dashboard';
import { SearchIcon, WindIcon, GearIcon, MapIcon, ShipWheelIcon, BoatIcon, ServerIcon, StarIcon, AnchorIcon, ChatIcon } from './components/Icons';
import { SkeletonDashboard } from './components/SkeletonLoader';
import { ForecastSheet } from './components/ForecastSheet';
import { IOSInstallPrompt } from './components/IOSInstallPrompt';
import { NotificationManager } from './components/NotificationManager';
import { ProcessOverlay } from './components/ProcessOverlay';
import { PullToRefresh } from './components/PullToRefresh';
import { NavButton } from './components/NavButton';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GpsTrackingIndicator } from './components/GpsTrackingIndicator';
import { AnchorStatusIndicator } from './components/AnchorStatusIndicator';



// --- LAZY LOAD HEAVY COMPONENTS ---
const VoyagePlanner = React.lazy(() => import('./components/RoutePlanner').then(module => ({ default: module.RoutePlanner })));
const SettingsView = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsView })));
const UpgradeModal = React.lazy(() => import('./components/UpgradeModal').then(module => ({ default: module.UpgradeModal })));
const VesselHub = React.lazy(() => import('./components/VesselHub').then(module => ({ default: module.VesselHub })));
const InventoryPage = React.lazy(() => import('./components/vessel/InventoryList').then(m => ({ default: m.InventoryList })));
const MaintenancePage = React.lazy(() => import('./components/vessel/MaintenanceHub').then(m => ({ default: m.MaintenanceHub })));
const EquipmentPage = React.lazy(() => import('./components/vessel/EquipmentList').then(m => ({ default: m.EquipmentList })));
const DocumentsPage = React.lazy(() => import('./components/vessel/DocumentsHub').then(m => ({ default: m.DocumentsHub })));
const NmeaGatewayPage = React.lazy(() => import('./components/vessel/NmeaPage').then(m => ({ default: m.NmeaPage })));
const PolarPage = React.lazy(() => import('./components/vessel/PolarPage').then(m => ({ default: m.PolarPage })));
const WeatherMap = React.lazy(() => import('./components/WeatherMap').then(module => ({ default: module.WeatherMap })));
const MapHub = React.lazy(() => import('./components/map/MapHub').then(m => ({ default: m.MapHub })));
const OnboardingWizard = React.lazy(() => import('./components/OnboardingWizard').then(module => ({ default: module.OnboardingWizard })));
const WarningDetails = React.lazy(() => import('./components/WarningDetails').then(module => ({ default: module.WarningDetails })));
const AnchorWatchPage = React.lazy(() => import('./components/AnchorWatchPage').then(module => ({ default: module.AnchorWatchPage })));
const ChatPage = React.lazy(() => import('./components/ChatHub').then(module => ({ default: module.ChatHub })));
const LogPage = React.lazy(() => import('./pages/LogPage').then(module => ({ default: module.LogPage })));

const App: React.FC = () => {
    // 1. DATA STATE
    const { weatherData, loading, loadingMessage, error, fetchWeather, refreshData } = useWeather();
    const { settings, togglePro, updateSettings, loading: settingsLoading } = useSettings();
    const { currentView, setPage, isOffline } = useUI();
    const isVesselView = currentView === 'vessel' || currentView === 'details' || currentView === 'voyage' || currentView === 'compass' || currentView === 'inventory' || currentView === 'maintenance' || currentView === 'polars' || currentView === 'nmea' || currentView === 'equipment' || currentView === 'documents';

    // 2. APP LOGIC / CONTROLLER
    const {
        query, bgImage, showOnboarding,
        toastMessage, showToast,
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
        AnchorWatchService.restoreWatchState().catch(() => { /* Non-critical */ });
    }, []);

    // Initialize local-first database and start background sync engine.
    useEffect(() => {
        initLocalDatabase()
            .then(() => startSyncEngine())
            .catch(e => console.error('[App] Local DB init failed:', e));
        return () => stopSyncEngine();
    }, []);

    // Loading State
    if (settingsLoading) {
        return (
            <div className="flex items-center justify-center h-screen w-full bg-[#0f172a] text-sky-500 flex-col gap-4">
                <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    const containerClasses = effectiveMode === 'night' ? 'bg-black text-red-600' : effectiveMode === 'high-contrast' ? 'bg-black text-white' : 'bg-slate-900 text-white';

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

    const showBackgroundImage = effectiveMode === 'standard' && currentView !== 'settings';
    const showHeader = !['map', 'warnings'].includes(currentView);
    const isDashboard = currentView === 'dashboard';

    return (
        <div className={`relative h-screen supports-[height:100dvh]:h-[100dvh] w-full overflow-hidden font-sans transition-colors duration-500 ${containerClasses} flex flex-col`}>

            {/* MODALS & OVERLAYS */}
            <Suspense fallback={null}>
                {showOnboarding && <OnboardingWizard onComplete={handleOnboardingComplete} />}
                <UpgradeModal isOpen={isUpgradeOpen} onClose={() => setIsUpgradeOpen(false)} onUpgrade={togglePro} />
            </Suspense>

            <IOSInstallPrompt />
            <NotificationManager onNotify={showToast} />

            {/* BACKGROUND */}
            {showBackgroundImage ? (
                <div className="absolute inset-0 z-0 bg-cover bg-center transition-all duration-1000 transform scale-105" style={{ backgroundImage: `url(${bgImage})` }}>
                    <div className="absolute inset-0 bg-black/30"></div>
                    <div className="absolute inset-0 bg-gradient-to-b from-slate-900/90 via-slate-900/40 to-slate-900/90"></div>
                </div>
            ) : (
                <div className={`absolute inset-0 z-0 ${effectiveMode === 'night' || effectiveMode === 'high-contrast' ? 'bg-black' : 'bg-[#0f172a]'}`}></div>
            )}

            {loading && <ProcessOverlay message={loadingMessage} />}

            <div className="relative z-10 flex flex-col h-full overflow-hidden">
                {/* OFFLINE BANNER */}
                {isOffline && (
                    <div className="bg-orange-600/90 backdrop-blur-md text-white text-xs font-bold uppercase tracking-widest text-center py-2 px-4 shadow-lg flex items-center justify-center gap-2 pt-[max(0.5rem,env(safe-area-inset-top))] shrink-0">
                        <ServerIcon className="w-4 h-4" /> OFFLINE MODE
                    </div>
                )}

                {/* TOASTS */}
                {toastMessage && (
                    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[1300] animate-in fade-in slide-in-from-top-2">
                        <div className="bg-slate-900/90 backdrop-blur-md border border-white/20 text-white text-sm font-medium px-4 py-2 rounded-full shadow-xl flex items-center gap-2">
                            <StarIcon filled={true} className="w-4 h-4 text-yellow-400" />
                            {toastMessage}
                        </div>
                    </div>
                )}



                {/* HEADER */}
                {showHeader && (
                    <header
                        className={`px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 ${isDashboard ? 'fixed top-0 left-0 right-0 z-[105] bg-black' : `${isMobileLandscape ? 'py-1' : 'py-2'}`} ${!isOffline && 'pt-[max(1rem,env(safe-area-inset-top))]'}`}
                        style={{ paddingBottom: isDashboard ? 0 : undefined, gap: '8px' }}
                    >
                        {/* Logo row — same style on all pages */}
                        <div className="flex items-center space-x-2 pointer-events-auto">
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

                        {currentView !== 'details' && currentView !== 'compass' && currentView !== 'chat' && currentView !== 'voyage' && currentView !== 'polars' && currentView !== 'nmea' && currentView !== 'vessel' && currentView !== 'inventory' && currentView !== 'maintenance' && currentView !== 'equipment' && currentView !== 'documents' && (
                            <div className={`flex items-center gap-3 w-full md:w-auto ${isMobileLandscape ? 'h-8' : 'h-12'} pointer-events-auto`}>
                                <div className="relative flex-grow md:w-96 group h-full">
                                    <form onSubmit={(e) => e.preventDefault()} className="relative w-full h-full">
                                        <input
                                            type="text"
                                            value={query}
                                            readOnly
                                            placeholder="Select via Map..."
                                            className={`w-full h-full text-white placeholder-gray-400 rounded-2xl pl-12 pr-12 outline-none transition-all shadow-2xl font-bold text-xl tracking-tight cursor-default ${isOffline ? 'bg-white/5 opacity-50' : 'bg-slate-900/60 backdrop-blur-md border border-white/10'}`}
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

                {/* GLOBAL GPS TRACKING INDICATOR */}
                <GpsTrackingIndicator />

                {/* GLOBAL ANCHOR STATUS — visible on all screens when deployed */}
                <AnchorStatusIndicator
                    currentView={currentView}
                    onNavigate={() => setPage('compass')}
                />

                {/* MAIN CONTENT AREA */}
                {currentView !== 'map' ? (
                    <PullToRefresh onRefresh={() => refreshData()} disabled={currentView === 'dashboard' || currentView === 'voyage' || currentView === 'details' || currentView === 'compass' || currentView === 'chat'}>
                        <main className={`flex-grow relative flex flex-col bg-black ${!showHeader ? 'pt-[max(2rem,env(safe-area-inset-top))]' : 'pt-0'} ${['voyage', 'settings', 'warnings'].includes(currentView) ? 'overflow-y-auto' : 'overflow-hidden'}`}>
                            <ErrorBoundary boundaryName="MainContent">
                                <Suspense fallback={<SkeletonDashboard />}>
                                    <div key={currentView} className="page-enter contents">
                                        {currentView === 'dashboard' && (
                                            <>
                                                {error ? (
                                                    <div className="p-8 bg-red-500/20 border border-red-500/30 backdrop-blur-md rounded-2xl text-center max-w-lg mx-auto mt-20">
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
                                                    />
                                                )}
                                            </>
                                        )}

                                        {currentView === 'details' && <LogPage />}

                                        {currentView === 'voyage' && <VoyagePlanner onTriggerUpgrade={() => setIsUpgradeOpen(true)} />}

                                        {currentView === 'settings' && (
                                            <SettingsView
                                                settings={settings}
                                                onSave={updateSettings}
                                                onLocationSelect={handleFavoriteSelect}
                                            />
                                        )}

                                        {currentView === 'warnings' && <WarningDetails alerts={weatherData?.alerts || []} />}

                                        {currentView === 'compass' && <AnchorWatchPage onBack={() => setPage('vessel')} />}

                                        {currentView === 'chat' && <ChatPage />}

                                        {currentView === 'vessel' && <VesselHub onNavigate={setPage} settings={settings as unknown as Record<string, unknown>} onSave={(u) => updateSettings(u as Partial<typeof settings>)} />}

                                        {currentView === 'inventory' && <InventoryPage onBack={() => setPage('vessel')} />}
                                        {currentView === 'maintenance' && <MaintenancePage onBack={() => setPage('vessel')} />}
                                        {currentView === 'polars' && <PolarPage onBack={() => setPage('vessel')} onNavigateToNmea={() => setPage('nmea')} />}
                                        {currentView === 'nmea' && <NmeaGatewayPage onBack={() => setPage('vessel')} />}
                                        {currentView === 'equipment' && <EquipmentPage onBack={() => setPage('vessel')} />}
                                        {currentView === 'documents' && <DocumentsPage onBack={() => setPage('vessel')} />}
                                    </div>
                                </Suspense>
                            </ErrorBoundary>
                        </main>
                    </PullToRefresh>
                ) : (
                    <div className="flex-grow w-full relative bg-slate-900 overflow-hidden">
                        <Suspense fallback={<div className="flex items-center justify-center h-full text-white"><div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div></div>}>
                            <MapHub
                                mapboxToken={settings.mapboxToken}
                                homePort={settings.defaultLocation}
                                onLocationSelect={handleMapTargetSelect}
                            />
                        </Suspense>
                    </div>
                )}

                {/* BOTTOM FADE removed — was obscuring Start Tracking button on Log page */}

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

                {!isMobileLandscape && (
                    <div className={`fixed bottom-0 left-0 right-0 z-[900] backdrop-blur-xl border-t border-white/10 pb-[env(safe-area-inset-bottom)] ${effectiveMode !== 'standard' ? 'bg-slate-900' : 'bg-slate-900/90'}`}>
                        <div className="flex justify-around items-center h-16 md:h-20 max-w-2xl mx-auto px-4 relative" role="tablist" aria-label="Main navigation">
                            <NavButton icon={<WindIcon className="w-6 h-6" />} label="Wx" active={currentView === 'dashboard'} onClick={handleTabDashboard} />
                            <NavButton icon={<MapIcon className="w-6 h-6" />} label="Map" active={currentView === 'map'} onClick={handleTabMap} />
                            <NavButton icon={<ChatIcon className="w-6 h-6" />} label="Chat" active={currentView === 'chat'} onClick={() => setPage('chat')} />
                            <NavButton icon={<ShipWheelIcon className="w-6 h-6" />} label="Vessel" active={isVesselView} onClick={() => setPage('vessel')} />
                        </div>
                    </div>
                )}

            </div>


            {effectiveMode === 'night' && (
                <div className="fixed inset-0 z-[9999] pointer-events-none touch-none" style={{ backdropFilter: 'grayscale(100%) sepia(100%) hue-rotate(-50deg) saturate(600%) contrast(0.8) brightness(0.8)' }}></div>
            )}


        </div>
    );
};

export default App;
