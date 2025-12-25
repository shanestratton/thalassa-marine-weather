
import React, { useState, useEffect } from 'react';
import { WindIcon, WaveIcon, RadioTowerIcon, CompassIcon, DropletIcon, GaugeIcon, ArrowUpIcon, ArrowDownIcon, MinusIcon, CloudIcon, MapIcon, RainIcon, SunIcon, EyeIcon, ClockIcon, GripIcon } from '../Icons';
import { UnitPreferences, WeatherMetrics, ForecastDay, VesselProfile } from '../../types';
import { convertTemp, convertSpeed, convertLength, convertPrecip, calculateApparentTemp, convertDistance } from '../../utils';
import { useThalassa } from '../../context/ThalassaContext';
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor, TouchSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const WIDGET_CARD_CLASS = "flex-1 min-w-[32%] md:min-w-[30%] bg-black/20 hover:bg-black/30 border border-white/5 rounded-xl p-2 md:p-4 transition-colors relative group select-none flex flex-col justify-center min-h-[90px] md:min-h-[110px] snap-center shrink-0";
const GRIP_CLASS = "absolute top-1 right-1 md:top-2 md:right-2 p-1 md:p-1.5 text-white/10 hover:text-white/60 hover:bg-white/5 rounded-lg cursor-grab active:cursor-grabbing transition-colors";

const Countdown = ({ targetTime }: { targetTime: number | null }) => {
    const [timeLeft, setTimeLeft] = useState("Updating...");

    useEffect(() => {
        if (!targetTime) return;
        const interval = setInterval(() => {
            const now = Date.now();
            const diff = targetTime - now;
            
            if (diff <= 0) {
                setTimeLeft("Now");
            } else {
                const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const secs = Math.floor((diff % (1000 * 60)) / 1000);
                setTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, [targetTime]);

    if (!targetTime) return null;
    return <span>{timeLeft}</span>;
};

// --- SORTABLE CARD COMPONENT ---
const SortableHeroWidget: React.FC<{ id: string, children: React.ReactNode }> = ({ id, children }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 50 : 1,
        position: 'relative' as 'relative',
    };

    return (
        <div ref={setNodeRef} style={style} className={WIDGET_CARD_CLASS}>
            {/* Grab Handle */}
            <div {...attributes} {...listeners} className={GRIP_CLASS}>
                <GripIcon className="w-3 h-3 md:w-4 md:h-4" />
            </div>
            {children}
        </div>
    );
};

export const HeroSection = ({ 
    current, 
    todayForecast, 
    units, 
    generatedAt, 
    vessel, 
    modelUsed, 
    groundingSource, 
    isLandlocked, 
    locationName,
    nextUpdate 
}: { 
    current: WeatherMetrics, 
    todayForecast: ForecastDay | null, 
    units: UnitPreferences, 
    generatedAt: string, 
    vessel?: VesselProfile, 
    modelUsed?: string, 
    groundingSource?: string, 
    isLandlocked?: boolean, 
    locationName?: string,
    nextUpdate?: number | null
}) => {
    const { settings, updateSettings } = useThalassa();
    // Enforce max 3 widgets display regardless of setting array length
    const heroWidgets = (settings.heroWidgets || ['wind', 'wave', 'pressure']).slice(0, 3);

    // DnD Sensors
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } })
    );

    const handleDragEnd = (event: any) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            const oldIndex = heroWidgets.indexOf(active.id);
            const newIndex = heroWidgets.indexOf(over.id);
            const newOrder = arrayMove(heroWidgets, oldIndex, newIndex);
            updateSettings({ heroWidgets: newOrder });
        }
    };

    const rawGust = current.windGust || ((current.windSpeed || 0) * 1.3);
    const hasWind = current.windSpeed !== null && current.windSpeed !== undefined;
    const hasWave = current.waveHeight !== null && current.waveHeight !== undefined;
    
    const sourceString = groundingSource || modelUsed || "Init";
    const isSensorLocked = sourceString.toLowerCase().includes('station:') || sourceString.toLowerCase().includes('buoy') || sourceString.toLowerCase().includes('sensor');
    // Shorten source name for mobile
    let displaySource = modelUsed?.replace("Free", "").replace(/\(Fallback.*\)/, "").trim() || "LIVE";
    if (displaySource.includes("Stormglass")) displaySource = "SG Pro";
    if (displaySource.includes("Open-Meteo")) displaySource = "OM AI";
    if (displaySource.includes("NOAA")) displaySource = "NOAA";
    
    // --- LOCATION CONTEXT LOGIC (Left Badge) ---
    let statusBadgeLabel = "OFFSHORE";
    let statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30"; 

    if (isLandlocked) {
        statusBadgeLabel = "INLAND";
        statusBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30"; 
    } else {
        const isCoordinates = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(locationName || "");
        const isStation = (locationName || "").toLowerCase().includes('station') || (locationName || "").toLowerCase().includes('buoy');
        
        if (!isCoordinates && !isStation && locationName && locationName.length > 0) {
            statusBadgeLabel = "COASTAL";
            statusBadgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
        }
    }

    // --- SOURCE & TIMER BADGE LOGIC (Right Badges) ---
    let sourceBadgeColor = "bg-indigo-500/20 text-indigo-300 border-indigo-500/30"; 
    if (isSensorLocked) {
        sourceBadgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    } else if (displaySource.includes("OM")) {
        sourceBadgeColor = "bg-slate-600/20 text-slate-300 border-slate-500/30";
    }

    const timerBadgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/30";

    const displayValues = {
        airTemp: current.airTemperature !== null ? convertTemp(current.airTemperature, units.temp) : '--',
        highTemp: todayForecast ? convertTemp(todayForecast.highTemp, units.temp) : '--',
        lowTemp: todayForecast ? convertTemp(todayForecast.lowTemp, units.temp) : '--',
        windSpeed: hasWind ? convertSpeed(current.windSpeed, units.speed) : '--',
        waveHeight: isLandlocked ? "0" : (hasWave ? convertLength(current.waveHeight, units.length) : '--'),
        humidity: current.humidity !== null && current.humidity !== undefined ? Math.round(current.humidity) : '--',
        visibility: current.visibility ? convertDistance(current.visibility, units.visibility || 'nm') : '--',
        gusts: hasWind ? convertSpeed(rawGust, units.speed) : '--',
        precip: convertPrecip(current.precipitation, units.temp),
        pressure: current.pressure ? Math.round(current.pressure) : '--',
        cloudCover: (current.cloudCover !== null && current.cloudCover !== undefined) ? Math.round(current.cloudCover) : '--',
        uv: current.uvIndex !== undefined ? Math.round(current.uvIndex) : '--',
    };

    const WidgetMap: Record<string, React.ReactNode> = {
        wind: (
            <div className="flex flex-col h-full justify-between">
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                    <WindIcon className="w-3 h-3 text-sky-400" />
                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-sky-200">Wind</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{displayValues.windSpeed}</span>
                    <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.speed}</span>
                </div>
                <div className="flex items-center gap-1 mt-auto pt-1">
                    <div className="flex items-center gap-1 bg-white/5 px-1 py-0.5 rounded text-[8px] md:text-[10px] font-mono text-sky-300 border border-white/5">
                        <CompassIcon rotation={current.windDegree || 0} className="w-2.5 h-2.5 md:w-3 md:h-3" />
                        {current.windDirection || 'VAR'}
                    </div>
                    {hasWind && (
                        <span className="text-[8px] md:text-[10px] text-orange-300 font-bold ml-auto hidden md:inline">
                            G {displayValues.gusts}
                        </span>
                    )}
                </div>
            </div>
        ),
        wave: (
            <div className="flex flex-col h-full justify-between">
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                    <WaveIcon className="w-3 h-3 text-blue-400" />
                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-blue-200">Seas</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{displayValues.waveHeight}</span>
                    <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.length}</span>
                </div>
                <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-blue-300 font-bold flex justify-between">
                    <span>{current.swellPeriod ? `${current.swellPeriod}s` : 'Calm'}</span>
                    {current.swellDirection && <span className="opacity-70 hidden md:inline">{current.swellDirection}</span>}
                </div>
            </div>
        ),
        pressure: (
            <div className="flex flex-col h-full justify-between">
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                    <GaugeIcon className="w-3 h-3 text-purple-400" />
                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-purple-200">Barometer</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl md:text-4xl font-black tracking-tighter text-white">{displayValues.pressure}</span>
                    <span className="text-[10px] md:text-xs font-medium text-gray-400">hPa</span>
                </div>
                <div className="flex items-center gap-1 mt-auto pt-1 text-[8px] md:text-[10px] font-medium text-gray-400">
                    {current.pressureTrend === 'rising' && <><ArrowUpIcon className="w-2.5 h-2.5 md:w-3 md:h-3 text-emerald-400" /> Rising</>}
                    {current.pressureTrend === 'falling' && <><ArrowDownIcon className="w-2.5 h-2.5 md:w-3 md:h-3 text-red-400" /> Falling</>}
                    {(current.pressureTrend === 'steady' || !current.pressureTrend) && <><MinusIcon className="w-2.5 h-2.5 md:w-3 md:h-3 text-gray-400" /> Steady</>}
                </div>
            </div>
        ),
        precip: (
            <div className="flex flex-col h-full justify-between">
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                    <RainIcon className="w-3 h-3 text-cyan-400" />
                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-cyan-200">Rain</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl md:text-4xl font-black tracking-tighter text-white">{displayValues.precip || '0'}</span>
                    <span className="text-[10px] md:text-xs font-medium text-gray-400">{units.length === 'ft' ? 'in' : 'mm'}</span>
                </div>
                <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-cyan-300 font-bold">
                    {current.precipitation ? 'Wet' : 'Dry'}
                </div>
            </div>
        ),
        uv: (
            <div className="flex flex-col h-full justify-between">
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                    <SunIcon className="w-3 h-3 text-orange-400" />
                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-orange-200">UV</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl md:text-4xl font-black tracking-tighter text-white">{displayValues.uv}</span>
                </div>
                <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-orange-300 font-bold">
                    {current.uvIndex && current.uvIndex > 5 ? 'High' : 'Low'}
                </div>
            </div>
        ),
        visibility: (
            <div className="flex flex-col h-full justify-between">
                <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                    <EyeIcon className="w-3 h-3 text-emerald-400" />
                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-emerald-200">Vis</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl md:text-4xl font-black tracking-tighter text-white">{displayValues.visibility}</span>
                    <span className="text-[10px] md:text-xs font-medium text-gray-400">{units.visibility || 'nm'}</span>
                </div>
                <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-gray-400 font-bold">
                    {current.visibility && current.visibility < 3 ? 'Low' : 'Clear'}
                </div>
            </div>
        )
    };

    return (
        <div className="relative overflow-hidden rounded-3xl bg-slate-900/60 border border-white/10 shadow-2xl p-6">
            {/* Background Texture */}
            <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-5 pointer-events-none"></div>
            
            {/* Top Bar: Compact Single Line Layout for Mobile */}
            <div className="flex flex-row justify-between items-center mb-6 relative z-10 gap-2">
                
                {/* Left: Status Badge */}
                <div className={`px-2 py-1 rounded-lg border text-[9px] font-bold uppercase tracking-widest ${statusBadgeColor} shadow-lg backdrop-blur-sm whitespace-nowrap`}>
                    {statusBadgeLabel}<span className="hidden sm:inline"> FORECAST</span>
                </div>

                {/* Right: Source & Countdown Group */}
                <div className="flex flex-nowrap items-center gap-1.5">
                    {/* API Source */}
                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[9px] font-bold uppercase tracking-widest ${sourceBadgeColor} shadow-lg backdrop-blur-sm whitespace-nowrap`}>
                        <RadioTowerIcon className="w-3 h-3" />
                        {displaySource}
                    </div>
                    {/* Countdown Timer */}
                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[9px] font-bold uppercase tracking-widest ${timerBadgeColor} shadow-lg backdrop-blur-sm font-mono whitespace-nowrap`}>
                        <ClockIcon className="w-3 h-3" />
                        {nextUpdate ? <Countdown targetTime={nextUpdate} /> : <span>LIVE</span>}
                    </div>
                </div>
            </div>

            {/* Main Content: Temp (Left) & Forecast Summary (Right) */}
            <div className="flex items-end justify-between mb-6 relative z-10 px-1 gap-4">
                <div className="flex items-start gap-4 shrink-0">
                    <span className="text-6xl md:text-7xl font-black tracking-tighter text-white drop-shadow-2xl">
                        {displayValues.airTemp}°
                    </span>
                    <div className="flex flex-col pt-3 md:pt-4">
                        <span className="text-lg text-sky-300 font-bold tracking-wide">{current.condition}</span>
                        
                        {/* New Feels Like & Cloud Cover */}
                        <div className="flex items-center gap-3 mt-1">
                             <span className="text-xs font-medium text-gray-300 flex items-center gap-1">
                                 Feels {convertTemp(current.feelsLike, units.temp)}°
                             </span>
                             <div className="flex items-center gap-1 text-[10px] font-bold text-gray-400 bg-white/10 px-1.5 py-0.5 rounded-full border border-white/5">
                                <CloudIcon className="w-3 h-3" />
                                <span>{displayValues.cloudCover}%</span>
                             </div>
                        </div>

                        {/* H/L */}
                        <div className="flex items-center gap-2 text-xs text-gray-500 font-medium mt-1">
                            <span>H: {displayValues.highTemp}°</span>
                            <span className="w-1 h-1 bg-gray-600 rounded-full"></span>
                            <span>L: {displayValues.lowTemp}°</span>
                        </div>
                    </div>
                </div>

                {/* One-Line Forecast Summary (Visible on sm+) */}
                <div className="flex-1 hidden sm:flex justify-end pb-2">
                    <p className="text-right text-sm md:text-base text-gray-300 font-medium leading-snug max-w-[250px] md:max-w-md line-clamp-2 md:line-clamp-1 opacity-90">
                        {current.description}
                    </p>
                </div>
            </div>

            {/* Reorderable Widgets Grid */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                {/* UPDATED: Improved flex container for mobile scrolling */}
                <div className="flex flex-row gap-2 md:gap-3 relative z-10 w-full mt-2 overflow-x-auto md:overflow-visible pb-2 md:pb-0 snap-x snap-mandatory scrollbar-hide">
                    <SortableContext items={heroWidgets} strategy={horizontalListSortingStrategy}>
                        {heroWidgets.map((id) => (
                            <SortableHeroWidget key={id} id={id}>
                                {WidgetMap[id] || WidgetMap['wind']}
                            </SortableHeroWidget>
                        ))}
                    </SortableContext>
                </div>
            </DndContext>
        </div>
    );
};
