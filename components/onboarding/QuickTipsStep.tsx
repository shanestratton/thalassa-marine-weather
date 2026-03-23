import React from 'react';
import { ArrowRightIcon } from '../Icons';

interface QuickTipsStepProps {
    onNext: () => void;
}

export const QuickTipsStep: React.FC<QuickTipsStepProps> = ({ onNext }) => (
    <div className="text-center animate-in fade-in slide-in-from-bottom-8 duration-700 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-sky-500/20 to-transparent blur-3xl rounded-full pointer-events-none transform -translate-y-10"></div>

        <h1 className="text-3xl font-black text-white mb-3 tracking-tight drop-shadow-xl relative z-10">Quick Tips</h1>
        <p className="text-base text-slate-300 mb-8 max-w-sm mx-auto leading-relaxed font-light relative z-10">
            A few gestures to get you started
        </p>

        <div className="space-y-3 mb-8 relative z-10">
            {[
                {
                    icon: '👆',
                    title: 'Swipe for Forecast',
                    desc: 'Swipe left/right on the weather cards to scrub through hours. Swipe up/down to change days.',
                },
                {
                    icon: '🔄',
                    title: 'Essential & Full Views',
                    desc: 'Toggle between a quick glance and detailed marine data using the chevron button in the header.',
                },
                {
                    icon: '🗺️',
                    title: 'Passage Planner',
                    desc: "Plan routes, check conditions, and export GPX tracks from the Ship's Office > Passages tab.",
                },
                {
                    icon: '💬',
                    title: 'Crew Talk Community',
                    desc: 'Join channels, share pins and voyage tracks, and connect with sailors worldwide via Cloud.',
                },
            ].map((tip) => (
                <div
                    key={tip.title}
                    className="relative overflow-hidden rounded-2xl bg-white/[0.04] border border-white/[0.08] p-4 backdrop-blur-sm hover:border-white/[0.15] transition-all"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-sky-400 to-sky-600 flex items-center justify-center text-xl shrink-0 shadow-[0_8px_24px_rgba(14,165,233,0.25)] ring-2 ring-white/10">
                            {tip.icon}
                        </div>
                        <div className="min-w-0 text-left">
                            <h4 className="text-sm font-bold text-white tracking-wide">{tip.title}</h4>
                            <p className="text-xs text-slate-400 leading-relaxed mt-0.5">{tip.desc}</p>
                        </div>
                    </div>
                </div>
            ))}
        </div>

        <button
            aria-label="Next"
            onClick={onNext}
            className="group bg-white text-slate-950 font-bold py-4 px-12 rounded-2xl hover:bg-sky-50 transition-all transform hover:scale-105 hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] flex items-center gap-3 mx-auto relative overflow-hidden"
        >
            <span className="relative z-10">Next</span>
            <ArrowRightIcon className="w-5 h-5 relative z-10 group-hover:translate-x-1 transition-transform" />
            <div className="absolute inset-0 bg-gradient-to-r from-sky-100 to-white opacity-0 group-hover:opacity-100 transition-opacity"></div>
        </button>
    </div>
);
