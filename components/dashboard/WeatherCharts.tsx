
import React from 'react';
import { Card } from './shared/Card';
import { WeatherIcon } from './shared/WeatherIcon';
import { ArrowRightIcon, LockIcon, WindIcon, WaveIcon, TideCurveIcon, SunIcon, CompassIcon, ArrowUpIcon, ArrowDownIcon, DropletIcon, MapIcon, GaugeIcon, ClockIcon, CalendarIcon } from '../Icons';
import { convertLength, convertSpeed, convertTemp, convertPrecip, calculateWindChill, getTideStatus, calculateDailyScore, getSailingScoreColor, getSailingConditionText } from '../../utils';
import { ForecastDay, HourlyForecast, UnitPreferences, VesselProfile } from '../../types';


export const HourlyWidget = ({ hourly, units, isLandlocked }: { hourly: HourlyForecast[], units: UnitPreferences, isLandlocked?: boolean }) => {
    const scrollContainerRef = React.useRef<HTMLDivElement>(null);
    return (
        <Card className="bg-slate-900/60 border border-white/10">
            <div className="space-y-3">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-sky-300 uppercase tracking-widest flex items-center gap-2">
                        <ClockIcon className="w-5 h-5 text-sky-400" />
                        Hourly Outlook
                    </h3>
                    <span className="text-[10px] text-gray-500 uppercase tracking-wide flex items-center gap-1">Swipe <ArrowRightIcon className="w-3 h-3 text-gray-400 animate-pulse" /></span>
                </div>
                <div ref={scrollContainerRef} className="w-full overflow-x-auto snap-x snap-mandatory custom-scrollbar pb-6 flex gap-4 touch-pan-x">
                    {hourly && hourly.map((item: HourlyForecast, idx: number) => {
                        const chill = item.feelsLike !== undefined ? item.feelsLike : calculateWindChill(item.temperature, item.windSpeed, units.temp);
                        const chillDisplay = chill ? convertTemp(chill, units.temp) : null;
                        const tempDisplay = convertTemp(item.temperature, units.temp);
                        const gustDisplay = item.windGust ? convertSpeed(item.windGust, units.speed) : convertSpeed(item.windSpeed * 1.2, units.speed);
                        const windSpeedDisplay = convertSpeed(item.windSpeed, units.speed);
                        const cloudCover = item.cloudCover;
                        const tideStatus = getTideStatus(idx, hourly);
                        const precipStr = convertPrecip(item.precipitation, units.temp);

                        // --- ADAPTIVE INLAND UI ---
                        let tideCell;
                        let waveCell;

                        if (isLandlocked) {
                            // Inland: Replaces Wave with Humidity
                            waveCell = (
                                <div className="bg-white/5 rounded-2xl p-3 border border-white/5 flex flex-col justify-between">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-[10px] uppercase text-gray-400 font-bold">Humidity</span>
                                        <DropletIcon className="w-3 h-3 text-blue-300 opacity-60" />
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                        <span className="text-xl font-bold text-blue-100">--</span>
                                        <span className="text-xs text-gray-500">%</span>
                                    </div>
                                    <div className="h-1 w-full bg-black/20 rounded-full mt-2 overflow-hidden">
                                        <div className="h-full bg-blue-400 opacity-50" style={{ width: '50%' }}></div>
                                    </div>
                                </div>
                            );

                            // Inland: Replaces Tide with Pressure (Placeholder or actual if available in hourly)
                            tideCell = (
                                <div className="bg-white/5 rounded-2xl p-3 border border-white/5 flex flex-col justify-between">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-[10px] uppercase text-gray-400 font-bold">Pressure</span>
                                        <GaugeIcon className="w-3 h-3 text-purple-300 opacity-60" />
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                        <span className="text-xl font-bold text-white">--</span>
                                        <span className="text-xs text-gray-500">hPa</span>
                                    </div>
                                    <div className="text-xs text-gray-500 font-medium mt-1">Steady</div>
                                </div>
                            );
                        } else {
                            // Marine: Wave
                            waveCell = (
                                <div className="bg-white/5 rounded-2xl p-3 border border-white/5 flex flex-col justify-between">
                                    <div className="flex justify-between items-center mb-1"><span className="text-[10px] uppercase text-gray-400 font-bold">Wave</span></div>
                                    <div className="flex items-baseline gap-1"><span className="text-xl font-bold text-white">{convertLength(item.waveHeight, units.length)}</span><span className="text-xs text-gray-500">{units.length}</span></div>
                                    <div className="text-xs text-blue-300 font-medium mt-1">{item.swellPeriod ? `${item.swellPeriod}s` : 'Choppy'}</div>
                                </div>
                            );

                            // Marine Tide
                            let tideIcon = null;
                            let tideLabel = "Tide Level";
                            let tideValueClass = "text-white";
                            let tideBg = "bg-white/5 border-white/5";

                            if (tideStatus === 'rising') {
                                tideIcon = <ArrowUpIcon className="w-3 h-3 text-emerald-400" />;
                                tideLabel = "Tide Level";
                                tideValueClass = "text-emerald-300";
                                tideBg = "bg-emerald-500/10 border-emerald-500/20";
                            } else if (tideStatus === 'falling') {
                                tideIcon = <ArrowDownIcon className="w-3 h-3 text-red-400" />;
                                tideLabel = "Tide Level";
                                tideValueClass = "text-red-300";
                                tideBg = "bg-red-500/10 border-red-500/20";
                            } else if (tideStatus === 'high') {
                                tideIcon = <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"></span>;
                                tideLabel = "High Tide";
                                tideValueClass = "text-sky-300";
                                tideBg = "bg-sky-500/20 border-sky-500/30 shadow-[0_0_10px_rgba(14,165,233,0.1)]";
                            } else if (tideStatus === 'low') {
                                tideIcon = <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse"></span>;
                                tideLabel = "Low Tide";
                                tideValueClass = "text-purple-300";
                                tideBg = "bg-purple-500/20 border-purple-500/30 shadow-[0_0_10px_rgba(192,132,252,0.1)]";
                            }

                            const tideVal = item.tideHeight !== undefined ? convertLength(item.tideHeight, units.tideHeight || 'm') : null;

                            tideCell = (
                                <div className={`rounded-2xl p-3 border flex flex-col justify-between ${tideBg}`}>
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-[10px] uppercase text-gray-400 font-bold">{tideLabel}</span>
                                        {tideIcon}
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                        <span className={`text-xl font-bold ${tideValueClass}`}>{tideVal !== null ? tideVal.toFixed(2) : '--'}</span>
                                        <span className="text-xs text-gray-500">{units.tideHeight || 'm'}</span>
                                    </div>
                                    <div className="h-1 w-full bg-black/20 rounded-full mt-2 overflow-hidden">
                                        <div className="h-full bg-current opacity-50" style={{ width: `${Math.min(((item.tideHeight || 0) / 3) * 100, 100)}%` }}></div>
                                    </div>
                                </div>
                            );
                        }

                        return (
                            <div key={idx} className="flex-none w-full sm:w-[calc(50%-0.5rem)] lg:w-[calc(33.333%-0.67rem)] snap-start bg-slate-900/80 rounded-3xl p-5 border border-white/10 hover:bg-slate-900 transition-colors shadow-lg">
                                <div className="flex justify-between items-center border-b border-white/5 pb-4 mb-4">
                                    <div className="flex flex-col"><span className="text-2xl font-bold text-white">{item.time}</span><span className="text-xs text-gray-400 uppercase tracking-widest truncate max-w-[100px]">{item.condition}</span></div>
                                    <div className="flex items-center gap-4">
                                        <div className="relative"><WeatherIcon condition={item.condition} cloudCover={cloudCover ?? undefined} className="w-10 h-10 text-sky-300" />{cloudCover !== undefined && cloudCover !== null && (<div className="absolute -top-2 -right-2 text-[8px] text-white font-bold bg-white/20 px-1.5 py-0.5 rounded-full backdrop-blur-sm">{cloudCover}%</div>)}</div>
                                        <div className="text-right"><p className={`text-3xl font-light ${item.isEstimated ? 'text-yellow-400' : 'text-white'}`}>{tempDisplay}°</p>{chillDisplay && (<p className="text-[10px] text-gray-400">Feels {chillDisplay}°</p>)}</div>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="bg-white/5 rounded-2xl p-3 border border-white/5 flex flex-col justify-between"><div className="flex justify-between items-center mb-1"><span className="text-[10px] uppercase text-gray-400 font-bold">Wind</span>{item.windDirection && <div className="flex items-center gap-1 text-[10px] text-sky-300"><CompassIcon rotation={item.windDegree || 0} className="w-3 h-3" /> {item.windDirection}</div>}</div><div className="flex items-baseline gap-1"><span className="text-xl font-bold text-white">{windSpeedDisplay}</span><span className="text-xs text-gray-500">{units.speed}</span></div><div className="text-xs text-orange-400 font-medium mt-1">Gusting {gustDisplay}</div></div>

                                    {waveCell}
                                    {tideCell}

                                    <div className="bg-white/5 rounded-2xl p-3 border border-white/5 flex flex-col justify-between"><div className="flex justify-between items-center mb-1"><span className="text-[10px] uppercase text-gray-400 font-bold">Precip</span></div><div className="flex items-center gap-2 mt-1">{precipStr ? (<><DropletIcon className="w-4 h-4 text-blue-400" /><span className="text-sm font-medium text-white">{precipStr}</span></>) : (<span className="text-xs text-gray-500 italic">None</span>)}</div></div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </Card>
    );
};

export const DailyWidget = ({ forecast, isPro, onTriggerUpgrade, units, vessel }: { forecast: ForecastDay[], isPro: boolean, onTriggerUpgrade: () => void, units: UnitPreferences, vessel?: VesselProfile }) => (
    <Card className="bg-slate-900/60 border border-white/10">
        <div className="space-y-4">
            <h3 className="text-sm font-bold text-sky-300 pl-2 border-b border-white/10 pb-2 flex items-center gap-2 uppercase tracking-widest">
                <CalendarIcon className="w-5 h-5 text-sky-400" />
                {forecast.length}-Day Forecast
                {!isPro && <LockIcon className="w-4 h-4 text-gray-500 ml-auto" />}
            </h3>
            <div className="space-y-4 relative">
                {forecast.map((day: ForecastDay, i: number) => {
                    // FREE TIER LIMIT: Lock days 4-10 (Index 3+)
                    const isLocked = !isPro && i > 2;

                    const dayGust = day.windGust ? convertSpeed(day.windGust, units.speed) : convertSpeed(day.windSpeed * 1.3, units.speed);
                    const dayWind = convertSpeed(day.windSpeed, units.speed);
                    const dayWave = convertLength(day.waveHeight, units.length);

                    // Use Vessel Specific Scoring
                    const score = calculateDailyScore(day.windSpeed, day.waveHeight, vessel);
                    const scoreClass = getSailingScoreColor(score);
                    const condText = getSailingConditionText(score);

                    const precipMm = day.precipitation || 0;
                    const hasTideData = day.tideSummary && day.tideSummary !== "N/A" && day.tideSummary !== "No Data";

                    const scoreLabel = vessel?.type === 'sail' ? 'Sailing Score' :
                        vessel?.type === 'power' ? 'Cruising Score' :
                            'Ocean State';

                    return (
                        <div key={i} className={`flex flex-col bg-slate-900/40 hover:bg-slate-900/60 border border-white/5 rounded-3xl p-5 gap-4 transition-all shadow-md ${isLocked ? 'blur-md opacity-30 pointer-events-none select-none grayscale' : ''}`}>

                            <div className="flex justify-between items-center border-b border-white/5 pb-3">
                                <div className="flex items-center gap-4">
                                    <WeatherIcon condition={day.condition} cloudCover={day.cloudCover} className="w-12 h-12 text-sky-300 drop-shadow-md" />
                                    <div>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-lg font-bold text-white">{day.day}</span>
                                            <span className="text-xs text-gray-400 uppercase tracking-wide">{day.date}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-sm">
                                            <span className="text-white font-medium">{convertTemp(day.highTemp, units.temp)}°</span>
                                            <span className="text-gray-500">/ {convertTemp(day.lowTemp, units.temp)}°</span>
                                            <span className="mx-1 text-gray-600">•</span>
                                            <span className="text-gray-300 capitalize">{day.condition}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className={`px-4 py-1.5 rounded-xl border flex flex-col items-center justify-center min-w-[90px] h-full ${scoreClass}`}>
                                    <span className="text-2xl font-black leading-none">{score}</span>
                                    <span className="text-[9px] font-bold uppercase tracking-wide leading-none mt-1 text-center">{scoreLabel}</span>
                                    <span className="text-[8px] uppercase tracking-wider opacity-80 mt-0.5 font-bold border-t border-current/20 pt-0.5 w-full text-center">{condText}</span>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">

                                <div className="bg-white/5 rounded-xl p-3 border border-white/5 relative overflow-hidden group flex flex-col justify-between">
                                    <div className="absolute top-0 right-0 p-1 opacity-20"><WindIcon className="w-12 h-12" /></div>
                                    <div className="flex justify-between items-center mb-1 relative z-10"><span className="text-[10px] text-gray-400 uppercase font-bold">Wind</span></div>
                                    <div className="flex items-baseline gap-1 relative z-10 mb-2"><span className="text-2xl font-bold text-white">{dayWind}</span><span className="text-xs text-gray-500">{units.speed}</span></div>
                                    <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all ${day.windSpeed > 20 ? 'bg-red-500' : day.windSpeed > 10 ? 'bg-emerald-400' : 'bg-blue-400'}`} style={{ width: `${Math.min(day.windSpeed * 3, 100)}%` }}></div></div>
                                    <div className="pt-2 border-t border-white/10 flex justify-between items-center"><span className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Gusts</span><span className="text-xs text-orange-300 font-mono font-bold">{dayGust}</span></div>
                                </div>

                                <div className="bg-white/5 rounded-xl p-3 border border-white/5 relative overflow-hidden group flex flex-col justify-between">
                                    <div className="absolute top-0 right-0 p-1 opacity-20"><WaveIcon className="w-12 h-12" /></div>
                                    <div className="flex justify-between items-center mb-1 relative z-10"><span className="text-[10px] text-gray-400 uppercase font-bold">Sea State</span></div>
                                    <div className="flex items-baseline gap-1 relative z-10 mb-2"><span className="text-2xl font-bold text-white">{dayWave}</span><span className="text-xs text-gray-500">{units.length}</span></div>
                                    <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all bg-blue-500`} style={{ width: `${Math.min(day.waveHeight * 10, 100)}%` }}></div></div>
                                    <div className="pt-2 border-t border-white/10 flex justify-between items-center"><span className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Period</span><span className="text-xs text-blue-300 font-mono font-bold">{day.swellPeriod ? `${day.swellPeriod}s` : '--'}</span></div>
                                </div>

                                {hasTideData ? (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                        <div className="flex justify-between items-center"><span className="text-[10px] text-gray-400 uppercase font-bold">Tide</span><TideCurveIcon className="w-4 h-4 text-purple-400" /></div>
                                        <div className="text-sm font-medium text-white truncate my-1">{day.tideSummary}</div>
                                        {day.sunrise && (<div className="flex justify-between items-center mt-1 pt-1 border-t border-white/5 text-[10px] text-gray-400"><span className="flex items-center gap-1"><SunIcon className="w-3 h-3 text-orange-400" /> {day.sunrise}</span><span>{day.sunset}</span></div>)}
                                    </div>
                                ) : (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                        <div className="flex justify-between items-center"><span className="text-[10px] text-gray-400 uppercase font-bold">Solar Cycle</span><SunIcon className="w-4 h-4 text-orange-400" /></div>
                                        <div className="grid grid-cols-2 gap-2 mt-2"><div><span className="text-[9px] text-gray-500 block uppercase">Sunrise</span><span className="text-sm font-bold text-white">{day.sunrise || '--:--'}</span></div><div className="text-right"><span className="text-[9px] text-gray-500 block uppercase">Sunset</span><span className="text-sm font-bold text-white">{day.sunset || '--:--'}</span></div></div>
                                        <div className="mt-2 pt-1 border-t border-white/5 text-[9px] text-gray-400 text-center uppercase tracking-wide">Daylight Hours</div>
                                    </div>
                                )}

                                <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                    <div className="flex justify-between items-center mb-1"><span className="text-[10px] text-gray-400 uppercase font-bold">Precip</span><span className="text-xs text-sky-300 font-bold">{precipMm > 0 ? `${convertPrecip(precipMm, units.temp)}` : '0'}</span></div>
                                    <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden mb-2"><div className={`h-full rounded-full transition-all bg-sky-500`} style={{ width: `${Math.min(precipMm * 10, 100)}%` }}></div></div>
                                    <div className="flex justify-between items-center pt-1 border-t border-white/5"><span className="text-[10px] text-gray-400 uppercase font-bold">UV Index</span><span className={`text-xs font-bold ${day.uvIndex && day.uvIndex > 5 ? 'text-orange-400' : 'text-emerald-400'}`}>{day.uvIndex ? Math.round(day.uvIndex) : '--'}</span></div>
                                </div>

                            </div>
                        </div>
                    )
                })}

                {!isPro && (
                    <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-[#0f172a] via-[#0f172a]/90 to-transparent flex items-end justify-center pb-8 z-20">
                        <button onClick={onTriggerUpgrade} className="bg-sky-600 hover:bg-sky-500 text-white font-bold py-3 px-8 rounded-full shadow-lg hover:scale-105 transition-transform flex items-center gap-2 border border-sky-400/30">
                            <LockIcon className="w-4 h-4" />
                            Unlock 10-Day Extended Forecast
                        </button>
                    </div>
                )}
            </div>
        </div>
    </Card>
);

export const MapWidget = ({ onOpenMap }: { onOpenMap: () => void }) => (
    <Card className="p-0 overflow-hidden h-60 cursor-pointer group hover:border-sky-500/50 transition-colors relative">
        <div onClick={onOpenMap} className="w-full h-full relative">
            {/* Background Image - Satellite View Style */}
            <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=2072&fm=jpg&fit=crop')] bg-cover bg-center opacity-30 grayscale group-hover:grayscale-0 group-hover:opacity-40 transition-all duration-700 group-hover:scale-105"></div>

            {/* Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/50 to-transparent"></div>

            {/* Content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10">
                <div className="w-16 h-16 rounded-full bg-sky-500/10 backdrop-blur-sm border border-sky-500/30 flex items-center justify-center mb-4 group-hover:bg-sky-500/20 group-hover:scale-110 transition-all duration-300 shadow-[0_0_30px_rgba(14,165,233,0.2)]">
                    <MapIcon className="w-8 h-8 text-sky-400 group-hover:text-sky-300" />
                </div>
                <h3 className="text-2xl font-bold text-white mb-1 tracking-tight group-hover:text-sky-200 transition-colors">Interactive Weather Map</h3>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-widest group-hover:text-gray-300">Live GRIB Visualization & Observations</p>
            </div>

            {/* CTA Button (appears on hover) */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 opacity-0 translate-y-4 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 z-20">
                <span className="bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold px-5 py-2.5 rounded-full shadow-lg flex items-center gap-2 transition-colors">
                    Launch Map <ArrowRightIcon className="w-3 h-3" />
                </span>
            </div>
        </div>
    </Card>
);
