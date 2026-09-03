/**
 * CrewSignInPrompt — the "Sign In Required" view of Passage Planning.
 *
 * Moved verbatim out of components/CrewManagement.tsx's `!isAuthed` early
 * return. It holds no state of its own; the early return itself (and the
 * hook-order rules that go with it) stays in CrewManagement.
 */
import React from 'react';
import { t } from '../../theme';
import { PageHeader } from '../ui/PageHeader';
import { SignInScreen } from '../SignInScreen';
import { UsersIcon } from '../Icons';

interface CrewSignInPromptProps {
    onBack: () => void;
    showAuth: boolean;
    setShowAuth: (open: boolean) => void;
}

export const CrewSignInPrompt: React.FC<CrewSignInPromptProps> = ({ onBack, showAuth, setShowAuth }) => {
    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
            <PageHeader title="Passage Planning" onBack={onBack} />
            <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center">
                    <div className="mb-4 flex justify-center text-sky-300/70">
                        <UsersIcon className="w-12 h-12" />
                    </div>
                    <h2 className="text-lg font-bold text-white mb-2">Sign In Required</h2>
                    <p className="text-sm text-gray-400 max-w-xs mb-6">
                        Sign in to save routes, prepare the passage with your crew, and privately share its float plan.
                    </p>
                    <button
                        onClick={() => setShowAuth(true)}
                        className="px-6 py-3 bg-white text-slate-900 font-bold rounded-xl shadow-lg hover:bg-gray-100 transition-all active:scale-95"
                    >
                        Sign In
                    </button>
                </div>
            </div>
            <SignInScreen
                isOpen={showAuth}
                onClose={() => {
                    setShowAuth(false);
                    // No need to re-poll auth — the global authStore's
                    // onAuthStateChange listener fires when sign-in
                    // completes, and our isAuthed is derived from
                    // that store so we re-render automatically.
                }}
                prompt="Sign in to plan passages with crew and sync across devices."
            />
        </div>
    );
};
