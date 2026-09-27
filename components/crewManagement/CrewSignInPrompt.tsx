/**
 * CrewSignInPrompt — the signed-out view of Crew & Float Plan.
 *
 * Moved verbatim out of components/CrewManagement.tsx's `!isAuthed` early
 * return. It holds no state of its own; the early return itself (and the
 * hook-order rules that go with it) stays in CrewManagement.
 *
 * UX scorecard run 7: the wall sat vertically centred ~250 pt under the header
 * with its Sign in button left-aligned under centred copy, led with "save
 * routes" on a crew page, and gave no preview of what signing in unlocks. It
 * now lists what is behind it.
 *
 * UX scorecard run 9: it wore the centred notice (chip, centred heading, a
 * compact button) while Galley's sign-in, one tap away, wore the sign-in card
 * — two looks for one "needs an account" state. It now uses the one sign-in
 * card recipe (settings/SettingsPrimitives SignInCard, as on Account & Cloud,
 * Voyage Log and Galley): an icon tile and a left-aligned heading and reason,
 * then the full-width SignInButton. The list of what signing in unlocks sits
 * between the reason and the button. The heading says the benefit, not the
 * barrier ("Sign in to plan with your crew", not "Sign in required").
 */
import React from 'react';
import { t } from '../../theme';
import { PageHeader } from '../ui/PageHeader';
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
            {/* Back goes to the Vessel hub and the chevron says so ('Back to
                Vessel', from the parent crumb; UX scorecard run 8). The signed-in
                Crew page (CrewManagement) carries the same VESSEL crumb, so the
                header keeps its height on sign-in. The crumb goes on both
                together or neither. */}
            <PageHeader
                title="Crew & Float Plan"
                subtitle={CREW_PAGE_SUBTITLE}
                onBack={onBack}
                breadcrumbs={['Vessel', 'Crew & Float Plan']}
            />
            <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="mx-auto w-full max-w-2xl p-4">
                    <section
                        aria-labelledby="crew-sign-in-title"
                        className="space-y-4 rounded-2xl border border-white/10 bg-white/3 p-4 shadow-lg shadow-black/10"
                    >
                        <div className="flex items-start gap-3">
                            <div className="shrink-0 rounded-xl bg-white/5 p-2.5 text-gray-300" aria-hidden="true">
                                <UsersIcon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2 id="crew-sign-in-title" className="text-sm font-bold text-white">
                                    Sign in to plan with your crew
                                </h2>
                                <p className="mt-1 text-xs text-gray-400">An account unlocks:</p>
                            </div>
                        </div>
                        {/* What is behind the wall, so it is not a blind sign-in.
                            role="list": Safari drops list semantics under
                            Tailwind's list-style: none. */}
                        <ul role="list" className="flex flex-col gap-2 text-sm text-gray-300">
                            {UNLOCKS.map((item) => (
                                <li key={item.text} className="flex items-start gap-2.5">
                                    <span aria-hidden="true" className="mt-0.5 shrink-0 text-sky-300">
                                        {item.icon}
                                    </span>
                                    <span>{item.text}</span>
                                </li>
                            ))}
                        </ul>
                        <SignInButton fullWidth onClick={() => setShowAuth(true)} />
                    </section>
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
