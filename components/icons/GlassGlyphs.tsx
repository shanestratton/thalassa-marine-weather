/**
 * Glyphs the Glass needed and the shared set lacked.
 *
 * WIND and GUST, and WAVE and PERIOD, each shared one glyph on the Glass
 * grid, the pin sheet and the Notifications rows (UX scorecard run 6), and
 * the saved-locations flyout borrowed the anchor for 'home port' while
 * System Status uses it for Anchor watch. Same 24-unit, 2-stroke,
 * round-cap drawing as the rest of components/icons. Every glyph is
 * decorative (aria-hidden): the control it sits in carries the name.
 */
import React from 'react';

type GlyphProps = { className?: string };

const Stroke: React.FC<GlyphProps & { children: React.ReactNode }> = ({ className, children }) => (
    <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        {children}
    </svg>
);

/** Gust: the wind glyph's curl, two streaks and a burst ahead of them. */
export const GustIcon: React.FC<GlyphProps> = ({ className }) => (
    <Stroke className={className}>
        <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
        <path d="M2 12h11" />
        <path d="M2 16h7" />
        <path d="M16 8.5l4.5 4-4.5 4" />
    </Stroke>
);

/** Wave period: a stopwatch — the seconds between crests. */
export const WavePeriodIcon: React.FC<GlyphProps> = ({ className }) => (
    <Stroke className={className}>
        <circle cx="12" cy="14" r="7.5" />
        <path d="M12 14l3-3" />
        <path d="M10 2.5h4" />
        <path d="M12 2.5v4" />
        <path d="M18.5 6.5 20 5" />
    </Stroke>
);

/** Home port: a house, so the anchor keeps meaning Anchor watch. */
export const HomeIcon: React.FC<GlyphProps> = ({ className }) => (
    <Stroke className={className}>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9v12h14V9" />
        <path d="M10 21v-6h4v6" />
    </Stroke>
);

/** Pin: a push pin, for the 'pin a metric to the top' sheet. */
export const PinIcon: React.FC<GlyphProps> = ({ className }) => (
    <Stroke className={className}>
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Stroke>
);

/** Chevron right: 'opens more', for the rain strip on a short phone, where
 *  its 'Tap for detail' line has no room. */
export const ChevronRightIcon: React.FC<GlyphProps> = ({ className }) => (
    <Stroke className={className}>
        <path d="m9 18 6-6-6-6" />
    </Stroke>
);
