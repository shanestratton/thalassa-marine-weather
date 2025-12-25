
import React, { useState, useEffect } from 'react';
import { UserSettings, LengthUnit, WeightUnit, VesselDimensionUnits, DisplayMode, VolumeUnit } from '../types';
import { 
  WindIcon, CompassIcon, 
  SailBoatIcon, PowerBoatIcon, BellIcon, ArrowRightIcon,
  BoatIcon, RainIcon, WaveIcon, StarIcon, SearchIcon, GearIcon, CheckIcon, ThermometerIcon, DropletIcon, MapIcon, ServerIcon,
  TrashIcon, MapPinIcon, DiamondIcon, BugIcon, PlayIcon, LockIcon, EyeIcon, XIcon, TideCurveIcon, SunIcon, GaugeIcon, ArrowUpIcon, ArrowDownIcon, GripIcon,
  CloudIcon, AlertTriangleIcon, QuoteIcon
} from './Icons';
import { reverseGeocode } from '../services/weatherService';
import { checkStormglassStatus, debugStormglassConnection, isStormglassKeyPresent } from '../services/stormglassService';
import { AuthModal } from './AuthModal';
import { useThalassa } from '../context/ThalassaContext';
import { isSupabaseConfigured } from '../services/supabase';
import { isGeminiConfigured } from '../services/geminiService';

// AVAILABLE WIDGETS CONFIG
const ALL_HERO_WIDGETS = [
    { id: 'wind', label: 'Wind Speed', icon: <WindIcon className="w-4 h-4"/> },
    { id: 'wave', label: 'Sea State', icon: <WaveIcon className="w-4 h-4"/> },
    { id: 'pressure', label: 'Barometer', icon: <GaugeIcon className="w-4 h-4"/> },
    { id: 'precip', label: 'Precipitation', icon: <RainIcon className="w-4 h-4"/> },
    { id: 'uv', label: 'UV Index', icon: <SunIcon className="w-4 h-4"/> },
    { id: 'visibility', label: 'Visibility', icon: <EyeIcon className="w-4 h-4"/> },
];

const ALL_DETAIL_WIDGETS = [
    { id: 'score', label: 'Condition Score', icon: <StarIcon className="w-4 h-4"/> },
    { id: 'tide', label: 'Tide Trend', icon: <TideCurveIcon className="w-4 h-4"/> },
    { id: 'pressure', label: 'Barometer', icon: <GaugeIcon className="w-4 h-4"/> },
    { id: 'humidity', label: 'Humidity', icon: <DropletIcon className="w-4 h-4"/> },
    { id: 'precip', label: 'Precipitation', icon: <RainIcon className="w-4 h-4"/> },
    { id: 'dewPoint', label: 'Dew Point', icon: <ThermometerIcon className="w-4 h-4"/> },
    { id: 'cloud', label: 'Cloud Cover', icon: <CloudIcon className="w-4 h-4"/> },
    { id: 'visibility', label: 'Visibility', icon: <EyeIcon className="w-4 h-4"/> },
    { id: 'chill', label: 'Wind Chill', icon: <ThermometerIcon className="w-4 h-4"/> },
    { id: 'swell', label: 'Swell Period', icon: <WaveIcon className="w-4 h-4"/> },
    { id: 'uv', label: 'UV Index', icon: <SunIcon className="w-4 h-4"/> },
    { id: 'waterTemp', label: 'Water Temp', icon: <ThermometerIcon className="w-4 h-4"/> },
];

const isMapboxConfigured = () => {
    // @ts-ignore
    const envKey = process.env.MAPBOX_ACCESS_TOKEN || (import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN);
    if (envKey && envKey.length > 5) return true;
    if (typeof window !== 'undefined') {
        const local = localStorage.getItem('thalassa_mapbox_key');
        if (local && local.length > 5) return true;
    }
    return false;
}

const isOpenMeteoConfigured = () => {
    // @ts-ignore
    const envKey = process.env.OPEN_METEO_API_KEY || (import.meta.env && import.meta.env.VITE_OPEN_METEO_API_KEY);
    return envKey && envKey.length > 5;
}

const getKeyPreview = (keyName: 'GEMINI' | 'STORMGLASS' | 'MAPBOX') => {
    let val = "";
    if (keyName === 'GEMINI') {
        // @ts-ignore
        val = process.env.API_KEY || process.env.GEMINI_API_KEY || (import.meta.env && import.meta.env.VITE_GEMINI_API_KEY);
    } else if (keyName === 'STORMGLASS') {
        // @ts-ignore
        val = process.env.STORMGLASS_API_KEY || (import.meta.env && import.meta.env.VITE_STORMGLASS_API_KEY);
    } else if (keyName === 'MAPBOX') {
        // @ts-ignore
        val = process.env.MAPBOX_ACCESS_TOKEN || (import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN);
    }
    if (!val || val.length < 5 || val.includes("YOUR_")) return "MISSING";
    return `Ends in ...${val.slice(-4)}`;
};

interface SettingsViewProps {
  settings: UserSettings;
  onSave: (settings: Partial<UserSettings>) => void;
  onLocationSelect: (location: string) => void;
}

const NavButton = ({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) => (
    <button 
        onClick={onClick}
        className={`flex items-center gap-3 w-full p-3 rounded-xl transition-all duration-300 text-left ${active ? 'bg-sky-500/10 text-white shadow-sm border border-sky-500/20' : 'text-gray-400 hover:bg-white/5 hover:text-white border border-transparent'}`}
    >
        <div className={`p-2 rounded-lg ${active ? 'bg-sky-500 text-white' : 'bg-white/5 text-gray-400'}`}>
            {icon}
        </div>
        <span className="font-medium text-sm tracking-wide">{label}</span>
        {active && <ArrowRightIcon className="w-4 h-4 ml-auto text-sky-500" />}
    </button>
);

const MobileNavTab = ({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) => (
    <button
        onClick={onClick}
        className={`flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap transition-all duration-300 ${active ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
    >
        {icon}
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
    </button>
);

const Toggle = ({ checked, onChange }: { checked: boolean, onChange: (v: boolean) => void }) => (
    <div 
        className="relative inline-flex items-center cursor-pointer p-2 -mr-2"
        onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onChange(!checked);
        }}
    >
        <div className={`w-11 h-6 rounded-full border border-white/10 transition-colors pointer-events-none ${checked ? 'bg-sky-500' : 'bg-slate-700/50'}`}></div>
        <div className={`absolute top-[10px] left-[10px] bg-white border border-gray-300 rounded-full h-5 w-5 transition-transform pointer-events-none shadow-sm ${checked ? 'translate-x-full border-white' : 'translate-x-0'}`}></div>
    </div>
);

const Section = ({ title, children }: { title: string, children?: React.ReactNode }) => (
    <div className="space-y-4 mb-8">
        <h3 className="text-xs font-bold text-sky-200/70 uppercase tracking-wider px-2 shadow-black drop-shadow-md">{title}</h3>
        <div className="bg-slate-900/60 backdrop-blur-md rounded-2xl border border-white/10 overflow-hidden shadow-xl">
            {children}
        </div>
    </div>
);

const Row = ({ children, className = "", onClick }: { children?: React.ReactNode, className?: string, onClick?: () => void }) => (
    <div 
        className={`p-4 border-b border-white/5 last:border-0 flex items-center justify-between gap-4 ${className} ${onClick ? 'cursor-pointer hover:bg-white/5 transition-colors' : ''}`}
        onClick={onClick}
    >
        {children}
    </div>
);

const MetricInput = ({ label, valInStandard, unitType, unitOptions, onChangeValue, onChangeUnit, placeholder, isEstimated }: any) => {
    const isWeight = unitOptions.includes('lbs');
    const [localStr, setLocalStr] = useState<string>('');
    
    useEffect(() => {
        const displayVal = isWeight 
            ? (unitType === 'kg' ? valInStandard * 0.453592 : unitType === 'tonnes' ? valInStandard * 0.000453592 : valInStandard)
            : (unitType === 'm' ? valInStandard * 0.3048 : valInStandard);
        
        const currentParsed = parseFloat(localStr);
        if (isNaN(currentParsed) || Math.abs(currentParsed - displayVal) > 0.01) {
            setLocalStr(displayVal.toFixed(2));
        }
    }, [valInStandard, unitType, isWeight]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalStr(e.target.value);

    const handleBlur = () => {
         const num = parseFloat(localStr);
         if(!isNaN(num)) {
             const standard = isWeight 
                ? (unitType === 'kg' ? num * 2.20462 : unitType === 'tonnes' ? num * 2204.62 : num)
                : (unitType === 'm' ? num * 3.28084 : num);
             onChangeValue(standard);
             setLocalStr(num.toFixed(2));
         }
    };

    return (
        <div className="flex-1 min-w-[120px]">
          <div className="flex justify-between items-center mb-1.5 ml-1">
              <label className={`text-[10px] uppercase tracking-wider block ${isEstimated ? "text-red-400" : "text-gray-400"}`}>{label}</label>
              {isEstimated && <span className="text-[9px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded font-bold uppercase">Est.</span>}
          </div>
          <div className={`flex bg-black/40 border rounded-xl overflow-hidden transition-colors ${isEstimated ? "border-red-500/50 focus-within:border-red-500" : "border-white/10 focus-within:border-sky-500"}`}>
              <input 
                  type="number"
                  step="0.1"
                  value={localStr}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  className={`flex-1 bg-transparent px-3 py-2 outline-none w-full text-sm font-mono placeholder-gray-600 ${isEstimated ? "text-red-300" : "text-white"}`}
                  placeholder={placeholder}
              />
              <select 
                  value={unitType}
                  onChange={(e) => onChangeUnit(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs font-bold px-2 outline-none border-l border-white/10 hover:text-white cursor-pointer uppercase"
              >
                  {unitOptions.map((opt: string) => <option key={opt} value={opt} className="bg-slate-900">{opt}</option>)}
              </select>
          </div>
        </div>
    );
};

export const SettingsView: React.FC<SettingsViewProps> = ({ settings, onSave, onLocationSelect }) => {
  const { user, logout, resetSettings } = useThalassa();
  const [activeTab, setActiveTab] = useState<'general' | 'account' | 'vessel' | 'alerts' | 'scenery' | 'locations' | 'layout'>('general');
  const [detectingLoc, setDetectingLoc] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [sgStatus, setSgStatus] = useState<{ status: string, message: string } | null>(null);
  const [debugLog, setDebugLog] = useState<string | null>(null);
  const [isRunningDebug, setIsRunningDebug] = useState(false);


  useEffect(() => {
      if (activeTab === 'account') {
          setSgStatus({ status: 'LOADING', message: 'Checking...' });
          checkStormglassStatus().then(res => setSgStatus({ status: res.status, message: res.message }));

          setSgStatus({ status: 'LOADING', message: 'Checking...' });
          checkStormglassStatus().then(res => setSgStatus({ status: res.status, message: res.message }));
      }
  }, [activeTab]);

  const runDiagnostics = async () => {
      setIsRunningDebug(true);
      try {
          const result = await debugStormglassConnection();
          setDebugLog(result);
      } catch (e: any) {
          setDebugLog(`FATAL ERROR: ${e.message}`);
      } finally {
          setIsRunningDebug(false);
      }
  };

  // Safe update helper - only sends 'units' delta
  const updateUnit = (type: keyof typeof settings.units, value: any) => {
    onSave({ units: { ...settings.units, [type]: value } });
  };

  const updateAlert = async (key: keyof typeof settings.notifications, field: 'enabled' | 'threshold', value: any) => {
    if (field === 'enabled' && value === true) {
        if ('Notification' in window && Notification.permission !== 'granted') {
            try { await Notification.requestPermission(); } catch (e) {}
        }
    }
    onSave({
      notifications: {
        ...settings.notifications,
        [key]: { ...settings.notifications[key as keyof typeof settings.notifications], [field]: value }
      }
    });
  };
  
  const updateVessel = (field: string, value: any) => {
      let newEstimatedFields = settings.vessel?.estimatedFields;
      if (newEstimatedFields && newEstimatedFields.includes(field)) {
          newEstimatedFields = newEstimatedFields.filter(f => f !== field);
      }
      onSave({
          vessel: {
              name: 'My Boat', type: 'sail', length: 30, beam: 10, draft: 5, displacement: 10000,
              maxWaveHeight: 6, cruisingSpeed: 6, fuelCapacity: 0, waterCapacity: 0,
              ...((settings.vessel || {}) as any),
              estimatedFields: newEstimatedFields,
              [field]: value
          }
      });
  }

  const handleDetectLocation = () => {
    setDetectingLoc(true);
    if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            let resolvedName = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
            try { const name = await reverseGeocode(latitude, longitude); if(name) resolvedName = name; } catch (e) { }
            onSave({ defaultLocation: resolvedName });
            setDetectingLoc(false);
        }, () => setDetectingLoc(false));
    } else { setDetectingLoc(false); }
  };

  // UPDATED STATUS ROW
  const StatusRow = ({ label, isConnected, status, details, loading, onTest }: any) => {
      const isMissing = status === 'MISSING_KEY' || (!isConnected && !status);
      const isActive = status === 'OK' || isConnected;
      let indicatorColor = 'bg-red-500 shadow-red-500/20';
      let textColor = 'text-red-400';
      let displayText = details || (isActive ? 'ACTIVE' : 'MISSING');

      if (loading) {
          indicatorColor = 'bg-yellow-500 animate-pulse'; textColor = 'text-yellow-400'; displayText = 'CHECKING...';
      } else if (isActive) {
          indicatorColor = 'bg-emerald-500 shadow-emerald-500/50'; textColor = 'text-emerald-400';
      } else if (isMissing) {
          indicatorColor = 'bg-sky-500 shadow-sky-500/50'; textColor = 'text-sky-300'; displayText = 'FREE MODE';
      }

      return (
          <div className="flex items-center justify-between p-3 bg-black/20 rounded-lg border border-white/5">
              <div className="flex items-center gap-3">
                  <div className={`w-2.5 h-2.5 rounded-full shadow-lg ${indicatorColor}`}></div>
                  <span className="text-xs font-bold text-white uppercase tracking-wider">{label}</span>
              </div>
              <div className="flex items-center gap-3">
                  <span className={`text-[10px] font-mono font-medium ${textColor}`}>{displayText}</span>
                  {onTest && <button onClick={onTest} className="px-2 py-1 rounded bg-white/5 border border-white/10 text-[9px] font-bold text-white uppercase">Test</button>}
              </div>
          </div>
      );
  };

  return (
    <div className="w-full max-w-6xl mx-auto h-full flex flex-col md:flex-row pb-24">
        <AuthModal isOpen={authOpen} onClose={() => setAuthOpen(false)} />
        
        {debugLog && (
            <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
                <div className="bg-[#0f172a] border border-white/20 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
                    <div className="p-4 border-b border-white/10 flex justify-between items-center">
                        <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2"><BugIcon className="w-4 h-4 text-emerald-400"/> Stormglass Diagnostic</h3>
                        <button onClick={() => setDebugLog(null)} className="p-1 hover:bg-white/10 rounded"><XIcon className="w-5 h-5 text-gray-400"/></button>
                    </div>
                    <div className="flex-1 overflow-auto p-4 bg-black/50 font-mono text-[10px] text-green-300 whitespace-pre-wrap">{debugLog}</div>
                </div>
            </div>
        )}
        
        <div className="hidden md:flex w-64 border-r border-white/5 p-6 flex-col gap-2 shrink-0">
            <h2 className="text-xl font-bold text-white mb-6 px-3 flex items-center gap-2 drop-shadow-md">Control Center</h2>
            <NavButton active={activeTab === 'general'} onClick={() => setActiveTab('general')} icon={<GearIcon className="w-5 h-5"/>} label="Preferences" />
            <NavButton active={activeTab === 'locations'} onClick={() => setActiveTab('locations')} icon={<MapPinIcon className="w-5 h-5"/>} label="Saved Locations" />
            <NavButton active={activeTab === 'account'} onClick={() => setActiveTab('account')} icon={<ServerIcon className="w-5 h-5"/>} label="System & Cloud" />
            <NavButton active={activeTab === 'vessel'} onClick={() => setActiveTab('vessel')} icon={<BoatIcon className="w-5 h-5"/>} label="Vessel Profile" />
            <NavButton active={activeTab === 'alerts'} onClick={() => setActiveTab('alerts')} icon={<BellIcon className="w-5 h-5"/>} label="Notifications" />
            <NavButton active={activeTab === 'scenery'} onClick={() => setActiveTab('scenery')} icon={<StarIcon className="w-5 h-5"/>} label="Aesthetics" />
        </div>

        <div className="md:hidden w-full border-b border-white/5 bg-slate-900/50 backdrop-blur-xl z-20 sticky top-0">
            <div className="flex overflow-x-auto p-4 gap-3 snap-x scrollbar-hide">
                <MobileNavTab active={activeTab === 'general'} onClick={() => setActiveTab('general')} icon={<GearIcon className="w-4 h-4"/>} label="Prefs" />
                <MobileNavTab active={activeTab === 'vessel'} onClick={() => setActiveTab('vessel')} icon={<BoatIcon className="w-4 h-4"/>} label="Vessel" />
                <MobileNavTab active={activeTab === 'locations'} onClick={() => setActiveTab('locations')} icon={<MapPinIcon className="w-4 h-4"/>} label="Locs" />
                <MobileNavTab active={activeTab === 'alerts'} onClick={() => setActiveTab('alerts')} icon={<BellIcon className="w-4 h-4"/>} label="Alerts" />
                <MobileNavTab active={activeTab === 'scenery'} onClick={() => setActiveTab('scenery')} icon={<StarIcon className="w-4 h-4"/>} label="Theme" />
            </div>
        </div>

        <div className="flex-1 flex flex-col h-full bg-transparent overflow-hidden">
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-10 pb-32">
                
                {activeTab === 'locations' && (
                    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                        <Section title="Saved Ports & Anchorages">
                            <div className="flex flex-col gap-2 p-2">
                                {(settings.savedLocations || []).map((loc, i) => (
                                    <div key={i} className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-xl group hover:bg-white/10 transition-colors">
                                        <div className="flex items-center gap-4 flex-1 cursor-pointer" onClick={() => onLocationSelect(loc)}>
                                            <div className="p-2 rounded-full bg-sky-500/20 text-sky-400"><MapPinIcon className="w-5 h-5" /></div>
                                            <span className="font-bold text-white text-sm">{loc}</span>
                                        </div>
                                        <button onClick={(e) => { e.stopPropagation(); onSave({ savedLocations: settings.savedLocations.filter(l => l !== loc) }); }} className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"><TrashIcon className="w-5 h-5" /></button>
                                    </div>
                                ))}
                            </div>
                        </Section>
                    </div>
                )}

                {activeTab === 'account' && (
                    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                        <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-white/10 rounded-3xl p-6 mb-8 shadow-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-32 bg-sky-500/10 rounded-full blur-3xl pointer-events-none -translate-y-1/2 translate-x-1/2"></div>
                            <div className="flex flex-col items-center gap-4 relative z-10 text-center">
                                <h3 className="text-lg font-bold text-white">Cloud Connection</h3>
                                <p className="text-sm text-gray-400 max-w-md">Connect your account to sync settings and unlock advanced features.</p>
                                {!user ? (
                                    <button onClick={() => setAuthOpen(true)} className="bg-sky-500 hover:bg-sky-400 text-white font-bold py-2 px-6 rounded-xl text-xs uppercase tracking-wider transition-all shadow-lg">
                                        Connect to Cloud
                                    </button>
                                ) : (
                                    <div className="flex flex-col gap-2 items-center">
                                        <span className="text-xs text-sky-400 font-mono">{user.email}</span>
                                        <button onClick={logout} className="text-xs text-gray-500 hover:text-white underline">Logout</button>
                                    </div>
                                )}
                            </div>
                        </div>

                        <Section title="System Health">
                            <div className="p-4 grid gap-2">
                                <StatusRow label="Gemini AI (Google)" isConnected={isGeminiConfigured()} details={getKeyPreview('GEMINI')} />
                                <StatusRow label="Stormglass Marine" status={sgStatus?.status} loading={sgStatus?.status === 'LOADING'} details={sgStatus?.message} />
                                <StatusRow label="Mapbox Charts" isConnected={isMapboxConfigured()} details={getKeyPreview('MAPBOX')} />
                                <StatusRow label="Open-Meteo Data" isConnected={true} details={isOpenMeteoConfigured() ? "COMMERCIAL" : "FREE TIER"} />
                                <StatusRow label="Supabase DB" isConnected={isSupabaseConfigured()} details={isSupabaseConfigured() ? "CONNECTED" : "DISCONNECTED"} />
                            </div>
                        </Section>
                    </div>
                )}

                {activeTab === 'general' && (
                    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                        <Section title="Location & Time">
                            <Row>
                                <div className="flex-1"><label className="text-sm text-white font-medium block">Default Port</label></div>
                                <div className="flex gap-2">
                                    <div className="relative"><input type="text" value={settings.defaultLocation || ''} onChange={(e) => onSave({ defaultLocation: e.target.value })} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm w-48" placeholder="City, Country"/></div>
                                    <button onClick={handleDetectLocation} className="p-2 bg-sky-500/20 text-sky-400 rounded-lg"><CompassIcon rotation={0} className="w-4 h-4"/></button>
                                </div>
                            </Row>
                        </Section>
                        
                        <Section title="Captain's Personality">
                            <div className="p-6">
                                <div className="flex justify-between items-center mb-4">
                                    <span className="text-sm text-white font-bold flex items-center gap-2"><QuoteIcon className="w-4 h-4 text-sky-400"/> AI Attitude</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0" 
                                    max="100" 
                                    value={settings.aiPersona ?? 50} 
                                    onChange={(e) => onSave({ aiPersona: parseInt(e.target.value) })}
                                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500"
                                />
                                <div className="flex justify-between mt-2 text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                                    <span>Teddy Bear</span>
                                    <span>Pro</span>
                                    <span>Salty</span>
                                    <span>Pirate</span>
                                </div>
                            </div>
                        </Section>

                        <Section title="Units">
                            <div className="grid grid-cols-2 gap-4 p-4">
                                {/* Speed */}
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Wind Speed</label>
                                    <select value={settings.units.speed} onChange={(e) => updateUnit('speed', e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                                        <option value="kts">Knots</option>
                                        <option value="mph">MPH</option>
                                        <option value="kmh">KM/H</option>
                                        <option value="mps">M/S</option>
                                    </select>
                                </div>
                                {/* Distance */}
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Distance</label>
                                    <select value={settings.units.distance} onChange={(e) => updateUnit('distance', e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                                        <option value="nm">Nautical Miles</option>
                                        <option value="mi">Miles</option>
                                        <option value="km">Kilometers</option>
                                    </select>
                                </div>
                                {/* Height (Waves/Tide) */}
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Height (Waves/Tide)</label>
                                    <select 
                                        value={settings.units.length} 
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            // FIX: Only pass updated units object, relying on context to merge with existing settings
                                            onSave({
                                                units: {
                                                    ...settings.units,
                                                    length: val as any,
                                                    tideHeight: val as any
                                                }
                                            });
                                        }} 
                                        className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                    >
                                        <option value="ft">Feet</option>
                                        <option value="m">Meters</option>
                                    </select>
                                </div>
                                {/* Temperature */}
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Temperature</label>
                                    <select value={settings.units.temp} onChange={(e) => updateUnit('temp', e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                                        <option value="C">Celsius</option>
                                        <option value="F">Fahrenheit</option>
                                    </select>
                                </div>
                                {/* Visibility */}
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Visibility</label>
                                    <select value={settings.units.visibility || 'nm'} onChange={(e) => updateUnit('visibility', e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                                        <option value="nm">Nautical Miles</option>
                                        <option value="mi">Miles</option>
                                        <option value="km">Kilometers</option>
                                    </select>
                                </div>
                                {/* Volume */}
                                <div>
                                    <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Liquid Volume</label>
                                    <select value={settings.units.volume || 'gal'} onChange={(e) => updateUnit('volume', e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                                        <option value="gal">Gallons</option>
                                        <option value="l">Liters</option>
                                    </select>
                                </div>
                            </div>
                        </Section>
                        <Section title="Danger Zone">
                            <div className="p-4"><button onClick={resetSettings} className="w-full py-3 bg-red-500/10 text-red-400 rounded-xl text-xs font-bold uppercase flex items-center justify-center gap-2"><TrashIcon className="w-4 h-4" /> Factory Reset</button></div>
                        </Section>
                    </div>
                )}

                {activeTab === 'vessel' && (
                    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                        <Section title="Vessel Configuration">
                            <Row>
                                <div><label className="text-sm text-white font-medium block">Vessel Type</label></div>
                                <div className="flex bg-black/40 p-1 rounded-lg border border-white/10">
                                    <button onClick={() => updateVessel('type', 'sail')} className={`px-4 py-2 rounded-md text-xs font-bold uppercase transition-all ${settings.vessel?.type === 'sail' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}>Sail</button>
                                    <button onClick={() => updateVessel('type', 'power')} className={`px-4 py-2 rounded-md text-xs font-bold uppercase transition-all ${settings.vessel?.type === 'power' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}>Power</button>
                                </div>
                            </Row>
                            <Row>
                                <div className="w-full">
                                    <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Vessel Name</label>
                                    <input type="text" value={settings.vessel?.name || ''} onChange={(e) => updateVessel('name', e.target.value)} placeholder="e.g. Black Pearl" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none text-sm font-medium" />
                                </div>
                            </Row>
                            <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
                                <MetricInput label="Length" valInStandard={settings.vessel?.length || 0} unitType={settings.vesselUnits?.length || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v: any) => updateVessel('length', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, length: u} as any })} placeholder="30" isEstimated={settings.vessel?.estimatedFields?.includes('length')} />
                                <MetricInput label="Beam" valInStandard={settings.vessel?.beam || 0} unitType={settings.vesselUnits?.beam || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v: any) => updateVessel('beam', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, beam: u} as any })} placeholder="10" isEstimated={settings.vessel?.estimatedFields?.includes('beam')} />
                                <MetricInput label="Draft" valInStandard={settings.vessel?.draft || 0} unitType={settings.vesselUnits?.draft || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v: any) => updateVessel('draft', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, draft: u} as any })} placeholder="5" isEstimated={settings.vessel?.estimatedFields?.includes('draft')} />
                                <MetricInput label="Displacement" valInStandard={settings.vessel?.displacement || 0} unitType={settings.vesselUnits?.displacement || 'lbs'} unitOptions={['lbs', 'kg', 'tonnes']} onChangeValue={(v: any) => updateVessel('displacement', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, displacement: u} as any })} placeholder="10000" isEstimated={settings.vessel?.estimatedFields?.includes('displacement')} />
                                <MetricInput label="Cruising Speed" valInStandard={settings.vessel?.cruisingSpeed || 0} unitType={settings.units.speed || 'kts'} unitOptions={['kts', 'mph', 'kmh']} onChangeValue={(v: any) => updateVessel('cruisingSpeed', v)} onChangeUnit={(u: any) => onSave({ units: {...settings.units, speed: u} as any })} placeholder="6" />
                                <MetricInput label="Max Wave Height" valInStandard={settings.vessel?.maxWaveHeight || 0} unitType={settings.vesselUnits?.length || 'ft'} unitOptions={['ft', 'm']} onChangeValue={(v: any) => updateVessel('maxWaveHeight', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, length: u} as any })} placeholder="10" />
                                <MetricInput label="Fuel Cap." valInStandard={settings.vessel?.fuelCapacity || 0} unitType={settings.vesselUnits?.volume || 'gal'} unitOptions={['gal', 'l']} onChangeValue={(v: any) => updateVessel('fuelCapacity', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, volume: u} as any })} placeholder="0" />
                                <MetricInput label="Water Cap." valInStandard={settings.vessel?.waterCapacity || 0} unitType={settings.vesselUnits?.volume || 'gal'} unitOptions={['gal', 'l']} onChangeValue={(v: any) => updateVessel('waterCapacity', v)} onChangeUnit={(u: any) => onSave({ vesselUnits: {...settings.vesselUnits, volume: u} as any })} placeholder="0" />
                            </div>
                        </Section>
                    </div>
                )}

                {activeTab === 'alerts' && (
                    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                        <Section title="Thresholds">
                            {/* 1. High Wind */}
                            <Row onClick={() => updateAlert('wind', 'enabled', !settings.notifications.wind.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-purple-500/20 text-purple-300 rounded-lg"><WindIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">High Wind</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Sustained Forecast</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <input type="number" value={settings.notifications.wind.threshold} onChange={(e) => updateAlert('wind', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">kts</span>
                                    </div>
                                    <Toggle checked={settings.notifications.wind.enabled} onChange={(v) => updateAlert('wind', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 2. Gusts */}
                            <Row onClick={() => updateAlert('gusts', 'enabled', !settings.notifications.gusts.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-orange-500/20 text-orange-300 rounded-lg"><WindIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">Gusts</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Peak Gust Forecast</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <input type="number" value={settings.notifications.gusts.threshold} onChange={(e) => updateAlert('gusts', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">kts</span>
                                    </div>
                                    <Toggle checked={settings.notifications.gusts.enabled} onChange={(v) => updateAlert('gusts', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 3. High Seas */}
                            <Row onClick={() => updateAlert('waves', 'enabled', !settings.notifications.waves.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-blue-500/20 text-blue-300 rounded-lg"><WaveIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">High Seas</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Significant Wave Hgt</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <input type="number" value={settings.notifications.waves.threshold} onChange={(e) => updateAlert('waves', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">ft</span>
                                    </div>
                                    <Toggle checked={settings.notifications.waves.enabled} onChange={(v) => updateAlert('waves', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 4. Long Period (Swell) */}
                            <Row onClick={() => updateAlert('swellPeriod', 'enabled', !settings.notifications.swellPeriod.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-indigo-500/20 text-indigo-300 rounded-lg"><WaveIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">Long Period</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Swell Interval</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <input type="number" value={settings.notifications.swellPeriod.threshold} onChange={(e) => updateAlert('swellPeriod', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">s</span>
                                    </div>
                                    <Toggle checked={settings.notifications.swellPeriod.enabled} onChange={(v) => updateAlert('swellPeriod', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 5. Low Vis */}
                            <Row onClick={() => updateAlert('visibility', 'enabled', !settings.notifications.visibility.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-gray-500/20 text-gray-300 rounded-lg"><EyeIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">Low Vis</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Fog / Mist</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <span className="text-xs text-gray-500 mr-1">&lt;</span>
                                        <input type="number" value={settings.notifications.visibility.threshold} onChange={(e) => updateAlert('visibility', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">nm</span>
                                    </div>
                                    <Toggle checked={settings.notifications.visibility.enabled} onChange={(v) => updateAlert('visibility', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 6. High UV */}
                            <Row onClick={() => updateAlert('uv', 'enabled', !settings.notifications.uv.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-yellow-500/20 text-yellow-300 rounded-lg"><SunIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">High UV</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Sun Intensity</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <input type="number" value={settings.notifications.uv.threshold} onChange={(e) => updateAlert('uv', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">idx</span>
                                    </div>
                                    <Toggle checked={settings.notifications.uv.enabled} onChange={(v) => updateAlert('uv', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 7. Heat Alert */}
                            <Row onClick={() => updateAlert('tempHigh', 'enabled', !settings.notifications.tempHigh.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-red-500/20 text-red-300 rounded-lg"><ThermometerIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">Heat Alert</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">High Temp</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <input type="number" value={settings.notifications.tempHigh.threshold} onChange={(e) => updateAlert('tempHigh', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">°</span>
                                    </div>
                                    <Toggle checked={settings.notifications.tempHigh.enabled} onChange={(v) => updateAlert('tempHigh', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 8. Freeze Alert */}
                            <Row onClick={() => updateAlert('tempLow', 'enabled', !settings.notifications.tempLow.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-cyan-500/20 text-cyan-300 rounded-lg"><ThermometerIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">Freeze Alert</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Low Temp</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-lg border border-white/10" onClick={e => e.stopPropagation()}>
                                        <span className="text-xs text-gray-500 mr-1">&lt;</span>
                                        <input type="number" value={settings.notifications.tempLow.threshold} onChange={(e) => updateAlert('tempLow', 'threshold', Number(e.target.value))} className="w-12 bg-transparent text-white text-right outline-none font-bold" />
                                        <span className="text-xs text-gray-500">°</span>
                                    </div>
                                    <Toggle checked={settings.notifications.tempLow.enabled} onChange={(v) => updateAlert('tempLow', 'enabled', v)} />
                                </div>
                            </Row>

                            {/* 9. Precipitation */}
                            <Row onClick={() => updateAlert('precipitation', 'enabled', !settings.notifications.precipitation.enabled)}>
                                <div className="flex items-center gap-4">
                                    <div className="p-2 bg-blue-500/20 text-blue-300 rounded-lg"><RainIcon className="w-6 h-6"/></div>
                                    <div>
                                        <p className="text-white font-bold">Precipitation</p>
                                        <p className="text-[10px] text-gray-500 uppercase tracking-wide">Notify on rain/storm forecast</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <Toggle checked={settings.notifications.precipitation.enabled} onChange={(v) => updateAlert('precipitation', 'enabled', v)} />
                                </div>
                            </Row>
                        </Section>
                    </div>
                )}

                {/* RESTORED AESTHETICS TAB */}
                {activeTab === 'scenery' && (
                    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                        <Section title="Visual Preferences">
                            <Row>
                                <div className="flex-1">
                                    <label className="text-sm text-white font-medium block">Display Mode</label>
                                    <p className="text-xs text-gray-500">Manage contrast and night vision</p>
                                </div>
                                <select 
                                    value={settings.displayMode} 
                                    onChange={(e) => onSave({ displayMode: e.target.value as any })}
                                    className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm outline-none focus:border-sky-500"
                                >
                                    <option value="auto">Auto (Time based)</option>
                                    <option value="night">Night Vision (Red)</option>
                                    <option value="high-contrast">High Contrast</option>
                                </select>
                            </Row>
                        </Section>

                        <Section title="Dashboard Layout">
                            <div className="p-4 space-y-6">
                                <div>
                                    <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Hero Widgets (Top Row) <span className="text-[9px] text-sky-400 ml-2">(MAX 3)</span></h4>
                                    <div className="grid grid-cols-2 gap-2">
                                        {ALL_HERO_WIDGETS.map(w => {
                                            const current = settings.heroWidgets || [];
                                            const isActive = current.includes(w.id);
                                            const isMaxed = current.length >= 3;
                                            const disabled = !isActive && isMaxed;

                                            return (
                                                <button 
                                                    key={w.id}
                                                    disabled={disabled}
                                                    onClick={() => {
                                                        const newWidgets = isActive 
                                                            ? current.filter(id => id !== w.id)
                                                            : [...current, w.id];
                                                        onSave({ heroWidgets: newWidgets });
                                                    }}
                                                    className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${isActive ? 'bg-sky-500/10 border-sky-500/50 text-white' : 'bg-white/5 border-transparent text-gray-500 hover:bg-white/10'} ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
                                                >
                                                    <div className={isActive ? 'text-sky-400' : 'text-gray-600'}>{w.icon}</div>
                                                    <span className="text-xs font-bold">{w.label}</span>
                                                    {isActive && <CheckIcon className="w-3 h-3 ml-auto text-sky-500" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div>
                                    <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Detail Widgets (Grid)</h4>
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                        {ALL_DETAIL_WIDGETS.map(w => {
                                            const isActive = settings.detailsWidgets?.includes(w.id);
                                            return (
                                                <button 
                                                    key={w.id}
                                                    onClick={() => {
                                                        const current = settings.detailsWidgets || [];
                                                        const newWidgets = isActive 
                                                            ? current.filter(id => id !== w.id)
                                                            : [...current, w.id];
                                                        onSave({ detailsWidgets: newWidgets });
                                                    }}
                                                    className={`flex items-center gap-2 p-2 rounded-lg border transition-all text-left ${isActive ? 'bg-indigo-500/10 border-indigo-500/50 text-white' : 'bg-white/5 border-transparent text-gray-500 hover:bg-white/10'}`}
                                                >
                                                    <div className={`scale-75 ${isActive ? 'text-indigo-400' : 'text-gray-600'}`}>{w.icon}</div>
                                                    <span className="text-[10px] font-bold truncate">{w.label}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        </Section>
                    </div>
                )}
            </div>
        </div>
    </div>
  );
};
