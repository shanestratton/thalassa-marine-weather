
import React, { useState, useEffect, Suspense, useCallback } from 'react';
import { useWeather } from './context/WeatherContext';
import { useSettings } from './context/SettingsContext';
import { useUI } from './context/UIContext';
import { useAppController } from './hooks/useAppController';
import { Dashboard } from './components/Dashboard';
import { SearchIcon, WindIcon, GearIcon, MapIcon, CompassIcon, BoatIcon, ServerIcon, StarIcon, LockIcon, ClockIcon } from './components/Icons';
import { SkeletonDashboard } from './components/SkeletonLoader';
import { ForecastSheet } from './components/ForecastSheet';
import { IOSInstallPrompt } from './components/IOSInstallPrompt';
import { NotificationManager } from './components/NotificationManager';
import { UserSettings } from './types';

// --- LAZY LOAD HEAVY COMPONENTS ---
// This ensures the initial bundle is small and startup is snappy.
const VoyagePlanner = React.lazy(() => import('./components/RoutePlanner').then(module => ({ default: module.VoyagePlanner })));
const SettingsView = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsView })));
const UpgradeModal = React.lazy(() => import('./components/UpgradeModal').then(module => ({ default: module.UpgradeModal })));
const WeatherMap = React.lazy(() => import('./components/WeatherMap').then(module => ({ default: module.WeatherMap })));
const OnboardingWizard = React.lazy(() => import('./components/OnboardingWizard').then(module => ({ default: module.OnboardingWizard })));

const App: React.FC = () => {
    // Optimization: De-coupled hooks
    const { weatherData, loading, error, fetchWeather, nextUpdate, backgroundUpdating } = useWeather();
    const { settings, updateSettings, togglePro } = useSettings();
    const { currentView, setPage, isOffline } = useUI();

    const { 
        query, setQuery, bgImage, showOnboarding, setShowOnboarding, toastMessage, showToast,
        handleSearchSubmit, handleLocate, effectiveMode 
    } = useAppController();

    const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
    const [isMobileLandscape, setIsMobileLandscape] = useState(false);
    
    // Map Sheet State
    const [sheetData, setSheetData] = useState<any>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [mapLoading, setMapLoading] = useState(false);

    // Detect Mobile Landscape
    useEffect(() => {
        const checkOrientation = () => {
            const isLandscape = window.matchMedia('(orientation: landscape)').matches;
            const isShort = window.innerHeight < 500; // Typical mobile landscape height
            setIsMobileLandscape(isLandscape && isShort);
        };
        checkOrientation();
        window.addEventListener('resize', checkOrientation);
        return () => window.removeEventListener('resize', checkOrientation);
    }, []);

    const handleOnboardingComplete = (newSettings: Partial<UserSettings>) => {
        updateSettings(newSettings);
        setShowOnboarding(false);
        if (newSettings.defaultLocation) {
            setQuery(newSettings.defaultLocation);
            setTimeout(() => fetchWeather(newSettings.defaultLocation!), 100);
        }
    };

    const handleMapTargetSelect = useCallback(async (lat: number, lon: number, name?: string) => {
        // Use name if provided (e.g. Buoy Name), else fallback to coordinates
        const locationQuery = name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        setQuery(locationQuery);
        setSheetOpen(false); 
        // FIX: Pass explicit coordinates to bypass name resolution bugs for generic buoy names
        fetchWeather(locationQuery, false, { lat, lon }); 
        setPage('dashboard');
    }, [setQuery, fetchWeather, setPage]);

    const toggleFavorite = useCallback(() => {
        if (!weatherData) return;
        const loc = weatherData.locationName;
        const isFav = settings.savedLocations.includes(loc);
        let newLocs;
        
        if (isFav) {
            newLocs = settings.savedLocations.filter(l => l !== loc);
            showToast(`Removed ${loc} from favorites`);
        } else {
            newLocs = [loc, ...settings.savedLocations];
            showToast(`Saved ${loc} to favorites`);
        }
        updateSettings({ savedLocations: newLocs });
    }, [weatherData, settings.savedLocations, showToast, updateSettings]);

    const handleFavoriteSelect = useCallback((loc: string) => {
        setQuery(loc); 
        fetchWeather(loc); 
        setPage('dashboard');
    }, [setQuery, fetchWeather, setPage]);

    const containerClasses = effectiveMode === 'night' ? 'bg-black text-red-600' : effectiveMode === 'high-contrast' ? 'bg-black text-white' : 'bg-slate-900 text-white';
    const displayTitle = weatherData ? weatherData.locationName : (query || settings.defaultLocation || "Select Location");
    const showBackgroundImage = effectiveMode === 'standard' && currentView !== 'settings';
    const showHeader = !['map', 'voyage'].includes(currentView);
    const isFavorite = settings.savedLocations.includes(displayTitle);

    // Determine scroll behavior based on view
    const mainScrollClass = currentView === 'settings' ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar';

    return (
        <div className={`relative h-screen supports-[height:100dvh]:h-[100dvh] w-full overflow-hidden font-sans transition-colors duration-500 ${containerClasses} flex flex-col`}>
            
            <Suspense fallback={null}>
                {showOnboarding && <OnboardingWizard onComplete={handleOnboardingComplete} />}
                <UpgradeModal isOpen={isUpgradeOpen} onClose={() => setIsUpgradeOpen(false)} onUpgrade={togglePro} />
            </Suspense>

            <IOSInstallPrompt />
            <NotificationManager onNotify={showToast} />
            
            {showBackgroundImage ? (
                <div className="absolute inset-0 z-0 bg-cover bg-center transition-all duration-1000 transform scale-105" style={{ backgroundImage: `url(${bgImage})` }}>
                    <div className="absolute inset-0 bg-black/30"></div>
                    <div className="absolute inset-0 bg-gradient-to-b from-slate-900/90 via-slate-900/40 to-slate-900/90"></div>
                </div>
            ) : (
                <div className={`absolute inset-0 z-0 ${effectiveMode === 'night' || effectiveMode === 'high-contrast' ? 'bg-black' : 'bg-[#0f172a]'}`}></div>
            )}

            <div className="relative z-10 flex flex-col h-full overflow-hidden">
                {isOffline && (
                    <div className="bg-orange-600/90 backdrop-blur-md text-white text-xs font-bold uppercase tracking-widest text-center py-2 px-4 shadow-lg flex items-center justify-center gap-2 pt-[max(0.5rem,env(safe-area-inset-top))] shrink-0">
                        <ServerIcon className="w-4 h-4" /> OFFLINE MODE
                    </div>
                )}

                {toastMessage && (
                    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[1300] animate-in fade-in slide-in-from-top-2">
                        <div className="bg-slate-900/90 backdrop-blur-md border border-white/20 text-white text-sm font-medium px-4 py-2 rounded-full shadow-xl flex items-center gap-2">
                            <StarIcon filled className="w-4 h-4 text-yellow-400" />
                            {toastMessage}
                        </div>
                    </div>
                )}

                {showHeader && (
                    <header className={`px-4 md:px-6 ${isMobileLandscape ? 'py-1' : 'py-3'} flex flex-col md:flex-row md:items-center justify-between gap-3 pointer-events-none shrink-0 ${!isOffline && 'pt-[max(1rem,env(safe-area-inset-top))]'}`}>
                        <div className="flex items-center space-x-2 pointer-events-auto">
                            <div className="bg-sky-500/20 p-2 rounded-lg backdrop-blur-md border border-sky-500/30">
                                <WindIcon className="w-6 h-6 text-sky-400" />
                            </div>
                            <div>
                                <div className="flex items-center gap-1">
                                    <h2 className="text-xl font-bold tracking-wider uppercase shadow-black drop-shadow-lg">Thalassa</h2>
                                    {settings.isPro && <span className="px-1.5 py-0.5 rounded bg-gradient-to-r from-sky-500 to-blue-600 text-[9px] font-bold text-white uppercase tracking-wider shadow-lg">PRO</span>}
                                </div>
                                <p className="text-[10px] text-sky-200 uppercase tracking-widest shadow-black drop-shadow-md">Marine Forecasting</p>
                            </div>
                        </div>

                        <div className={`flex items-center gap-3 w-full md:w-auto ${isMobileLandscape ? 'h-8' : 'h-10'} pointer-events-auto`}>
                            <div className="relative flex-grow md:w-96 group h-full">
                                <form onSubmit={handleSearchSubmit} className="relative w-full h-full">
                                    <input 
                                        type="text" 
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder={isOffline ? "Search Unavailable Offline" : "Search Port..."}
                                        disabled={isOffline}
                                        className={`w-full h-full text-white placeholder-gray-300 rounded-full pl-10 pr-20 outline-none transition-all shadow-lg font-medium text-sm md:text-base ${isOffline ? 'bg-white/5 opacity-50' : 'bg-white/10 backdrop-blur-md border border-white/20 focus:bg-white/20 focus:border-sky-400'}`}
                                    />
                                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-200"><SearchIcon className="w-4 h-4" /></div>
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                        <button 
                                            type="button" 
                                            onClick={toggleFavorite}
                                            className="p-1.5 rounded-full hover:bg-white/10 text-gray-300 hover:text-yellow-400 transition-colors"
                                            title="Toggle Favorite"
                                        >
                                            <StarIcon className={`w-4 h-4 ${isFavorite ? 'text-yellow-400' : ''}`} filled={isFavorite} />
                                        </button>
                                        <button 
                                            type="button" 
                                            onClick={handleLocate} 
                                            className="p-1.5 hover:bg-white/10 rounded-full text-gray-300 hover:text-sky-400 transition-colors"
                                            title="Use GPS"
                                        >
                                            <CompassIcon rotation={0} className="w-4 h-4" />
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    </header>
                )}

                {/* Main Content Area - Suspense Wrapper for View Switching */}
                {currentView !== 'map' ? (
                    <main className={`flex-grow relative flex flex-col ${mainScrollClass} ${!showHeader ? 'pt-[max(2rem,env(safe-area-inset-top))]' : 'pt-0'}`}>
                        <Suspense fallback={<SkeletonDashboard />}>
                            {currentView === 'dashboard' && (
                                <>
                                    {error ? (
                                        <div className="p-8 bg-red-500/20 border border-red-500/30 backdrop-blur-md rounded-2xl text-center max-w-lg mx-auto mt-20">
                                            <h3 className="text-xl font-bold text-red-200 mb-2">Error</h3>
                                            <p className="text-white/80">{error}</p>
                                            <button onClick={() => fetchWeather(query || settings.defaultLocation || '')} className="mt-6 px-6 py-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors">Retry</button>
                                        </div>
                                    ) : (!weatherData && loading) ? (
                                        <SkeletonDashboard />
                                    ) : (
                                        <Dashboard 
                                            onOpenMap={() => setPage('map')} 
                                            onTriggerUpgrade={() => setIsUpgradeOpen(true)}
                                            displayTitle={displayTitle}
                                            timeZone={weatherData?.timeZone}
                                            // @ts-ignore
                                            utcOffset={weatherData?.utcOffset}
                                            timeDisplaySetting={settings.timeDisplay}
                                            onToggleFavorite={toggleFavorite}
                                            favorites={settings.savedLocations}
                                            isRefreshing={loading}
                                            isNightMode={effectiveMode === 'night'}
                                            isMobileLandscape={isMobileLandscape}
                                        />
                                    )}
                                </>
                            )}

                            {currentView === 'voyage' && <VoyagePlanner onTriggerUpgrade={() => setIsUpgradeOpen(true)} />}
                            
                            {currentView === 'settings' && (
                                <SettingsView 
                                    settings={settings} 
                                    onSave={updateSettings} 
                                    onLocationSelect={handleFavoriteSelect}
                                />
                            )}
                        </Suspense>
                    </main>
                ) : (
                    <div className="flex-grow w-full relative bg-slate-900 overflow-hidden">
                        <Suspense fallback={<div className="flex items-center justify-center h-full text-white"><div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div></div>}>
                            <WeatherMap 
                                locationName={weatherData?.locationName || "Global"} 
                                lat={weatherData?.coordinates?.lat} 
                                lon={weatherData?.coordinates?.lon}
                                currentWeather={weatherData?.current}
                                synopticMap={weatherData?.synopticMap}
                                onLocationSelect={handleMapTargetSelect}
                                mapboxToken={settings.mapboxToken}
                                enableZoom={true}
                                restrictBounds={true} 
                                isConfirmMode={true} // Enable Confirm Button Flow
                            />
                        </Suspense>
                    </div>
                )}

                {/* Fade Overlay for Bottom Scroll Softening - Visible in Dashboard/Voyage */}
                {(currentView === 'dashboard' || currentView === 'voyage') && !isMobileLandscape && (
                    <div 
                        className={`fixed bottom-0 left-0 right-0 h-40 z-[850] pointer-events-none bg-gradient-to-t ${
                            effectiveMode === 'night' || effectiveMode === 'high-contrast' 
                                ? 'from-black via-black/95 to-transparent' 
                                : 'from-[#0f172a] via-[#0f172a] to-transparent'
                        }`} 
                    />
                )}

                <ForecastSheet 
                    data={sheetData} 
                    isLoading={mapLoading} 
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
                        <div className="flex justify-around items-center h-16 md:h-20 max-w-2xl mx-auto px-4 relative">
                            <NavButton icon={<WindIcon className="w-5 h-5 mb-0.5"/>} label="Wx" active={currentView === 'dashboard'} onClick={() => setPage('dashboard')} />
                            <NavButton icon={<BoatIcon className="w-5 h-5 mb-0.5"/>} label="Passage" active={currentView === 'voyage'} onClick={() => setPage('voyage')} />
                            <NavButton icon={<MapIcon className="w-5 h-5 mb-0.5"/>} label="Map" active={currentView === 'map'} onClick={() => setPage('map')} />
                            <NavButton icon={<GearIcon className="w-5 h-5 mb-0.5"/>} label="Settings" active={currentView === 'settings'} onClick={() => setPage('settings')} />
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

const NavButton = ({ icon, label, active, onClick }: any) => (
    <button onClick={onClick} className={`flex flex-col items-center justify-center w-14 h-full transition-all duration-300 ${active ? 'text-sky-400' : 'text-gray-400 hover:text-gray-200'}`}>
        {icon}<span className="text-[9px] font-bold uppercase tracking-wider">{label}</span>
        {active && <div className="absolute bottom-1 w-1 h-1 bg-sky-400 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.8)]"></div>}
    </button>
);

export default App;
