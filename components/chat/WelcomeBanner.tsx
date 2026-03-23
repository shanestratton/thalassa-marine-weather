import React from 'react';
import { CREW_RANKS } from './chatUtils';

interface WelcomeBannerProps {
    onDismiss: () => void;
}

export const WelcomeBanner: React.FC<WelcomeBannerProps> = ({ onDismiss }) => (
    <div className="mx-4 mt-3 fade-slide-down" role="banner" aria-label="Welcome to Crew Talk">
        <div className="relative p-5 rounded-2xl overflow-hidden">
            {/* Premium glassmorphism bg */}
            <div className="absolute inset-0 bg-gradient-to-br from-sky-500/[0.08] via-indigo-500/[0.05] to-purple-500/[0.06] border border-sky-400/15 rounded-2xl" />
            <div className="absolute inset-0 backdrop-blur-sm" />
            <div className="relative">
                <div className="flex items-start justify-between mb-3">
                    <div>
                        <p className="text-base font-bold text-sky-300">Welcome aboard, sailor! 🌊</p>
                        <p className="text-xs text-white/50 mt-0.5">Your crew is ready to help</p>
                    </div>
                    <button
                        onClick={onDismiss}
                        aria-label="Dismiss welcome message"
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white/40 hover:text-white/70 text-sm transition-all min-w-[44px] min-h-[44px]"
                    >
                        ✕
                    </button>
                </div>
                <div className="space-y-2.5">
                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                        <span className="text-lg">📢</span>
                        <p className="text-xs text-white/60">
                            Tap the <span className="text-amber-400 font-semibold">horn</span> to mark your message as a
                            question — the crew will help
                        </p>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                        <span className="text-lg">📍</span>
                        <p className="text-xs text-white/60">
                            Use <span className="text-sky-400 font-semibold">➕</span> to drop pins, share POIs, or send
                            voyage tracks
                        </p>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                        <span className="text-lg">⭐</span>
                        <p className="text-xs text-white/60">
                            Help others to rank up:{' '}
                            {CREW_RANKS.slice(0, 4)
                                .map((r) => `${r.badge}`)
                                .join(' → ')}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </div>
);
