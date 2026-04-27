import React from 'react';

interface WelcomeBannerProps {
    onDismiss: () => void;
}

export const WelcomeBanner: React.FC<WelcomeBannerProps> = ({ onDismiss }) => (
    <div className="mx-4 mt-3 fade-slide-down" role="banner" aria-label="Welcome to the Scuttlebutt">
        <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
            <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white/90">Welcome aboard</p>
                <p className="text-[11px] text-white/50 mt-0.5">
                    Pick a channel to join the conversation, or open a DM from any sailor's avatar.
                </p>
            </div>
            <button
                onClick={onDismiss}
                aria-label="Dismiss welcome message"
                className="w-11 h-11 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/40 hover:text-white/70 text-sm transition-all flex-shrink-0"
            >
                ✕
            </button>
        </div>
    </div>
);
