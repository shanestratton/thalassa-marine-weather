/**
 * Weather Window Check — the interactive, scored Go/No-Go tool.
 *
 * Thin UI over the pure engine in services/weatherWindow/weatherWindowScore.ts.
 * The skipper answers each question; the score updates live. To call it a window
 * the score must clear the GO threshold AND trip no veto gate (a cyclone in the
 * track can't be "scored away"). Decision aid only — the skipper decides.
 */
import React, { useMemo, useState } from 'react';
import {
    QUESTIONS,
    scoreWeatherWindow,
    GO_THRESHOLD,
    MARGINAL_THRESHOLD,
    type Answers,
    type Band,
    type GateQuestion,
    type ScoredQuestion,
} from '../../services/weatherWindow/weatherWindowScore';

const BAND: Record<Band, { word: string; text: string; bg: string; ring: string; bar: string }> = {
    GO: {
        word: 'GO',
        text: 'text-emerald-300',
        bg: 'bg-emerald-500/15',
        ring: 'ring-emerald-400/40',
        bar: 'bg-emerald-400',
    },
    MARGINAL: {
        word: 'MARGINAL',
        text: 'text-amber-300',
        bg: 'bg-amber-500/15',
        ring: 'ring-amber-400/40',
        bar: 'bg-amber-400',
    },
    'NO-GO': { word: 'NO-GO', text: 'text-red-300', bg: 'bg-red-500/15', ring: 'ring-red-400/40', bar: 'bg-red-400' },
};

const gates = QUESTIONS.filter((q): q is GateQuestion => q.kind === 'gate');
const scored = QUESTIONS.filter((q): q is ScoredQuestion => q.kind === 'scored');

export const WeatherWindowCheck: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [answers, setAnswers] = useState<Answers>({});
    const result = useMemo(() => scoreWeatherWindow(answers), [answers]);
    const band = BAND[result.band];

    const pick = (qid: string, oid: string) => setAnswers((a) => ({ ...a, [qid]: oid }));

    const optionButton = (qid: string, oid: string, label: string, selected: boolean, danger: boolean) => (
        <button
            key={oid}
            type="button"
            onClick={() => pick(qid, oid)}
            className={[
                'w-full text-left px-3 py-2.5 rounded-xl text-[13px] leading-snug border transition-colors',
                selected
                    ? danger
                        ? 'bg-red-500/20 border-red-400/60 text-red-100'
                        : 'bg-sky-500/20 border-sky-400/60 text-sky-50'
                    : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10',
            ].join(' ')}
        >
            {label}
        </button>
    );

    return (
        <div className="flex flex-col h-full min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-slate-950/85 backdrop-blur-xl border-b border-white/10 pt-[env(safe-area-inset-top)]">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="p-1.5 -ml-1.5 rounded-lg hover:bg-white/10"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h1 className="text-[15px] font-bold tracking-tight">Weather Window Check</h1>
                    <p className="text-[11px] text-slate-400">
                        Go / No-Go score · needs ≥ {GO_THRESHOLD} to be a window
                    </p>
                </div>
                <div className={`px-3 py-1.5 rounded-xl text-center ring-1 ${band.bg} ${band.ring}`}>
                    <div className={`text-[15px] font-black leading-none ${band.text}`}>{result.score}</div>
                    <div className={`text-[9px] font-bold tracking-wider ${band.text}`}>{band.word}</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-28 pt-3 space-y-5">
                <p className="text-[12px] text-slate-400 leading-relaxed">
                    Answer from your <em>own</em> reading of the official forecast and GRIBs. This is a decision aid —
                    it sharpens the call, it doesn’t make it.
                </p>

                {/* Gates */}
                <section className="space-y-3">
                    <h2 className="text-[11px] font-bold uppercase tracking-wider text-red-300/90">
                        Showstoppers — any one is an automatic No-Go
                    </h2>
                    {gates.map((q) => (
                        <div
                            key={q.id}
                            className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 space-y-2.5"
                        >
                            <div className="text-[13.5px] font-semibold leading-snug">{q.prompt}</div>
                            {q.help && <div className="text-[11px] text-slate-400 -mt-1">{q.help}</div>}
                            <div className="grid gap-2">
                                {q.options.map((o) =>
                                    optionButton(q.id, o.id, o.label, answers[q.id] === o.id, o.veto),
                                )}
                            </div>
                        </div>
                    ))}
                </section>

                {/* Scored */}
                <section className="space-y-3">
                    <h2 className="text-[11px] font-bold uppercase tracking-wider text-sky-300/90">
                        Conditions — these set the score
                    </h2>
                    {scored.map((q) => (
                        <div
                            key={q.id}
                            className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 space-y-2.5"
                        >
                            <div className="text-[13.5px] font-semibold leading-snug">{q.prompt}</div>
                            {q.help && <div className="text-[11px] text-slate-400 -mt-1">{q.help}</div>}
                            <div className="grid gap-2">
                                {q.options.map((o) => optionButton(q.id, o.id, o.label, answers[q.id] === o.id, false))}
                            </div>
                        </div>
                    ))}
                </section>

                {/* Result card */}
                <section className={`rounded-2xl p-4 ring-1 ${band.bg} ${band.ring} space-y-3`}>
                    <div className="flex items-end justify-between">
                        <div className={`text-2xl font-black ${band.text}`}>{band.word}</div>
                        <div className="text-right">
                            <span className="text-2xl font-black">{result.score}</span>
                            <span className="text-sm text-slate-400">/100</span>
                        </div>
                    </div>

                    {/* Score bar with marginal + go zones */}
                    <div className="relative h-2.5 rounded-full overflow-hidden bg-slate-700/50">
                        <div
                            className="absolute inset-y-0 left-0 bg-red-500/30"
                            style={{ width: `${MARGINAL_THRESHOLD}%` }}
                        />
                        <div
                            className="absolute inset-y-0 bg-amber-500/30"
                            style={{ left: `${MARGINAL_THRESHOLD}%`, width: `${GO_THRESHOLD - MARGINAL_THRESHOLD}%` }}
                        />
                        <div
                            className="absolute inset-y-0 bg-emerald-500/30"
                            style={{ left: `${GO_THRESHOLD}%`, right: 0 }}
                        />
                        <div
                            className={`absolute inset-y-0 left-0 ${band.bar}`}
                            style={{ width: `${result.score}%`, opacity: 0.85 }}
                        />
                        <div
                            className="absolute inset-y-0 w-0.5 bg-white/80"
                            style={{ left: `${GO_THRESHOLD}%` }}
                            title={`GO line (${GO_THRESHOLD})`}
                        />
                    </div>

                    <p className="text-[12.5px] text-slate-200 leading-snug">{result.verdict}</p>

                    {result.vetoes.length > 0 && (
                        <div className="space-y-1.5">
                            {result.vetoes.map((v, i) => (
                                <div key={i} className="flex gap-2 text-[12px] text-red-200">
                                    <span aria-hidden>⛔</span>
                                    <span>{v}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {result.vetoes.length === 0 && result.weakest.length > 0 && (
                        <div className="space-y-1">
                            <div className="text-[10.5px] font-bold uppercase tracking-wider text-amber-300/80">
                                Dragging it down
                            </div>
                            {result.weakest.map((w) => (
                                <div key={w.id} className="text-[12px] text-amber-100/90">
                                    • {w.prompt.replace(/\?$/, '')} → <span className="text-slate-300">{w.choice}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex items-center justify-between pt-1">
                        <span className="text-[11px] text-slate-400">
                            Answered {result.answered}/{result.total}
                        </span>
                        <button
                            type="button"
                            onClick={() => setAnswers({})}
                            className="text-[12px] px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-slate-200"
                        >
                            Reset
                        </button>
                    </div>

                    <p className="text-[10.5px] text-slate-500 leading-relaxed border-t border-white/10 pt-2.5">
                        {result.disclaimer}
                    </p>
                </section>
            </div>
        </div>
    );
};

export default WeatherWindowCheck;
