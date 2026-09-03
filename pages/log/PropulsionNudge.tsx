/**
 * PropulsionNudge — the "Looks like you're sailing / under power" banner,
 * extracted verbatim from pages/LogPage.tsx. The caller keeps the guard that
 * decides whether the declared and estimated propulsion sustainedly disagree.
 */
import React from 'react';
import type { evaluatePropulsionConflict } from '../../services/shiplog/propulsion';

export const PropulsionNudge: React.FC<{
    propConflict: ReturnType<typeof evaluatePropulsionConflict>;
    engineRunning: boolean | undefined;
    toggleEngine: (running: boolean) => void;
    setNudgeDismiss: React.Dispatch<React.SetStateAction<{ until: number; forDeclared: boolean | undefined } | null>>;
}> = ({ propConflict, engineRunning, toggleEngine, setNudgeDismiss }) => (
    <div
        className="fixed inset-x-0 z-10000 flex justify-center px-4 animate-in fade-in slide-in-from-bottom-4 duration-300"
        style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 76px)' }}
        role="alert"
    >
        <div className="w-full max-w-sm rounded-2xl bg-slate-900/96 border border-sky-400/40 shadow-2xl shadow-black/50 px-4 py-3 backdrop-blur-md">
            <div className="flex items-start gap-2.5">
                <span className="text-lg leading-none mt-0.5">{propConflict.suggested === 'sail' ? '⛵' : '⚙'}</span>
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold text-white">
                        {propConflict.suggested === 'sail'
                            ? 'Looks like you’re sailing'
                            : 'Looks like you’re under power'}
                    </div>
                    <div className="text-xs text-white/75 leading-snug mt-0.5">
                        Logged as {engineRunning ? 'motoring' : 'sailing'} — switch it?
                    </div>
                    <div className="flex gap-2 mt-2.5">
                        <button
                            onClick={() => toggleEngine(propConflict.suggested === 'motor')}
                            className="flex-1 h-11 rounded-xl bg-sky-500 text-white text-[12px] font-extrabold uppercase tracking-wider active:scale-[0.97] transition-transform"
                        >
                            Switch to {propConflict.suggested === 'sail' ? 'Sailing' : 'Motoring'}
                        </button>
                        <button
                            onClick={() =>
                                setNudgeDismiss({
                                    until: Date.now() + 10 * 60 * 1000,
                                    forDeclared: engineRunning,
                                })
                            }
                            className="px-3 h-11 rounded-xl bg-white/10 text-white/60 text-[12px] font-bold active:scale-[0.97] transition-transform"
                        >
                            Dismiss
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
);
