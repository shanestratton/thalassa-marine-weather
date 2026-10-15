/**
 * Skipper's Reference — the four marine-weather reference cards folded into Thalassa from the
 * Passage-Maker's Weather Pack (GRIB in 60s, Synoptic Decoder, Forecast Decoder, Squalls & Cyclone
 * Rules). The pack's Go/No-Go scorer is gone (132-B23); the Departure Window on the Plan tab finds
 * leaving times.
 *
 * Hub → card: a list of laminate-style cards; tap one to read it full-screen. Content is the pure,
 * trusted data module in services/reference/skipperReferenceCards.ts; bodyHtml is authored constant
 * markup rendered via dangerouslySetInnerHTML (no user input).
 *
 * The house shell since 132-B23 (binder audit SR-3, SR-4): PageHeader with the Boat Binder crumb,
 * so Back is the 44 pt chevron and the page no longer pads a second notch band under the app
 * header's. The GPX import page's shell around it: the page is exactly the view's height and its
 * own list is the scroller, faded over the tab bar and padded clear of it, so the last lines never
 * sit under the bar. The hub fits one screen and fills it (styles/menu-page-fit.css, pinned in
 * browser-tests/menu-pages-fit.spec.ts).
 *
 * The synoptic and cyclone cards follow the skipper's hemisphere (SR-5, SR-6): from the GPS, else
 * the forecast's place, and the card says which; the skipper can pick the other one.
 */
import React, { useId, useMemo, useState } from 'react';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { useLocationStore } from '../../stores/LocationStore';
import {
    skipperReferenceCards,
    type Hemisphere,
    type ReferenceCard,
    type ReferenceStep,
} from '../../services/reference/skipperReferenceCards';
import { CHOSEN_HEMISPHERE_WORDS, hemisphereFromPlace } from '../../services/reference/referenceHemisphere';

const BINDER = 'Boat Binder';
const PAGE_TITLE = "Skipper's Reference";

/** The GPX import page's shell: the view's height, nothing scrolls but the list inside. */
const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="relative flex h-full flex-1 flex-col overflow-hidden bg-slate-950 text-slate-100 slide-up-enter">
        {children}
    </div>
);

const Steps: React.FC<{ steps: ReferenceStep[]; level?: 2 | 3 }> = ({ steps, level = 2 }) => {
    const Heading = level === 3 ? 'h3' : 'h2';
    return (
        <>
            {steps.map((step) => (
                <div key={step.num} className="rounded-2xl border border-white/10 bg-white/3 p-3.5">
                    <div className="flex items-baseline gap-2.5">
                        <span className="inline-flex items-center justify-center w-5 h-5 shrink-0 rounded-full bg-sky-500/20 text-sky-300 text-[11px] font-black">
                            {step.num}
                        </span>
                        <Heading className="text-[12px] font-bold uppercase tracking-wider text-sky-300/90">
                            {step.heading}
                        </Heading>
                    </div>
                    <div
                        className="mt-2 pl-[30px] text-[13px] leading-relaxed text-slate-300 [&_strong]:font-semibold [&_strong]:text-white [&_em]:italic [&_em]:text-slate-200 [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded-sm"
                        // Authored, trusted, constant marine-met copy (services/reference/skipperReferenceCards.ts) — not user input.
                        dangerouslySetInnerHTML={{ __html: step.bodyHtml }}
                    />
                </div>
            ))}
        </>
    );
};

const HEMISPHERES: { id: Hemisphere; label: string }[] = [
    { id: 'south', label: 'Southern' },
    { id: 'north', label: 'Northern' },
];

/** Two 44 pt buttons and the line saying where the choice came from. */
const HemispherePicker: React.FC<{ value: Hemisphere; words: string; onPick: (hemisphere: Hemisphere) => void }> = ({
    value,
    words,
    onPick,
}) => {
    const labelId = useId();
    return (
        <div className="rounded-2xl border border-white/10 bg-white/3 p-3">
            <p id={labelId} className="text-[11px] font-bold uppercase tracking-wider text-sky-300/90">
                Your hemisphere
            </p>
            <div role="group" aria-labelledby={labelId} className="mt-2 flex gap-2">
                {HEMISPHERES.map(({ id, label }) => (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={value === id}
                        onClick={() => onPick(id)}
                        className={`min-h-11 flex-1 rounded-xl border px-3 text-[13px] font-bold transition-colors ${
                            value === id
                                ? 'border-sky-400/50 bg-sky-500/20 text-white'
                                : 'border-white/10 bg-white/3 text-slate-300 hover:bg-white/6'
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <p className="mt-2 text-[11.5px] leading-snug text-slate-400">{words}</p>
        </div>
    );
};

const CardDetail: React.FC<{ card: ReferenceCard; onBack: () => void; picker?: React.ReactNode }> = ({
    card,
    onBack,
    picker,
}) => {
    const regionId = useId();
    return (
        <Page>
            {/* Back goes to the hub, which the trail names. */}
            <PageHeader title={card.title} onBack={onBack} breadcrumbs={[BINDER, PAGE_TITLE, card.title]} />
            <div
                key={card.id}
                className="skipper-ref-scroll thalassa-scroll-fade thalassa-scroll-fade--nav min-h-0 flex-1 overflow-y-auto px-4"
            >
                <div className="skipper-ref-body space-y-3">
                    <p className="text-[13px] leading-snug text-slate-300">
                        <span aria-hidden="true">{card.emoji} </span>
                        {card.subtitle}
                    </p>
                    {picker}
                    <Steps steps={card.steps} />

                    {/* Detail that holds for one region only, under its own label (132-B23). */}
                    {card.region && (
                        <section
                            aria-labelledby={regionId}
                            className="space-y-3 rounded-2xl border border-teal-400/25 bg-teal-500/5 p-3"
                        >
                            <div>
                                <h2
                                    id={regionId}
                                    className="text-[11px] font-bold uppercase tracking-wider text-teal-300"
                                >
                                    {card.region.label}
                                </h2>
                                <p className="mt-0.5 text-[11.5px] leading-snug text-slate-400">{card.region.note}</p>
                            </div>
                            <Steps steps={card.region.steps} level={3} />
                        </section>
                    )}

                    {/* Callout — the cautionary / auto-no-go checklist */}
                    <div className="rounded-2xl border border-amber-400/30 bg-amber-500/8 p-3.5">
                        <h2 className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                            {card.callout.label}
                        </h2>
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
            </div>
        </Page>
    );
};

export const SkipperReference: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [openId, setOpenId] = useState<string | null>(null);
    // The hemisphere the skipper picked on a card, kept while the page is open.
    const [picked, setPicked] = useState<Hemisphere | null>(null);
    const found = hemisphereFromPlace(useLocationStore());
    const hemisphere = picked ?? found.hemisphere;
    const cards = useMemo(() => skipperReferenceCards(hemisphere), [hemisphere]);
    const open = openId ? cards.find((c) => c.id === openId) : undefined;

    if (open) {
        return (
            <CardDetail
                card={open}
                onBack={() => {
                    triggerHaptic('light');
                    setOpenId(null);
                }}
                picker={
                    open.hemisphere && (
                        <HemispherePicker
                            value={hemisphere}
                            words={picked ? CHOSEN_HEMISPHERE_WORDS : found.words}
                            onPick={(next) => {
                                triggerHaptic('light');
                                setPicked(next);
                            }}
                        />
                    )
                }
            />
        );
    }

    return (
        <Page>
            <PageHeader
                title={PAGE_TITLE}
                subtitle="Weather cards"
                onBack={onBack}
                breadcrumbs={[BINDER, PAGE_TITLE]}
            />
            {/* A size container: the cards' subtitles take the lines the page has room for. */}
            <div
                key="hub"
                className="skipper-ref-scroll skipper-ref-hub thalassa-scroll-fade thalassa-scroll-fade--nav min-h-0 flex-1 overflow-y-auto px-4"
            >
                <div className="skipper-ref-body">
                    <p className="text-[12px] leading-snug text-slate-400">
                        Quick-reference cards from the Passage-Maker&apos;s Weather Pack, by the crew behind Thalassa.
                        Decision aids, not the decision.
                    </p>
                    <div className="skipper-ref-cards">
                        {cards.map((card) => (
                            <button
                                key={card.id}
                                type="button"
                                // The name is the title; the subtitle, cut to fit on a short
                                // screen, is read whole as its description.
                                aria-label={card.title}
                                aria-describedby={`skipper-ref-${card.id}`}
                                onClick={() => {
                                    triggerHaptic('light');
                                    setOpenId(card.id);
                                }}
                                className="skipper-ref-card w-full text-left rounded-2xl border border-white/10 bg-white/3 px-3.5 py-2 flex items-center gap-3 hover:bg-white/6 active:scale-[0.99] transition-all"
                            >
                                <span className="text-2xl shrink-0" aria-hidden="true">
                                    {card.emoji}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[14px] font-bold text-white leading-tight">
                                        {card.title}
                                    </span>
                                    <span
                                        id={`skipper-ref-${card.id}`}
                                        className="skipper-ref-card-sub mt-0.5 text-[12px] text-slate-400 leading-snug"
                                    >
                                        {card.subtitle}
                                    </span>
                                </span>
                                <svg
                                    aria-hidden="true"
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
                    </div>
                </div>
            </div>
        </Page>
    );
};

export default SkipperReference;
