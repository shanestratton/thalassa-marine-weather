/**
 * OnboardingOverlay — 3-screen first-time user walkthrough.
 * Shown once on first app open. Auto-dismissed, stored in localStorage.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
    WaveIcon,
    MapIcon,
    ChatIcon,
    SailBoatIcon,
    PartlyCloudyIcon,
    DiamondIcon,
    WindIcon,
    AnchorIcon,
    PowerBoatIcon,
} from '../Icons';

const STORAGE_KEY = 'thalassa_onboarding_complete';

interface OnboardingSlide {
    Icon: React.FC<{ className?: string }>;
    title: string;
    subtitle: string;
    features: { Icon?: React.FC<{ className?: string }>; text: string }[];
    accent: string;
    tab: string;
}

const slides: OnboardingSlide[] = [
    {
        Icon: WaveIcon,
        title: 'Your Weather',
        subtitle: 'Real-time marine forecasts at your fingertips',
        features: [
            { Icon: PartlyCloudyIcon, text: 'Multi-model forecasts offshore' },
            { Icon: WaveIcon, text: 'Tide charts, wave height, and swell periods' },
            { Icon: DiamondIcon, text: 'AI-generated tactical advice for your vessel' },
        ],
        accent: 'from-sky-500/20 to-cyan-500/10',
        tab: 'The Glass',
    },
    {
        Icon: MapIcon,
        title: 'Your Charts',
        subtitle: 'Wind, waves, and weather right on the map',
        features: [
            { Icon: WindIcon, text: 'Real-time wind particle overlay (NOAA GFS)' },
            { Icon: WaveIcon, text: 'Ocean currents, waves, SST, and sea state' },
            { Icon: SailBoatIcon, text: 'Track your vessel live with GPS' },
        ],
        accent: 'from-emerald-500/20 to-teal-500/10',
        tab: 'Charts',
    },
    {
        Icon: ChatIcon,
        title: 'The Scuttlebutt',
        subtitle: 'Where sailors gather, share, and swap tales',
        features: [
            { text: 'Channels and DMs with sailors worldwide' },
            { text: 'Drop pins to share anchorages, POIs, and tracks' },
            { text: 'Crew Chat — private group for your invited crew' },
        ],
        accent: 'from-indigo-500/20 to-violet-500/10',
        tab: 'Scuttlebutt',
    },
    {
        Icon: SailBoatIcon,
        title: 'Your Vessel',
        subtitle: 'Everything about your boat in one place',
        features: [
            { text: 'Logbook, diary, and voyage tracking' },
            { Icon: PowerBoatIcon, text: "Maintenance, equipment, and ship's stores" },
            { text: 'Meal planning + community recipe library' },
            { Icon: AnchorIcon, text: 'Anchor watch + MOB safety systems' },
        ],
        accent: 'from-amber-500/20 to-orange-500/10',
        tab: 'Nav Station',
    },
];

export const OnboardingOverlay: React.FC = () => {
    // Default to HIDDEN. Returning users on a fresh install hit a
    // race where this overlay's useState initializer read
    // localStorage before useAppController's boats-row check could
    // back-fill the "I've seen this" flag — they'd see the intro
    // slides flash for a second. Polling for the flag (previous
    // attempt) helped but didn't eliminate the flash, especially
    // now that pullFromCloud blocks on Geolocation permission
    // (which holds the whole chain).
    //
    // New model: never show by default. The OnboardingWizard's
    // handleOnboardingComplete dispatches `thalassa:show-intro-
    // overlay` after a brand-new account finishes vessel setup —
    // THAT's the only moment we show the intro slides. Returning
    // users never trigger the wizard, never trigger the event,
    // never see this. Subsequent launches: STORAGE_KEY is already
    // set by previous dismiss, so even if the event somehow fires
    // we stay hidden.
    const [visible, setVisible] = useState(false);
    const [current, setCurrent] = useState(0);

    useEffect(() => {
        const handler = () => {
            try {
                if (localStorage.getItem(STORAGE_KEY)) return; // already seen
            } catch {
                /* private mode — show anyway */
            }
            setVisible(true);
            setCurrent(0);
        };
        window.addEventListener('thalassa:show-intro-overlay', handler);
        return () => window.removeEventListener('thalassa:show-intro-overlay', handler);
    }, []);

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
                        <span className="text-white/90" style={{ filter: 'drop-shadow(0 4px 20px rgba(0,0,0,0.3))' }}>
                            <slide.Icon className="w-20 h-20" />
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
                                    {f.Icon && (
                                        <span className="shrink-0 mt-0.5 text-sky-300/70">
                                            <f.Icon className="w-4 h-4" />
                                        </span>
                                    )}
                                    <span className="text-sm leading-relaxed text-white/70">{f.text}</span>
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
