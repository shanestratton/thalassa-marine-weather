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
                        className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${t.chip}`}
                    >
                        {icon}
                    </div>
                )}
                <div role="status">
                    <h2 className="text-lg font-bold text-white text-balance">{title}</h2>
                    {/* A paragraph that wraps reads left-aligned; one that fits
                        on a line stays centred under the heading. `w-fit` with
                        auto margins does both: a one-liner shrinks to its words
                        and centres, a longer one fills the column and runs from
                        the left. Centred three-line bodies on Boat Network and
                        Music broke the house rule Calypso keeps (UX scorecard
                        run 8). No text-pretty: it pulled lines in to even out
                        the last one, so Calypso's first paragraph wrapped at
                        237 of 305 pt and sat lopsided under the heading (run 9). */}
                    {children && (
                        <div
                            className={`mx-auto mt-2 max-w-lg space-y-3 text-sm leading-relaxed ${t.body} [&>p]:mx-auto [&>p]:w-fit [&>p]:text-left`}
                        >
                            {children}
                        </div>
                    )}
                    {/* The note runs from the body's left edge, not centred on
                        its own: Boat Network stacked three alignments in one
                        card (run 9). */}
                    {note && (
                        <p className="mx-auto mt-3 max-w-lg text-left text-xs leading-relaxed text-white/60">{note}</p>
                    )}
                </div>
                {actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
            </div>
        </div>
    );
};

/** Stroke smartphone, the one glyph for "needs the iPhone app". */
const IPhoneGlyph: React.FC = () => (
    <svg
        aria-hidden="true"
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M12 18h.01" />
    </svg>
);

/**
 * One look for "this needs the iPhone app" (UX scorecard run 7). The same
 * condition was a blue note card on Music and an amber padlock card on Boat
 * Network; it is not a warning, so it is sky with a phone glyph everywhere.
 * Callers keep their own words; lead the title with the feature, e.g.
 * "Apple Music needs the Thalassa iPhone app".
 */
export const NeedsIPhoneAppNotice: React.FC<Omit<UnavailableNoticeProps, 'tone' | 'icon'>> = (props) => (
    <UnavailableNotice tone="sky" icon={<IPhoneGlyph />} {...props} />
);

/**
 * A whole routed page that is closed here: the house header plus the notice.
 * `breadcrumbs` and `backLabel` go straight to PageHeader, so a closed page
 * names its parent the way its open sibling does ('VESSEL' over the title,
 * 'Back to Vessel' on the chevron) instead of a bare 'Go back' (UX scorecard
 * run 8). Pass them only when Back really goes there.
 */
export const UnavailablePage: React.FC<
    UnavailableNoticeProps & {
        pageTitle: string;
        pageSubtitle?: string;
        onBack: () => void;
        breadcrumbs?: string[];
        backLabel?: string;
    }
> = ({ pageTitle, pageSubtitle, onBack, breadcrumbs, backLabel, ...notice }) => (
    <div className="flex h-full flex-col">
        <PageHeader
            title={pageTitle}
            subtitle={pageSubtitle}
            onBack={onBack}
            breadcrumbs={breadcrumbs}
            backLabel={backLabel}
        />
        <div className="flex-1 overflow-y-auto">
            <UnavailableNotice {...notice} />
        </div>
    </div>
);
