import React from 'react';
import { triggerHaptic } from '../../utils/system';
import { UsersIcon } from '../Icons';
import { SignInButton } from '../ui/SignInButton';

interface AuthBannerProps {
    onSignIn: () => void;
    onDismiss: () => void;
}

// Standard card surface and sentence case, matching the Welcome aboard
// notice above it — the violet card and Title Case read as a different app.
export const AuthBanner: React.FC<AuthBannerProps> = ({ onSignIn, onDismiss }) => (
    <div className="mx-4 mt-3 mb-1 p-3 rounded-2xl bg-white/3 border border-white/6 flex items-center gap-3">
        <div aria-hidden="true" className="p-1.5 rounded-lg bg-white/5 text-sky-300">
            <UsersIcon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white/90">Sign in to chat</p>
            <p className="text-xs text-gray-400">Post in channels and message other sailors.</p>
        </div>
        {/* The one sign-in control: a filled accent in daylight too, where the
            old white button vanished into the near-white card (UX scorecard
            run 6). Compact padding, so the banner stays one short row. */}
        <SignInButton
            onClick={() => {
                triggerHaptic('light');
                onSignIn();
            }}
            className="shrink-0 px-4! py-2! text-sm!"
        />
        <button
            onClick={onDismiss}
            className="hit-target-44 shrink-0 p-1 text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Dismiss sign-in banner"
        >
            <svg
                aria-hidden="true"
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    </div>
);
