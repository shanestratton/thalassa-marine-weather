/**
 * CrewSignInPrompt — the "Sign in required" view of Crew & Float Plan.
 *
 * Moved verbatim out of components/CrewManagement.tsx's `!isAuthed` early
 * return. It holds no state of its own; the early return itself (and the
 * hook-order rules that go with it) stays in CrewManagement.
 *
 * UX scorecard run 7: the wall sat vertically centred ~250 pt under the header
 * with its Sign in button left-aligned under centred copy, led with "save
 * routes" on a crew page, and gave no preview of what signing in unlocks. It
 * now uses the sibling notice recipe (UnavailableNotice: a tinted card at the
 * top, icon chip, heading, body, centred action) and lists what is behind it.
 */
import React from 'react';
import { t } from '../../theme';
import { PageHeader } from '../ui/PageHeader';
import { UnavailableNotice } from '../ui/UnavailableNotice';
import { SignInButton } from '../ui/SignInButton';
import { SignInScreen } from '../SignInScreen';
import { CheckCircleIcon, LifeBuoyIcon, UsersIcon } from '../Icons';

/** The page's caption, shared with CrewManagement's own headers. */
export const CREW_PAGE_SUBTITLE = 'Readiness checks & cast off';

const UNLOCKS: ReadonlyArray<{ icon: React.ReactNode; text: string }> = [
    { icon: <CheckCircleIcon className="h-4 w-4" />, text: 'Readiness checks before you cast off' },
    { icon: <UsersIcon className="h-4 w-4" />, text: 'Invite crew to prepare the passage with you' },
    { icon: <LifeBuoyIcon className="h-4 w-4" />, text: 'A private float plan to share ashore' },
];

interface CrewSignInPromptProps {
    onBack: () => void;
    showAuth: boolean;
    setShowAuth: (open: boolean) => void;
}

export const CrewSignInPrompt: React.FC<CrewSignInPromptProps> = ({ onBack, showAuth, setShowAuth }) => {
    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
            <PageHeader title="Crew & Float Plan" subtitle={CREW_PAGE_SUBTITLE} onBack={onBack} />
            <div className="flex-1 min-h-0 overflow-y-auto">
                <UnavailableNotice
                    icon={<UsersIcon className="h-6 w-6" />}
                    title="Sign in required"
                    actions={<SignInButton onClick={() => setShowAuth(true)} />}
                >
                    <p>Sign in to check readiness with your crew and share a private float plan.</p>
                    {/* What is behind the wall, so it is not a blind sign-in.
                        role="list": Safari drops list semantics under
                        Tailwind's list-style: none. */}
                    <ul role="list" className="inline-flex flex-col gap-2 text-left">
                        {UNLOCKS.map((item) => (
                            <li key={item.text} className="flex items-start gap-2.5">
                                <span aria-hidden="true" className="mt-0.5 shrink-0 text-sky-300">
                                    {item.icon}
                                </span>
                                <span>{item.text}</span>
                            </li>
                        ))}
                    </ul>
                </UnavailableNotice>
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
