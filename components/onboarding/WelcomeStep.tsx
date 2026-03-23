import React from 'react';
import { BoatIcon, ArrowRightIcon } from '../Icons';

interface WelcomeStepProps {
    onNext: () => void;
}

export const WelcomeStep: React.FC<WelcomeStepProps> = ({ onNext }) => (
    <div className="text-center animate-in fade-in slide-in-from-bottom-8 duration-700 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-sky-500/20 to-transparent blur-3xl rounded-full pointer-events-none transform -translate-y-10"></div>

        <div className="w-24 h-24 bg-gradient-to-br from-sky-400 to-sky-600 rounded-2xl mx-auto mb-8 flex items-center justify-center shadow-[0_20px_50px_rgba(14,165,233,0.3)] ring-4 ring-white/10 relative z-10">
            <BoatIcon className="w-12 h-12 text-white fill-white" />
        </div>

        <h1 className="text-3xl font-black text-white mb-6 tracking-tight drop-shadow-xl">
            Thalassa
            <span className="block text-2xl font-light text-sky-400 mt-2 tracking-widest uppercase">
                Marine Weather
            </span>
        </h1>

        <p className="text-lg text-slate-300 mb-12 max-w-sm mx-auto leading-relaxed font-light">
            Professional-grade forecasting for the modern mariner. Precision tools for safety and performance.
        </p>

        <button
            aria-label="Next"
            onClick={onNext}
            className="group bg-white text-slate-950 font-bold py-4 px-12 rounded-2xl hover:bg-sky-50 transition-all transform hover:scale-105 hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] flex items-center gap-3 mx-auto relative overflow-hidden"
        >
            <span className="relative z-10">Initialize System</span>
            <ArrowRightIcon className="w-5 h-5 relative z-10 group-hover:translate-x-1 transition-transform" />
            <div className="absolute inset-0 bg-gradient-to-r from-sky-100 to-white opacity-0 group-hover:opacity-100 transition-opacity"></div>
        </button>
    </div>
);
