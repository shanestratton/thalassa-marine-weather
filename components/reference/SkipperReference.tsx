/**
 * Skipper's Reference — the four marine-weather reference cards folded into Thalassa from the
 * Passage-Maker's Weather Pack (GRIB in 60s, Synoptic Decoder, Forecast Decoder, Squalls & Cyclone
 * Rules). Card #1 of the pack (Go/No-Go) is the interactive scorer — this is its reference companion.
 *
 * Hub → card: a list of laminate-style cards; tap one to read it full-screen. Content is the pure,
 * trusted data module in services/reference/skipperReferenceCards.ts; bodyHtml is authored constant
 * markup rendered via dangerouslySetInnerHTML (no user input).
 */
import React, { useState } from 'react';
import { triggerHaptic } from '../../utils/system';
import { SKIPPER_REFERENCE_CARDS, type ReferenceCard } from '../../services/reference/skipperReferenceCards';

const BackButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
    <button type="button" onClick={onClick} aria-label="Back" className="p-1.5 -ml-1.5 rounded-lg hover:bg-white/10">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
    </button>
);

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="flex flex-col h-full min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
        {children}
    </div>
);

const CardDetail: React.FC<{ card: ReferenceCard; onBack: () => void }> = ({ card, onBack }) => (
    <Shell>
        <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-slate-950/85 backdrop-blur-xl border-b border-white/10 pt-[env(safe-area-inset-top)]">
            <BackButton onClick={onBack} />
            <div className="flex-1 min-w-0">
                <h1 className="text-[15px] font-bold tracking-tight truncate">
                    {card.emoji} {card.title}
                </h1>
                <p className="text-[11px] text-slate-400 truncate">{card.subtitle}</p>
            </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-28 pt-3 space-y-3">
            {card.steps.map((step) => (
                <div key={step.num} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
                    <div className="flex items-baseline gap-2.5">
                        <span className="inline-flex items-center justify-center w-5 h-5 shrink-0 rounded-full bg-sky-500/20 text-sky-300 text-[11px] font-black">
                            {step.num}
                        </span>
                        <h2 className="text-[12px] font-bold uppercase tracking-wider text-sky-300/90">
                            {step.heading}
                        </h2>
                    </div>
                    <div
                        className="mt-2 pl-[30px] text-[13px] leading-relaxed text-slate-300 [&_strong]:font-semibold [&_strong]:text-white [&_em]:italic [&_em]:text-slate-200 [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded"
                        // Authored, trusted, constant marine-met copy (services/reference/skipperReferenceCards.ts) — not user input.
                        dangerouslySetInnerHTML={{ __html: step.bodyHtml }}
                    />
                </div>
            ))}

            {/* Callout — the cautionary / auto-no-go checklist */}
            <div className="rounded-2xl border border-amber-400/30 bg-amber-500/[0.08] p-3.5">
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-amber-300">{card.callout.label}</h2>
                <ul className="mt-2 space-y-1.5">
                    {card.callout.items.map((item, i) => (
                        <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-amber-100/90">
                            <span aria-hidden className="text-amber-400">
                                ⚑
                            </span>
                            <span>{item}</span>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Pullquote */}
            <blockquote className="border-l-2 border-sky-400/50 pl-3 py-0.5 italic text-[13.5px] leading-snug text-slate-200">
                “{card.pullquote}”
            </blockquote>

            {/* Sources */}
            <p className="text-[10.5px] text-slate-500 leading-relaxed border-t border-white/10 pt-2.5">
                {card.sources}
            </p>
        </div>
    </Shell>
);

export const SkipperReference: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [openId, setOpenId] = useState<string | null>(null);
    const open = openId ? SKIPPER_REFERENCE_CARDS.find((c) => c.id === openId) : undefined;

    if (open) {
        return (
            <CardDetail
                card={open}
                onBack={() => {
                    triggerHaptic('light');
                    setOpenId(null);
                }}
            />
        );
    }

    return (
        <Shell>
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-slate-950/85 backdrop-blur-xl border-b border-white/10 pt-[env(safe-area-inset-top)]">
                <BackButton onClick={onBack} />
                <div className="flex-1">
                    <h1 className="text-[15px] font-bold tracking-tight">Skipper's Reference</h1>
                    <p className="text-[11px] text-slate-400">Read the weather like a passage-maker</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-28 pt-3 space-y-3">
                <p className="text-[12px] text-slate-400 leading-relaxed">
                    Quick-reference cards for reading the forecast, the GRIB and the synoptic chart — and staying ahead
                    of squalls and the cyclone season. Decision aids, not the decision.
                </p>
                {SKIPPER_REFERENCE_CARDS.map((card) => (
                    <button
                        key={card.id}
                        type="button"
                        onClick={() => {
                            triggerHaptic('light');
                            setOpenId(card.id);
                        }}
                        className="w-full text-left rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex items-center gap-3.5 hover:bg-white/[0.06] active:scale-[0.99] transition-all"
                    >
                        <div className="text-2xl shrink-0" aria-hidden>
                            {card.emoji}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-[14px] font-bold text-white leading-tight">{card.title}</h2>
                            <p className="text-[12px] text-slate-400 leading-snug mt-0.5">{card.subtitle}</p>
                        </div>
                        <svg
                            className="w-4 h-4 shrink-0 text-slate-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                ))}

                <p className="text-[10.5px] text-slate-500 leading-relaxed pt-1">
                    From the Passage-Maker's Weather Pack — the crew behind Thalassa.
                </p>
            </div>
        </Shell>
    );
};

export default SkipperReference;
