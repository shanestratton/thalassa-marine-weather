
import React from 'react';
import { Card } from './shared/Card';
import { DiamondIcon, BoatIcon, PlayIcon, ShareIcon, SpeakerWaveIcon, QuoteIcon } from '../Icons';

import { LockerItem } from '../../types';

interface AdviceWidgetProps {
    advice: string;
    isPro: boolean;
    onUpgrade: () => void;
    isSpeaking: boolean;
    isBuffering: boolean;
    isAudioPreloading?: boolean;
    toggleBroadcast: () => void;
    handleShare: () => void;
    uvIndex: number;
    lockerItems: LockerItem[];
    isBackgroundUpdating?: boolean; // New Prop
}

export const AdviceWidget: React.FC<AdviceWidgetProps> = ({ advice, isPro, onUpgrade, isSpeaking, isBuffering, isAudioPreloading, toggleBroadcast, handleShare, uvIndex, lockerItems, isBackgroundUpdating }) => {
    const UVBar = ({ value }: { value: number }) => {
        const roundedValue = Math.round(value);
        const percentage = Math.min(Math.max((roundedValue / 11) * 100, 0), 100);
        let colorClass = "bg-emerald-400";
        let label = "Low";
        if (roundedValue > 2) { colorClass = "bg-yellow-400"; label = "Moderate"; }
        if (roundedValue > 5) { colorClass = "bg-orange-500"; label = "High"; }
        if (roundedValue > 7) { colorClass = "bg-red-500"; label = "Very High"; }
        if (roundedValue > 10) { colorClass = "bg-purple-500"; label = "Extreme"; }
        return (
            <div className="w-full space-y-1 mb-4">
                <div className="flex justify-between items-end"><span className="text-[10px] uppercase text-gray-400 font-bold tracking-widest">UV Rating</span><span className={`text-xs font-bold ${colorClass.replace("bg-", "text-")}`}>{roundedValue} - {label}</span></div>
                <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden"><div className={`h-full ${colorClass} rounded-full transition-all duration-1000`} style={{ width: `${percentage}%` }}></div></div>
            </div>
        );
    };

    if (!advice) return null;

    // Detect if we are showing placeholder advice while loading AI
    const isPlaceholder = advice.includes("Scanning horizon") || advice.includes("Inland mode");
    // Show skeleton only if it's updating AND we don't have real advice yet (placeholder). 
    // If we have real advice, keep showing it while updating in background.
    const showSkeleton = isBackgroundUpdating && isPlaceholder;
    // Always show updating status in header if background update is active
    const showStatus = isBackgroundUpdating;

    return (
        <Card className="bg-[#0f172a] p-0 overflow-hidden border border-white/10 relative shadow-2xl group">
            {!isPro && (
                <div className="absolute inset-0 z-20 backdrop-blur-md bg-slate-900/60 flex items-center justify-center">
                    <button onClick={onUpgrade} className="bg-gradient-to-r from-sky-500 to-blue-600 text-white font-bold py-3 px-8 rounded-xl shadow-lg shadow-sky-500/30 flex items-center gap-3 hover:scale-105 transition-transform border border-white/10">
                        <DiamondIcon className="w-5 h-5" />
                        Unlock Digital Captain's Log
                    </button>
                </div>
            )}

            <div className={`flex flex-col md:flex-row items-stretch min-h-[300px] ${!isPro ? 'opacity-30 blur-sm select-none' : ''}`}>

                {/* LEFT: LOGBOOK AREA */}
                <div className="flex flex-1 flex-col relative">
                    {/* Background Texture */}
                    <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/nautical-charts.png')] opacity-5 pointer-events-none"></div>
                    <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-[#0f172a] to-blue-950/30"></div>

                    {/* Content Layer */}
                    <div className="relative z-10 p-6 md:p-8 flex flex-col h-full">
                        {/* Header */}
                        <div className="flex items-center justify-between w-full border-b border-white/5 pb-4 mb-6">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-indigo-500/10 rounded-xl text-indigo-400 shrink-0 border border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.1)]">
                                    <BoatIcon className="w-6 h-6" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-indigo-300 uppercase tracking-widest flex items-center gap-2">
                                        Captain's Log
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        {/* Label Removed */}
                                        {showStatus ? (
                                            <span className="flex items-center gap-1.5 ">
                                                <span className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-ping"></span>
                                                <span className="text-[9px] text-sky-400 font-mono animate-pulse">UPDATING...</span>
                                            </span>
                                        ) : (
                                            <>
                                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full shadow-[0_0_5px_rgba(16,185,129,0.5)]"></span>
                                                <span className="text-[10px] text-gray-500 uppercase tracking-widest">Bridge Active</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Controls */}
                            <div className="flex items-center gap-3">
                                {/* TTS Button Removed */}
                                <button onClick={handleShare} className="h-11 w-11 flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:bg-white/10 transition-all active:scale-95" title="Log Entry"><ShareIcon className="w-5 h-5" /></button>
                            </div>
                        </div>

                        {/* Text Area - Auto Expanding */}
                        <div className="relative flex-1 min-h-[120px] pr-2">
                            <div className="absolute top-0 left-0 bottom-0 w-[2px] bg-gradient-to-b from-indigo-500/50 via-indigo-500/10 to-transparent"></div>
                            <div className="pl-6 py-1">
                                <QuoteIcon className="w-6 h-6 text-white/10 mb-4 transform -scale-x-100" />

                                {showSkeleton ? (
                                    <div className="space-y-3 animate-pulse">
                                        <div className="h-4 bg-white/10 rounded w-3/4"></div>
                                        <div className="h-4 bg-white/10 rounded w-full"></div>
                                        <div className="h-4 bg-white/10 rounded w-5/6"></div>
                                        <div className="h-4 bg-white/5 rounded w-1/2"></div>
                                    </div>
                                ) : (
                                    <p className="text-gray-200 leading-relaxed font-serif text-lg md:text-xl tracking-wide whitespace-pre-line animate-in fade-in slide-in-from-bottom-2 duration-500">
                                        {advice}
                                    </p>
                                )}

                                <div className="mt-6 flex items-center gap-2 opacity-50">
                                    <div className="h-[1px] w-8 bg-indigo-400"></div>
                                    <span className="text-xs font-mono text-indigo-300">END LOG</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* RIGHT: SIDEBAR */}
                <div className="w-full md:w-72 bg-black/20 border-t md:border-t-0 md:border-l border-white/5 p-6 flex flex-col backdrop-blur-md">
                    <div className="flex items-center gap-2 mb-6">
                        <div className="h-1 w-4 bg-orange-400 rounded-full"></div>
                        <h4 className="text-xs font-bold uppercase tracking-widest text-gray-300">Skipper's Locker</h4>
                    </div>

                    <UVBar value={uvIndex} />

                    {/* Updated Container with Scroll */}
                    <div className="flex-1 mt-4 overflow-y-auto custom-scrollbar min-h-[100px]">
                        <p className="text-[9px] text-gray-500 uppercase tracking-widest mb-3 font-bold sticky top-0 bg-[#141b29] py-1 z-10 opacity-90">Recommended Gear</p>
                        <div className="flex flex-wrap gap-2 content-start pb-2">
                            {lockerItems.map((item, idx) => (
                                <span key={idx} className="px-3 py-2 bg-white/5 hover:bg-white/10 text-xs font-medium text-indigo-100 border border-white/10 rounded-lg shadow-sm transition-all hover:border-indigo-500/30 cursor-default flex items-center gap-1.5">
                                    <span>{item.icon}</span>
                                    {item.name}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    );
};
