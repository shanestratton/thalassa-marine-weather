import React from 'react';
import { triggerHaptic } from '../../utils/system';

interface AuthBannerProps {
    onSignIn: () => void;
    onDismiss: () => void;
}

export const AuthBanner: React.FC<AuthBannerProps> = ({ onSignIn, onDismiss }) => (
    <div className="mx-4 mt-3 mb-1 p-3 rounded-xl bg-violet-500/[0.06] border border-violet-500/15 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-violet-500/10">
            <span className="text-lg">👥</span>
        </div>
        <div className="flex-1">
            <p className="text-xs font-bold text-white">Sign In Required</p>
            <p className="text-[10px] text-gray-400">Sign in to share registers with crew</p>
        </div>
        <button
            onClick={() => {
                triggerHaptic('light');
                onSignIn();
            }}
            className="px-3 py-1.5 bg-white text-slate-900 text-[11px] font-bold rounded-lg hover:bg-gray-100 transition-all active:scale-95"
        >
            Sign In
        </button>
        <button
            onClick={onDismiss}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Dismiss install prompt"
        >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    </div>
);
