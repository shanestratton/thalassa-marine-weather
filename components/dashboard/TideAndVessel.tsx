
import React, { useState, useEffect } from 'react';
import { Card } from './shared/Card';
import { PowerBoatIcon, SailBoatIcon, TideCurveIcon, SearchIcon, ArrowUpIcon, ArrowDownIcon, CloudIcon, GaugeIcon, ClockIcon, MoonIcon, SunIcon, EyeIcon } from '../Icons';
import { Tide, UnitPreferences, VesselProfile, WeatherMetrics, HourlyForecast, TidePoint } from '../../types';
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, CartesianGrid, ReferenceLine, ReferenceDot, LabelList, Tooltip } from 'recharts';
import { calculateMCR, calculateCSF, calculateDLR, calculateHullSpeed, convertDistance, convertLength } from '../../utils';

// --- MOON LOGIC ---
const getMoonPhaseData = (date: Date) => {
    const synodic = 29.53058867;
    const knownNewMoon = new Date('2000-01-06T12:24:01').getTime(); // UTC
    const diff = date.getTime() - knownNewMoon;
    const days = diff / (1000 * 60 * 60 * 24);
    
    // Normalize to 0-1 cycle
    let phaseRatio = (days % synodic) / synodic;
    if (phaseRatio < 0) phaseRatio += 1;

    let phaseName = '';
    // Approx phase windows
    if (phaseRatio < 0.03 || phaseRatio > 0.97) phaseName = 'New Moon';
    else if (phaseRatio < 0.22) phaseName = 'Waxing Crescent';
    else if (phaseRatio < 0.28) phaseName = 'First Quarter';
    else if (phaseRatio < 0.47) phaseName = 'Waxing Gibbous';
    else if (phaseRatio < 0.53) phaseName = 'Full Moon';
    else if (phaseRatio < 0.72) phaseName = 'Waning Gibbous';
    else if (phaseRatio < 0.78) phaseName = 'Last Quarter';
    else phaseName = 'Waning Crescent';

    // Illumination fraction (0 = New, 1 = Full)
    const illumination = 0.5 * (1 - Math.cos(phaseRatio * 2 * Math.PI));
    
    return { phaseName, illumination, phaseRatio };
};

const MoonVisual = ({ cloudCover }: { cloudCover: number }) => {
    const { phaseName, illumination, phaseRatio } = getMoonPhaseData(new Date());
    
    // SVG Path Generation for Moon Phase
    const generateMoonPath = (phase: number) => {
        const r = 40; 
        const cx = 50; 
        const cy = 50;
        const theta = phase * 2 * Math.PI;
        
        const isWaxing = phase <= 0.5;
        const rawRx = r * Math.cos(theta);
        const rx = Math.abs(rawRx);
        
        let d = '';
        if (isWaxing) {
            const sweep = rawRx > 0 ? 0 : 1;
            d = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${rx} ${r} 0 0 ${sweep} ${cx} ${cy - r}`;
        } else {
            const sweep = rawRx < 0 ? 0 : 1;
            d = `M ${cx} ${cy + r} A ${r} ${r} 0 0 1 ${cx} ${cy - r} A ${rx} ${r} 0 0 ${sweep} ${cx} ${cy + r}`;
        }
        
        return d;
    };

    const safeCloud = cloudCover || 0;
    const cloudOpacity = Math.min(safeCloud / 100 * 0.85, 0.9);

    return (
        <div className="flex items-center gap-3">
            <div className="relative w-12 h-12 rounded-full bg-[#0f172a] border border-white/20 overflow-hidden shadow-inner">
                <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
                    <circle cx="50" cy="50" r="40" fill="#1e293b" />
                    <path 
                        d={generateMoonPath(phaseRatio)} 
                        fill="#e2e8f0" 
                        className="transition-all duration-1000 ease-in-out"
                    />
                </svg>
                {/* Simple Cloud Overlay */}
                <div 
                    className="absolute inset-0 bg-slate-900 transition-all duration-1000 z-10 pointer-events-none mix-blend-overlay"
                    style={{ opacity: cloudOpacity }}
                ></div>
            </div>
            
            <div className="text-left leading-tight">
                <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-0.5">Lunar Phase</div>
                <div className="text-sm text-white font-bold tracking-wide whitespace-nowrap">{phaseName}</div>
                <div className="text-[10px] text-sky-400 font-mono">{(illumination * 100).toFixed(0)}% Illumination</div>
            </div>
        </div>
    );
};

const SolarArc = ({ sunrise, sunset, showTimes = true, size = 'normal' }: { sunrise: string, sunset: string, showTimes?: boolean, size?: 'normal' | 'large' }) => {
    // ... existing solar logic ...
    const parseTime = (tStr: string) => {
        if (!tStr || tStr === '--:--') return null;
        const parts = tStr.split(' ');
        if (parts.length < 2) return null;
        let [time, period] = parts;
        let [h, m] = time.split(':').map(Number);
        if (isNaN(h) || isNaN(m)) return null;
        if (period === 'PM' && h !== 12) h += 12;
        if (period === 'AM' && h === 12) h = 0;
        return h * 60 + m; 
    };

    const sr = parseTime(sunrise) || 360; 
    const ss = parseTime(sunset) || 1080; 
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();

    const dayLength = ss - sr;
    const progress = Math.min(Math.max((current - sr) / dayLength, 0), 1);
    
    // We only show the arc if it's daylight, otherwise show night state
    const isDay = current >= sr && current <= ss;
    
    // Calculate position on arc (0 to 180 degrees)
    const angle = 180 - (progress * 180);
    const rad = (angle * Math.PI) / 180;
    
    // SVG coords
    const r = 40; 
    const cx = 50;
    const cy = 50; // Bottom center of arc
    const x = cx + r * Math.cos(rad);
    const y = cy - r * Math.sin(rad);

    const heightClass = size === 'large' ? 'h-32' : 'h-12';

    return (
        <div className={`flex items-center gap-4 w-full ${size === 'large' ? 'flex-col justify-center' : ''}`}>
            {showTimes && size === 'normal' && (
                <div className="flex flex-col items-center">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Sunrise</span>
                    <span className="text-xs font-bold text-white flex items-center gap-1"><ArrowUpIcon className="w-3 h-3 text-orange-400"/> {sunrise}</span>
                </div>
            )}
            
            <div className={`flex-1 relative ${heightClass} flex justify-center items-end pb-1 w-full`}>
                <svg viewBox="0 0 100 50" className="w-full h-full overflow-visible">
                    {/* Horizon Line */}
                    <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="3 3" />
                    
                    {/* Arc Path */}
                    <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" strokeLinecap="round" />
                    
                    {/* Sun Indicator */}
                    {isDay && (
                        <circle cx={x} cy={y} r="5" fill="#fbbf24" filter="url(#sunGlow)" />
                    )}
                    
                    <defs>
                        <filter id="sunGlow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                            <feMerge>
                                <feMergeNode in="coloredBlur"/>
                                <feMergeNode in="SourceGraphic"/>
                            </feMerge>
                        </filter>
                    </defs>
                </svg>
            </div>

            {showTimes && size === 'normal' && (
                <div className="flex flex-col items-center">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Sunset</span>
                    <span className="text-xs font-bold text-white flex items-center gap-1">{sunset} <ArrowDownIcon className="w-3 h-3 text-orange-400"/></span>
                </div>
            )}
            
            {size === 'large' && (
                 <div className="flex justify-between w-full px-8 -mt-2">
                    <div className="flex flex-col items-start">
                        <span className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sunrise</span>
                        <span className="text-xl font-bold text-white flex items-center gap-1"><ArrowUpIcon className="w-4 h-4 text-orange-400"/> {sunrise}</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sunset</span>
                        <span className="text-xl font-bold text-white flex items-center gap-1">{sunset} <ArrowDownIcon className="w-4 h-4 text-orange-400"/></span>
                    </div>
                 </div>
            )}
        </div>
    );
};

export const TideGraph = ({ tides, unit, timeZone, hourlyTides, tideSeries, modelUsed, unitPref }: { tides: Tide[], unit: string, timeZone?: string, hourlyTides?: HourlyForecast[], tideSeries?: TidePoint[], modelUsed?: string, unitPref: UnitPreferences }) => {
    const [currentTime, setCurrentTime] = useState(new Date());

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000); 
        return () => clearInterval(timer);
    }, []);

    const getDecimalHour = (date: Date, tz?: string) => {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, 
                hour: 'numeric', 
                minute: 'numeric',
                hour12: false,
            }).formatToParts(date);
            const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
            const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
            return h + (m / 60);
        } catch {
            return date.getHours() + (date.getMinutes() / 60);
        }
    };

    const currentHour = getDecimalHour(new Date(), timeZone);
    const getHourFromMidnight = (dateStr: string) => {
        const d = new Date(dateStr);
        const now = new Date();
        const diffMs = d.getTime() - now.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        return currentHour + diffHours; 
    };

    // --- SMART DATA GENERATION ---
    const dataPoints: { time: number, height: number }[] = [];
    
    // Priority 1: Use hourlyTides from Dashboard if available (Consistency with metrics)
    if (hourlyTides && hourlyTides.length > 0 && hourlyTides[0].tideHeight !== undefined) {
        // Map next 24 hours
        hourlyTides.slice(0, 24).forEach((h, i) => {
            const t = currentHour + i;
            if (t <= 24 && h.tideHeight !== undefined) {
                // IMPORTANT: Apply conversion here to match dashboard unit preference
                const converted = convertLength(h.tideHeight, unitPref.tideHeight || 'm');
                dataPoints.push({ 
                    time: t, 
                    height: converted || 0 
                });
            } else if (h.tideHeight !== undefined && t > 24) {
                // Wrap for visual continuity if needed (not strictly needed for x-axis 0-24)
            }
        });
    }

    // Priority 2: Use TideSeries (Sea Level API) if Hourly didn't cover enough
    if (dataPoints.length < 12 && tideSeries && tideSeries.length > 0) {
        // Clear and rebuild from full series if hourly was insufficient
        dataPoints.length = 0; 
        tideSeries.forEach(p => {
            const h = getHourFromMidnight(p.time); 
            if (h >= -2 && h <= 26) { 
                const converted = convertLength(p.height, unitPref.tideHeight || 'm');
                dataPoints.push({ time: Math.max(0, Math.min(24, h)), height: converted || 0 });
            }
        });
    } 
    
    // Priority 3: Fallback Interpolation from Extremes
    if (dataPoints.length < 5 && tides && tides.length > 0) {
        // Clear any partial points
        dataPoints.length = 0;
        
        const sortedTides = [...tides].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        
        for (let t = 0; t <= 24; t += 0.5) { // 30min resolution
            let h = 0;
            let t1 = -999;
            let t2 = 999;
            let h1 = 0;
            let h2 = 0;

            for (let i = 0; i < sortedTides.length - 1; i++) {
                const timeA = getHourFromMidnight(sortedTides[i].time);
                const timeB = getHourFromMidnight(sortedTides[i+1].time);
                
                if (t >= timeA && t <= timeB) {
                    t1 = timeA;
                    t2 = timeB;
                    h1 = convertLength(sortedTides[i].height, unitPref.tideHeight || 'm') || 0;
                    h2 = convertLength(sortedTides[i+1].height, unitPref.tideHeight || 'm') || 0;
                    break;
                }
            }

            if (t1 !== -999) {
                const phase = Math.PI * (t - t1) / (t2 - t1);
                const amp = (h1 - h2) / 2;
                const mid = (h1 + h2) / 2;
                h = mid + amp * Math.cos(phase);
            } else {
                const nearest = sortedTides.reduce((prev, curr) => {
                    const timeC = getHourFromMidnight(curr.time);
                    const timeP = getHourFromMidnight(prev.time);
                    return Math.abs(timeC - t) < Math.abs(timeP - t) ? curr : prev;
                });
                h = convertLength(nearest.height, unitPref.tideHeight || 'm') || 0;
            }
            dataPoints.push({ time: t, height: h });
        }
    }

    // --- MARKERS FOR HIGH / LOW ---
    const markers = tides ? tides.map(t => {
        const time = getHourFromMidnight(t.time);
        if (time >= 0 && time <= 24) {
            return { 
                time, 
                height: convertLength(t.height, unitPref.tideHeight || 'm') || 0, 
                type: t.type, 
                labelTime: new Date(t.time).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) 
            };
        }
        return null;
    }).filter(Boolean) as { time: number, height: number, type: 'High'|'Low', labelTime: string }[] : [];

    if (dataPoints.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full opacity-60">
                <GaugeIcon className="w-8 h-8 text-gray-600 mb-2" />
                <span className="text-[10px] uppercase font-bold text-gray-500 tracking-widest">Awaiting Telemetry</span>
            </div>
        );
    }

    // Sort dataPoints by time to ensure Recharts renders correctly
    dataPoints.sort((a, b) => a.time - b.time);

    let closestPoint = dataPoints.reduce((prev, curr) => 
        Math.abs(curr.time - currentHour) < Math.abs(prev.time - currentHour) ? curr : prev
    );
    const currentHeight = closestPoint?.height ?? 0;
    
    // Find next event
    const nextEvent = markers.find(m => m.time > currentHour);
    
    // Trend Logic
    const nextHourVal = dataPoints.find(p => p.time > currentHour + 0.5 && p.time < currentHour + 1.5)?.height;
    const isRising = nextHourVal !== undefined ? nextHourVal > currentHeight : false;
    const TrendIcon = isRising ? ArrowUpIcon : ArrowDownIcon;
    const trendColor = isRising ? "text-emerald-400" : "text-red-400";

    let minHeight = Math.min(...dataPoints.map(d => d.height), ...markers.map(m => m.height));
    let maxHeight = Math.max(...dataPoints.map(d => d.height), ...markers.map(m => m.height));
    
    if (minHeight === maxHeight) {
        minHeight -= 0.5;
        maxHeight += 0.5;
    }
    const domainBuffer = (maxHeight - minHeight) * 0.2;

    const Tick = ({ x, y, payload }: any) => {
        const val = payload.value;
        const hr = Math.floor(val);
        const displayHr = hr % 12 || 12;
        const isKeyTime = hr === 0 || hr === 6 || hr === 12 || hr === 18 || hr === 24;
        
        return (
            <g transform={`translate(${x},${y})`}>
                <text x={0} y={0} dy={16} textAnchor="middle" fill="#cbd5e1" fontSize={9} fontWeight={600} fontFamily="monospace" opacity={isKeyTime ? 0.8 : 0}>
                    {displayHr}
                </text>
            </g>
        );
    };

    return (
        <div className="flex flex-col h-full relative group">
            {/* INTUITIVE HEADER OVERLAYS */}
            <div className="absolute top-0 left-0 right-0 z-20 flex justify-between items-start pointer-events-none">
                {/* Current Status Box */}
                <div className="bg-slate-900/80 backdrop-blur-md rounded-xl p-2.5 border border-white/10 shadow-xl flex flex-col items-start pointer-events-auto">
                    <span className="text-[9px] text-gray-400 uppercase font-bold tracking-widest mb-0.5 flex items-center gap-1">
                        Current Level
                    </span>
                    <div className={`flex items-baseline gap-1.5 ${trendColor}`}>
                        <span className="text-2xl font-black tracking-tight">{currentHeight.toFixed(1)}</span>
                        <span className="text-xs font-bold">{unit}</span>
                        <TrendIcon className="w-4 h-4 translate-y-0.5" />
                    </div>
                </div>

                {/* Next Event Box */}
                {nextEvent && (
                    <div className="bg-slate-900/80 backdrop-blur-md rounded-xl p-2.5 border border-white/10 shadow-xl flex flex-col items-end pointer-events-auto">
                        <span className="text-[9px] text-gray-400 uppercase font-bold tracking-widest mb-0.5 flex items-center gap-1">
                            Next {nextEvent.type === 'High' ? 'High' : 'Low'}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-2xl font-bold text-white tracking-tight">{nextEvent.labelTime.replace(/ [AP]M/, '')}</span>
                            <span className="text-xs text-gray-500 font-bold self-end mb-1">{nextEvent.labelTime.includes('PM') ? 'PM' : 'AM'}</span>
                        </div>
                        <span className="text-[10px] text-sky-400 font-mono font-bold">{nextEvent.height.toFixed(1)} {unit} Target</span>
                    </div>
                )}
            </div>

            {/* CHART AREA - FIXED: Absolute Position to prevent 0-height flex collapse */}
            <div className="flex-1 w-full relative overflow-hidden rounded-xl bg-slate-950 border border-white/5 shadow-inner min-h-[160px]">
                {/* Deep Background Image */}
                <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1551244072-5d12893278ab?q=80&w=1932&auto=format&fit=crop')] bg-cover bg-center opacity-40 mix-blend-overlay pointer-events-none"></div>
                <div className="absolute inset-0 bg-gradient-to-t from-sky-900/20 to-transparent pointer-events-none"></div>

                <div className="absolute inset-0">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                        <AreaChart data={dataPoints} margin={{top: 40, right: 0, left: 0, bottom: 0}}>
                            <defs>
                                {/* Water Pattern Fill */}
                                <pattern id="waterPattern" patternUnits="userSpaceOnUse" width="100" height="100" viewBox="0 0 100 100">
                                    <image href="https://images.unsplash.com/photo-1505118380757-91f5f5632de0?q=80&w=2071&auto=format&fit=crop" x="0" y="0" width="300" height="300" preserveAspectRatio="xMidYMid slice" opacity="0.5"/>
                                </pattern>
                                <linearGradient id="deepWater" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.8}/>
                                    <stop offset="100%" stopColor="#0284c7" stopOpacity={0.4}/>
                                </linearGradient>
                                <filter id="waveShadow" height="130%">
                                    <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.5"/>
                                </filter>
                            </defs>
                            
                            <XAxis 
                                dataKey="time" 
                                type="number" 
                                domain={[0, 24]} 
                                ticks={[0, 6, 12, 18, 24]}
                                tick={<Tick />}
                                axisLine={false}
                                hide={false}
                                interval={0}
                            />
                            <YAxis hide domain={[minHeight - domainBuffer, maxHeight + domainBuffer]} />
                            
                            {/* The Water Volume */}
                            <Area 
                                type="monotone" 
                                dataKey="height" 
                                stroke="#38bdf8" 
                                strokeWidth={3} 
                                fill="url(#deepWater)" 
                                filter="url(#waveShadow)"
                                animationDuration={1500}
                            />
                            
                            {/* Current Time Indicator */}
                            <ReferenceLine x={currentHour} stroke="rgba(255,255,255,0.5)" strokeWidth={1} strokeDasharray="3 3" />
                            <ReferenceDot 
                                x={currentHour} 
                                y={currentHeight} 
                                r={5} 
                                fill="#facc15" 
                                stroke="#fff" 
                                strokeWidth={2}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
};

export const VesselStatusWidget = ({ vessel, current, vesselStatus, statusStyles, tides, hourlyTides, tideHourly, units, timeZone, modelUsed, isLandlocked }: { vessel: VesselProfile, current: WeatherMetrics, vesselStatus: any, statusStyles: any, tides: Tide[], hourlyTides: HourlyForecast[], tideHourly?: TidePoint[], units: UnitPreferences, timeZone?: string, modelUsed?: string, isLandlocked?: boolean }) => {
    
    // --- MARINE CALCULATIONS ---
    const hullSpeed = vessel && vessel.type !== 'observer' ? calculateHullSpeed(vessel.length) : null;
    const mcr = vessel && vessel.type === 'sail' ? calculateMCR(vessel.displacement, vessel.length, vessel.beam) : null;
    const csf = vessel && vessel.type === 'sail' ? calculateCSF(vessel.displacement, vessel.beam) : null;
    const dlr = vessel && vessel.type === 'sail' ? calculateDLR(vessel.displacement, vessel.length) : null;

    if (isLandlocked) {
        // --- INLAND VIEW (Solar Cycle & Atmosphere) ---
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Card 1: Solar Cycle (Replaces Tides) */}
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[300px] relative overflow-hidden gap-4">
                    <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                        <SunIcon className="w-5 h-5 text-orange-400" />
                        <h3 className="text-sm font-bold text-white uppercase tracking-widest">Solar Cycle</h3>
                    </div>
                    
                    <div className="flex-1 flex flex-col justify-center items-center py-4">
                        <SolarArc sunrise={current.sunrise || '06:00'} sunset={current.sunset || '18:00'} showTimes={true} size="large" />
                    </div>
                    
                    <div className="bg-white/5 rounded-xl p-3 border border-white/5 mt-auto">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-400 font-bold uppercase tracking-wider">Daylight Remaining</span>
                            <span className="text-white font-mono">{current.uvIndex > 0 ? "High Visibility" : "Night Mode"}</span>
                        </div>
                    </div>
                </Card>

                {/* Card 2: Lunar & Atmosphere (Replaces Vessel Physics) */}
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[300px]">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-indigo-300">
                            <MoonIcon className="w-5 h-5" />
                            <span className="text-sm font-bold uppercase tracking-widest">Lunar & Atmosphere</span>
                        </div>
                    </div>

                    <div className="flex flex-col gap-4 mt-2 h-full">
                        {/* Moon Section */}
                        <div className="bg-white/5 rounded-xl p-4 border border-white/5 flex items-center justify-between">
                            <MoonVisual cloudCover={current.cloudCover || 0} />
                        </div>

                        {/* Atmospherics Grid */}
                        <div className="grid grid-cols-2 gap-4 flex-1">
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1 flex items-center gap-1"><EyeIcon className="w-3 h-3"/> Visibility</span>
                                <span className="text-xl font-mono font-bold text-white">
                                    {current.visibility ? convertDistance(current.visibility, units.visibility || 'mi') : '--'} 
                                    <span className="text-xs text-gray-500 ml-1">{units.visibility || 'mi'}</span>
                                </span>
                            </div>
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1 flex items-center gap-1"><GaugeIcon className="w-3 h-3"/> Pressure</span>
                                <span className="text-xl font-mono font-bold text-white">
                                    {current.pressure ? Math.round(current.pressure) : '--'}
                                    <span className="text-xs text-gray-500 ml-1">hPa</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </Card>
            </div>
        );
    }

    // --- MARINE VIEW (Original) ---
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Card 1: Tides & Astro - REMOVED OLD HEADER for cleaner look with new overlays */}
            <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[300px] relative overflow-hidden gap-4">
                
                {/* Header: Moon & Phase */}
                <div className="flex justify-between items-start border-b border-white/5 pb-2">
                    <div className="flex items-center gap-2">
                        <TideCurveIcon className="w-5 h-5 text-sky-400" />
                        <h3 className="text-sm font-bold text-white uppercase tracking-widest">Tidal Cycle</h3>
                    </div>
                    {/* Explicitly Restored Moon Info */}
                    <MoonVisual cloudCover={current.cloudCover || 0} />
                </div>
                
                {/* Graph Area */}
                <div className="flex-1 w-full min-h-[160px] relative z-10">
                    <TideGraph tides={tides} unit={units.tideHeight || 'm'} timeZone={timeZone} hourlyTides={hourlyTides} tideSeries={tideHourly} modelUsed={modelUsed} unitPref={units} />
                </div>

                {/* Solar Arc Footer */}
                {current.sunrise && current.sunset && current.sunrise !== '--:--' && (
                    <div className="mt-1 pt-2 border-t border-white/5">
                        <SolarArc sunrise={current.sunrise} sunset={current.sunset} />
                    </div>
                )}
            </Card>

            {/* Card 2: Vessel Physics & Status */}
            {vessel && vessel.type !== 'observer' ? (
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[300px]">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-orange-300">
                            {vessel.type === 'power' ? <PowerBoatIcon className="w-5 h-5" /> : <SailBoatIcon className="w-5 h-5" />}
                            <span className="text-sm font-bold uppercase tracking-widest truncate max-w-[150px]">{vessel.name}</span>
                        </div>
                        <div className={`px-2 py-1 rounded border text-[10px] font-bold uppercase ${vesselStatus?.status === 'unsafe' ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'}`}>
                            {vesselStatus?.status === 'unsafe' ? 'Limits Exceeded' : 'Within Limits'}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                            <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Theoretical Hull Speed</span>
                            <span className="text-xl font-mono font-bold text-white">{hullSpeed?.toFixed(1)} <span className="text-xs text-gray-500">kts</span></span>
                        </div>
                        <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                            <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Displacement</span>
                            <span className="text-xl font-mono font-bold text-white">{(vessel.displacement / 2204.62).toFixed(1)} <span className="text-xs text-gray-500">t</span></span>
                        </div>
                        {vessel.type === 'sail' && (
                            <>
                                {mcr && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Motion Comfort</span>
                                        <span className={`text-xl font-mono font-bold ${mcr > 30 ? 'text-emerald-300' : mcr > 20 ? 'text-yellow-300' : 'text-orange-300'}`}>{Math.round(mcr)}</span>
                                    </div>
                                )}
                                {csf && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Capsize Risk</span>
                                        <span className={`text-xl font-mono font-bold ${csf < 2 ? 'text-emerald-300' : 'text-red-300'}`}>{csf.toFixed(2)}</span>
                                    </div>
                                )}
                                {dlr && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">D/L Ratio</span>
                                        <span className="text-xl font-mono font-bold text-white">{Math.round(dlr)}</span>
                                    </div>
                                )}
                                <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                    <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Rigging</span>
                                    <span className="text-sm font-bold text-sky-300 truncate block">{vessel.riggingType || 'Sloop'}</span>
                                </div>
                            </>
                        )}
                    </div>
                    
                    <div className="mt-3 text-[10px] text-gray-500 text-center">
                        Calculated based on {vessel.length}ft {vessel.type} profile
                    </div>
                </Card>
            ) : (
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-center items-center min-h-[300px] text-center">
                    <SearchIcon className="w-12 h-12 text-gray-600 mb-3" />
                    <h3 className="text-lg font-medium text-white mb-1">Observer Mode</h3>
                    <p className="text-xs text-gray-400 max-w-[200px]">Configure a vessel profile in settings to see hull speed, comfort ratios, and safety limits.</p>
                </Card>
            )}
        </div>
    );
};
