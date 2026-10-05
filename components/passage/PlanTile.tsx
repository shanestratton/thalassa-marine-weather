/**
 * PlanTile — the face of the Plan page's ways in: Trip · Legs, Saved routes,
 * Past voyages and Plan Your Day (Shane 2026-10-05: "the only screen i dont
 * really like, is the planning, it looks very messy. can you make it pop.
 * cleaner. dont lose any information from it").
 *
 * The four wear the Vessel page's Diary and Scuttlebutt surface
 * (vesselHub/JournalCard): the sky accent as a soft wash, a raised icon tile,
 * the title and a subline. The caller owns the root (a button, or the Trip
 * tile's div with its native select laid over it) and gives it
 * PLAN_TILE_CLASS and PLAN_TILE_STYLE; this draws what is inside.
 *
 * The tile grows with the page (styles/plan-page.css): a short tile is one
 * row with the short subline; a taller one puts the icon and title on one row
 * with the full subline beneath; a tall one stacks, icon on top, words at its
 * foot, an arrow in the corner and a large faint glyph behind. The full
 * subline is always the tile's description, so nothing is lost to VoiceOver
 * when the short one shows.
 */
import React from 'react';
import { JOURNAL_CARD, JOURNAL_CHIP } from '../vesselHub/JournalCard';
import { daylightUiColor } from '../../utils/daylightUiColor';

/** The page's one accent, the Vessel hub's sky. */
export const PLAN_ACCENT = daylightUiColor('#7dd3fc');
export const PLAN_TILE_STYLE = JOURNAL_CARD;
export const PLAN_TILE_CLASS = 'plan-tile card-lift text-left transition-all active:scale-[0.98]';

export const PlanTileFace: React.FC<{
    icon: React.ReactNode;
    title: string;
    /** The full subline: the tile's description, shown when there is room. */
    sub: string;
    /** The same facts in fewer words, for a short or narrow tile. */
    short: string;
    subId: string;
    /** 'pick' draws a chevron for a picker (the Trip tile's select). */
    go?: 'open' | 'pick';
    /** Hide the face from VoiceOver when the control laid over it carries
     *  the name (the subline stays its description by reference). */
    hidden?: boolean;
}> = ({ icon, title, sub, short, subId, go = 'open', hidden }) => (
    <span className="plan-tile-body" aria-hidden={hidden || undefined}>
        <span aria-hidden="true" className="plan-tile-mark" style={{ color: PLAN_ACCENT }}>
            {icon}
        </span>
        <span aria-hidden="true" className="plan-tile-icon" style={{ ...JOURNAL_CHIP, color: PLAN_ACCENT }}>
            {icon}
        </span>
        <span className="plan-tile-text">
            <span className="plan-tile-title text-white">{title}</span>
            <span id={subId} className="plan-tile-sub" style={{ color: daylightUiColor('#94a3b8') }}>
                {sub}
            </span>
            <span aria-hidden="true" className="plan-tile-short" style={{ color: daylightUiColor('#94a3b8') }}>
                {short}
            </span>
        </span>
        <svg
            aria-hidden="true"
            className="plan-tile-go"
            fill="none"
            viewBox="0 0 24 24"
            stroke={PLAN_ACCENT}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={go === 'pick' ? 'M6 9l6 6 6-6' : 'M7 17L17 7M9 7h8v8'} />
        </svg>
    </span>
);
