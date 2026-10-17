/**
 * OffshoreModelStep — Onboarding step for selecting the offshore atmosphere
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

/**
 * Copy rewritten 2026-05-17 (scorecard fix #4 — onboarding microcopy).
 *
 * Before: "AI-blended ensemble model", "Global Forecast System — NOAA",
 * "NWP model", "20 nm offshore boundary" — all correct but talks to the
 * 5 % of sailors who already know what NWP means. The other 95 % glaze
 * over and pick the default.
 *
 * After: plain-English first ("Blends the best of the major forecasts"),
 * technical badge stays as the secondary line for the pros who want it.
 * The page subtitle frames the WHOLE choice in user-facing terms ("which
 * forecast to trust offshore") instead of engineering ones ("NWP model").
 */
const MODEL_OPTIONS: {
    value: OffshoreModel;
    label: string;
    tag?: string;
    tagColor?: string;
    desc: string;
    detail: string;
}[] = [
    {
        value: 'auto',
        label: 'Auto · ECMWF',
        tag: 'Default',
        tagColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
        desc: 'ECMWF atmosphere with Météo-France sea forecast',
        detail: 'Uses ECMWF IFS 0.25° for the atmosphere. Waves, water temperature and currents have separate marine sources.',
    },
    {
        value: 'ecmwf',
        label: 'ECMWF',
        tag: 'European Standard',
        tagColor: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
        desc: 'European global atmospheric forecast',
        detail: 'ECMWF IFS 0.25° for wind and weather, paired with the same independent marine forecast.',
    },
    {
        value: 'gfs',
        label: 'GFS / NOAA',
        tag: 'American Standard',
        tagColor: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
        desc: 'American atmospheric forecast',
        detail: 'NOAA GFS seamless for wind and weather, paired with the same independent marine forecast.',
    },
    {
        value: 'icon',
        label: 'ICON',
        desc: 'German global atmospheric forecast',
        detail: 'DWD ICON for wind and weather, paired with the same independent marine forecast.',
    },
];

export const OffshoreModelStep: React.FC<OffshoreModelStepProps> = ({ selected, onChange, onNext }) => (
    <div className="animate-in fade-in slide-in-from-right-8 duration-500 pt-8">
        <h2 className="text-2xl font-bold text-white mb-2 text-center">Which forecast offshore?</h2>
        {/* Describe the routing rule without claiming that one provider
            becomes inaccurate at an arbitrary line. Availability varies by
            location and the orchestrator can still fall back automatically. */}
        <p className="text-sm text-gray-400 text-center mb-6 leading-relaxed max-w-md mx-auto">
            Beyond <span className="text-white font-semibold">20 nautical miles</span> from shore, Thalassa prioritises
            your chosen offshore model for the fields it supplies. If that source is unavailable, Thalassa falls back
            automatically and labels the source in the forecast.
        </p>

        <div className="space-y-3 mb-8">
            {MODEL_OPTIONS.map((opt) => {
                const isActive = selected === opt.value;
                return (
                    <button
                        type="button"
                        key={opt.value}
                        aria-label={`Select ${opt.label} model`}
                        aria-pressed={isActive}
                        onClick={() => onChange(opt.value)}
                        className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-300 active:scale-[0.98] ${
                            isActive
                                ? 'bg-linear-to-br from-sky-500/15 to-sky-600/10 border-sky-500/40 shadow-lg shadow-sky-500/10'
                                : 'bg-white/3 border-white/6 hover:bg-white/6 hover:border-white/10'
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
                                    className={`text-xs mt-1.5 leading-relaxed ${isActive ? 'text-gray-400' : 'text-gray-400'}`}
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
            type="button"
            aria-label="Continue to next step"
            onClick={onNext}
            className="w-full bg-linear-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-sky-500/20 active:scale-[0.98]"
        >
            Next
        </button>
    </div>
);
