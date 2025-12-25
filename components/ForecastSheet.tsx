
import React, { useEffect, useState, useRef } from 'react';
import { MarineWeatherReport, UnitPreferences } from '../types';
import { WindIcon, WaveIcon, CompassIcon, ThermometerIcon, ArrowRightIcon, XIcon, ArrowUpIcon, ArrowDownIcon } from './Icons';

interface ForecastSheetProps {
    data: MarineWeatherReport | null;
    isLoading: boolean;
    units: UnitPreferences;
    isOpen: boolean;
    onClose: () => void;
    onViewFull: () => void;
}

const LOADING_STEPS = [
    "Contacting Satellite Grid...",
    "Downloading GRIB Data...",
    "Calculating Wave Gradients...",
    "Triangulating Wind Vectors...",
    "Synthesizing Forecast Model...",
    "Finalizing Report..."
];

export const ForecastSheet: React.FC<ForecastSheetProps> = ({ data, isLoading, units, isOpen, onClose, onViewFull }) => {
    const [isVisible, setIsVisible] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState(LOADING_STEPS[0]);
    
    // GESTURE STATE
    const [offsetY, setOffsetY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const startY = useRef<number>(0);
    const currentY = useRef<number>(0);
    const sheetRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen) {
            setOffsetY(0);
            // Small delay to allow render before sliding in
            requestAnimationFrame(() => setIsVisible(true));
        } else {
            setIsVisible(false);
        }
    }, [isOpen]);

    // Rotate loading messages to show activity
    useEffect(() => {
        if (isLoading && isOpen) {
            let step = 0;
            setLoadingMessage(LOADING_STEPS[0]);
            const interval = setInterval(() => {
                step = (step + 1) % LOADING_STEPS.length; 
                setLoadingMessage(LOADING_STEPS[step]);
            }, 300);
            return () => clearInterval(interval);
        }
    }, [isLoading, isOpen]);

    // --- TOUCH HANDLERS ---
    const handleTouchStart = (e: React.TouchEvent) => {
        startY.current = e.touches[0].clientY;
        currentY.current = e.touches[0].clientY;
        setIsDragging(true);
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (!isDragging) return;
        const y = e.touches[0].clientY;
        const diff = y - startY.current;
        
        // Only allow dragging down (positive diff)
        if (diff > 0) {
            e.preventDefault(); // Prevent body scroll while dragging sheet
            setOffsetY(diff);
        }
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        setIsDragging(false);
        const diff = offsetY;
        
        // Threshold to close: 100px drag down
        if (diff > 100) {
            setIsVisible(false);
            setTimeout(onClose, 300); // Wait for animation
        } else {
            // Snap back
            setOffsetY(0);
        }
    };

    if (!isOpen && !isVisible) return null;

    const current = data?.current;

    return (
        <>
            {/* Backdrop for click-to-dismiss */}
            {isOpen && (
                <div 
                    className={`fixed inset-0 z-[1100] bg-black/40 transition-opacity duration-500 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
                    onClick={() => { setIsVisible(false); setTimeout(onClose, 300); }}
                />
            )}

            <div 
                ref={sheetRef}
                className={`fixed inset-x-0 bottom-0 z-[1110] transition-transform duration-500 cubic-bezier(0.32, 0.72, 0, 1) md:mb-4 md:mx-auto md:max-w-2xl`}
                style={{ 
                    transform: isDragging 
                        ? `translateY(${offsetY}px)` 
                        : `translateY(${isVisible ? '0%' : '100%'})`,
                    transition: isDragging ? 'none' : 'transform 0.5s cubic-bezier(0.32, 0.72, 0, 1)'
                }}
            >
                <div className="mx-2 mb-2 md:mx-0">
                    {/* Glass Panel */}
                    <div 
                        className="bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-[2rem] shadow-2xl overflow-hidden ring-1 ring-white/10 relative"
                    >
                        
                        {/* DRAG HANDLE AREA - Expanded touch target */}
                        <div 
                            className="h-8 w-full absolute top-0 left-0 z-[60] flex items-start justify-center pt-3 cursor-grab active:cursor-grabbing"
                            onTouchStart={handleTouchStart}
                            onTouchMove={handleTouchMove}
                            onTouchEnd={handleTouchEnd}
                        >
                            <div className="h-1.5 w-12 bg-white/20 rounded-full transition-colors hover:bg-white/40" />
                        </div>

                        {/* Close Button */}
                        <button 
                            onClick={() => { setIsVisible(false); setTimeout(onClose, 300); }}
                            className="absolute top-4 right-4 z-50 p-2 bg-white/10 hover:bg-white/20 rounded-full text-gray-300 hover:text-white transition-colors"
                        >
                            <XIcon className="w-5 h-5" />
                        </button>

                        <div className="p-6 pt-10">
                            {isLoading ? (
                                <div className="flex flex-col items-center justify-center py-8 space-y-4">
                                    <div className="relative">
                                        <div className="w-12 h-12 border-4 border-white/10 rounded-full"></div>
                                        <div className="absolute inset-0 w-12 h-12 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-sm text-white font-bold tracking-wide animate-pulse min-w-[200px]">{loadingMessage}</p>
                                        <p className="text-xs text-gray-400 mt-1">Please wait...</p>
                                    </div>
                                </div>
                            ) : current ? (
                                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                                    <div className="flex justify-between items-start mb-6 pr-10">
                                        <div>
                                            <h3 className="text-2xl font-bold text-white tracking-tight line-clamp-1">{data.locationName}</h3>
                                            <p className="text-sm text-sky-300 font-medium mt-0.5">{current.condition} • {current.airTemperature}°{units.temp}</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-3 gap-3 mb-6">
                                        <div className="bg-white/5 rounded-2xl p-3 flex flex-col items-center justify-center text-center border border-white/5">
                                            <div className="text-sky-400 mb-1"><WindIcon className="w-5 h-5" /></div>
                                            <span className="text-lg font-bold text-white">{current.windSpeed}</span>
                                            <span className="text-[10px] text-gray-400 uppercase font-bold">{units.speed}</span>
                                        </div>
                                        <div className="bg-white/5 rounded-2xl p-3 flex flex-col items-center justify-center text-center border border-white/5">
                                            <div className="text-blue-400 mb-1"><WaveIcon className="w-5 h-5" /></div>
                                            <span className="text-lg font-bold text-white">{current.waveHeight}</span>
                                            <span className="text-[10px] text-gray-400 uppercase font-bold">{units.length}</span>
                                        </div>
                                        <div className="bg-white/5 rounded-2xl p-3 flex flex-col items-center justify-center text-center border border-white/5">
                                            <div className="text-orange-400 mb-1"><CompassIcon rotation={current.windDegree} className="w-5 h-5" /></div>
                                            <span className="text-lg font-bold text-white">{current.windDirection}</span>
                                            <span className="text-[10px] text-gray-400 uppercase font-bold">Dir</span>
                                        </div>
                                    </div>

                                    <button 
                                        onClick={onViewFull}
                                        className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white font-bold rounded-xl shadow-lg shadow-sky-900/20 transition-all flex items-center justify-center gap-2 group active:scale-95"
                                    >
                                        View Full Report
                                        <ArrowRightIcon className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                    </button>
                                </div>
                            ) : (
                                <div className="text-center py-8 text-red-300">
                                    Failed to load data.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};
