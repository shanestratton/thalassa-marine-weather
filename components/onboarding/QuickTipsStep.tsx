/**
 * QuickTipsStep — Onboarding Step 2: Swipeable intro cards for each main tab.
 * 4 cards: WX → MAP → CHAT → VESSEL, each highlighting accurate features.
 */
import React, { useState } from 'react';

interface QuickTipsStepProps {
    onNext: () => void;
}

const CARDS = [
    {
        badge: 'WX TAB',
        emoji: '🌊',
        title: 'Your Weather',
        subtitle: 'Real-time marine forecasts at your fingertips',
        features: [
            { icon: '🌤️', text: 'Live conditions with multi-model AI blending' },
            { icon: '🌊', text: 'Tide charts, wave height, and swell periods' },
            { icon: '📊', text: '10-day forecast with hourly detail' },
        ],
        gradient: 'from-sky-900/60 to-slate-900/80',
        accentColor: 'sky',
    },
    {
        badge: 'MAP TAB',
        emoji: '🗺️',
        title: 'Your Charts',
        subtitle: 'Wind, waves, and weather right on the map',
        features: [
            { icon: '🌬️', text: 'Real-time wind particle overlay (NOAA GFS)' },
            { icon: '⛈️', text: 'Squall detection and satellite IR overlay' },
            { icon: '📍', text: 'Track your vessel live with GPS wake trail' },
        ],
        gradient: 'from-teal-900/60 to-slate-900/80',
        accentColor: 'teal',
    },
    {
        badge: 'CHAT TAB',
        emoji: '💬',
        title: 'Crew Talk',
        subtitle: 'Connect with sailors worldwide',
        features: [
            { icon: '📡', text: 'Join channels and chat with the fleet' },
            { icon: '📌', text: 'Share pins, tracks, and points of interest' },
            { icon: '🍳', text: "The Captain's Table — community recipes" },
        ],
        gradient: 'from-indigo-900/60 to-slate-900/80',
        accentColor: 'indigo',
    },
    {
        badge: 'VESSEL TAB',
        emoji: '⛵',
        title: 'Your Vessel',
        subtitle: 'Everything about your boat in one place',
        features: [
            { icon: '📓', text: 'Logbook, diary, and voyage tracking' },
            { icon: '🔧', text: "Ship's stores, galley, and maintenance" },
            { icon: '📡', text: 'NMEA instrument gauges from your backbone' },
        ],
        gradient: 'from-amber-900/40 to-slate-900/80',
        accentColor: 'amber',
    },
];

export const QuickTipsStep: React.FC<QuickTipsStepProps> = ({ onNext }) => {
    const [cardIndex, setCardIndex] = useState(0);
    const card = CARDS[cardIndex];
    const isLast = cardIndex === CARDS.length - 1;

    const handleNext = () => {
        if (isLast) {
            onNext();
        } else {
            setCardIndex((i) => i + 1);
        }
    };

    const handleSkip = () => {
        onNext();
    };

    return (
        <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 relative flex flex-col items-center">
            {/* Card */}
            <div
                key={cardIndex}
                className="w-full max-w-sm rounded-2xl overflow-hidden border border-white/[0.08] shadow-2xl animate-in fade-in slide-in-from-right-6 duration-400"
            >
                {/* Hero area with gradient + emoji */}
                <div
                    className={`relative bg-gradient-to-b ${card.gradient} h-[200px] flex flex-col items-center justify-center`}
                >
                    {/* Tab badge */}
                    <div className="absolute top-3 right-3">
                        <span className="px-3 py-1 bg-white/[0.12] backdrop-blur-md rounded-full text-[11px] font-bold text-white/70 uppercase tracking-[0.15em]">
                            {card.badge}
                        </span>
                    </div>
                    {/* Large emoji */}
                    <span className="text-7xl drop-shadow-2xl">{card.emoji}</span>
                </div>

                {/* Content area */}
                <div className="bg-slate-900/95 px-6 py-5">
                    <h2 className="text-xl font-black text-white mb-1">{card.title}</h2>
                    <p className="text-sm text-white/50 mb-5">{card.subtitle}</p>

                    <div className="space-y-3.5">
                        {card.features.map((f) => (
                            <div key={f.text} className="flex items-start gap-3">
                                <span className="text-base flex-shrink-0 mt-0.5">{f.icon}</span>
                                <span className="text-sm text-white/70 leading-snug">{f.text}</span>
                            </div>
                        ))}
                    </div>

                    {/* Progress dots + navigation */}
                    <div className="flex items-center justify-between mt-6">
                        <div className="flex gap-1.5">
                            {CARDS.map((_, i) => (
                                <div
                                    key={i}
                                    className={`h-2 rounded-full transition-all duration-300 ${
                                        i === cardIndex
                                            ? 'w-5 bg-sky-500'
                                            : i < cardIndex
                                              ? 'w-2 bg-sky-500/40'
                                              : 'w-2 bg-white/15'
                                    }`}
                                />
                            ))}
                        </div>
                        <div className="flex items-center gap-3">
                            {!isLast && (
                                <button
                                    aria-label="Skip tips"
                                    onClick={handleSkip}
                                    className="text-sm text-white/40 hover:text-white/60 transition-colors py-2 px-2"
                                >
                                    Skip
                                </button>
                            )}
                            <button
                                aria-label={isLast ? 'Get Started' : 'Next tip'}
                                onClick={handleNext}
                                className="px-5 py-2 rounded-xl border border-sky-500/30 text-sm font-bold text-sky-400 hover:bg-sky-500/10 transition-all active:scale-95"
                            >
                                {isLast ? 'Get Started' : 'Next'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
