/**
 * OnboardingOverlay — 3-screen first-time user walkthrough.
 * Shown once on first app open. Auto-dismissed, stored in localStorage.
 */
import React, { useState, useCallback } from 'react';

const STORAGE_KEY = 'thalassa_onboarding_complete';

const slides = [
    {
        icon: '🌊',
        title: 'Your Weather',
        subtitle: 'Real-time marine forecasts at your fingertips',
        features: [
            '🌤️ Multi-model forecasts offshore',
            '🌊 Tide charts, wave height, and swell periods',
            '🧠 AI-generated tactical advice for your vessel',
        ],
        accent: 'from-sky-500/20 to-cyan-500/10',
        tab: 'The Glass',
    },
    {
        icon: '🗺️',
        title: 'Your Charts',
        subtitle: 'Wind, waves, and weather right on the map',
        features: [
            '💨 Real-time wind particle overlay (NOAA GFS)',
            '🌊 Ocean currents, waves, SST, and sea state',
            '⛵ Track your vessel live with GPS',
        ],
        accent: 'from-emerald-500/20 to-teal-500/10',
        tab: 'Charts',
    },
    {
        icon: '💬',
        title: 'The Scuttlebutt',
        subtitle: 'Where sailors gather, share, and swap tales',
        features: [
            'Channels and DMs with sailors worldwide',
            'Drop pins to share anchorages, POIs, and tracks',
            'Crew Chat — private group for your invited crew',
        ],
        accent: 'from-indigo-500/20 to-violet-500/10',
        tab: 'Scuttlebutt',
    },
    {
        icon: '⛵',
        title: 'Your Vessel',
        subtitle: 'Everything about your boat in one place',
        features: [
            'Logbook, diary, and voyage tracking',
            "Maintenance, equipment, and ship's stores",
            'Meal planning + community recipe library',
            'Anchor watch + MOB safety systems',
        ],
        accent: 'from-amber-500/20 to-orange-500/10',
        tab: 'Nav Station',
    },
];

export const OnboardingOverlay: React.FC = () => {
    const [visible, setVisible] = useState(() => {
        try {
            return !localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            console.warn('Suppressed:', e);
            return true;
        }
    });
    const [current, setCurrent] = useState(0);

    const dismiss = useCallback(() => {
        try {
            localStorage.setItem(STORAGE_KEY, 'true');
        } catch (e) {
            console.warn('Suppressed:', e);
            /* noop */
        }
        setVisible(false);
    }, []);

    const next = useCallback(() => {
        if (current < slides.length - 1) {
            setCurrent((c) => c + 1);
        } else {
            dismiss();
        }
    }, [current, dismiss]);

    if (!visible) return null;

    const slide = slides[current];
    const isLast = current === slides.length - 1;

    return (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 p-6">
            <div className="w-full max-w-sm animate-in fade-in zoom-in-95 duration-300">
                {/* Card */}
                <div className="bg-slate-900 border border-white/10 rounded-3xl overflow-hidden shadow-2xl">
                    {/* Hero gradient */}
                    <div className={`relative h-48 bg-gradient-to-br ${slide.accent} flex items-center justify-center`}>
                        <span className="text-7xl" style={{ filter: 'drop-shadow(0 4px 20px rgba(0,0,0,0.3))' }}>
                            {slide.icon}
                        </span>
                        {/* Tab badge */}
                        <div className="absolute top-4 right-4 px-3 py-1 rounded-full bg-white/10 border border-white/10 text-[11px] font-bold text-white/60 uppercase tracking-widest">
                            {slide.tab} Tab
                        </div>
                    </div>

                    {/* Content */}
                    <div className="px-6 pt-5 pb-6">
                        <h2 className="text-xl font-extrabold text-white mb-1">{slide.title}</h2>
                        <p className="text-sm text-white/50 mb-5">{slide.subtitle}</p>

                        <div className="space-y-3">
                            {slide.features.map((f, i) => (
                                <div key={i} className="flex items-start gap-2.5">
                                    <span className="text-sm leading-relaxed text-white/70">{f}</span>
                                </div>
                            ))}
                        </div>

                        {/* Dots + buttons */}
                        <div className="flex items-center justify-between mt-8">
                            {/* Dots */}
                            <div className="flex gap-2">
                                {slides.map((_, i) => (
                                    <div
                                        key={i}
                                        className={`w-2 h-2 rounded-full transition-all duration-300 ${i === current ? 'bg-sky-400 w-6' : 'bg-white/20'}`}
                                    />
                                ))}
                            </div>

                            <div className="flex items-center gap-3">
                                {!isLast && (
                                    <button
                                        aria-label="Close onboarding overlay"
                                        onClick={dismiss}
                                        className="text-sm text-white/30 hover:text-white/60 transition-colors"
                                    >
                                        Skip
                                    </button>
                                )}
                                <button
                                    aria-label="Next onboarding step"
                                    onClick={next}
                                    className="px-5 py-2.5 rounded-xl bg-sky-500/20 border border-sky-500/30 text-sky-400 text-sm font-bold hover:bg-sky-500/30 transition-all active:scale-95"
                                >
                                    {isLast ? 'Get Started' : 'Next'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OnboardingOverlay;
