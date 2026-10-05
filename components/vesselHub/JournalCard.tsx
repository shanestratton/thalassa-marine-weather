/**
 * JournalCard — the Diary and Scuttlebutt cards at the top of the Vessel
 * page's lower area (Shane 2026-10-04: "maybe make the didary and scuttlebutt
 * look better, also make the whole thing take up the enitre page").
 *
 * The two are the screens a skipper reads rather than configures, so they get
 * the page's richest treatment: the hub's one accent (sky) as a soft gradient
 * wash, a raised icon tile, the title and a one-line subtitle. The pair grows
 * with the height the page is given (styles/menu-page-fit.css): a short screen
 * keeps the one-row card, 44 pt at the least; once the pair is tall enough the
 * card stacks, icon tile on top, words at its foot, an arrow in the corner and
 * a large faint glyph behind. Nothing is dropped between the two forms.
 *
 * Light mode takes its own wash through --vessel-journal-* (index.css); dark
 * and night keep the fallbacks here.
 */
import React, { useId } from 'react';
import { daylightUiColor } from '../../utils/daylightUiColor';

export const JOURNAL_CARD: React.CSSProperties = {
    background:
        'var(--vessel-journal-card-bg, linear-gradient(145deg, rgba(56, 189, 248, 0.17) 0%, rgba(20, 25, 35, 0.72) 64%))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid var(--vessel-journal-card-border, rgba(125, 211, 252, 0.24))',
    borderRadius: '16px',
    boxShadow:
        'var(--vessel-journal-card-shadow, inset 0 1px 0 rgba(186, 230, 253, 0.12), 0 8px 22px rgba(14, 165, 233, 0.08))',
};

export const JOURNAL_CHIP: React.CSSProperties = {
    background:
        'var(--vessel-journal-chip-bg, linear-gradient(145deg, rgba(56, 189, 248, 0.32) 0%, rgba(14, 165, 233, 0.10) 100%))',
    border: '1px solid var(--vessel-journal-chip-border, rgba(125, 211, 252, 0.30))',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
};

export const JournalCard: React.FC<{
    'aria-label': string;
    title: string;
    /** What is inside, in a few words, or what is new; also the card's
     *  description. */
    subtitle: string;
    /** A count worth a glance (unread messages), drawn in the corner. */
    badge?: string;
    /** The glyph, drawn in the hub accent. */
    icon: React.ReactNode;
    accent: string;
    onClick: () => void;
}> = ({ 'aria-label': ariaLabel, title, subtitle, badge, icon, accent, onClick }) => {
    const id = useId();
    return (
        <button
            aria-label={ariaLabel}
            aria-describedby={`${id}-sub`}
            onClick={onClick}
            style={JOURNAL_CARD}
            className="vessel-hub-tile relative flex h-full min-w-0 items-center gap-3 overflow-hidden px-4 py-2 text-left transition-all active:scale-[0.98] card-lift"
        >
            {/* The large faint glyph behind the stacked card. */}
            <span
                aria-hidden="true"
                className="vessel-hub-tile-watermark pointer-events-none absolute -right-3 -bottom-4 flex opacity-[0.09]"
            >
                {icon}
            </span>
            <span
                aria-hidden="true"
                className="vessel-hub-tile-icon relative flex shrink-0 items-center justify-center rounded-xl p-2.5"
                style={JOURNAL_CHIP}
            >
                {icon}
            </span>
            <span className="vessel-hub-tile-text relative min-w-0">
                <span className="vessel-hub-tile-title block text-[13px] font-black leading-tight tracking-wide text-white">
                    {title}
                </span>
                <span
                    id={`${id}-sub`}
                    className="vessel-hub-tile-sub block truncate text-xs font-semibold leading-snug"
                    style={{ color: daylightUiColor('#94a3b8') }}
                >
                    {subtitle}
                </span>
            </span>
            {/* The count, the tab bar's badge colours; the subtitle says it in
                words, so it is hidden from VoiceOver. */}
            {badge && (
                <span
                    aria-hidden="true"
                    className="vessel-hub-tile-badge absolute top-1.5 right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-black leading-none text-white shadow-lg shadow-red-500/30"
                >
                    {badge}
                </span>
            )}
            {/* The way in, shown on the stacked card only, and not under a
                count. */}
            <svg
                aria-hidden="true"
                className={`vessel-hub-tile-go absolute top-3 right-3 h-4 w-4${badge ? ' hidden' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke={accent}
                strokeWidth={2}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M9 7h8v8" />
            </svg>
        </button>
    );
};
