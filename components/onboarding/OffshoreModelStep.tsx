/**
 * OffshoreModelStep — Onboarding step for selecting the default Stormglass
 * NWP model used when the vessel crosses the 20 nm offshore boundary.
 *
 * Skipper-only (owner tier).
 */
import React from 'react';
import type { OffshoreModel } from '../../types';

interface OffshoreModelStepProps {
    selected: OffshoreModel;
    onChange: (model: OffshoreModel) => void;
    onNext: () => void;
}

const MODEL_OPTIONS: {
    value: OffshoreModel;
    label: string;
    tag?: string;
    tagColor?: string;
    desc: string;
    detail: string;
}[] = [
    {
        value: 'sg',
        label: 'Stormglass AI',
        tag: 'Recommended',
        tagColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
        desc: 'AI-blended ensemble model',
        detail: 'Combines the best of multiple NWP models into a single, optimised forecast. Ideal for most passages.',
    },
    {
        value: 'ecmwf',
        label: 'ECMWF',
        tag: 'European Standard',
        tagColor: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
        desc: 'European Centre for Medium-Range Weather Forecasts',
        detail: 'World-leading 9 km global model. Widely trusted by professional meteorologists and ocean routing services.',
    },
    {
        value: 'gfs',
        label: 'GFS / NOAA',
        tag: 'American Standard',
        tagColor: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
        desc: 'Global Forecast System — NOAA',
        detail: '25 km global model from the US National Weather Service. Excellent coverage, frequent updates (every 6 hours).',
    },
    {
        value: 'icon',
        label: 'ICON',
        desc: 'DWD Global High-Resolution',
        detail: '13 km global model from the German Weather Service. Strong performance in mid-latitudes and Southern Ocean.',
    },
];

export const OffshoreModelStep: React.FC<OffshoreModelStepProps> = ({ selected, onChange, onNext }) => (
    <div className="animate-in fade-in slide-in-from-right-8 duration-500">
        <h2 className="text-2xl font-bold text-white mb-2 text-center">Offshore Weather Model</h2>
        <p className="text-sm text-gray-400 text-center mb-6 leading-relaxed">
            When your vessel crosses the <span className="text-white font-semibold">20 nm</span> offshore boundary,
            Thalassa switches from Apple WeatherKit to Stormglass for ocean data. Choose your preferred NWP model.
        </p>

        <div className="space-y-3 mb-8">
            {MODEL_OPTIONS.map((opt) => {
                const isActive = selected === opt.value;
                return (
                    <button
                        key={opt.value}
                        aria-label={`Select ${opt.label} model`}
                        onClick={() => onChange(opt.value)}
                        className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-300 active:scale-[0.98] ${
                            isActive
                                ? 'bg-gradient-to-br from-sky-500/15 to-sky-600/10 border-sky-500/40 shadow-lg shadow-sky-500/10'
                                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06] hover:border-white/10'
                        }`}
                    >
                        <div className="flex items-start gap-3">
                            {/* Radio indicator */}
                            <div className="mt-0.5 shrink-0">
                                <div
                                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${
                                        isActive ? 'border-sky-500 bg-sky-500/20' : 'border-white/20'
                                    }`}
                                >
                                    {isActive && <div className="w-2.5 h-2.5 rounded-full bg-sky-400" />}
                                </div>
                            </div>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-gray-200'}`}>
                                        {opt.label}
                                    </span>
                                    {opt.tag && (
                                        <span
                                            className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                                                opt.tagColor ?? 'bg-white/10 text-gray-400 border-white/10'
                                            }`}
                                        >
                                            {opt.tag}
                                        </span>
                                    )}
                                </div>
                                <p className={`text-xs mt-1 ${isActive ? 'text-gray-300' : 'text-gray-500'}`}>
                                    {opt.desc}
                                </p>
                                <p
                                    className={`text-xs mt-1.5 leading-relaxed ${isActive ? 'text-gray-400' : 'text-gray-600'}`}
                                >
                                    {opt.detail}
                                </p>
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>

        <button
            aria-label="Continue to next step"
            onClick={onNext}
            className="w-full bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-sky-500/20 active:scale-[0.98]"
        >
            Continue
        </button>
    </div>
);
