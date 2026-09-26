/**
 * UnavailableNotice — the one "not available here" layout.
 *
 * Calypso (parked), Apple Music (off the iPhone app) and Boat Network (off the
 * iPhone app) each drew their own version: a bare blue card, an icon tile with
 * an eyebrow and a gradient band, and an amber lock card (UX scorecard run 6).
 * They now share one card: an icon chip, a balanced heading, plain body copy
 * and, when there is somewhere useful to go, secondary buttons. Only the tone
 * and the words vary.
 *
 * The heading and body sit in a status region so VoiceOver announces why the
 * page is closed. The buttons stay outside it: a live region is for the state
 * sentence, not for controls.
 */
import React from 'react';
import { PageHeader } from './PageHeader';

export type UnavailableTone = 'sky' | 'amber';

const TONE: Record<UnavailableTone, { card: string; chip: string; body: string }> = {
    sky: {
        card: 'border-sky-400/25 bg-sky-500/10',
        chip: 'bg-sky-400/15 text-sky-300',
        body: 'text-sky-100/80',
    },
    amber: {
        card: 'border-amber-400/25 bg-amber-500/10',
        chip: 'bg-amber-400/15 text-amber-300',
        body: 'text-amber-100/80',
    },
};

export interface UnavailableNoticeProps {
    tone?: UnavailableTone;
    /** A stroke icon. Decorative: the heading carries the meaning. */
    icon?: React.ReactNode;
    title: string;
    /** Body paragraphs (<p> elements). */
    children?: React.ReactNode;
    /** Optional smaller follow-up line under the body. */
    note?: React.ReactNode;
    /** Secondary buttons (ui/Button) to the places that still work. */
    actions?: React.ReactNode;
}

export const UnavailableNotice: React.FC<UnavailableNoticeProps> = ({
    tone = 'sky',
    icon,
    title,
    children,
    note,
    actions,
}) => {
    const t = TONE[tone];
    return (
        <div className="mx-auto w-full max-w-2xl p-5 pt-2 sm:p-8 sm:pt-2">
            <div className={`rounded-2xl border p-6 text-center ${t.card}`}>
                {icon && (
                    <div
                        aria-hidden="true"
                        className={`mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full ${t.chip}`}
                    >
                        {icon}
                    </div>
                )}
                <div role="status">
                    <h2 className="text-lg font-bold text-white text-balance">{title}</h2>
                    {children && (
                        <div
                            className={`mx-auto mt-2 max-w-lg space-y-3 text-sm leading-relaxed text-pretty ${t.body}`}
                        >
                            {children}
                        </div>
                    )}
                    {note && (
                        <p className="mx-auto mt-3 max-w-lg text-xs leading-relaxed text-white/60 text-pretty">
                            {note}
                        </p>
                    )}
                </div>
                {actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
            </div>
        </div>
    );
};

/** A whole routed page that is closed here: the house header plus the notice. */
export const UnavailablePage: React.FC<
    UnavailableNoticeProps & { pageTitle: string; pageSubtitle?: string; onBack: () => void }
> = ({ pageTitle, pageSubtitle, onBack, ...notice }) => (
    <div className="flex h-full flex-col">
        <PageHeader title={pageTitle} subtitle={pageSubtitle} onBack={onBack} />
        <div className="flex-1 overflow-y-auto">
            <UnavailableNotice {...notice} />
        </div>
    </div>
);
