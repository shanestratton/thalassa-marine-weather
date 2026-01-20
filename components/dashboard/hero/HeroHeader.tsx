import React from 'react';
import { ArrowUpIcon, ArrowDownIcon, CloudIcon, RainIcon, DropletIcon, EyeIcon, SunriseIcon, SunsetIcon, SunIcon, GaugeIcon } from '../../Icons';
import { convertTemp } from '../../../utils';
import { UnitPreferences, WeatherMetrics } from '../../../types';

interface HeroHeaderProps {
    cardData: WeatherMetrics;
    cardDisplayValues: any;
    units: UnitPreferences;
    isCardDay: boolean;
    cardIsLive: boolean;
    timeZone?: string;
    isHourly: boolean;
    hTime?: number;
    forceLabel?: string;
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
    forceLabel
}) => {
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
                <div className="flex flex-row w-full flex-1 border-b border-white/5 min-h-[70%]">
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
                                        <span className={`${sizeClass} font-black tracking-tighter text-white drop-shadow-2xl leading-none -translate-y-2 transition-all duration-300`}>
                                            {cardDisplayValues.airTemp}°
                                        </span>
                                    )
                                })()}
                                <span className="text-sm font-bold text-white/50 mt-1 ml-0.5">{units.temp}</span>
                            </div>
                            <span className={`text-[10px] md: text-xs font-bold uppercase tracking-widest opacity-90 pl-1 ${cardData.condition?.includes('STORM') ? 'text-red-500 animate-pulse' :
                                cardData.condition?.includes('POURING') ? 'text-orange-400' :
                                    cardData.condition?.includes('SHOWERS') ? 'text-cyan-400' :
                                        'text-sky-300'
                                } `}>
                                {cardData.condition?.replace(/Thunderstorm/i, 'Thunder').replace(/Light Showers/i, 'Showers')}
                            </span>
                        </div>

                        {/* Detail Stack (Right Aligned-Squashed 4 Lines) */}
                        <div className="flex flex-col justify-between items-end h-full py-0.5">
                            {/* 1. Hi/Lo */}
                            <div className="flex items-center gap-2 text-xs font-bold leading-none -translate-y-1.5">
                                <div className="flex items-center gap-0.5 text-white">
                                    <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400" />
                                    {cardDisplayValues.highTemp}°<span className="text-[9px] text-white/50">{units.temp}</span>
                                </div>
                                <div className="w-px h-2.5 bg-white/20" />
                                <div className="flex items-center gap-0.5 text-gray-300">
                                    <ArrowDownIcon className="w-2.5 h-2.5 text-emerald-400" />
                                    {cardDisplayValues.lowTemp}°<span className="text-[9px] text-white/50">{units.temp}</span>
                                </div>
                            </div>

                            {/* 2. Feels Like */}
                            <div className="flex items-center gap-1.5 justify-end">
                                <span className={`text-[9px] font-bold uppercase tracking-wider text-slate-400 ${!(cardData.feelsLike !== undefined) ? 'opacity-0' : ''} `}>Feels Like</span>
                                <span className={`text-xs font-bold text-orange-200 ${!(cardData.feelsLike !== undefined) ? 'opacity-0' : ''} `}>
                                    {cardData.feelsLike !== undefined ? convertTemp(cardData.feelsLike, units.temp) : '--'}°<span className="text-[9px] text-orange-200/50 ml-0.5">{units.temp}</span>
                                </span>
                            </div>

                            {/* 4. Cloud */}
                            <div className="flex items-center gap-1 text-[10px] font-bold text-gray-300 justify-end translate-y-0.5">
                                <CloudIcon className="w-2.5 h-2.5" />
                                {Math.round(cardData.cloudCover || 0)}%
                                <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 ml-0.5">Clouds</span>
                            </div>

                            {/* 3. Rain */}
                            <div className="flex items-center gap-1 text-[10px] font-bold text-cyan-300 justify-end">
                                <RainIcon className="w-2.5 h-2.5" />
                                {cardData.precipValue || '0.0 mm'}
                            </div>
                        </div>
                    </div>

                    {/* RIGHT PARTITION (Clock/Label)-~42% */}
                    <div className="flex flex-col justify-between items-start p-4 flex-1 relative min-w-0 z-10 w-[42%] h-full">
                        <div className="w-full flex justify-start items-start flex-col -translate-y-1.5">
                            {/* TOP LINE */}
                            <span className={`${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} font-extrabold text-xs md: text-sm tracking-[0.2em] leading-none mb-1 w-full text-left`}>
                                {cardIsLive ? "TODAY" : "FORECAST"}
                            </span>
                            {/* MIDDLE LINE */}
                            <span className={`${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} ${(!cardIsLive && (forceLabel || "TODAY") !== "TODAY") ? 'text-xl md:text-2xl' : 'text-2xl md:text-3xl'} font-black tracking-tighter leading-none w-full text-left whitespace-nowrap mb-0.5`}>
                                {cardIsLive ? "NOW" : (forceLabel || "TODAY")}
                            </span>
                        </div>

                        {/* BOTTOM LINE: Hour Range */}
                        {/* Unified Logic: Show if Live OR (Hourly + hTime) */}
                        {(cardIsLive || (isHourly && hTime)) ? (
                            <span className={`text-sm md: text-base font-bold ${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} font-mono translate-y-1`}>
                                {cardIsLive ? (() => {
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
                                })()}
                            </span>
                        ) : <div className="mt-auto" />}
                    </div>
                </div>

                {/* BOTTOM SECTION (Unified Stats Row) */}
                <div className="flex flex-row items-center justify-between w-full relative z-10 px-4 py-2 bg-white/5 min-h-[40px] gap-2">
                    {/* Humidity (Replaces Cloud) */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <DropletIcon className="w-3.5 h-3.5 text-cyan-400 mb-0.5" />
                        <span className="text-[10px] font-bold text-white leading-none">{cardData.humidity ? Math.round(cardData.humidity) : '--'}%</span>
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Hum</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Visibility (Replaces Rain) */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <EyeIcon className="w-3.5 h-3.5 text-emerald-400 mb-0.5" />
                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.vis}</span>
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Vis NM</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Sunrise */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <SunriseIcon className="w-3.5 h-3.5 text-orange-400 mb-0.5" />
                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.sunrise}</span>
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Rise</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Sunset */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <SunsetIcon className="w-3.5 h-3.5 text-indigo-300 mb-0.5" />
                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.sunset}</span>
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Set</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* UV Index */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <SunIcon className="w-3.5 h-3.5 text-orange-400 mb-0.5" />
                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.uv !== '--' ? cardDisplayValues.uv : '0'}</span>
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">UV:{cardData.uvIndex}</span>
                    </div>
                    <div className="w-px h-4 bg-white/10 shrink-0" />
                    {/* Pressure */}
                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                        <GaugeIcon className="w-3.5 h-3.5 text-teal-400 mb-0.5" />
                        <span className="text-[10px] font-bold text-white leading-none">
                            {cardDisplayValues.pressure && cardDisplayValues.pressure !== '--' ? Math.round(parseFloat(cardDisplayValues.pressure.toString())).toString() : '--'}
                        </span>
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">PRMSL</span>

                    </div>
                </div>
            </div>
        </div>
    );
};
