import React from 'react';
import { t } from '../../../theme';
import { ArrowUpIcon, ArrowDownIcon, CloudIcon, RainIcon, DropletIcon, EyeIcon, SunriseIcon, SunsetIcon, SunIcon, GaugeIcon } from '../../Icons';
import { convertTemp } from '../../../utils';
import { UnitPreferences, WeatherMetrics } from '../../../types';
import { CardDisplayValues } from './types';

/** Selects the appropriate weather background image based on conditions */
function getWeatherBackgroundImage(condition?: string, isDay?: boolean, cloudCover?: number, moonIllumination?: number): string {
    const c = (condition || '').toLowerCase();

    // Storm / Thunder always wins
    if (c.includes('storm') || c.includes('thunder')) return '/weather-bg/storm.png';
    // Rain / Showers / Drizzle / Pouring
    if (c.includes('rain') || c.includes('shower') || c.includes('drizzle') || c.includes('pour')) return '/weather-bg/rain.png';
    // Fog / Mist / Haze
    if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return '/weather-bg/fog.png';

    // Night scenes
    if (!isDay) {
        // Moonlit night vs pitch-dark night
        if (moonIllumination !== undefined && moonIllumination > 0.3) return '/weather-bg/night-moon.png';
        return '/weather-bg/night-dark.png';
    }

    // Day scenes — use cloud cover thresholds
    const cc = cloudCover ?? 0;
    if (cc > 70) return '/weather-bg/cloudy.png';
    if (cc > 30) return '/weather-bg/partly-cloudy.png';
    return '/weather-bg/sunny.png';
}

interface HeroHeaderProps {
    cardData: WeatherMetrics;
    cardDisplayValues: CardDisplayValues;
    units: UnitPreferences;
    isCardDay: boolean;
    cardIsLive: boolean;
    timeZone?: string;
    isHourly: boolean;
    hTime?: number;
    forceLabel?: string;
    moonIllumination?: number;
}

export const HeroHeader: React.FC<HeroHeaderProps> = ({
    cardData,
    cardDisplayValues,
    units,
    isCardDay,
    cardIsLive,
    timeZone,
    isHourly,
    hTime,
    forceLabel,
    moonIllumination
}) => {
    const bgImage = getWeatherBackgroundImage(cardData.condition, isCardDay, cardData.cloudCover ?? undefined, moonIllumination);
    return (
        <div className="flex flex-col gap-2 md:gap-3 mb-2 relative z-10 px-4 md:px-6 pt-4 md:pt-6 shrink-0">
            {/* MERGED Header Card (Span 3-Full Width) - PREMIUM GLASS THEME */}
            <div className={`col-span-3 rounded-2xl p-0 backdrop-blur-md flex flex-col relative overflow-hidden group min-h-[110px] border shadow-lg ${isCardDay
                ? 'bg-gradient-to-br from-sky-900/20 via-slate-900/40 to-black/40 border-sky-400/20 shadow-sky-900/5'
                : 'bg-gradient-to-br from-indigo-900/20 via-slate-900/40 to-black/40 border-indigo-400/20 shadow-indigo-900/5'
                } `}>
                {/* Gradient Orb (Shared) */}
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-transparent rounded-full blur-2xl pointer-events-none" />

                {/* TOP SECTION (Split 58/42) */}
                <div className="flex flex-row w-full flex-1 border-b border-white/5 min-h-[70%] relative overflow-hidden">
                    {/* Dynamic Weather Background Image */}
                    <div className="absolute inset-0 z-0 overflow-hidden bg-black">
                        <img
                            src={bgImage}
                            alt=""
                            className="w-full h-full object-cover"
                            style={{ minWidth: '100%', minHeight: '100%' }}
                        />
                    </div>
                    {/* Dark overlay for text readability */}
                    <div className="absolute inset-0 z-[1] bg-gradient-to-r from-black/60 via-black/40 to-black/50" />
                    {/* LEFT PARTITION (Conditions)-~58% */}
                    <div className="flex flex-row justify-between items-stretch p-4 pt-4 border-r border-white/5 w-[58%] shrink-0 relative z-10">

                        {/* Main Temp + Condition */}
                        <div className="flex flex-col justify-between gap-0.5">
                            <div className="flex items-start">
                                {(() => {
                                    const tempStr = cardDisplayValues.airTemp.toString();
                                    const len = tempStr.length;
                                    // Shrink for 3 chars (100 or -5) or 4 chars (-12)
                                    const sizeClass = len > 3 ? 'text-3xl md:text-4xl' : len > 2 ? 'text-4xl md:text-5xl' : 'text-5xl md:text-6xl';

                                    return (
                                        <span className={`${sizeClass} font-mono font-bold tracking-tighter text-ivory drop-shadow-2xl leading-none transition-all duration-300`}>
                                            {cardDisplayValues.airTemp}°
                                        </span>
                                    )
                                })()}
                                <span className="text-sm font-bold text-white/50 mt-1 ml-0.5">{units.temp}</span>
                            </div>
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest opacity-90 pl-1 ${cardData.condition?.includes('STORM') ? 'text-red-500 animate-pulse' :
                                cardData.condition?.includes('POURING') ? 'text-orange-400' :
                                    cardData.condition?.includes('SHOWERS') ? 'text-cyan-400' :
                                        'text-sky-300'
                                } `}>
                                {cardData.condition?.replace(/Thunderstorm/i, 'Thunder').replace(/Light Showers/i, 'Showers')}
                            </span>
                        </div>

                        {/* Detail Stack (Right Aligned) */}
                        <div className="flex flex-col justify-between items-end h-full py-0">
                            {/* 1. Hi/Lo - Larger, bottom aligned with hours */}
                            <div className="flex-1" />
                            <div className="flex items-center gap-2 text-sm font-bold leading-none">
                                <div className="flex items-center gap-0.5 text-white">
                                    <ArrowUpIcon className="w-3 h-3 text-orange-400" />
                                    <span className="text-base font-mono font-bold text-ivory">{cardDisplayValues.highTemp}°</span>
                                </div>
                                <div className="w-px h-3 bg-white/20" />
                                <div className="flex items-center gap-0.5 text-gray-300">
                                    <ArrowDownIcon className="w-3 h-3 text-emerald-400" />
                                    <span className="text-base font-mono font-bold text-ivory">{cardDisplayValues.lowTemp}°</span>
                                </div>
                            </div>

                            {/* 2. Feels Like */}
                            <div className="flex items-center gap-1.5 justify-end">
                                <span className={`text-sm font-bold uppercase tracking-wider text-slate-400 ${!(cardData.feelsLike !== undefined) ? 'opacity-0' : ''} `}>Feels Like</span>
                                <span className={`text-sm font-bold text-orange-200 ${!(cardData.feelsLike !== undefined) ? 'opacity-0' : ''} `}>
                                    {cardData.feelsLike !== undefined ? convertTemp(cardData.feelsLike, units.temp) : '--'}°<span className="text-sm text-orange-200/50 ml-0.5">{units.temp}</span>
                                </span>
                            </div>

                            {/* 4. Cloud */}
                            <div className="flex items-center gap-1 text-sm font-bold text-gray-300 justify-end translate-y-0.5">
                                <CloudIcon className="w-2.5 h-2.5" />
                                {Math.round(cardData.cloudCover || 0)}%
                                <span className="text-sm font-bold uppercase tracking-wider text-slate-500 ml-0.5">Clouds</span>
                            </div>

                            {/* 3. Rain */}
                            <div className="flex items-center gap-1 text-sm font-bold text-cyan-300 justify-end">
                                <RainIcon className="w-2.5 h-2.5" />
                                {cardData.precipValue || '0.0 mm'}
                            </div>
                        </div>
                    </div>

                    {/* RIGHT PARTITION (Clock/Label)-~42% */}
                    {/* EXACT MATCH to left partition's Main Temp + Condition structure */}
                    <div className="flex flex-col justify-between gap-0.5 p-4 pt-4 flex-1 relative min-w-0 z-10 w-[42%] h-full">
                        {/* TOP: Today - matches temp position */}
                        <div className="flex items-start">
                            <span className={`${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} font-extrabold text-sm md:text-sm tracking-[0.2em] leading-none`}>
                                {cardIsLive ? "TODAY" : "FORECAST"}
                            </span>
                        </div>
                        {/* MIDDLE: Now - large text like temp */}
                        <span className={`${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} ${(!cardIsLive && (forceLabel || "TODAY") !== "TODAY") ? 'text-xl md:text-2xl' : 'text-2xl md:text-3xl'} font-mono font-bold tracking-tighter leading-none whitespace-nowrap`}>
                            {cardIsLive ? "NOW" : (forceLabel || "TODAY")}
                        </span>
                        {/* BOTTOM: Hours - matches condition position */}
                        <span className={`text-sm md:text-sm font-bold uppercase tracking-widest ${cardIsLive ? 'text-emerald-400' : 'text-blue-400'}`}>
                            {(cardIsLive || (isHourly && hTime)) ? (
                                cardIsLive ? (() => {
                                    const startH = new Date().toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: timeZone }).split(':')[0];
                                    const nextDate = new Date();
                                    nextDate.setHours(nextDate.getHours() + 1);
                                    const nextH = nextDate.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: timeZone }).split(':')[0];
                                    return `${startH}:00 - ${nextH}:00`;
                                })() : (() => {
                                    const start = new Date(hTime!);
                                    const end = new Date(hTime!);
                                    end.setHours(start.getHours() + 1);
                                    const strictFmt = (d: Date) => {
                                        const h = d.getHours();
                                        const m = d.getMinutes().toString().padStart(2, '0');
                                        return `${h.toString().padStart(2, '0')}:${m}`;
                                    };
                                    return `${strictFmt(start)} - ${strictFmt(end)}`;
                                })()
                            ) : '--:-- - --:--'}
                        </span>
                    </div>
                </div>

                {/* BOTTOM SECTION (Unified Stats Row) */}
                <div className="flex flex-row items-center justify-between w-full relative z-10 px-4 py-2 bg-white/5 min-h-[40px] gap-2">
                    {/* Humidity (Replaces Cloud) */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <DropletIcon className="w-3.5 h-3.5 text-cyan-400 mb-0.5" />
                        <span className="text-sm font-bold text-white leading-none">{cardData.humidity ? Math.round(cardData.humidity) : '--'}%</span>
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mt-0.5">Hum</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Visibility (Replaces Rain) */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <EyeIcon className="w-3.5 h-3.5 text-emerald-400 mb-0.5" />
                        <span className="text-sm font-bold text-white leading-none">{cardDisplayValues.vis}</span>
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mt-0.5">Vis NM</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Sunrise */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <SunriseIcon className="w-3.5 h-3.5 text-orange-400 mb-0.5" />
                        <span className="text-sm font-bold text-white leading-none">{cardDisplayValues.sunrise}</span>
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mt-0.5">Rise</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Sunset */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <SunsetIcon className="w-3.5 h-3.5 text-indigo-300 mb-0.5" />
                        <span className="text-sm font-bold text-white leading-none">{cardDisplayValues.sunset}</span>
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mt-0.5">Set</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* UV Index */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <SunIcon className="w-3.5 h-3.5 text-orange-400 mb-0.5" />
                        <span className="text-sm font-bold text-white leading-none">{cardDisplayValues.uv !== '--' ? cardDisplayValues.uv : '0'}</span>
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mt-0.5">UV:{cardData.uvIndex}</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Pressure */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <GaugeIcon className="w-3.5 h-3.5 text-teal-400 mb-0.5" />
                        <span className="text-sm font-bold text-white leading-none">
                            {cardDisplayValues.pressure && cardDisplayValues.pressure !== '--' ? Math.round(parseFloat(cardDisplayValues.pressure.toString())).toString() : '--'}
                        </span>
                        <span className="text-sm font-bold text-gray-500 uppercase tracking-wider mt-0.5">PRMSL</span>

                    </div>
                </div>
            </div>
        </div>
    );
};
