import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The stand-in-question fixture is available only through the development server.');

// Isolation: no network at all. The two modals are pure presentation.
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Stand-in fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Large text: the root size the draft-confirm and Shore Watch fixtures use.
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';
// A long, fictional boat name: the title must wrap, never clip or push the buttons off.
const boatName = params.get('boat') ?? 'Wandering Albatross of Port Moselle';

const [{ StandInQuestionModal }, { GpsDisclaimerModal }] = await Promise.all([
    import('../../pages/log/StandInQuestionModal'),
    import('../../pages/log/GpsDisclaimerModal'),
]);

function Fixture() {
    const [open, setOpen] = useState<'question' | 'notice' | null>(null);
    const [outcome, setOutcome] = useState('waiting');
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-4 text-white">
            <h1 className="ui-page-title">Log</h1>
            <button
                type="button"
                className="mt-4 min-h-11 rounded-xl bg-white/10 px-4"
                onClick={() => setOpen('question')}
            >
                Slide to Start Tracking
            </button>
            <button
                type="button"
                className="mt-4 ml-2 min-h-11 rounded-xl bg-white/10 px-4"
                onClick={() => setOpen('notice')}
            >
                Phone notice
            </button>
            <output data-testid="outcome" className="mt-4 block text-sm text-slate-300">
                {outcome}
            </output>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span className="text-sky-300">LOG</span>
                    <span>VESSEL</span>
                </div>
            </nav>
            <StandInQuestionModal
                isOpen={open === 'question'}
                boatName={boatName}
                onAnswer={(answer) => {
                    setOpen(null);
                    setOutcome(answer);
                }}
                onCancel={() => {
                    setOpen(null);
                    setOutcome('cancelled');
                }}
            />
            <GpsDisclaimerModal
                isOpen={open === 'notice'}
                alwaysAdvice
                onDismiss={(dontShowAgain) => {
                    setOpen(null);
                    setOutcome(dontShowAgain ? 'started, not again' : 'started');
                }}
            />
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
